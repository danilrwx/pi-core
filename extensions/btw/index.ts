/** Copyright 2026 GhabiX. Apache-2.0; see licenses/Apache-2.0-GhabiX.txt.
 * Vendored from pi-btw-cached c7d9867; modified for pi-core: cancellation, deadlines, separate cost status.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeFirstWords } from "../lib/complete.js";
import { askSide, installMainRequestRecorder, mainRequest, sideQuestion } from "../lib/main-request.js";

const NO_REQUEST = "no main request yet; send a prompt in the main session first.";

export default function btw(pi: ExtensionAPI): void {
  installMainRequestRecorder(pi);
  let active: AbortController | undefined;
  let sideCost = 0;
  let epoch = 0;
  let activeSession: string | undefined;

  // Every session change (start, reload, resume, new, fork) emits session_start; tree
  // navigation and compaction keep the session id. Main requests carry that id, including
  // ones Pi sends without a new prompt, such as the continue after compact-and-retry.
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    active?.abort();
    active = undefined;
    if (activeSession !== ctx.sessionManager.getSessionId()) sideCost = 0;
    activeSession = ctx.sessionManager.getSessionId();
    epoch++;
    ctx.ui.setWidget("btw-lite", undefined);
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", (_event, ctx) => {
    reset(_event, ctx);
    ctx.ui.setStatus?.("btw-cost", undefined);
  });

  pi.registerCommand("btw", {
    description: "Ask a side question about the main session (runs no tools, not saved to history)",
    getArgumentCompletions: (argument) => completeFirstWords(argument, ["cancel"],
      { cancel: "stop the running side question" }),
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) return ctx.ui.notify("Usage: /btw <question> | /btw cancel", "info");
      if (ctx.mode !== "tui") return ctx.ui.notify("/btw needs the interactive terminal UI.", "warning");
      if (question === "cancel") {
        active?.abort();
        active = undefined;
        epoch++;
        ctx.ui.setWidget("btw-lite", ["/btw cancelled"]);
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (!mainRequest(sessionId)) return ctx.ui.notify(`/btw: ${NO_REQUEST}`, "warning");
      if (active) return ctx.ui.notify("/btw: the previous side question is still being answered; /btw cancel to stop it.", "info");
      const answerEpoch = epoch;
      const controller = new AbortController();
      active = controller;
      const deadline = setTimeout(() => controller.abort(), 90_000);
      deadline.unref();
      ctx.ui.setWidget("btw-lite", [`/btw ${question}`, "answering…"]);
      try {
        const answer = await askSide(ctx, {
          sessionId,
          tail: [{ role: "user", content: sideQuestion(question), timestamp: Date.now() }],
          signal: controller.signal,
        });
        if (answerEpoch !== epoch) return;
        sideCost += answer.cost;
        ctx.ui.setStatus?.("btw-cost", `btw $${sideCost.toFixed(4)} (separate from session totals)`);
        const shown = answer.text || (answer.toolCalls.length
          ? `(no text answer; the model asked to call ${answer.toolCalls.join(", ")}, which /btw does not run)`
          : "(no text answer)");
        ctx.ui.setWidget("btw-lite", [`/btw ${question}`, ...shown.split("\n")]);
      } catch (error) {
        if (answerEpoch === epoch) ctx.ui.setWidget("btw-lite", [`/btw ${question}`, `failed: ${error instanceof Error ? error.message : String(error)}`]);
      } finally {
        clearTimeout(deadline);
        if (active === controller) active = undefined;
      }
    },
  });
}
