/**
 * Review mode: a slider over the change set inside Pi.
 *
 * The agent used to finish a tour with questions of its own; the user wants to
 * drive instead. `/review` puts the stops in a panel above the editor, `]t`/`[t`
 * move between them, a stop can be discussed in its own thread, and nothing
 * reaches the main conversation until `/review submit` writes one digest.
 *
 * Threads are side requests on top of the cached main prefix, so discussing ten
 * stops does not rewrite the conversation or throw away the cache.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArgs } from "../lib/complete.js";
import { resolveDiffBase } from "../lib/git-base.js";
import { askSide, installMainRequestRecorder, sideQuestion } from "../lib/main-request.js";
import { lastTour, type SharedStop } from "../lib/tour-state.js";
import {
  acceptedWithoutDiscussion, appendTurn, createSession, currentStop, fallbackSummary, move, thread,
  threadTranscript, type ReviewSession, type ReviewStop,
} from "./session.js";
import { ReviewPanel } from "./view.js";

export interface ReviewCost { side: number }

let session: ReviewSession | undefined;
let cost: ReviewCost = { side: 0 };
let panel: ReviewPanel | undefined;
let ctxRef: ExtensionContext | undefined;

/** The stops a fresh review is built from: the walkthrough first, nothing else. */
function stopsFromWalkthrough(): { stops: ReviewStop[]; base: string } | undefined {
  const tour = lastTour();
  if (!tour?.stops.length) return;
  return { stops: tour.stops.map((stop: SharedStop) => ({ ...stop })), base: tour.base };
}

export function reviewState(): ReviewSession | undefined {
  return session;
}

export default function review(pi: ExtensionAPI): void {
  installMainRequestRecorder(pi);

  const status = () => {
    const label = session ? `review ${session.index + 1}/${session.stops.length}` : undefined;
    ctxRef?.ui.setStatus("review", label);
  };

  function renderPanel(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (!session) {
      panel = undefined;
      ctx.ui.setWidget("review", undefined);
      return;
    }
    const stop = currentStop(session);
    const turns = thread(session);
    ctx.ui.setWidget("review", (tui, theme) => {
      panel = new ReviewPanel(tui, theme, {
        position: `${session!.index + 1}/${session!.stops.length}`,
        base: session!.base,
        title: stop?.title ?? "",
        where: stop ? `${stop.file}:${stop.from}-${stop.to}` : "",
        why: stop?.why ?? "",
        replies: turns.length,
        side: cost.side,
      });
      return panel;
    }, { placement: "aboveEditor" });
    status();
  }

  function widget(ctx: ExtensionContext) {
    panel?.update({
      position: session ? `${session.index + 1}/${session.stops.length}` : "",
      base: session?.base ?? "",
      title: currentStop(session!)?.title ?? "",
      where: (() => { const stop = currentStop(session!); return stop ? `${stop.file}:${stop.from}-${stop.to}` : ""; })(),
      why: currentStop(session!)?.why ?? "",
      replies: session ? thread(session).length : 0,
      side: cost.side,
    });
    status();
    void ctx;
  }

  async function ask(ctx: ExtensionContext, question: string): Promise<void> {
    if (!session) { ctx.ui.notify("No review is running; /review start first.", "info"); return; }
    const text = question.trim();
    if (!text) { ctx.ui.notify("Usage: /review ask <question>", "info"); return; }
    const index = session.index;
    const stop = session.stops[index];
    appendTurn(session, { role: "user", text });
    widget(ctx);
    ctx.ui.setStatus("review", `review ${index + 1}/${session.stops.length} · thinking…`);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 120_000);
    deadline.unref();
    try {
      const earlier = thread(session, index).slice(0, -1)
        .map((turn) => `${turn.role === "user" ? "Q" : "A"}: ${turn.text.trim()}`)
        .join("\n");
      const tail = [
        ...(earlier ? [{ role: "user" as const, content: `Earlier in this review thread:\n${earlier}`, timestamp: Date.now() }] : []),
        { role: "user" as const, content: [stopPrompt(stop), sideQuestion(text)].join("\n\n"), timestamp: Date.now() },
      ];
      const answer = await askSide(ctx, { sessionId: ctx.sessionManager.getSessionId(), tail, signal: controller.signal });
      cost = { side: cost.side + answer.cost };
      appendTurn(session, { role: "assistant", text: answer.text.trim() || "(no answer)" });
      widget(ctx);
      // The thread lives in the panel; the transcript stays untouched until submit.
      ctx.ui.notify(`Stop ${index + 1}/${session.stops.length}: ${shorten(answer.text)}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTurn(session, { role: "assistant", text: `(failed: ${message})` });
      ctx.ui.notify(`Review question failed: ${message}`, "error");
      widget(ctx);
    } finally {
      clearTimeout(deadline);
      status();
    }
  }

  async function submit(ctx: ExtensionContext): Promise<void> {
    if (!session) { ctx.ui.notify("No review to submit.", "info"); return; }
    const current = session;
    const unopened = acceptedWithoutDiscussion(current);
    let digest = "";
    ctx.ui.setStatus("review", "review · writing the digest…");
    try {
      const answer = await askSide(ctx, {
        sessionId: ctx.sessionManager.getSessionId(),
        tail: [{
          role: "user",
          content: [
            "Write the digest of this change review for the main conversation. Keep it under 200 words:",
            "- decisions and the direction that was accepted,",
            "- anything the user asked to change or to keep in mind,",
            "- open questions, if any.",
            "No code blocks and no restating the diff.",
            "",
            threadTranscript(current),
            unopened.length ? `\nStops nobody discussed (accepted as is): ${unopened.map((stop) => stop.title).join("; ")}` : "",
          ].join("\n"),
          timestamp: Date.now(),
        }],
      });
      cost = { side: cost.side + answer.cost };
      digest = answer.text.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      digest = `${fallbackSummary(current)}\n\n(the digest could not be written: ${message})`;
    }
    const header = `Review submitted: ${current.stops.length} stop${current.stops.length === 1 ? "" : "s"} against ${current.base}.`;
    // One custom message is the whole footprint in the main conversation: it is
    // in the context from now on, and the threads themselves are not.
    pi.sendMessage({ customType: "pi-core:review", display: true, content: `${header}\n\n${digest || fallbackSummary(current)}` });
    session = undefined;
    cost = { side: 0 };
    panel = undefined;
    ctx.ui.setWidget("review", undefined);
    ctx.ui.setStatus("review", undefined);
    ctx.ui.notify("Review submitted into the conversation.", "info");
  }

  pi.events.on("pi-core:tour-ready", (payload: unknown) => {
    const data = payload as { base?: string; stops?: ReviewStop[] } | undefined;
    if (!ctxRef || !data?.stops?.length) return;
    session = createSession(data.stops.map((stop) => ({ ...stop })), data.base ?? "HEAD");
    cost = { side: 0 };
    if (!session) return;
    renderPanel(ctxRef);
    ctxRef.ui.notify(`Review ready: ${session.stops.length} stop${session.stops.length === 1 ? "" : "s"} · ]t/[t move · /review ask <question> · /review submit`, "info");
  });

  pi.on("session_start", (_event, ctx) => { ctxRef = ctx; });
  pi.on("session_shutdown", (_event, ctx) => {
    session = undefined;
    panel = undefined;
    cost = { side: 0 };
    ctx.ui.setWidget("review", undefined);
    ctx.ui.setStatus("review", undefined);
    ctxRef = undefined;
  });

  // `]t` / `[t` exactly like Neovim. The bracket is only claimed when a review is
  // running and `t` follows immediately; otherwise the keystroke is handed back
  // untouched, so ordinary typing is never swallowed.
  let bracket: { key: "]" | "["; at: number } | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.onTerminalInput((data) => {
      if (!session) return;
      if (bracket) {
        const recent = Date.now() - bracket.at < 500;
        const key = bracket.key;
        bracket = undefined;
        if (recent && data === "t") {
          if (move(session, key === "]" ? 1 : -1)) widget(ctx);
          else ctx.ui.notify(key === "]" ? "Last stop." : "First stop.", "info");
          // Drop the bracket that already reached the editor, and eat the `t`.
          return { data: key === "]" || key === "[" ? "\x7f" : data };
        }
        return;
      }
      if (data === "]" || data === "[") {
        bracket = { key: data, at: Date.now() };
        // 600 ms give-up: if `t` never comes, the bracket stays in the editor.
        const pending = data;
        setTimeout(() => { if (bracket?.key === pending) bracket = undefined; }, 600).unref();
      }
    });
  });

  pi.registerCommand("review", {
    description: "Review the change set in Pi: /review start [--base <ref>] | next | prev | ask <question> | thread | submit | stop | status",
    getArgumentCompletions: (prefix) => completeArgs(prefix,
      ["start", "next", "prev", "ask", "thread", "submit", "stop", "status"],
      { start: ["--base", "--fresh"] },
      { start: "open the slider over the stop list", next: "]t — next stop", prev: "[t — previous stop",
        ask: "discuss the current stop in its own thread", thread: "show the thread of the current stop",
        submit: "write one digest into the main conversation", stop: "drop the review without submitting",
        status: "where the slider is" }),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      if (ctx.mode !== "tui") { ctx.ui.notify("Review needs the interactive terminal.", "warning"); return; }
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const text = rest.join(" ");

      if (action === "start") {
        let base: string | undefined;
        const tokens: string[] = [];
        for (let index = 0; index < rest.length; index++) {
          const token = rest[index];
          if (token === "--base" || token === "-b") { base = rest[++index]; continue; }
          if (token.startsWith("--base=")) { base = token.slice("--base=".length); continue; }
          tokens.push(token);
        }
        const reusable = stopsFromWalkthrough();
        const resolved = base ?? reusable?.base ?? await resolveDiffBase((argv) => runGit(ctx.cwd, argv));
        const stops = reusable && (!base || base === reusable.base)
          ? reusable.stops
          : [];
        if (!stops.length) {
          ctx.ui.notify("No walkthrough to review yet: run /story first, then /review start.", "info");
          return;
        }
        session = createSession(stops, resolved);
        cost = { side: 0 };
        if (!session) { ctx.ui.notify("No stops to review.", "info"); return; }
        renderPanel(ctx);
        ctx.ui.notify(`Review: ${session.stops.length} stop${session.stops.length === 1 ? "" : "s"} against ${resolved} · ]t/[t move · /review ask <question> · /review submit`, "info");
        return;
      }

      if (action === "stop") {
        session = undefined;
        cost = { side: 0 };
        panel = undefined;
        ctx.ui.setWidget("review", undefined);
        ctx.ui.setStatus("review", undefined);
        ctx.ui.notify("Review closed without submitting.", "info");
        return;
      }

      if (!session) { ctx.ui.notify(action === "status" ? "No review is running." : "No review is running; /review start first.", "info"); return; }

      if (action === "next" || action === "prev") {
        if (move(session, action === "next" ? 1 : -1)) { widget(ctx); return; }
        ctx.ui.notify(action === "next" ? "Last stop." : "First stop.", "info");
        return;
      }
      if (action === "ask") { await ask(ctx, text); return; }
      if (action === "thread") {
        const turns = thread(session);
        if (!turns.length) { ctx.ui.notify("No discussion for this stop yet; /review ask <question>.", "info"); return; }
        ctx.ui.notify(turns.map((turn) => `${turn.role === "user" ? "Q" : "A"}: ${turn.text}`).join("\n\n"), "info");
        return;
      }
      if (action === "submit") { await submit(ctx); return; }
      if (action === "status") {
        const stop = currentStop(session)!;
        ctx.ui.notify(`Review ${session.index + 1}/${session.stops.length} · ${stop.file}:${stop.from}-${stop.to} · ${thread(session).length} thread turn(s) · side cost $${cost.side.toFixed(4)}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /review start|next|prev|ask <question>|thread|submit|stop|status", "info");
    },
  });
}

function stopPrompt(stop: ReviewStop): string {
  const lines = [
    `We are reviewing one stop of a change set: ${stop.title}`,
    `File: ${stop.file}, new-file lines ${stop.from}-${stop.to}`,
    `Why it exists: ${stop.why || "(not written)"}`,
    stop.note ? `Note: ${stop.note}` : "",
    `Changed lines (added: ${stop.added.length}, removed: ${stop.deleted.reduce((sum, block) => sum + block.lines.length, 0)})`,
  ].filter(Boolean);
  return lines.join("\n");
}

function shorten(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}
