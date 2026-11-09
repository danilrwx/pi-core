/**
 * Dictation as a service, so any UI can borrow the microphone the `voice`
 * extension owns.
 *
 * The `voice` extension registers one implementation at load time; a consumer
 * (the question dialog today) asks for it lazily and passes a target. When a
 * target is attached, the transcript goes to that target instead of the main
 * editor draft, and the panel data becomes readable through `snapshot()`.
 *
 * Registry instead of a direct import: a consumer that is loaded on its own
 * (`voice` disabled) must not spawn a recorder by touching a module.
 */

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationSnapshot {
  phase: DictationPhase;
  muted: boolean;
  /** Seconds since recording started. */
  elapsed: number;
  /** Input level of the last chunk, 0..1. */
  level: number;
  /** Live partial transcript while recording. */
  text: string;
}

export interface DictationTarget {
  /** Called when the live partial transcript changes. */
  partial?(text: string): void;
  /** Called once with the final transcript, instead of pasting into the editor. */
  final(text: string): void;
  /** Called when the recording failed to start or transcription failed. */
  error?(message: string): void;
  /** Called whenever the snapshot changed (level, elapsed, phase). */
  state?(): void;
}

export interface DictationService {
  phase(): DictationPhase;
  snapshot(): DictationSnapshot;
  /**
   * Start recording for a target, or attach the target to a recording that is
   * already running (the global shortcut may have started it first).
   * Returns false when dictation is busy in a way the target cannot adopt.
   */
  start(target: DictationTarget): Promise<boolean>;
  /** Stop and transcribe; the transcript goes to the attached target. */
  stop(): Promise<void>;
  /** Drop the recording without transcribing. */
  cancel(): Promise<void>;
  toggleMute(): void;
}

let service: DictationService | undefined;

export function setDictationService(next: DictationService | undefined): void {
  service = next;
}

export function getDictationService(): DictationService | undefined {
  return service;
}
