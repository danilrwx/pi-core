/**
 * Side requests that keep the main conversation's cache prefix.
 *
 * Pi has no public handle on the latest request, so it is observed at the
 * provider entry: the wrapper only records, forwarding every call unchanged.
 * A side request then re-sends the same message array plus its own tail, which
 * is what makes a review thread or `/btw` cheap — the prefix stays cached.
 *
 * Lives here rather than in one extension because two features need it (btw and
 * the review slider), and double-decorating the same provider would make one of
 * them blind to the main request.
 */

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type OnPayload = NonNullable<SimpleStreamOptions["onPayload"]>;

export interface MainRequest {
  model: Model<Api>;
  messages: Message[];
  options: SimpleStreamOptions;
  sessionId: string;
}

let latest: MainRequest | undefined;
let latestMessages: unknown;
let activeSession: string | undefined;
let installed = false;
const wrapped = new WeakSet<StreamSimple>();
const sideCallbacks = new WeakSet<OnPayload>();

/** Register the recorder. Idempotent: several extensions may ask for it. */
export function installMainRequestRecorder(pi: ExtensionAPI): void {
  if (installed) return;
  installed = true;

  const reset = (ctx: ExtensionContext) => { latest = undefined; latestMessages = undefined; activeSession = ctx.sessionManager.getSessionId(); };
  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => { reset(ctx); latest = undefined; activeSession = undefined; });

  pi.on("before_agent_start", (_event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const id = model.provider;
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const registration = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native && wrapped.has(native.streamSimple)) return;
    if (registration && registration.api === model.api && registration.streamSimple && wrapped.has(registration.streamSimple)) return;
    const provider = native ?? ctx.modelRegistry.getProvider(id);
    if (!provider) return;
    const decorated: StreamSimple = (requested, context, options) => {
      // Compaction and summaries use other session ids; side requests carry a
      // marked callback; Pi's cache warmer re-sends the same messages array with
      // maxTokens 1, which is not a new main request.
      if (options && activeSession && options.sessionId === activeSession && !(options.onPayload && sideCallbacks.has(options.onPayload))
        && context.messages !== latestMessages) {
        const { signal: _signal, apiKey: _apiKey, headers: _headers, env: _env, onResponse: _onResponse, onProviderStreamEvent: _onStream, ...rest } = options;
        latestMessages = context.messages;
        latest = { model: structuredClone(requested), messages: [...context.messages], options: rest, sessionId: activeSession };
      }
      return provider.streamSimple(requested, context, options);
    };
    wrapped.add(decorated);
    if (native) pi.registerProvider({ ...native, streamSimple: decorated });
    else pi.registerProvider(id, { api: model.api, streamSimple: decorated });
  });
}

/** The last main-session request, when it belongs to this session. */
export function mainRequest(sessionId: string): MainRequest | undefined {
  return latest && latest.sessionId === sessionId ? latest : undefined;
}

export interface SideAnswer {
  text: string;
  cost: number;
  toolCalls: string[];
}

/**
 * Run one side turn on top of the main prefix. `tail` is everything after the
 * cached messages: earlier thread turns and the new question.
 */
export async function askSide(
  ctx: ExtensionContext,
  options: { sessionId: string; tail: Message[]; signal?: AbortSignal },
): Promise<SideAnswer> {
  const main = mainRequest(options.sessionId);
  const model = main?.model ?? ctx.model;
  if (!model) throw new Error("no model selected yet");
  const messages: Message[] = [...(main?.messages ?? []), ...options.tail];
  const baseOptions = main?.options ?? {};
  const hooks = baseOptions.onPayload;
  const onPayload: OnPayload | undefined = hooks ? (payload, selected) => hooks(payload, selected) : undefined;
  if (onPayload) sideCallbacks.add(onPayload);
  const answer = await ctx.modelRegistry.streamSimple(model, { messages }, {
    ...baseOptions,
    ...(onPayload ? { onPayload } : {}),
    signal: options.signal,
    // Codex WebSocket continuation belongs to the main conversation.
    ...(model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
  }).result();
  if (answer.stopReason === "error" || answer.stopReason === "aborted") {
    throw new Error(answer.errorMessage ?? "side request failed");
  }
  return {
    text: answer.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    cost: answer.usage?.cost?.total ?? 0,
    toolCalls: answer.content.filter((part) => part.type === "toolCall").map((part) => part.name),
  };
}

/** The side-question suffix that keeps tool declarations untouched but asks for prose. */
export function sideQuestion(question: string): string {
  return `${question}\n\n(Side question: answer from the conversation so far. Tools are unavailable here, so do not call any.)`;
}
