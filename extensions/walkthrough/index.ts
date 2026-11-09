/**
 * `walkthrough` — present a change set as a narrated tour inside the chat.
 *
 * Unlike the Neovim tour, nothing is shown in the editor: the tool renders the
 * chosen hunks and the reasoning right where the conversation is, so the tour
 * stays in the transcript. The model decides what matters and why; the diff
 * itself always comes from git, so the reader never sees invented code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveDiffBase } from "../lib/git-base.js";
import { diffSignature, rememberTour, type SharedStop } from "../lib/tour-state.js";
import { hasNvim, nvimRequest } from "../nvim/nvim.js";
import {
  clipHunk, findFile, parseUnifiedDiff, selectHunks, type FileDiff,
} from "./diff.js";
import { TourView, type Tour, type TourStop } from "./render.js";

const run = promisify(execFile);

const MAX_STOPS = 12;

/** Custom block type: the tour is a transcript block, not a tool shell. */
const BLOCK_TYPE = "pi-core:walkthrough";

interface WalkthroughBlock {
  tour: Tour;
}

/** Tool failures still carry a details field; the contract requires the key. */
function fail(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: undefined, isError: true };
}

const PARAMETERS = Type.Object({
  title: Type.Optional(Type.String({ description: "Headline of the tour, e.g. 'Dictation reaches the question dialog'" })),
  intro: Type.Optional(Type.String({ description: "One or two sentences: what changed and why, shown under the title" })),
  base: Type.Optional(Type.String({
    description: "Git revision to compare against. Default HEAD (uncommitted work). Use origin/main or HEAD~1 for committed work; 'staged' and 'unstaged' are accepted",
  })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Limit the diff to these paths" })),
  annotate: Type.Optional(Type.Boolean({
    description: "Also write each stop's explanation as an annotation into the Neovim buffers that are already open (default true; files that are not open are left alone)",
  })),
  stops: Type.Array(Type.Object({
    title: Type.String({ description: "Short headline for this stop: what the reader is looking at" }),
    why: Type.String({ description: "Why this change exists and why it works this way — the reasoning a reviewer needs, not a restatement of the code" }),
    file: Type.Optional(Type.String({ description: "Path as it appears in the diff; omit only when the tour covers a single file" })),
    hunk: Type.Optional(Type.Number({ description: "1-based hunk index within the file" })),
    lines: Type.Optional(Type.Array(Type.Number(), { description: "Line range [from, to] in the new file: picks the hunk that covers it and shows only those lines with two of context" })),
    note: Type.Optional(Type.String({ description: "Optional caveat, trade-off or follow-up" })),
  }), { description: "Stops of the tour, in reading order; pick the hunks that carry the story" }),
}, { additionalProperties: false });

interface StopDetails {
  title: string;
  why: string;
  file?: string;
  hunks: number[];
  warning?: string;
}

interface WalkthroughDetails {
  base: string;
  files: { path: string; additions: number; deletions: number; hunks: number }[];
  stops: StopDetails[];
  fileCount: number;
  additions: number;
  deletions: number;
}

function describeBase(base: string | undefined): { args: string[]; label: string } {
  if (!base || base === "HEAD" || base === "head") return { args: ["diff", "HEAD"], label: "HEAD → working tree" };
  if (base === "staged" || base === "index") return { args: ["diff", "--cached"], label: "index → HEAD" };
  if (base === "unstaged" || base === "worktree") return { args: ["diff"], label: "working tree → index" };
  return { args: ["diff", base], label: `${base} → working tree` };
}

async function gitDiff(cwd: string, base: string | undefined, paths: readonly string[]): Promise<{ text: string; label: string }> {
  const { args, label } = describeBase(base);
  const full = [...args, "--no-color", "--no-ext-diff", "-U3", "--", ...paths];
  try {
    const { stdout } = await run("git", full, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { text: stdout, label };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) throw new Error("Not a git repository; the tour needs git to read the changes.");
    if (/unknown revision|ambiguous argument|bad revision/i.test(message)) throw new Error(`Unknown base revision "${base}". Pass a ref that exists (e.g. origin/main, HEAD~1) or omit it for uncommitted work.`);
    throw error;
  }
}

/**
 * Mirror the chat tour into Neovim: the same explanation hangs above the same
 * hunk in buffers the user already has open. Files that are not open are left
 * alone — the chat tour must not open windows or move the cursor.
 */
async function annotateInNvim(cwd: string, enabled: boolean, stops: readonly TourStop[]): Promise<void> {
  if (!enabled || !hasNvim(cwd)) return;
  const byFile = new Map<string, { from_line: number; header: string; text: string }[]>();
  for (const stop of stops) {
    const hunk = stop.hunks[0];
    if (!hunk) continue;
    const items = byFile.get(stop.file) ?? [];
    // Anchor above the first changed line rather than the hunk's context edge,
    // so a stop that points deep inside a hunk is annotated where it matters.
    const changed = hunk.lines.find((line) => line.kind !== "context");
    items.push({
      from_line: Math.max(1, changed?.newLine ?? changed?.oldLine ?? hunk.newStart),
      header: stop.title,
      text: [stop.why, stop.note].filter(Boolean).join("\n"),
    });
    byFile.set(stop.file, items);
  }
  await Promise.all([...byFile].map(([file, items]) =>
    nvimRequest({ method: "annotate", file, root: cwd, items }, 5_000).catch(() => undefined)));
}

/** Flatten the rendered stops into the editor-facing shape the tour consumes. */
function sharedStops(stops: readonly TourStop[]): SharedStop[] {
  return stops.flatMap((stop) => stop.hunks.map((hunk) => {
    const added: number[] = [];
    const deleted: SharedStop["deleted"] = [];
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== undefined) added.push(line.newLine);
      else if (line.kind === "del") {
        const at = line.newLine ?? added.at(-1) ?? hunk.newStart;
        const entry = { old: line.oldLine ?? 0, text: line.text };
        const block = deleted.at(-1);
        if (block && block.at === at) block.lines.push(entry);
        else deleted.push({ at, lines: [entry] });
      }
    }
    return {
      file: stop.file,
      from: hunk.newStart,
      to: Math.max(hunk.newStart, hunk.newStart + hunk.newCount - 1),
      title: stop.title,
      why: stop.why,
      // The editor annotation is the explanation itself, note included.
      note: [stop.why, stop.note].filter(Boolean).join("\n"),
      added,
      deleted,
    };
  }));
}

function hunkLabel(file: FileDiff, index: number, total: number): string {
  return total > 1 ? `hunk ${index + 1}/${total}` : "hunk 1/1";
}

/**
 * The one entry point for "show me what you just did": narrate the change set in
 * the chat, then let the reader go deeper in Neovim on the same stops.
 *
 * The command cannot write the explanations itself — the model has them — so it
 * starts a turn with the shape of the review spelled out, and the tool does the
 * rendering. Because the walkthrough records its stops, `/tour start` afterwards
 * opens exactly these hunks with these explanations instead of planning anew.
 */
export default function walkthrough(pi: ExtensionAPI) {
  // The block renders itself: no tool shell, no label, just the card. It is
  // persisted with the message, so the tour survives a reload.
  pi.registerMessageRenderer<WalkthroughBlock>(BLOCK_TYPE, (message, options, theme) => {
    const tour = message.details?.tour;
    return tour ? new TourView(tour, theme, options.outputPad) : undefined;
  });

  pi.registerCommand("story", {
    description: "Narrate the change set in the chat, then continue in Neovim: /story [--base <ref>] [paths]",
    getArgumentCompletions: (prefix) => (prefix.startsWith("-")
      ? [{ label: "--base", value: "--base ", description: "Compare against this revision (default: uncommitted work, else the branch point)" }]
      : null),
    handler: async (args, context) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      let base: string | undefined;
      const paths: string[] = [];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === "--base" || token === "-b") { base = tokens[++index]; continue; }
        if (token.startsWith("--base=")) { base = token.slice("--base=".length); continue; }
        paths.push(token);
      }
      const scope = [
        base ? `base ${base}` : "the default base (uncommitted work, or the branch point when the tree is clean)",
        paths.length ? `limited to ${paths.join(", ")}` : "the whole change set",
      ].join(", ");
      pi.sendUserMessage([
        `Present a walkthrough of the current change set (${scope}).`,
        "",
        "1. Call the `walkthrough` tool with 3-6 stops that carry the story: the decision, the tricky part, the risk. Skip formatting, renames and generated files. Write `why` as the reasoning a reviewer cannot read off the code, not as a description of the lines.",
        "2. Stop there. Do not ask me questions of your own and do not propose options: the review slider opens on these stops, I walk them with `]t`/`[t` and ask when I want.",
        "",
        "The stops are remembered, so `/tour start` opens the same hunks with the same explanations in Neovim. Keep the stop order meaningful for that.",
      ].join("\n"));
      context.ui.notify(`Walking through ${scope}.`, "info");
    },
  });

  pi.registerTool({
    name: "walkthrough",
    label: "Walkthrough",
    executionMode: "sequential",
    description: "Present a change set as a narrated tour in the chat: pick the hunks that carry the story and explain why each change exists and why it works this way. Diffs are read from git, so they always match the working tree. Use it instead of dumping a raw diff when the user should understand a change, not review it line by line.",
    promptSnippet: "Narrate a change set in the chat instead of showing a raw diff",
    promptGuidelines: [
      "Use walkthrough after a change set is ready, when the user asked to see what changed or to explain the work; skip it for trivial one-line edits.",
      "Do not end the walkthrough with a question of your own and do not poll the user: the review slider takes over, and the user decides whether to discuss a stop.",
      "After the tool returns, stop and let the user read. One sentence about where they can go next is enough.",
      "Pick 3-6 stops that carry the story (the decision, the tricky part, the risk). Skip formatting, renames and generated files.",
      "`why` explains the reasoning and the trade-off a reviewer cannot see from the code; never restate what the line does.",
      "Name `file` plus `hunk` or `lines` when the file has several hunks; the diff itself is read from git.",
      "Set `base` explicitly when the work is already committed (origin/main, HEAD~1); the default is HEAD, i.e. uncommitted changes.",
    ],
    parameters: PARAMETERS,
    // The tour draws its own frame (rule lines, indented stops), so the default
    // boxed shell would only add a second border around it.
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const stops = params.stops ?? [];
      if (!stops.length) return fail("a walkthrough needs at least one stop; pass the hunks the reader should see.");
      if (stops.length > MAX_STOPS) return fail(`${stops.length} stops is more than a tour; pick at most ${MAX_STOPS}.`);

      let base = params.base;
      let diff: { text: string; label: string };
      try {
        base = params.base ?? await resolveDiffBase((args) => run("git", args, { cwd: ctx.cwd, maxBuffer: 4 * 1024 * 1024 }).then((result) => result.stdout));
        diff = await gitDiff(ctx.cwd, base, params.paths ?? []);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }

      const files = parseUnifiedDiff(diff.text);
      if (!files.length) {
        const where = params.base && params.base !== "HEAD" ? ` against ${params.base}` : " against HEAD";
        return fail(`no changes${where}${params.paths?.length ? ` in ${params.paths.join(", ")}` : ""}. Nothing to walk through; check the base revision or make the change first.`);
      }

      const tourStops: TourStop[] = [];
      const details: StopDetails[] = [];
      for (const stop of stops) {
        const wanted = stop.file ?? (files.length === 1 ? files[0].path : undefined);
        const file = wanted ? findFile(files, wanted) : undefined;
        if (!file) {
          tourStops.push({
            title: stop.title,
            why: stop.why,
            note: stop.note,
            file: wanted ?? "(no file)",
            hunks: [],
            warning: wanted ? `${wanted} is not part of this diff` : "Name a file: the diff touches several",
          });
          details.push({ title: stop.title, why: stop.why, file: wanted, hunks: [], warning: "file not in diff" });
          continue;
        }
        const picked = selectHunks(file, stop);
        if (stop.lines && stop.lines.length >= 2) {
          const clipped = picked.hunks
            .map((hunk) => clipHunk(hunk, stop.lines![0], stop.lines![1]))
            .filter((hunk): hunk is NonNullable<typeof hunk> => hunk !== undefined);
          if (clipped.length) picked.hunks = clipped;
        }
        const indexes = picked.hunks.map((hunk) => file.hunks.indexOf(hunk) + 1);
        tourStops.push({
          title: stop.title,
          why: stop.why,
          note: stop.note,
          file: file.path,
          hunkLabel: picked.hunks.length === 1 ? hunkLabel(file, indexes[0] - 1, file.hunks.length) : `${picked.hunks.length} hunks`,
          hunks: picked.hunks,
          warning: picked.reason,
        });
        details.push({ title: stop.title, why: stop.why, file: file.path, hunks: indexes, warning: picked.reason });
      }

      const tour: Tour = {
        title: params.title,
        intro: params.intro,
        base: diff.label,
        fileCount: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        stops: tourStops,
      };

      const shown = details.map((stop, index) => `${index + 1}. ${stop.title}${stop.file ? ` (${stop.file}${stop.hunks.length ? `, hunk ${stop.hunks.join(", ")}` : ""})` : ""}${stop.warning ? ` — ${stop.warning}` : ""}`);
      // Remember the tour so `/tour start` can bring the same stops, with these
      // explanations, into the editor instead of planning a different set.
      rememberTour({
        base,
        signature: diffSignature(files.length, tour.additions, tour.deletions),
        stops: sharedStops(tourStops),
      });

      await annotateInNvim(ctx.cwd, params.annotate !== false, tourStops);
      // Hand the stops to review mode so the slider is ready without a second
      // command: "/story, then work with it".
      pi.events.emit("pi-core:tour-ready", { base, stops: tour.stops });

      pi.sendMessage<WalkthroughBlock>({
        customType: BLOCK_TYPE,
        display: true,
        content: params.title ?? "Change tour",
        details: { tour },
      });

      const summary = [
        `Walkthrough shown against ${tour.base}: ${files.length} files, +${tour.additions}/−${tour.deletions}, ${tourStops.length} stops.`,
        ...shown,
        "The user sees the hunks and your explanations; no diff text is needed in your reply.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        details: {
          base: tour.base,
          files: files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, hunks: file.hunks.length })),
          stops: details,
          fileCount: tour.fileCount,
          additions: tour.additions,
          deletions: tour.deletions,
        } satisfies WalkthroughDetails,
      };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.stops) ? args.stops.length : 0;
      const base = typeof args.base === "string" && args.base ? args.base : "HEAD";
      const title = typeof args.title === "string" && args.title ? args.title : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("walkthrough "))}${theme.fg("muted", `${count} stop${count === 1 ? "" : "s"} against ${base}`)}${title ? theme.fg("dim", ` · ${title}`) : ""}`,
        0, 0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WalkthroughDetails | undefined;
      if (!details?.fileCount) {
        const part = result.content[0];
        return new Text(part?.type === "text" ? part.text : "", 0, 0);
      }
      // The card above carries the presentation; this is the closing line.
      return new Text(theme.fg("dim", `${details.stops.length} stop${details.stops.length === 1 ? "" : "s"} · ${details.fileCount} file${details.fileCount === 1 ? "" : "s"} · ${theme.fg("success", `+${details.additions}`)} ${theme.fg("error", `−${details.deletions}`)} · ${details.base}`), 0, 0);
    },
  });
}
