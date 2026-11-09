/**
 * One box for every popup in pi-core.
 *
 * Pi gives an overlay geometry only (width, height, anchor, margin); the frame
 * is the component's own business. Keeping it in one place means the question
 * dialog, the review panel and the image gallery look like the same product.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface FrameOptions {
  theme: Theme;
  /** Shown in the top border, between dashes. */
  title: string;
  width: number;
  /** Content of the scrollable middle. */
  body: string[];
  /** Pinned lines under a separator: input fields, key hints. */
  footer?: string[];
  /** Optional right-hand column, one character per body line (scrollbar). */
  scrollbar?: string[];
  /** Minimum outer width, so a narrow terminal does not squeeze the box flat. */
  minWidth?: number;
}

export function frameLines(options: FrameOptions): string[] {
  const { theme, title } = options;
  const outer = Math.max(options.minWidth ?? 30, options.width);
  const inner = Math.max(8, outer - 4);
  const bar = options.scrollbar;
  const barWidth = bar?.length ? 1 : 0;
  const contentWidth = inner - barWidth;

  const lines: string[] = [];
  const paint = (text: string) => theme.fg("borderMuted", text);

  const heading = `─ ${title} `;
  const headRoom = Math.max(0, outer - 2 - visibleWidth(heading));
  lines.push(paint(`╭${truncateToWidth(heading + "─".repeat(headRoom), outer - 2, "…")}╮`));

  const body = options.body.length ? options.body : [""];
  body.forEach((line, index) => {
    const content = truncateToWidth(line, contentWidth, "…");
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
    const column = barWidth ? (bar?.[index] ?? " ") : "";
    lines.push(`${paint("│")} ${content}${padding}${barWidth ? theme.fg("dim", column) : ""} ${paint("│")}`);
  });

  if (options.footer?.length) {
    lines.push(paint(`├${"─".repeat(outer - 2)}┤`));
    for (const line of options.footer) {
      const content = truncateToWidth(line, contentWidth, "…");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
      lines.push(`${paint("│")} ${content}${padding}${barWidth ? " " : ""} ${paint("│")}`);
    }
  }

  lines.push(paint(`╰${"─".repeat(outer - 2)}╯`));
  return lines;
}

/** Wrap text to the frame's inner width, for callers that build body lines. */
export function innerWidth(width: number, hasScrollbar = false): number {
  return Math.max(8, Math.max(30, width) - 4 - (hasScrollbar ? 1 : 0));
}

/** Vertical scrollbar column for a body that is taller than the viewport. */
export function scrollbarColumn(total: number, viewport: number, offset: number): string[] {
  if (total <= viewport) return [];
  const track = Math.max(1, viewport);
  const thumb = Math.max(1, Math.round((viewport / total) * track));
  const start = Math.round((offset / Math.max(1, total - viewport)) * Math.max(0, track - thumb));
  return Array.from({ length: track }, (_unused, index) => (index >= start && index < start + thumb ? "█" : "│"));
}

export { wrapTextWithAnsi };
