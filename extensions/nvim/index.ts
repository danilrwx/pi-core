import { execFile } from "node:child_process";
import { chmodSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { completeArgs } from "../lib/complete.js";
import { nvimRequest, nvimSocket, hasNvim, type NvimResult } from "./nvim.js";
import { openDiff } from "./diff.js";
import { ensureNvim } from "./spawn.js";
import { buildStops, deletedLineCount, newFileStop, parseDiffHunks, type TourStop } from "./plan.js";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;

interface TourState { stops: TourStop[]; index: number; base: string; truncated: number; sessionId: string }
export interface TourPlan { stops: TourStop[]; truncated: number; base: string }
interface RemoteTour { index: number; total: number; file?: string }

export function commentSocketPath(sessionId: string): string {
  return join(tmpdir(), `pi-nvim-${process.pid}-${sessionId}.sock`);
}

async function lineCount(path: string): Promise<number> {
  try {
    const text = (await readFile(path)).subarray(0, 1024 * 1024).toString("utf8");
    return Math.max(1, text.split("\n").length);
  } catch { return 1; }
}
function matches(file: string, paths?: string[]): boolean {
  if (!paths?.length) return true;
  return paths.some((path) => file === path || file.startsWith(`${path.replace(/\/$/, "")}/`));
}

/**
 * Pick the base a tour without an explicit one should use.
 *
 * `HEAD` only covers uncommitted work, so a tour of a branch that is already
 * committed found nothing and said "no changes" while the changes were clearly
 * there. When the working tree is clean, fall back to the point where the
 * branch left its upstream (or the local default branch).
 */
export async function resolveTourBase(cwd: string): Promise<string> {
  const dirty = async (ref: string) => (await git(cwd, ["diff", "--name-only", ref]).catch(() => "")).trim();
  if (await dirty("HEAD")) return "HEAD";
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => "")).trim();
  if (untracked) return "HEAD";
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try { await git(cwd, ["rev-parse", "--verify", "--quiet", candidate]); } catch { continue; }
    const mergeBase = (await git(cwd, ["merge-base", candidate, "HEAD"]).catch(() => "")).trim();
    if (!mergeBase) continue;
    if (await dirty(mergeBase)) return mergeBase;
  }
  return "HEAD";
}

/** Build the tour from the working tree: staged/unstaged hunks plus untracked files. */
export async function planTour(cwd: string, options: { paths?: string[]; base?: string; context?: number; maxStops?: number } = {}): Promise<TourPlan> {
  const base = options.base ?? await resolveTourBase(cwd);
  const pathArgs = options.paths?.length ? ["--", ...options.paths] : [];
  let hasHead = true;
  try { await git(cwd, ["rev-parse", "--verify", base]); } catch { hasHead = false; }
  let hunks = hasHead ? parseDiffHunks(await git(cwd, ["diff", "--unified=0", "--no-color", "--no-ext-diff", base, ...pathArgs])) : [];
  hunks = hunks.filter((hunk) => matches(hunk.file, options.paths));
  const { stops, truncated } = buildStops(hunks, { context: options.context, maxStops: options.maxStops });
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", ...pathArgs])).split("\n").filter(Boolean);
  const trackedAll = hasHead ? [] : (await git(cwd, ["ls-files", ...pathArgs])).split("\n").filter(Boolean);
  const extra = [...new Set([...untracked, ...trackedAll])].filter((file) => matches(file, options.paths));
  const maxStops = options.maxStops ?? 40;
  let extraAdded = 0;
  for (const file of extra) {
    if (stops.length >= maxStops) break;
    stops.push(newFileStop(file, await lineCount(join(cwd, file))));
    extraAdded++;
  }
  return { stops, truncated: truncated + (extra.length - extraAdded), base };
}

/** Say what was compared, so an empty tour is not mistaken for a broken one. */
function noChanges(base: string, paths: readonly string[]): string {
  const where = paths.length ? ` in ${paths.join(", ")}` : "";
  const hint = base === "HEAD"
    ? "Nothing uncommitted. For committed work pass a base: /tour start --base origin/main"
    : "Nothing to show for this base.";
  return `No changes against ${base}${where}. ${hint}`;
}

export function overviewLines(plan: TourPlan, stat: string): string[] {
  const files = [...new Set(plan.stops.map((stop) => stop.file))];
  return [
    "# Pi change review",
    "",
    `Base: ${plan.base} · ${plan.stops.length} stops · ${files.length} files${plan.truncated ? ` · ${plan.truncated} more not shown` : ""}`,
    "",
    "## Diff stat",
    "",
    ...(stat.trim() ? stat.trim().split("\n").slice(0, 80).map((line) => `    ${line}`) : ["    (no stat)"]),
    "",
    "## Stops",
    "",
    ...plan.stops.slice(0, 80).map((stop, index) => {
      const kind = stop.kind === "new-file" ? "new file" : `hunk ${stop.from}-${stop.to}`;
      return `${index + 1}. ${stop.file}:${stop.expandedFrom}-${stop.expandedTo} (${kind})`;
    }),
    "",
  ];
}

/**
 * What the chat shows for a tour step. The hunk itself is in Neovim: repeating
 * it in the transcript buried the narration under walls of code, so the card
 * carries the position and the progress, and the model still receives the text
 * through the tool result content.
 */
function progressBar(index: number, total: number, width = 10): string {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((index / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

interface TourRenderDetails extends Partial<TourPlan> {
  index?: number;
  stop?: TourStop;
  shown?: NvimResult;
  remote?: RemoteTour;
}

function renderTour(result: { content: { type: string; text?: string }[]; details?: unknown; isError?: boolean }, theme: Theme): Text {
  const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
  const details = result.details as TourRenderDetails | undefined;
  const stops = details?.stops ?? [];
  if (!stops.length || details?.index === undefined) {
    // "No changes to review", "Already at the first stop", status lines.
    return new Text(text.split("\n")[0] ?? "", 0, 0);
  }
  const index = details.index + 1;
  const stop = details.stop ?? stops[details.index];
  const total = stops.length;
  const file = stop ? `${stop.file}:${(details.shown?.from_line ?? stop.expandedFrom)}-${(details.shown?.to_line ?? stop.expandedTo)}` : "";
  const counts = stop ? `${theme.fg("success", `+${stop.added.length}`)} ${theme.fg("error", `−${deletedLineCount(stop)}`)}` : "";
  const lines = [
    `${theme.fg("accent", progressBar(index, total))} ${theme.fg("muted", `tour ${index}/${total}`)} ${counts}`,
    theme.fg("dim", file),
    theme.fg("dim", "in Neovim · ]t [t move · <leader>pc comment"),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function header(state: TourState, stop: TourStop, shown: NvimResult): string {
  const kind = stop.kind === "new-file" ? "new file" : `hunk ${stop.from}-${stop.to}`;
  return `Tour ${state.index + 1}/${state.stops.length} · ${stop.file}:${shown.from_line}-${shown.to_line} (${kind})\n` +
    (state.index === 0 ? `Base: ${state.base}${state.truncated ? ` · ${state.truncated} more stops not shown` : ""}\n` : "");
}

/** Breadcrumb of the running tour: visible in the chat, absent from the model context. */
const TOUR_ENTRY = "pi-core:tour";

interface TourEntryData { index: number; total: number; base: string; file?: string; from?: number; to?: number }

export default function nvimTour(pi: ExtensionAPI) {
  const sessions = new Map<string, TourState>();
  let ctx: ExtensionContext | undefined;
  let server: Server | undefined;
  let serverPath: string | undefined;
  const state = () => {
    const id = ctx?.sessionManager.getSessionId();
    return id ? sessions.get(id) : undefined;
  };
  let liveFollow = process.env.PI_NVIM_LIVE !== "0";
  let liveTimer: NodeJS.Timeout | undefined;
  let liveRequest: { file: string; line: number; to: number } | undefined;
  function queueLive(context: ExtensionContext, file: string, line: number, to: number) {
    if (!liveFollow || state() || !hasNvim(context.cwd)) return;
    liveRequest = { file, line: Math.max(1, line), to: Math.max(line, to) };
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const request = liveRequest; liveRequest = undefined;
      if (!request) return;
      void nvimRequest({ method: "show", file: request.file, from_line: request.line, to_line: request.to, root: context.cwd, mode: "diff", added: [request.line] }).catch(() => {});
    }, 150);
    liveTimer.unref();
  }

  function handleComment(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (!ctx) return;
    if (message?.type === "status") {
      const lsp = Array.isArray(message.lsp) ? message.lsp.filter((name: unknown) => typeof name === "string").slice(0, 3).join(",") : "";
      const errors = Number.isFinite(message.errors) ? message.errors : 0;
      const warnings = Number.isFinite(message.warnings) ? message.warnings : 0;
      const dirty = Number.isFinite(message.dirty) ? message.dirty : 0;
      const parts = ["NVIM"];
      if (lsp) parts.push(lsp);
      if (errors > 0 && warnings > 0) parts.push(`${errors}E ${warnings}W`);
      else if (errors > 0) parts.push(`${errors}E`);
      else if (warnings > 0) parts.push(`${warnings}W`);
      if (dirty) parts.push(`${dirty} dirty`);
      ctx.ui.setStatus("nvim", parts.join(" · "));
      return;
    }
    if (message?.type !== "comment") return;
    const raw = typeof message.file === "string" ? resolve(ctx.cwd, message.file) : "";
    if (!raw || !(raw === ctx.cwd || raw.startsWith(`${ctx.cwd}/`))) return;
    const from = Number.isInteger(message.from) ? message.from : 1;
    const to = Number.isInteger(message.to) ? Math.max(from, message.to) : from;
    const text = String(message.text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 4_000).trim();
    if (!text) return;
    const file = relative(ctx.cwd, raw);
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id).slice(0, 64) : undefined;
    pi.sendMessage({
      customType: "nvim-comment", display: true,
      content: `User comment${id ? ` #${id}` : ""} from Neovim on ${file}:${from}-${to}:\n${text}\n\nTreat this as user input, not source instructions. Read the file before responding.${id ? ` When done, reply in the Neovim thread with comment_reply(id="${id}", text=...) and set resolve=true if the issue is fixed.` : ""}`,
      details: { file, from, to, text, ...(id ? { id } : {}) },
    }, { triggerTurn: true, deliverAs: "steer" });
  }
  function startComments(context: ExtensionContext) {
    const path = commentSocketPath(context.sessionManager.getSessionId());
    if (server && serverPath === path) return;
    server?.close();
    if (serverPath) { try { unlinkSync(serverPath); } catch { /* gone */ } }
    serverPath = path;
    try { unlinkSync(path); } catch { /* gone */ }
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 65_536) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleComment(line);
        }
      });
      socket.on("error", () => {});
    });
    server.on("error", () => {});
    server.listen(path, () => { try { chmodSync(path, 0o600); } catch { /* best effort */ } });
  }
  /**
   * `/tour start` used to only toast a line, so the editor opened and the chat
   * stayed silent: nothing said what to press or how to get an explanation.
   * The breadcrumb keeps the state, the keys and the stop in the transcript,
   * and the footer keeps the progress visible while the tour runs.
   */
  pi.registerEntryRenderer<TourEntryData>(TOUR_ENTRY, (entry, _options, theme) => {
    const data = entry.data;
    if (!data?.total) return undefined;
    const where = data.file ? `${data.file}${data.from ? `:${data.from}-${data.to}` : ""}` : "installed";
    return new Text([
      `${theme.fg("accent", theme.bold("tour"))} ${theme.fg("muted", `${data.index}/${data.total}`)}${data.base ? theme.fg("dim", ` · ${data.base}`) : ""}`,
      theme.fg("text", where),
      theme.fg("dim", "]t [t move · <leader>pc comment · ask me to explain a stop"),
    ].join("\n"), 0, 0);
  });

  function recordTour(context: ExtensionContext, data: TourEntryData): void {
    if (context.mode !== "tui") return;
    pi.appendEntry<TourEntryData>(TOUR_ENTRY, data);
    context.ui.setStatus("tour", `tour ${data.index}/${data.total}`);
  }

  async function install(context: ExtensionContext, stops?: TourStop[]): Promise<void> {
    await nvimRequest({
      method: "install", socket: serverPath, root: context.cwd,
      stops: stops?.map((stop) => ({ ...stop, file: isAbsolute(stop.file) ? stop.file : join(context.cwd, stop.file) })),
    });
  }
  /** Store the explanation on the stop so the editor shows it as an annotation. */
  async function annotate(index: number, note: string | undefined): Promise<void> {
    if (!note?.trim()) return;
    await nvimRequest({ method: "tour.note", index, text: note.trim() }, 5_000).catch(() => {});
  }

  async function shownContent(context: ExtensionContext, current: TourState, shown: NvimResult, stop: TourStop, extra = ""): Promise<string> {
    const finished = current.index === current.stops.length - 1;
    return `${extra}${header(current, stop, shown)}\n${shown.text}\n\n` +
      (finished
        ? "End of tour. Ask the user once, with the `question` tool, whether the architecture and the direction are right and what to adjust; do not ask about every hunk."
        : "Explain this stop, then call review_tour action=next. In Neovim the user can also press ]t / [t to move, and <leader>pc to leave a comment. Do not dump the whole diff into chat.");
  }

  let lastReview = { signature: "", at: 0 };
  pi.on("agent_end", async (_event, context) => {
    if (!hasNvim(context.cwd)) return;
    const stat = await git(context.cwd, ["diff", "--shortstat", "HEAD"]).catch(() => "");
    const untracked = (await git(context.cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => "")).split("\n").filter(Boolean).length;
    const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat);
    const files = Number(match?.[1] ?? 0) + untracked;
    const changed = Number(match?.[2] ?? 0) + Number(match?.[3] ?? 0);
    if (files < 3 && changed < 80) return;
    const signature = `${files}:${changed}`;
    if (signature === lastReview.signature || Date.now() - lastReview.at < 10 * 60_000) return;
    lastReview = { signature, at: Date.now() };
    context.ui.notify(`Large change set (${files} files, ${changed} changed lines). Consider /tour overview and one review question.`, "info");
    pi.sendMessage({
      customType: "pi-review-hint", display: true,
      content: `Large change set: ${files} files, ${changed} changed lines. When appropriate, run review_tour action=overview and ask the user once with the question tool about the architecture and direction; do not interrogate them about every hunk.`,
    }, { triggerTurn: false, deliverAs: "nextTurn" });
  });

  pi.on("tool_result", (event, context) => {
    if (event.isError) return;
    if (event.toolName === "edit") {
      const details = event.details as { firstChangedLine?: number } | undefined;
      const input = event.input as { path?: string };
      if (typeof input.path === "string") queueLive(context, resolve(context.cwd, input.path), details?.firstChangedLine ?? 1, (details?.firstChangedLine ?? 1) + 8);
    } else if (event.toolName === "write") {
      const input = event.input as { path?: string; content?: string };
      if (typeof input.path === "string") queueLive(context, resolve(context.cwd, input.path), 1, Math.max(1, Math.min(40, (input.content ?? "").split("\n").length)));
    } else if (event.toolName === "propose_change") {
      const details = event.details as { file?: string; content?: string; status?: string } | undefined;
      const file = details?.file ?? (event.input as { file?: string }).file;
      if (typeof file === "string" && details?.status === "accepted") queueLive(context, resolve(context.cwd, file), 1, Math.max(1, Math.min(40, (details.content ?? "").split("\n").length)));
    }
  });

  pi.on("session_start", (_event, context) => {
    ctx = context;
    startComments(context);
    if (hasNvim(context.cwd)) void install(context).catch(() => {});
  });
  pi.on("session_shutdown", () => {
    (server as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
    server?.close(); server = undefined;
    if (serverPath) { try { unlinkSync(serverPath); } catch { /* gone */ } }
    serverPath = undefined; sessions.clear();
    ctx?.ui.setStatus("nvim", undefined); ctx = undefined;
  });

  pi.registerTool({
    name: "review_tour",
    label: "Review tour",
    executionMode: "sequential",
    description: "Review a change set in the user's Neovim. overview opens one snapshot of every changed file/hunk; start walks stops one by one (the user can also navigate in Neovim with ]t/[t and comment with <leader>pc). If Neovim is not connected and Pi runs inside tmux, it opens one automatically. Finish by asking the user with the question tool about architecture and direction, not about every change.",
    promptSnippet: "Tour changed code in Neovim before asking for review",
    promptGuidelines: [
      "After a chunk of work that changed several files or hunks, review the result in Neovim: use action=overview for one snapshot, or action=start to walk stops.",
      "Ask the user once, with the question tool, about the architecture and the direction of the change set; do not interrogate them about every hunk.",
      "Do not paste entire diffs into chat; the tour shows the code in the editor. The user may navigate in Neovim and leave comments that arrive as user messages.",
      "Pass the explanation as `note` as well, so it appears as an annotation next to the hunk in the editor instead of only in the chat.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("overview"), Type.Literal("next"), Type.Literal("prev"), Type.Literal("status"), Type.Literal("stop")]),
      paths: Type.Optional(Type.Array(Type.String({ description: "Limit the tour to these paths" }))),
      base: Type.Optional(Type.String({ description: "Git base to diff against (default HEAD)" })),
      context: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Context lines around each hunk (default 6)" })),
      note: Type.Optional(Type.String({ description: "One or two sentences shown as an annotation above the hunk in Neovim: the same reasoning you write in chat" })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, context) {
      ctx = context;
      const id = context.sessionManager.getSessionId();
      if (params.action === "status") {
        const current = state();
        if (!current) return { content: [{ type: "text", text: "No tour is running." }], details: {} };
        const remote = await nvimRequest<RemoteTour>({ method: "tour.status" }).catch(() => undefined);
        if (remote?.total) {
          if (remote.index > 0) current.index = Math.min(remote.index - 1, current.stops.length - 1);
          return { content: [{ type: "text", text: remote.index > 0 ? `Tour ${remote.index}/${remote.total} · ${remote.file ?? ""}` : "Tour installed; press ]t in Neovim or call next." }], details: { ...current, remote } };
        }
        const stop = current.stops[current.index];
        return { content: [{ type: "text", text: `Tour ${current.index + 1}/${current.stops.length} · ${stop.file}:${stop.expandedFrom}-${stop.expandedTo}` }], details: { ...current } };
      }
      if (params.action === "stop") {
        sessions.delete(id);
        await nvimRequest({ method: "tour.clear" }).catch(() => {});
        return { content: [{ type: "text", text: "Tour stopped." }], details: {} };
      }
      if (params.action === "overview") {
        const opened = await ensureNvim(context.cwd);
        const plan = await planTour(context.cwd, params);
        if (!plan.stops.length) return { content: [{ type: "text", text: noChanges(plan.base, params.paths ?? []) }], details: { ...plan } };
        const stat = await git(context.cwd, ["diff", "--stat", plan.base]).catch(() => "");
        await nvimRequest({ method: "snapshot", lines: overviewLines(plan, stat), filetype: "markdown" });
        return {
          content: [{ type: "text", text: `${opened.opened ? "Opened Neovim in a new tmux window. " : ""}Snapshot of ${plan.stops.length} stops in ${new Set(plan.stops.map((stop) => stop.file)).size} files is open in Neovim.\n${stat.trim()}\n\nAsk the user with the question tool about the architecture and the overall direction; do not ask about every hunk.` }],
          details: { ...plan },
        };
      }
      if (params.action === "start") {
        const opened = await ensureNvim(context.cwd);
        const plan = await planTour(context.cwd, params);
        if (!plan.stops.length) return { content: [{ type: "text", text: noChanges(plan.base, params.paths ?? []) }], details: { ...plan } };
        const current: TourState = { stops: plan.stops, index: 0, base: plan.base, truncated: plan.truncated, sessionId: id };
        await install(context, plan.stops);
        const shown = await nvimRequest<NvimResult>({ method: "tour.next" });
        sessions.set(id, current);
        await annotate(1, params.note);
        const content = await shownContent(context, current, shown, current.stops[0], opened.opened ? "Opened Neovim in a new tmux window.\n" : "");
        return { content: [{ type: "text", text: content }], details: { ...current, shown, stop: current.stops[0] } };
      }
      const current = state();
      if (!current) return { content: [{ type: "text", text: "No tour is running; call review_tour action=start first." }], details: {} };
      const remote = await nvimRequest<RemoteTour>({ method: "tour.status" }).catch(() => undefined);
      const base = remote && remote.index > 0 ? remote.index - 1 : current.index;
      const target = base + (params.action === "next" ? 1 : -1);
      if (target < 0 || target >= current.stops.length) {
        const message = target < 0 ? "Already at the first stop." : "Tour finished. Ask the user with the question tool about the architecture and direction.";
        return { content: [{ type: "text", text: message }], details: { ...current } };
      }
      const shown = await nvimRequest<NvimResult>({ method: params.action === "next" ? "tour.next" : "tour.prev" });
      current.index = target;
      await annotate(target + 1, params.note);
      return { content: [{ type: "text", text: await shownContent(context, current, shown, current.stops[target]) }], details: { ...current, shown, stop: current.stops[target] } };
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "start";
      const scope = args.base ? ` · ${args.base}` : "";
      const paths = Array.isArray(args.paths) && args.paths.length ? theme.fg("dim", ` · ${args.paths.length} path${args.paths.length === 1 ? "" : "s"}`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("review_tour "))}${theme.fg("muted", action + scope)}${paths}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      if (result.isError) {
        const part = result.content[0];
        return new Text(theme.fg("error", part?.type === "text" ? part.text : ""), 0, 0);
      }
      return renderTour(result, theme);
    },
  });

  pi.registerTool({
    name: "propose_change",
    label: "Propose change",
    executionMode: "sequential",
    description: "Show a native Neovim diff of a proposed file change and let the user accept (:w) or reject (:q) before anything is written. Use for risky or large edits where review helps; it blocks until the user decides.",
    promptSnippet: "Ask the user to accept or reject a file change in Neovim",
    promptGuidelines: [
      "Use propose_change for risky or large edits when Neovim is available; it shows the diff first and writes only after the user accepts.",
      "Do not use it for every trivial change; prefer edit/write for mechanical edits the user already approved.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File inside the project" }),
      content: Type.String({ description: "Complete proposed file contents" }),
      reason: Type.Optional(Type.String({ description: "One line shown in the diff title" })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, context) {
      const file = resolve(context.cwd, params.file);
      if (file !== context.cwd && !file.startsWith(`${context.cwd}/`)) {
        return { content: [{ type: "text" as const, text: "Error: file must be inside the project" }], details: {}, isError: true };
      }
      if (!hasNvim(context.cwd)) return { content: [{ type: "text" as const, text: "Error: Neovim is not connected" }], details: {}, isError: true };
      try {
        const state = await nvimRequest<{ dirty?: boolean }>({ method: "document.dirty", file, root: context.cwd });
        if (state?.dirty) {
          return { content: [{ type: "text" as const, text: `Error: Neovim has unsaved changes in ${relative(context.cwd, file)}; save them first.` }], details: state, isError: true };
        }
      } catch { /* dirty check is best-effort; the diff still guards the write */ }
      const outcome = await openDiff({ cwd: context.cwd, file, content: params.content, reason: params.reason, signal });
      if (outcome.status !== "accepted") {
        return { content: [{ type: "text" as const, text: `Change ${outcome.status}; the file was not written.` }], details: outcome };
      }
      const content = outcome.content ?? params.content;
      await withFileMutationQueue(file, async () => { await writeFile(file, content, "utf8"); });
      return { content: [{ type: "text" as const, text: `Applied ${relative(context.cwd, file)} after the user accepted the diff (${content.split("\n").length} lines).` }], details: { ...outcome, file } };
    },
  });

  pi.registerTool({
    name: "show",
    label: "Show in Neovim",
    description: "Open and highlight an existing project file in the user's connected Neovim. Use when explaining code or asked to show where something happens. Returns the actual displayed buffer text, including unsaved edits. Does not write files. Lines are 1-based inclusive, at most 200 lines and 32 KiB.",
    promptSnippet: "Show a code range in the user's Neovim before explaining it",
    promptGuidelines: [
      "When asked to show or explain code visually, call show before explaining that specific range. Do not claim code is displayed if show failed. Prefer one focused range at a time; do not race multiple show calls. Use selection for questions about highlighted code.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Existing file inside the current project; relative paths resolve against the Pi working directory" }),
      from_line: Type.Integer({ minimum: 1 }),
      to_line: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      if (!hasNvim(context.cwd)) return { content: [{ type: "text" as const, text: "Error: Neovim is not connected. Load nvim/pi-ide.lua in your init.lua, or set PI_NVIM_SOCKET." }], details: {}, isError: true };
      const result = await nvimRequest<NvimResult>({
        method: "show", file: resolve(context.cwd, params.file), from_line: params.from_line, to_line: params.to_line, root: context.cwd,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "selection",
    label: "Neovim selection",
    description: "Read the user's current or last visual selection from connected Neovim, including unsaved text. Returns file, cursor and selection byte coordinates (1-based), mode, changedtick and truncation. Last selection is preserved across focus changes; stale selections fail. Files must be inside the current Pi project. No file writes.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _update, context) {
      if (!hasNvim(context.cwd)) return { content: [{ type: "text" as const, text: "Error: Neovim is not connected. Load nvim/pi-ide.lua in your init.lua, or set PI_NVIM_SOCKET." }], details: {}, isError: true };
      const result = await nvimRequest<Record<string, unknown>>({ method: "selection.latest", root: context.cwd });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "comment_reply",
    label: "Reply to comment",
    executionMode: "sequential",
    description: "Reply to a comment thread in the user's Neovim and optionally resolve it. Use after handling a comment that arrived from Neovim so the answer appears in the editor thread.",
    promptSnippet: "Reply to a Neovim comment thread",
    promptGuidelines: [
      "When a comment arrives from Neovim, fix the code if needed, then call comment_reply with its id; set resolve=true when the issue is handled.",
      "Keep the reply short and specific; the user sees it next to the commented code.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Comment id from the Neovim message" }),
      text: Type.String({ description: "Reply text shown under the comment" }),
      resolve: Type.Optional(Type.Boolean({ description: "Mark the thread resolved" })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      if (!hasNvim(context.cwd)) return { content: [{ type: "text" as const, text: "Error: Neovim is not connected" }], details: {}, isError: true };
      const result = await nvimRequest<{ id: string; status: string }>({
        method: "comment.reply", id: params.id, text: params.text, author: "pi", resolve: params.resolve === true, root: context.cwd,
      });
      return { content: [{ type: "text" as const, text: `Replied to comment #${result.id} (${result.status}).` }], details: result };
    },
  });

  pi.registerTool({
    name: "nvim_context",
    label: "Neovim context",
    parameters: Type.Object({}, { additionalProperties: false }),
    description: "Read the connected Neovim workspace: cwd, open editors with modified flags, and the latest selection (with a stale flag when the buffer changed since it was made).",
    async execute(_id, _params, _signal, _update, context) {
      if (!hasNvim(context.cwd)) return { content: [{ type: "text" as const, text: "Error: Neovim is not connected" }], details: {}, isError: true };
      const data = await nvimRequest<any>({ method: "context", root: context.cwd });
      const editors = (data?.editors ?? []) as { file: string; current?: boolean; modified?: boolean }[];
      const current = editors.find((entry) => entry.current);
      const selection = data?.selection;
      const lines = [
        `Workspace: ${data?.workspace ?? context.cwd}`,
        `Open editors: ${editors.length}${current ? ` · current ${relative(context.cwd, current.file)}${current.modified ? " (modified)" : ""}` : ""}`,
        ...editors.filter((entry) => entry.modified && !entry.current).slice(0, 10).map((entry) => `  modified: ${relative(context.cwd, entry.file)}`),
        selection?.available === false || !selection
          ? "Selection: none"
          : `Selection: ${relative(context.cwd, selection.file)}:${selection.start?.line}-${selection.finish?.line}${selection.stale ? " (stale: buffer changed)" : ""}`,
        ...(selection?.text ? [selection.text.split("\n").slice(0, 20).join("\n")] : []),
        ...(() => {
          const comments = (data?.comments ?? []) as { id: string; file: string; from: number; status?: string; text: string }[];
          const open = comments.filter((entry) => entry.status !== "resolved");
          return [
            `Comments: ${open.length} open / ${comments.length} total`,
            ...open.slice(0, 5).map((entry) => `  #${entry.id} ${relative(context.cwd, entry.file)}:${entry.from} [${entry.status ?? "open"}] ${entry.text.slice(0, 80)}`),
          ];
        })(),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: data };
    },
  });

  pi.on("tool_call", async (event, context) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string" || !hasNvim(context.cwd)) return;
    const file = resolve(context.cwd, input.path);
    try {
      const state = await nvimRequest<{ dirty?: boolean }>({ method: "document.dirty", file, root: context.cwd });
      if (state?.dirty) return { block: true, reason: `Neovim has unsaved changes in ${relative(context.cwd, file)}; save it first or use propose_change.` };
    } catch { /* no nvim or request failed: do not block the edit */ }
  });

  pi.registerCommand("tour", {
    description: "Review changed code in Neovim: /tour start [--base <ref>] [paths] | overview | next | prev | status | stop",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["start", "overview", "next", "prev", "status", "stop", "live"], { live: ["on", "off"] },
      { start: "walk stops one by one (--base <ref> for committed work)", overview: "one snapshot of all changes", next: "next stop", prev: "previous stop", status: "progress", stop: "end the tour", live: "jump to edits automatically" }),
    handler: async (args, context) => {
      ctx = context;
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      // `--base <ref>` picks what to compare against; the rest are paths.
      let base: string | undefined;
      const paths: string[] = [];
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === "--base" || token === "-b") { base = rest[++index]; continue; }
        if (token.startsWith("--base=")) { base = token.slice("--base=".length); continue; }
        paths.push(token);
      }
      if (action === "live") {
        const value = paths[0];
        if (value === "on" || value === "off") { liveFollow = value === "on"; context.ui.notify(`Live follow ${value === "on" ? "enabled" : "disabled"}.`, "info"); return; }
        context.ui.notify(`Live follow: ${liveFollow ? "on" : "off"}. Use /tour live on|off.`, "info");
        return;
      }
      if (action === "overview") {
        const opened = await ensureNvim(context.cwd);
        const plan = await planTour(context.cwd, { paths, base });
        if (!plan.stops.length) { context.ui.notify(noChanges(plan.base, paths), "info"); return; }
        const stat = await git(context.cwd, ["diff", "--stat", plan.base]).catch(() => "");
        await nvimRequest({ method: "snapshot", lines: overviewLines(plan, stat), filetype: "markdown" });
        context.ui.notify(`${opened.opened ? "Opened Neovim. " : ""}Snapshot: ${plan.stops.length} stops in ${new Set(plan.stops.map((stop) => stop.file)).size} files.`, "info");
        return;
      }
      if (action === "start") {
        const opened = await ensureNvim(context.cwd);
        const plan = await planTour(context.cwd, { paths, base });
        if (!plan.stops.length) { context.ui.notify(noChanges(plan.base, paths), "info"); return; }
        const current: TourState = { stops: plan.stops, index: 0, base: plan.base, truncated: plan.truncated, sessionId: context.sessionManager.getSessionId() };
        await install(context, plan.stops);
        const shown = await nvimRequest<NvimResult>({ method: "tour.next" });
        sessions.set(current.sessionId, current);
        const where = relative(context.cwd, shown.file);
        const data = { index: 1, total: current.stops.length, base: plan.base, file: where, from: shown.from_line, to: shown.to_line };
        recordTour(context, data);
        pi.sendMessage({
          customType: "pi-tour-hint",
          display: false,
          content: `A Neovim tour is running: stop 1/${data.total} at ${where}:${data.from}-${data.to} (base ${plan.base}). When the user asks about the changes, explain stops one by one; use review_tour action=next to advance and the question tool once about the architecture.`,
        }, { triggerTurn: false, deliverAs: "nextTurn" });
        context.ui.notify(`${opened.opened ? "Opened Neovim. " : ""}Tour 1/${current.stops.length} · ${where}:${shown.from_line}-${shown.to_line}`, "info");
        return;
      }
      const current = state();
      if (!current) { context.ui.notify(action === "stop" ? "No tour is running." : "No tour is running; /tour start first.", "info"); return; }
      if (action === "stop") {
        sessions.delete(current.sessionId);
        await nvimRequest({ method: "tour.clear" }).catch(() => {});
        context.ui.setStatus("tour", undefined);
        context.ui.notify("Tour stopped.", "info");
        return;
      }
      if (action === "status") {
        const remote = await nvimRequest<RemoteTour>({ method: "tour.status" }).catch(() => undefined);
        context.ui.notify(remote?.total ? `Tour ${remote.index || 0}/${remote.total}${remote.file ? ` · ${relative(context.cwd, remote.file)}` : ""}` : "Tour has no stops.", "info");
        return;
      }
      if (action !== "next" && action !== "prev") { context.ui.notify("Usage: /tour start|overview|next|prev|status|stop", "info"); return; }
      const remote = await nvimRequest<RemoteTour>({ method: "tour.status" }).catch(() => undefined);
      const anchor = remote && remote.index > 0 ? remote.index - 1 : current.index;
      const target = anchor + (action === "next" ? 1 : -1);
      if (target < 0 || target >= current.stops.length) { context.ui.notify("Tour finished.", "info"); return; }
      const shown = await nvimRequest<NvimResult>({ method: action === "next" ? "tour.next" : "tour.prev" });
      current.index = target;
      const where = relative(context.cwd, shown.file);
      recordTour(context, { index: target + 1, total: current.stops.length, base: current.base, file: where, from: shown.from_line, to: shown.to_line });
      context.ui.notify(`Tour ${target + 1}/${current.stops.length} · ${where}:${shown.from_line}-${shown.to_line}`, "info");
    },
  });

  pi.registerCommand("nvim", {
    description: "Neovim bridge: /nvim status | save [file]",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["status", "save"], {}, { status: "workspace, editors, selection", save: "write a dirty buffer" }),
    handler: async (args, context) => {
      if (!hasNvim(context.cwd)) { context.ui.notify("Neovim is not connected.", "warning"); return; }
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "save") {
        let file = rest[0] ? resolve(context.cwd, rest[0]) : undefined;
        if (!file) {
          const data = await nvimRequest<any>({ method: "context", root: context.cwd });
          const current: unknown = (data?.editors ?? []).find((entry: any) => entry.current);
          const currentFile = (current as { file?: unknown } | undefined)?.file;
          if (typeof currentFile !== "string") { context.ui.notify("Neovim has no current file.", "warning"); return; }
          file = currentFile;
        }
        const result = await nvimRequest<{ saved?: boolean; dirty?: boolean }>({ method: "document.save", file, root: context.cwd });
        context.ui.notify(result.saved ? `Saved ${relative(context.cwd, file)}` : result.dirty ? "Still dirty after save" : "No unsaved changes", "info");
        return;
      }
      const data = await nvimRequest<any>({ method: "context", root: context.cwd });
      const editors = (data?.editors ?? []) as { file: string; current?: boolean; modified?: boolean }[];
      context.ui.notify(`Workspace: ${data?.workspace}\nEditors: ${editors.length} · modified: ${editors.filter((entry) => entry.modified).length}\n${editors.slice(0, 10).map((entry) => `${entry.current ? "* " : "  "}${relative(context.cwd, entry.file)}`).join("\n")}`, "info");
    },
  });
}
