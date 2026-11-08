import { spawn, type ChildProcess } from "node:child_process";

export interface CaptureCallbacks {
  onChunk: (pcm: Buffer) => void;
  onLevel: (level: number) => void;
  onStop: (reason: "limit" | "failure", error?: Error) => void;
}
const SAMPLE_RATE = 16_000;
const MAX_PCM = SAMPLE_RATE * 2 * 300;
const SILENCE_RMS = 0.005;

function signal(child: ChildProcess, value: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid!, value); } catch { /* Already gone. */ }
}
function audioLevel(pcm: Buffer): number {
  let sum = 0, count = 0;
  const stride = 2 * Math.max(1, Math.floor(pcm.length / 2048));
  for (let i = 0; i + 1 < pcm.length; i += stride) { const n = pcm.readInt16LE(i) / 32768; sum += n * n; count++; }
  return count ? Math.sqrt(sum / count) : 0;
}

/** Bounded mono 16 kHz PCM16 capture from an external recorder; never logs audio. */
export class Capture {
  private child?: ChildProcess;
  private closed?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private muted = false;
  private failure?: Error;
  bytes = 0;
  voiced = false;
  constructor(private recorderBin: string, private callbacks: CaptureCallbacks) {}

  async start(): Promise<void> {
    const child = spawn(this.recorderBin, ["--rate=16000", "--channels=1", "--format=s16", "--raw", "-"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.closed = new Promise((resolve) => {
      child.on("error", (error) => { this.failure = error; resolve(); });
      child.on("close", () => resolve());
    });
    child.stderr?.resume(); // Keep recorder diagnostics out of the transcript and model.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.stopped || this.muted) return;
      const part = chunk.subarray(0, Math.max(0, MAX_PCM - this.bytes));
      if (!part.length) return;
      this.bytes += part.length;
      const level = audioLevel(part);
      if (level > SILENCE_RMS) this.voiced = true;
      this.callbacks.onLevel(level);
      this.callbacks.onChunk(part);
      if (this.bytes >= MAX_PCM) this.stop("limit");
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.timer = setTimeout(() => this.stop("limit"), 300_000);
    this.timer.unref();
    void this.closed.then(() => {
      if (!this.stopped && this.child?.exitCode !== null) {
        this.failure ??= new Error("Microphone recorder stopped unexpectedly");
        this.stopped = true;
        this.callbacks.onStop("failure", this.failure);
      }
    });
  }
  private stop(reason: "limit" | "failure", error?: Error) {
    if (this.stopped) return;
    this.stopped = true;
    this.callbacks.onStop(reason, error);
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.child && this.closed) {
      signal(this.child, "SIGINT");
      const term = setTimeout(() => signal(this.child!, "SIGTERM"), 700);
      const kill = setTimeout(() => signal(this.child!, "SIGKILL"), 1400);
      try { await this.closed; } finally { clearTimeout(term); clearTimeout(kill); }
    }
    if (this.failure) throw this.failure;
  }
  get failed(): Error | undefined { return this.failure; }
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.callbacks.onLevel(0);
  }
}
