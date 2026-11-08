import WebSocket from "ws";

export interface NariOptions {
  url: string; apiKey: string; model: string; language: string; prompt: string;
  onPartial?: (text: string) => void; timeoutMs?: number;
}
const END = "pi-core-end";
const MAX_TRANSCRIPT = 64 * 1024;

function validateUrl(value: string): string {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) throw new Error("Nari endpoint must use wss:// (ws:// only for local testing)");
  if (url.username || url.password) throw new Error("Nari endpoint must not contain credentials");
  return url.toString();
}
function providerError(message: unknown): Error {
  const text = String(message ?? "unknown").slice(0, 200);
  if (/UNAUTHORIZED|INVALID_API_KEY/i.test(text)) return new Error(`Nari rejected the key. Check the API key and credits.`);
  if (/INSUFFICIENT_CREDITS/i.test(text)) return new Error("Nari credits are exhausted.");
  if (/RATE_LIMITED/i.test(text)) return new Error("Nari rate limit reached; retry shortly.");
  return new Error(`Nari error: ${text}`);
}

/** Streaming transcription over Nari's realtime WebSocket, matching jcode's protocol. */
export class NariStream {
  private ws?: WebSocket;
  private ready = false;
  private closed = false;
  private failed?: Error;
  private items: { id: string; text: string }[] = [];
  private pending = new Set<string>();
  private completed = new Set<string>();
  private endAck = false;
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private waiters: ((() => boolean))[] = [];
  private onAbort?: () => void;
  private abortSignal?: AbortSignal;
  constructor(private options: NariOptions) {}

  private changed() {
    const keep: (() => boolean)[] = [];
    for (const waiter of this.waiters) if (!waiter()) keep.push(waiter);
    this.waiters = keep;
  }
  private text(): string {
    return this.items.map((item) => item.text.trim()).filter(Boolean).join(" ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, MAX_TRANSCRIPT);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const url = validateUrl(this.options.url);
    this.abortSignal = signal;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.options.apiKey}` } });
    this.ws = ws;
    const born = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Nari connection timed out")), this.options.timeoutMs ?? 15_000);
      const abort = () => { clearTimeout(timer); reject(new Error("Dictation cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.onAbort = abort;
      const done = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      ws.once("open", () => {
        const session: Record<string, unknown> = { model: this.options.model, turn_detection: null, prompt: this.options.prompt.slice(0, 1000) };
        if (this.options.language !== "auto") session.language = this.options.language;
        ws.send(JSON.stringify({ type: "session.configure", session }));
      });
      ws.once("error", (error) => done(error instanceof Error ? error : new Error(String(error))));
      ws.on("message", (data) => {
        let event: any;
        try { event = JSON.parse(data.toString()); } catch { return; }
        if (event.type === "session.configured") { this.ready = true; done(); return; }
        this.handle(event);
        if (!this.ready && this.failed) done(this.failed);
      });
      ws.once("close", () => {
        this.closed = true;
        if (!this.ready) done(new Error("Nari closed the connection before it was ready"));
        this.changed();
      });
    });
    await born();
    signal?.removeEventListener("abort", this.onAbort ?? (() => {}));
    this.onAbort = undefined;
    for (const chunk of this.queued.splice(0)) this.send(chunk);
    this.queuedBytes = 0;
  }

  private handle(event: any) {
    if (event.type === "error") { this.failed = providerError(event.error?.code ?? event.error?.message); this.changed(); return; }
    const id = typeof event.item_id === "string" ? event.item_id : "default";
    if (id.length > 256) { this.failed = new Error("Nari returned an invalid item id"); this.changed(); return; }
    const isTranscript = event.type === "transcript.partial" || event.type === "transcript.completed";
    if (event.type === "input_audio_buffer.committed" || isTranscript) {
      if (!this.items.some((item) => item.id === id)) {
        if (this.items.length >= 1024) { this.failed = new Error("Nari returned too many transcript items"); this.changed(); return; }
        this.items.push({ id, text: "" });
      }
      if (!this.completed.has(id)) this.pending.add(id);
    }
    if (isTranscript) {
      if (typeof event.transcript !== "string" || event.transcript.length > MAX_TRANSCRIPT) {
        this.failed = new Error("Nari returned an invalid transcript"); this.changed(); return;
      }
      if (event.type === "transcript.completed" || !this.completed.has(id)) {
        const item = this.items.find((entry) => entry.id === id)!;
        item.text = event.transcript;
      }
      if (event.type === "transcript.completed") { this.pending.delete(id); this.completed.add(id); }
      this.options.onPartial?.(this.text());
    }
    if ((event.type === "input_audio_buffer.committed" || event.type === "input_audio_buffer.commit_empty") && event.client_event_id === END) {
      this.endAck = true;
    }
    this.changed();
  }

  private send(pcm: Buffer) {
    if (!this.ready || this.closed || this.failed) return;
    this.ws?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  }
  append(pcm: Buffer): void {
    if (this.closed || this.failed) return;
    if (!this.ready) {
      if (this.queuedBytes + pcm.length > 1024 * 1024) { this.failed = new Error("Audio buffered before Nari was ready exceeds the limit"); return; }
      this.queued.push(Buffer.from(pcm)); this.queuedBytes += pcm.length; return;
    }
    this.send(pcm);
  }

  async finish(timeoutMs = 20_000): Promise<string> {
    if (this.failed) throw this.failed;
    if (!this.ready || this.closed) throw new Error("Nari session is not connected");
    this.ws!.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: END }));
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const check = (): boolean => {
        if (this.failed) { clearTimeout(timer); reject(this.failed); return true; }
        if (this.endAck && this.pending.size === 0) { clearTimeout(timer); resolve(); return true; }
        return false;
      };
      timer = setTimeout(() => reject(new Error("Nari did not finish the transcript in time")), timeoutMs);
      if (check()) return;
      this.waiters.push(check);
    });
    const text = this.text();
    if (!text) throw new Error("Nari returned an empty transcript; nothing inserted");
    return text;
  }

  async close(): Promise<void> {
    this.abortSignal?.removeEventListener("abort", this.onAbort ?? (() => {}));
    const ws = this.ws; this.ws = undefined; this.ready = false; this.closed = true;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 1_000);
      ws.once("close", () => { clearTimeout(timer); resolve(); });
      try { ws.close(1000, "done"); } catch { clearTimeout(timer); resolve(); }
    });
  }
}
