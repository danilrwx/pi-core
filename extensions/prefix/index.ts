import { buildSessionContext, convertToLlm, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeFirstWords } from "../lib/complete.js";
import { betaEndpoint, isPrefixCapable, streamPrefixCompletion, toOpenAIMessages, type OpenAIChatMessage } from "./client.js";

export function lastAssistantText(messages: OpenAIChatMessage[]): { index: number; text: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) return { index, text: message.content };
  }
  return undefined;
}

export default function prefix(pi: ExtensionAPI) {
  let active: { controller: AbortController; epoch: number } | undefined;
  let last: string | undefined;
  let epoch = 0;

  const cancel = () => { epoch++; active?.controller.abort(); active = undefined; };

  pi.registerCommand("prefix", {
    description: "DeepSeek chat prefix completion: /prefix [начало ответа] | cancel | insert",
    getArgumentCompletions: (argument) => completeFirstWords(argument, ["cancel", "insert"],
      { cancel: "stop the running completion", insert: "paste the last result again" }),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim();
      if (arg === "cancel") { cancel(); ctx.ui.notify("Prefix completion cancelled", "info"); return; }
      if (arg === "insert") {
        if (!last) { ctx.ui.notify("No prefix completion yet", "warning"); return; }
        if (ctx.mode !== "tui") { ctx.ui.notify(last, "info"); return; }
        ctx.ui.pasteToEditor(last); return;
      }
      if (ctx.mode !== "tui") { ctx.ui.notify("/prefix needs the interactive terminal UI", "warning"); return; }
      if (active) { ctx.ui.notify("Prefix completion is already running; /prefix cancel stops it", "info"); return; }
      const model = ctx.model;
      if (!model) { ctx.ui.notify("No active model", "warning"); return; }
      if (!isPrefixCapable(model)) {
        ctx.ui.notify(`Prefix completion needs DeepSeek's OpenAI-compatible endpoint. Active: ${model.provider}/${model.id} (${model.api}).`, "warning");
        return;
      }
      const current = ++epoch;
      const messages = toOpenAIMessages(convertToLlm(buildSessionContext(ctx.sessionManager.getBranch()).messages));
      let prefixText = arg;
      if (!prefixText) {
        const previous = lastAssistantText(messages);
        if (!previous) { ctx.ui.notify("Usage: /prefix <начало ответа>, or run it after an assistant reply to continue it", "info"); return; }
        prefixText = previous.text;
        messages.splice(previous.index, 1);
      }
      let apiKey: string | undefined;
      try { apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
      if (!apiKey) { ctx.ui.notify(`No API key for provider ${model.provider}`, "warning"); return; }
      if (current !== epoch) return;
      const controller = new AbortController();
      active = { controller, epoch: current };
      let shown = "";
      const render = () => ctx.ui.setWidget("prefix", [`/prefix ${model.id}`, ...shown.split("\n").slice(-8)]);
      render();
      try {
        const result = await streamPrefixCompletion({
          endpoint: betaEndpoint(model.baseUrl), apiKey, model: model.id, messages, prefix: prefixText,
          maxTokens: Math.min(1024, model.maxTokens || 1024), signal: controller.signal,
          onDelta: (delta) => {
            if (current !== epoch) return;
            shown += delta;
            render();
          },
        });
        if (current !== epoch) return;
        last = prefixText + result.text;
        ctx.ui.setWidget("prefix", undefined);
        ctx.ui.pasteToEditor(last);
        const cost = result.usage
          ? ((result.usage.input - result.usage.cacheHit) * model.cost.input + result.usage.cacheHit * model.cost.cacheRead + result.usage.output * model.cost.output) / 1_000_000
          : undefined;
        ctx.ui.notify(`Prefix completion inserted into the draft${result.usage ? ` · ${result.usage.total} tokens · ~$${cost!.toFixed(4)}` : ""}. Review, then press Enter.`, "info");
      } catch (error) {
        if (current !== epoch) return;
        ctx.ui.setWidget("prefix", undefined);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        if (active?.epoch === current) active = undefined;
      }
    },
  });
  pi.on("session_shutdown", () => { cancel(); last = undefined; });
}
