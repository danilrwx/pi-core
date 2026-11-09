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
import {
  findFile, parseUnifiedDiff, selectHunks, type FileDiff,
} from "./diff.js";
import { TourView, type Tour, type TourStop } from "./render.js";

const run = promisify(execFile);

const MAX_STOPS = 12;

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
  stops: Type.Array(Type.Object({
    title: Type.String({ description: "Short headline for this stop: what the reader is looking at" }),
    why: Type.String({ description: "Why this change exists and why it works this way — the reasoning a reviewer needs, not a restatement of the code" }),
    file: Type.Optional(Type.String({ description: "Path as it appears in the diff; omit only when the tour covers a single file" })),
    hunk: Type.Optional(Type.Number({ description: "1-based hunk index within the file" })),
    lines: Type.Optional(Type.Array(Type.Number(), { description: "Line range [from, to] in the new file, an alternative to hunk" })),
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
  /** Renders the tour after a reload; the selected hunks live here. */
  tour: Tour;
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

function hunkLabel(file: FileDiff, index: number, total: number): string {
  return total > 1 ? `hunk ${index + 1}/${total}` : "hunk 1/1";
}

export default function walkthrough(pi: ExtensionAPI) {
  pi.registerTool({
    name: "walkthrough",
    label: "Walkthrough",
    executionMode: "sequential",
    description: "Present a change set as a narrated tour in the chat: pick the hunks that carry the story and explain why each change exists and why it works this way. Diffs are read from git, so they always match the working tree. Use it instead of dumping a raw diff when the user should understand a change, not review it line by line.",
    promptSnippet: "Narrate a change set in the chat instead of showing a raw diff",
    promptGuidelines: [
      "Use walkthrough after a change set is ready, when the user asked to see what changed or to explain the work; skip it for trivial one-line edits.",
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

      let diff: { text: string; label: string };
      try {
        diff = await gitDiff(ctx.cwd, params.base, params.paths ?? []);
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
          tour,
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
    renderResult(result, _options, theme, context) {
      const details = result.details as WalkthroughDetails | undefined;
      if (details?.tour) return new TourView(details.tour, theme, context.outputPad);
      const part = result.content[0];
      return new Text(part?.type === "text" ? part.text : "", 0, 0);
    },
  });
}
