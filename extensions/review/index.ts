/**
 * Review mode: a slider over the change set inside Pi.
 *
 * The agent used to finish a tour with questions of its own; the user wants to
 * drive instead. `/story` narrates the change set and opens a full-size panel
 * over the conversation, `]t`/`[t` move between stops, typing talks to the
 * current stop, and nothing reaches the main conversation until `/story submit`
 * writes one digest.
 *
 * Threads are side requests on top of the cached main prefix, so discussing ten
 * stops does not rewrite the conversation or throw away the cache.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArgs } from "../lib/complete.js";
import { resolveDiffBase } from "../lib/git-base.js";
import { askSide, installMainRequestRecorder, sideQuestion } from "../lib/main-request.js";
import { setReviewActive } from "../lib/review-state.js";
import { lastTour, type SharedStop } from "../lib/tour-state.js";
import {
  acceptedWithoutDiscussion, appendTurn, createSession, currentStop, fallbackSummary, move, thread,
  threadTranscript, type ReviewSession, type ReviewStop,
} from "./session.js";
import { parseUnifiedDiff, type FileDiff } from "../walkthrough/diff.js";
import { ReviewOverlay } from "./overlay.js";
import { ReviewPanel } from "./view.js";

export interface ReviewCost { side: number }

let session: ReviewSession | undefined;
let cost: ReviewCost = { side: 0 };
let panel: ReviewPanel | undefined;
let overlay: ReviewOverlay | undefined;
let ctxRef: ExtensionContext | undefined;
/** Parsed diff of the whole change set, so the overlay shows real code. */
let diffFiles: FileDiff[] = [];
/** Set by /story: open the big panel once the agent turn that wrote it settles. */
let openWhenSettled = false;

async function loadDiff(ctx: ExtensionContext, base: string): Promise<void> {
  try {
    const text = await runGit(ctx.cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", base]);
    diffFiles = parseUnifiedDiff(text);
  } catch {
    diffFiles = [];
  }
}

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
    if (!session) { ctx.ui.notify("No review is running; /story starts one.", "info"); return; }
    const text = question.trim();
    if (!text) return;
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
      overlay?.update();
      // The thread lives in the panel; the transcript stays untouched until submit.
      ctx.ui.notify(`Stop ${index + 1}/${session.stops.length}: ${shorten(answer.text)}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendTurn(session, { role: "assistant", text: `(failed: ${message})` });
      ctx.ui.notify(`Review question failed: ${message}`, "error");
      widget(ctx);
      overlay?.update();
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
    pi.events.emit("pi-core:review-closed", {});
    session = undefined;
    setReviewActive(false);
    cost = { side: 0 };
    panel = undefined;
    diffFiles = [];
    ctx.ui.setWidget("review", undefined);
    ctx.ui.setStatus("review", undefined);
    ctx.ui.notify("Review submitted into the conversation.", "info");
  }

  pi.events.on("pi-core:tour-ready", (payload: unknown) => {
    const data = payload as { base?: string; stops?: ReviewStop[] } | undefined;
    if (!ctxRef || !data?.stops?.length) return;
    session = createSession(data.stops.map((stop) => ({ ...stop })), data.base ?? "HEAD");
    cost = { side: 0 };
    setReviewActive(Boolean(session));
    if (!session) return;
    renderPanel(ctxRef);
    openWhenSettled = true;
    ctxRef.ui.notify(`Review ready: ${session.stops.length} stop${session.stops.length === 1 ? "" : "s"} · the panel opens when this turn ends`, "info");
  });

  /**
   * With the big panel closed, `]t`/`[t` still mean "flip the slide": they move
   * the slider and reopen the panel, so the readable view follows the keys
   * instead of only the strip above the editor changing.
   */
  let bracket: { key: "]" | "["; at: number } | undefined;
  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    if (ctx.mode !== "tui") return;
    ctx.ui.onTerminalInput((data) => {
      if (!session || overlay) return;
      if (bracket) {
        const recent = Date.now() - bracket.at < 500;
        const key = bracket.key;
        bracket = undefined;
        if (recent && data === "t") {
          if (move(session, key === "]" ? 1 : -1)) {
            widget(ctx);
            queueMicrotask(() => { void openOverlay(ctx); });
          } else {
            ctx.ui.notify(key === "]" ? "Last stop." : "First stop.", "info");
          }
          return { data: "\x7f" };
        }
        return;
      }
      if (data === "]" || data === "[") {
        bracket = { key: data, at: Date.now() };
        const pending = data;
        setTimeout(() => { if (bracket?.key === pending) bracket = undefined; }, 600).unref();
      }
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    session = undefined;
    panel = undefined;
    cost = { side: 0 };
    ctx.ui.setWidget("review", undefined);
    ctx.ui.setStatus("review", undefined);
    ctxRef = undefined;
  });

  /**
   * Typing while a review is open talks to the current stop, not to the main
   * conversation: that is what "start working with it" means, and it needs no
   * command. The answer lands in the panel, so the transcript stays untouched.
   */
  pi.on("input", async (event, ctx) => {
    if (!session || ctx.mode !== "tui") return { action: "continue" as const };
    const text = event.text.trim();
    if (!text) return { action: "continue" as const };
    void ask(ctx, text);
    return { action: "handled" as const };
  });

  async function openOverlay(ctx: ExtensionContext): Promise<void> {
    if (!session || ctx.mode !== "tui") return;
    await loadDiff(ctx, session.base);
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        overlay = new ReviewOverlay(tui, theme, {
          session: session!,
          files: diffFiles,
          sideCost: () => cost.side,
          ask: (question) => { void ask(ctx, question); },
          submit: () => { done(); void submit(ctx); },
          close: () => done(),
        });
        return overlay;
      },
      { overlay: true, overlayOptions: { width: "92%", maxHeight: "88%", minWidth: 60, anchor: "center", margin: 1 } },
    );
    overlay = undefined;
    if (session) renderPanel(ctx);
  }

  // The story turn must finish before a blocking panel opens, otherwise the tool
  // that produced the tour would wait for the user to close the review.
  pi.on("agent_end", async (_event, ctx) => {
    if (!openWhenSettled) return;
    openWhenSettled = false;
    await openOverlay(ctx);
  });

  pi.events.on("pi-core:story-control", (payload: unknown) => {
    const data = payload as { action?: string; text?: string } | undefined;
    if (!ctxRef || !data?.action) return;
    const ctx = ctxRef;
    if (data.action === "open") { void openOverlay(ctx); return; }
    if (data.action === "submit") { void submit(ctx); return; }
    if (data.action === "stop") {
      pi.events.emit("pi-core:review-closed", {});
      session = undefined;
      setReviewActive(false);
      cost = { side: 0 };
      panel = undefined;
      diffFiles = [];
      ctx.ui.setWidget("review", undefined);
      ctx.ui.setStatus("review", undefined);
      ctx.ui.notify("Review closed without submitting.", "info");
      return;
    }
    if (data.action === "status") {
      if (!session) { ctx.ui.notify("No review is running.", "info"); return; }
      const stop = currentStop(session)!;
      ctx.ui.notify(`Review ${session.index + 1}/${session.stops.length} · ${stop.file}:${stop.from}-${stop.to} · ${thread(session).length} thread turn(s) · side cost $${cost.side.toFixed(4)}`, "info");
      return;
    }
    if (data.action === "ask" && data.text) { void ask(ctx, data.text); return; }
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
