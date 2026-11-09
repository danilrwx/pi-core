import {
  truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Hunk } from "./diff.js";

export interface TourStop {
  title: string;
  why: string;
  note?: string;
  file: string;
  /** Human label for the selected hunk, e.g. `hunk 2/3`. */
  hunkLabel?: string;
  hunks: Hunk[];
  /** Set when the stop asked for something the diff does not contain. */
  warning?: string;
}

/**
 * Everything the view needs, and nothing more: this object is stored in the
 * session as tool details, so it carries the selected hunks rather than whole
 * files and stays small enough to keep transcripts readable.
 */
export interface Tour {
  title?: string;
  intro?: string;
  base: string;
  fileCount: number;
  additions: number;
  deletions: number;
  stops: TourStop[];
}

const MAX_DIFF_LINES = 32;
const MAX_TOTAL_DIFF_LINES = 200;

/**
 * A narrated tour rendered where the chat is, not in the editor. Static output:
 * one pass over the stops, wrapped to the terminal width, colored with the
 * theme's diff tokens so it reads like the rest of the transcript.
 */
export class TourView implements Component {
  constructor(private readonly tour: Tour, private readonly theme: Theme, private readonly pad = 0) {}

  render(width: number): string[] {
    const theme = this.theme;
    const indent = " ".repeat(this.pad);
    const w = Math.max(24, width - this.pad * 2);
    const out: string[] = [];
    const push = (...lines: string[]) => out.push(...lines);
    const wrap = (text: string, indent: string) => {
      const wrapped = wrapTextWithAnsi(text, Math.max(8, w - visibleWidth(indent)));
      push(...wrapped.map((line) => `${indent}${line}`));
    };

    const { tour } = this;
    push(theme.fg("borderMuted", "─".repeat(w)));
    push(`${theme.fg("accent", theme.bold("changes tour"))}${tour.title ? theme.fg("text", ` · ${tour.title}`) : ""}`);
    push(theme.fg("dim", `${tour.base} · ${tour.fileCount} file${tour.fileCount === 1 ? "" : "s"} · ${theme.fg("success", `+${tour.additions}`)} ${theme.fg("error", `−${tour.deletions}`)} · ${tour.stops.length} stop${tour.stops.length === 1 ? "" : "s"}`));
    if (tour.intro) {
      push("");
      wrap(tour.intro, " ");
    }

    let budget = MAX_TOTAL_DIFF_LINES;
    tour.stops.forEach((stop, index) => {
      push("");
      push(`${theme.fg("accent", theme.bold(`${index + 1}`))}${theme.fg("dim", "/")}${theme.fg("dim", `${tour.stops.length}`)} ${theme.fg("text", theme.bold(stop.title))}`);
      const meta: string[] = [stop.file];
      if (stop.hunkLabel) meta.push(stop.hunkLabel);
      push(theme.fg("dim", `   ${meta.join(" · ")}`));

      for (const hunk of stop.hunks) {
        if (budget <= 0) { push(theme.fg("dim", "   … diff budget reached")); break; }
        push(`${theme.fg("dim", `   ${hunk.header}`)}${hunk.context ? theme.fg("muted", ` ${hunk.context}`) : ""}`);
        const shown = hunk.lines.slice(0, Math.min(MAX_DIFF_LINES, budget));
        for (const line of shown) {
          const gutter = `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} │`;
          const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
          const token = line.kind === "add" ? "toolDiffAdded" : line.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
          const body = truncateToWidth(`${gutter} ${marker} ${line.text}`, w - 3, "…");
          push(`   ${theme.fg(token, body)}`);
        }
        budget -= shown.length;
        const hidden = hunk.lines.length - shown.length;
        if (hidden > 0) push(theme.fg("dim", `   … ${hidden} more line${hidden === 1 ? "" : "s"} in this hunk`));
      }
      if (stop.warning) push(theme.fg("warning", `   ${stop.warning}`));

      push("");
      const whyIndent = "   ";
      const whyLines = wrapTextWithAnsi(stop.why, Math.max(8, w - visibleWidth(whyIndent) - 5));
      whyLines.forEach((line, lineIndex) => {
        const label = lineIndex === 0 ? `${theme.fg("accent", "why")}  ` : "     ";
        push(`${whyIndent}${label}${theme.fg("muted", line)}`);
      });
      if (stop.note) {
        const noteLines = wrapTextWithAnsi(stop.note, Math.max(8, w - visibleWidth(whyIndent) - 8));
        noteLines.forEach((line, lineIndex) => {
          const label = lineIndex === 0 ? `${theme.fg("warning", "note")} ` : "     ";
          push(`${whyIndent}${label}${theme.fg("dim", line)}`);
        });
      }
    });

    push("");
    push(theme.fg("borderMuted", "─".repeat(w)));
    return this.pad ? out.map((line) => `${indent}${line}`) : out;
  }

  invalidate(): void {}
}
