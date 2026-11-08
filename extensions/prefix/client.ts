import type { Message } from "@earendil-works/pi-ai";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface PrefixUsage { input: number; output: number; total: number; cacheHit: number }

/** DeepSeek enables prefix completion only on the beta base URL. */
export function betaEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Prefix completion requires HTTPS for the DeepSeek endpoint");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const base = path.endsWith("/beta") ? path : `${path}/beta`;
  return `${url.origin}${base}/chat/completions`;
}
export function isPrefixCapable(model: { provider: string; baseUrl: string; api: string }): boolean {
  if (model.api !== "openai-completions") return false;
  try { return new URL(model.baseUrl).hostname === "api.deepseek.com" || model.provider === "deepseek"; }
  catch { return false; }
}

/** Text-only serialization for the prefix endpoint; images are deliberately not sent. */
export function toOpenAIMessages(messages: Message[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      const content = typeof message.content === "string" ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (content) out.push({ role: message.role, content });
    } else if (message.role === "assistant") {
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const calls = message.content.filter((part) => part.type === "toolCall").map((part) => ({
        id: part.id, type: "function" as const, function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
      }));
      if (!content && !calls.length) continue;
      out.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (message.role === "toolResult") {
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: content.slice(0, 32_000) });
    }
  }
  return out;
}

export interface PrefixCompletionOptions {
  endpoint: string; apiKey: string; model: string; messages: OpenAIChatMessage[]; prefix: string;
  maxTokens?: number; signal?: AbortSignal; timeoutMs?: number;
  onDelta?: (text: string) => void; fetchImpl?: typeof fetch;
}
export interface PrefixCompletionResult { text: string; usage?: PrefixUsage; finishReason?: string }

export async function streamPrefixCompletion(options: PrefixCompletionOptions): Promise<PrefixCompletionResult> {
  if (!Number.isInteger(options.maxTokens ?? 1024) || (options.maxTokens ?? 1024) < 1 || (options.maxTokens ?? 1024) > 8192) {
    throw new Error("maxTokens must be an integer between 1 and 8192");
  }
  if (!options.prefix.trim()) throw new Error("Prefix must not be empty");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: "POST", signal: controller.signal, redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages: [...options.messages, { role: "assistant", content: options.prefix, prefix: true }],
        max_tokens: options.maxTokens ?? 1024,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DeepSeek prefix request failed (HTTP ${response.status}): ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (!response.body) throw new Error("DeepSeek prefix response has no body");
    let text = "", buffer = "", finishReason: string | undefined, usage: PrefixUsage | undefined;
    const decoder = new TextDecoder();
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let payload: any;
      try { payload = JSON.parse(data); } catch { return; }
      if (payload.error) throw new Error(`DeepSeek prefix error: ${String(payload.error.message ?? "unknown").slice(0, 300)}`);
      const choice = payload.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) { text += delta; options.onDelta?.(delta); }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (payload.usage) usage = {
        input: Number(payload.usage.prompt_tokens ?? 0), output: Number(payload.usage.completion_tokens ?? 0),
        total: Number(payload.usage.total_tokens ?? 0), cacheHit: Number(payload.usage.prompt_cache_hit_tokens ?? 0),
      };
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer.trim());
    if (!text) throw new Error("DeepSeek returned an empty prefix completion");
    return { text, usage, finishReason };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error("Prefix completion timed out or was cancelled");
    if (options.signal?.aborted) throw new Error("Prefix completion cancelled");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
