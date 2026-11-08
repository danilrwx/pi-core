import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface VoiceUiState {
  backend: "local" | "nari";
  muted: boolean;
  level: number;
  text: string;
  elapsed: number;
}
interface ThemeLike { fg(token: string, text: string): string }

export function formatElapsed(seconds: number): string {
  const value = Math.max(0, Math.min(99 * 60 + 59, Math.floor(seconds)));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
export function voiceLines(state: VoiceUiState, theme: ThemeLike, width = 200): string[] {
  const backend = state.backend === "nari" ? "Nari" : "local";
  const icon = state.muted ? "🔇" : "🎙";
  const label = state.muted ? "muted · audio not sent" : `recording · ${backend}`;
  const head = theme.fg(state.muted ? "warning" : "accent", `${icon} ${label}  ${formatElapsed(state.elapsed)}`);
  const level = Math.min(10, Math.max(0, Math.round(state.level * 50)));
  const meter = theme.fg(state.muted ? "muted" : "accent", "▮".repeat(level) + "·".repeat(10 - level));
  const hints = theme.fg("dim", state.muted ? "Alt+M stop · Alt+U unmute · Esc cancel" : "Alt+M stop · Alt+U mute · Esc cancel");
  const body = liveBody(state, meter, theme, width);
  return [truncateToWidth(head, Math.max(1, width), ""), ...body, truncateToWidth(hints, Math.max(1, width), "")];
}

/** Wrap the tail of a long transcript instead of cutting it off; the newest words stay visible. */
function liveBody(state: VoiceUiState, meter: string, theme: ThemeLike, width: number): string[] {
  const gap = "  ";
  const prefix = `${meter}${gap}`;
  const prefixWidth = visibleWidth(prefix);
  const available = Math.max(8, width - prefixWidth);
  const plain = (state.text || (state.muted ? "unmute to continue" : "listening…")).replace(/\s+/g, " ").trim();
  const tail = plain.length > 240 ? `…${plain.slice(-240)}` : plain;
  let wrapped = wrapTextWithAnsi(theme.fg("muted", tail), available);
  if (wrapped.length > 3) wrapped = wrapped.slice(-3);
  const indent = " ".repeat(prefixWidth);
  return wrapped.map((line, index) => truncateToWidth(index === 0 ? `${prefix}${line}` : `${indent}${line}`, Math.max(1, width), ""));
}

/** Persistent widget above the editor; updates repaint in place instead of re-registering it. */
export class VoicePanel {
  private state: VoiceUiState = { backend: "local", muted: false, level: 0, text: "", elapsed: 0 };
  private cached?: { width: number; lines: string[] };
  constructor(private tui: { requestRender(): void }, private theme: ThemeLike) {}
  set(state: VoiceUiState): void { this.state = state; this.cached = undefined; this.tui.requestRender(); }
  invalidate(): void { this.cached = undefined; }
  render(width: number): string[] {
    if (!this.cached || this.cached.width !== width) this.cached = { width, lines: voiceLines(this.state, this.theme, width) };
    return this.cached.lines;
  }
}
