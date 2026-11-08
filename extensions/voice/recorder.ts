import { spawn, type ChildProcess } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { access, chmod, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type VoiceBackend = "local" | "nari";
export interface VoiceConfig {
  backend: VoiceBackend;
  model: string;
  language: string;
  whisperBin: string;
  recorderBin: string;
  vocabulary: string;
  apiUrl: string;
  apiModel: string;
  apiKeyEnv: string;
}
export const DEFAULT_VOICE: VoiceConfig = {
  backend: "local",
  model: "", language: "auto", whisperBin: "whisper-cli", recorderBin: "pw-record",
  vocabulary: "Kubernetes, KubeVirt, Deckhouse, Go, TypeScript, Neovim, pi-core, git, reconciliation, controller",
  apiUrl: "wss://api.narilabs.com/v1/realtime?intent=transcription",
  apiModel: "qwen3-asr-fast",
  apiKeyEnv: "NARI_API_KEY",
};
const MAX_PCM = 16000 * 2 * 300;
export function wavHeader(bytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(bytes + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes, 40);
  return header;
}
export function audioLevel(pcm: Buffer): number {
  let sum = 0, count = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2 * Math.max(1, Math.floor(pcm.length / 2048))) {
    const n = pcm.readInt16LE(i) / 32768; sum += n * n; count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}
function signal(child: ChildProcess, value: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid!, value); } catch { /* Already gone. */ }
}

async function executable(command: string): Promise<void> {
  const paths = command.includes("/") ? [command] : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, command));
  for (const path of paths) { try { await access(path, constants.X_OK); return; } catch {} }
  throw new Error(`Local voice executable not found: ${command}. Install it explicitly; pi-core does not download binaries.`);
}

export class LocalDictation {
  private child?: ChildProcess;
  private closed?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private fd?: number;
  private bytes = 0;
  private voiced = false;
  private directory?: string;
  private maxTimer?: NodeJS.Timeout;
  private failure?: Error;
  private stopped = false;
  private transcriber?: ChildProcess;
  private transcriberClosed?: Promise<void>;
  private cancelled = false;
  private muted = false;
  constructor(private config: VoiceConfig, private level: (value: number) => void, private expired: () => void) {}

  async start(): Promise<void> {
    if (!this.config.model) throw new Error("Set a local multilingual Whisper model first: /voice model /path/to/ggml-model.bin");
    await executable(this.config.whisperBin);
    await executable(this.config.recorderBin);
    const model = await stat(this.config.model);
    if (!model.isFile()) throw new Error("Voice model must be a local regular file");
    if (this.cancelled) throw new Error("Dictation cancelled");
    this.directory = await mkdtemp(join(tmpdir(), "pi-core-voice-"));
    await chmod(this.directory, 0o700);
    if (this.cancelled) { await this.cleanup(); throw new Error("Dictation cancelled"); }
    const path = join(this.directory, "audio.wav");
    this.fd = openSync(path, "wx", 0o600); writeSync(this.fd, wavHeader(0));
    const child = spawn(this.config.recorderBin, ["--rate=16000", "--channels=1", "--format=s16", "--raw", "-"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.closed = new Promise((resolve) => {
      child.on("error", (error) => { this.failure = error; });
      child.on("close", (code, sig) => resolve({ code, signal: sig }));
    });
    child.stderr?.resume(); // Never send microphone/recorder output to the model.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.fd === undefined || this.cancelled) return;
      if (this.muted) { this.level(0); return; }
      const part = chunk.subarray(0, Math.max(0, MAX_PCM - this.bytes));
      try {
        let offset = 0;
        while (offset < part.length) offset += writeSync(this.fd, part, offset, part.length - offset);
        this.bytes += part.length;
      } catch (error) { this.failure = error as Error; signal(child, "SIGINT"); }
      const value = audioLevel(part); this.voiced ||= value > 0.005; this.level(value);
      if (this.bytes >= MAX_PCM && !this.stopped) { this.stopped = true; signal(child, "SIGINT"); this.expired(); }
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    this.maxTimer = setTimeout(() => { if (!this.stopped) { this.stopped = true; signal(child, "SIGINT"); this.expired(); } }, 300_000);
    this.maxTimer.unref();
    void this.closed.then(() => { if (!this.stopped && !this.cancelled) { this.failure ??= new Error("Microphone recorder stopped unexpectedly"); this.stopped = true; this.expired(); } });
  }

  private async stopRecorder(): Promise<void> {
    this.stopped = true; clearTimeout(this.maxTimer);
    if (this.child && this.closed) {
      signal(this.child, "SIGINT");
      const term = setTimeout(() => signal(this.child!, "SIGTERM"), 700);
      const kill = setTimeout(() => signal(this.child!, "SIGKILL"), 1400);
      try { await this.closed; } finally { clearTimeout(term); clearTimeout(kill); }
    }
    if (this.fd !== undefined) {
      const fd = this.fd; this.fd = undefined;
      const size = Math.min(this.bytes, Math.max(0, fstatSync(fd).size - 44));
      writeSync(fd, wavHeader(size), 0, 44, 0); closeSync(fd);
    }
  }
  async transcribe(): Promise<string> {
    await this.stopRecorder();
    if (this.cancelled) throw new Error("Dictation cancelled");
    if (this.failure) throw this.failure;
    if (!this.voiced || this.bytes < 9600) throw new Error("Recording is too short or silent; nothing inserted");
    const prefix = join(this.directory!, "transcript");
    const child = spawn(this.config.whisperBin, ["-m", this.config.model, "-f", join(this.directory!, "audio.wav"),
      "-l", this.config.language, "-nt", "-np", "-otxt", "-of", prefix, "--prompt", this.config.vocabulary.slice(0, 1000)], {
      detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    this.transcriber = child;
    this.transcriberClosed = new Promise((resolve) => child.once("close", () => resolve()));
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal(child, "SIGKILL"); reject(new Error("Local transcription exceeded 90 seconds")); }, 90_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Local transcription failed (${code ?? "signal"})`)); });
      if (this.cancelled) signal(child, "SIGKILL");
    });
    if (this.cancelled) throw new Error("Dictation cancelled");
    const file = await open(`${prefix}.txt`, "r");
    try {
      if ((await file.stat()).size > 65536) throw new Error("Transcript exceeds 64 KiB");
      const text = (await file.readFile("utf8")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
      if (!text) throw new Error("Empty transcript; nothing inserted");
      return text;
    } finally { await file.close(); }
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.level(0);
  }
  async cancel(): Promise<void> {
    this.cancelled = true;    if (this.transcriber) signal(this.transcriber, "SIGKILL");
    await this.stopRecorder();
    await this.cleanup();
  }
  async cleanup(): Promise<void> {
    await this.transcriberClosed;
    if (this.directory) { const path = this.directory; this.directory = undefined; await rm(path, { recursive: true, force: true }); }
  }
}
