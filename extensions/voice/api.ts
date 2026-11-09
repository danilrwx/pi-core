import { Capture } from "./capture.js";
import { NariStream } from "./nari.js";
import type { VoiceConfig } from "./recorder.js";

export interface DictationSession {
  start(): Promise<void>;
  transcribe(): Promise<string>;
  cancel(): Promise<void>;
  cleanup(): Promise<void>;
  setMuted(muted: boolean): void;
}
export const NARI_USD_PER_AUDIO_HOUR = 0.12;

/** Streaming API dictation. Audio is never written to disk; only PCM buffers live in memory. */
export class ApiDictation implements DictationSession {
  private capture?: Capture;
  private stream?: NariStream;
  private cancelled = false;
  private failed?: Error;
  constructor(private config: VoiceConfig, private apiKey: string,
    private level: (value: number) => void, private partial: (text: string) => void, private expired: () => void) {}

  async start(): Promise<void> {
    if (!this.apiKey.trim()) throw new Error(`Set ${this.config.apiKeyEnv} to use API dictation`);
    const stream = new NariStream({
      url: this.config.apiUrl, apiKey: this.apiKey, model: this.config.apiModel,
      language: this.config.language, prompt: this.config.vocabulary, onPartial: (text) => this.partial(text),
    });
    const capture = new Capture(this.config.recorderBin, {
      onChunk: (pcm) => stream.append(pcm),
      onLevel: (level) => this.level(level),
      onStop: (reason, error) => {
        if (reason === "limit") this.expired();
        else { this.failed = error ?? new Error("Microphone recorder stopped unexpectedly"); this.expired(); }
      },
    });
    this.stream = stream; this.capture = capture;
    await capture.start();
    try { await stream.connect(); }
    catch (error) {
      await capture.close().catch(() => {});
      await stream.close();
      throw error;
    }
    if (this.cancelled) throw new Error("Dictation cancelled");
  }

  async transcribe(): Promise<string> {
    if (!this.capture || !this.stream) throw new Error("Dictation was not started");
    try {
      await this.capture.close();
    } catch (error) {
      await this.stream.close().catch(() => {});
      throw error;
    }
    if (this.cancelled) {
      await this.stream.close().catch(() => {});
      throw new Error("Dictation cancelled");
    }
    if (this.failed) {
      await this.stream.close().catch(() => {});
      throw this.failed;
    }
    if (!this.capture.voiced || this.capture.bytes < 9600) {
      await this.stream.close();
      throw new Error("Recording is too short or silent; nothing inserted");
    }
    try { return await this.stream.finish(); }
    finally { await this.stream.close(); }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;    await this.capture?.close().catch(() => {});
    await this.stream?.close();
  }
  async cleanup(): Promise<void> { /* No temporary files for API dictation. */ }
  setMuted(muted: boolean): void { this.capture?.setMuted(muted); }

  get audioSeconds(): number { return (this.capture?.bytes ?? 0) / 32_000; }
  estimatedCostUsd(): number { return this.audioSeconds / 3600 * NARI_USD_PER_AUDIO_HOUR; }
}
