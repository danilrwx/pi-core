import { visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface ReviewPanelState {
  position: string;
  base: string;
  title: string;
  where: string;
  why: string;
  replies: number;
  side: number;
}

/**
 * The slider: where you are in the change set, why this stop exists, and what
 * you can do about it. It sits above the editor the way the todo panel does, so
 * the conversation itself is not rewritten by walking the stops.
 */
export class ReviewPanel implements Component {
  private state: ReviewPanelState;
  private cached?: { width: number; lines: string[] };

  constructor(private readonly tui: TUI, private readonly theme: Theme, state: ReviewPanelState) {
    this.state = state;
  }

  update(state: ReviewPanelState): void {
    this.state = state;
    this.cached = undefined;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const theme = this.theme;
    const w = Math.max(20, width);
    const lines: string[] = [];
    const push = (text: string) => lines.push(...wrapTextWithAnsi(text, w));

    const { position, base, title, where, why, replies, side } = this.state;
    const total = position.split("/")[1] ?? "?";
    push(`${theme.fg("accent", "◀ ")}${theme.fg("accent", theme.bold(`review ${position}`))}${theme.fg("dim", ` · ${base}`)}${replies ? theme.fg("dim", ` · ${replies} repl${replies === 1 ? "y" : "ies"}`) : ""}${side > 0 ? theme.fg("dim", ` · side $${side.toFixed(4)}`) : ""}`);
    if (title) push(`${theme.fg("muted", `  ${title}`)}${theme.fg("dim", where ? ` · ${where}` : "")}`);
    if (why) {
      const indent = "  ";
      const wrapped = wrapTextWithAnsi(why, Math.max(10, w - visibleWidth(indent) - 5));
      wrapped.forEach((line, index) => lines.push(`${indent}${index === 0 ? theme.fg("accent", "why") : "     "}${theme.fg("text", ` ${line}`)}`));
    } else {
      push(theme.fg("warning", "  no explanation for this stop yet"));
    }
    push(theme.fg("dim", `  ]t [t move · /review ask <question> · /review submit · ${total === "1" ? "single stop" : "/review stop"}`));
    this.cached = { width, lines };
    return lines;
  }
}
