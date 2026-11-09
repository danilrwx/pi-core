import {
  Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type EditorTheme, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pairChanges, wordDiff } from "../walkthrough/render.js";
import { findFile, selectHunks, type FileDiff } from "../walkthrough/diff.js";
import { currentStop, move, thread, type ReviewSession, type Turn } from "./session.js";

export interface ReviewOverlayOptions {
  session: ReviewSession;
  /** Parsed diff of the whole change set, so the panel can show real code. */
  files: FileDiff[];
  sideCost: () => number;
  /** Ask the current stop a question; the answer arrives in the thread. */
  ask: (question: string) => void;
  submit: () => void;
  close: () => void;
}

const MAX_DIFF_LINES = 40;
const MAX_THREAD_TURNS = 4;

/**
 * The review screen: a full-size panel instead of a three-line strip.
 *
 * It shows the stop's real diff (colours plus word-level marking), the reason it
 * exists, the discussion so far and a field to ask the next question. `]t`/`[t`
 * move between stops inside the panel, so the keys behave exactly like Neovim
 * and nothing competes with the main editor.
 */
export class ReviewOverlay implements Component {
  private editor: Editor;
  private pending: string | undefined;
  private busy = false;
  private scroll = 0;
  private cached?: { width: number; lines: string[] };

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: ReviewOverlayOptions,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value: string) => {
      const text = value.trim();
      this.editor.setText("");
      if (!text) return;
      this.busy = true;
      this.options.ask(text);
      this.refresh();
    };
  }

  /** Called by the owner when a thread answer arrived or the stop changed. */
  update(): void {
    this.busy = false;
    this.refresh();
  }

  private refresh(): void {
    this.cached = undefined;
    this.tui.requestRender();
  }

  /** Wheel scrolling, so the panel behaves like any other window. */
  handleMouse(event: TuiMouseEvent): { handled?: boolean } | undefined {
    const delta = event.wheelDelta ?? 0;
    if (!delta) return;
    this.scrollBy(-Math.trunc(delta) * 3);
    return { handled: true };
  }

  private scrollBy(lines: number): void {
    this.scroll = Math.max(0, this.scroll + lines);
    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.options.close(); return; }
    if (data === "\x13") { this.options.submit(); return; } // ctrl+s
    if (matchesKey(data, Key.up)) { this.scrollBy(-1); return; }
    if (matchesKey(data, Key.down)) { this.scrollBy(1); return; }
    if (matchesKey(data, Key.pageUp) || data === "\x15") { this.scrollBy(-10); return; } // ctrl+u
    if (matchesKey(data, Key.pageDown) || data === "\x04") { this.scrollBy(10); return; } // ctrl+d
    if (matchesKey(data, Key.home)) { this.scroll = 0; this.refresh(); return; }
    if (matchesKey(data, Key.end)) { this.scroll = Number.MAX_SAFE_INTEGER; this.refresh(); return; }
    if (this.pending !== undefined) {
      const first = this.pending;
      this.pending = undefined;
      if (data === "t") {
        if (move(this.options.session, first === "]" ? 1 : -1)) this.refresh();
        else this.tui.requestRender();
        return;
      }
      this.editor.handleInput(first);
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (data === "]" || data === "[") {
      // Held for one keystroke: `]t`/`[t` move, anything else types the bracket.
      this.pending = data;
      setTimeout(() => {
        if (this.pending === data) {
          const bracket = this.pending;
          this.pending = undefined;
          this.editor.handleInput(bracket);
          this.refresh();
        }
      }, 400).unref();
      return;
    }
    this.editor.handleInput(data);
    this.refresh();
  }

  invalidate(): void {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const theme = this.theme;
    const outer = Math.max(30, width);
    const inner = outer - 4; // borders plus one column of padding on each side
    const { session, files } = this.options;
    const stop = currentStop(session)!;
    const turns = thread(session);

    const body: string[] = [];
    const push = (text: string) => body.push(...wrapTextWithAnsi(text, inner));
    const pushRaw = (text: string) => body.push(text);

    const total = session.stops.length;
    const where = `${stop.file}:${stop.from}-${stop.to}`;
    push(`${theme.fg("accent", theme.bold(stop.title))}`);
    push(theme.fg("dim", `${where} · ${theme.fg("success", `+${stop.added.length}`)} ${theme.fg("error", `−${stop.deleted.reduce((sum, block) => sum + block.lines.length, 0)}`)}`));
    push("");

    const file = findFile(files, stop.file);
    if (!file) {
      push(theme.fg("warning", "this file is not part of the diff any more"));
    } else if (file.binary) {
      push(theme.fg("dim", "binary file"));
    } else {
      const picked = selectHunks(file, { lines: [stop.from, stop.to] }, 2);
      for (const hunk of picked.hunks) {
        push(`${theme.fg("dim", hunk.header)}${hunk.context ? theme.fg("muted", ` ${hunk.context}`) : ""}`);
        const pairs = pairChanges(hunk.lines);
        const markings = new Map<number, { text: string; changed: boolean }[]>();
        for (const [removedIndex, addedIndex] of pairs) {
          const diff = wordDiff(hunk.lines[removedIndex].text, hunk.lines[addedIndex].text);
          markings.set(removedIndex, diff.before);
          markings.set(addedIndex, diff.after);
        }
        hunk.lines.slice(0, MAX_DIFF_LINES).forEach((line, index) => {
          const gutter = `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} │`;
          const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
          const token = line.kind === "add" ? "toolDiffAdded" : line.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
          const segments = markings.get(index);
          const code = segments
            ? segments.map((segment) => (segment.changed ? theme.inverse(segment.text) : segment.text)).join("")
            : line.text;
          pushRaw(theme.fg(token, `${gutter} ${marker} ${code}`));
        });
        const hidden = hunk.lines.length - Math.min(hunk.lines.length, MAX_DIFF_LINES);
        if (hidden > 0) push(theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`));
      }
    }

    push("");
    const whyWidth = Math.max(12, inner - 5);
    wrapTextWithAnsi(stop.why || "no explanation for this stop", whyWidth).forEach((line, index) => {
      pushRaw(`${index === 0 ? theme.fg("accent", "why") : "     "}${theme.fg(stop.why ? "muted" : "warning", ` ${line}`)}`);
    });
    if (stop.note) {
      wrapTextWithAnsi(stop.note, whyWidth).forEach((line, index) => {
        pushRaw(`${index === 0 ? theme.fg("warning", "note") : "      "}${theme.fg("dim", ` ${line}`)}`);
      });
    }

    if (turns.length) {
      push("");
      const shown = turns.slice(-MAX_THREAD_TURNS * 2);
      const hidden = turns.length - shown.length;
      if (hidden > 0) push(theme.fg("dim", `… ${hidden} earlier thread turn${hidden === 1 ? "" : "s"}`));
      for (const turn of shown) pushThread(push, theme, turn, inner);
      if (this.busy) push(theme.fg("accent", "thinking…"));
    }

    const footer: string[] = [];
    footer.push(theme.fg("muted", "ask about this stop:"));
    for (const line of this.editor.render(Math.max(10, inner - 2))) footer.push(` ${line}`);
    footer.push(theme.fg("dim", ` ]t [t stops · ↑↓ pgup/pgdn scroll · ctrl+s submit · Esc close`));

    const rows = this.tui.terminal?.rows ?? 40;
    const height = Math.max(12, Math.floor(rows * 0.88) - 2);
    // The box is as tall as the slide needs, not taller: an empty half-screen
    // looks like a broken panel, so the viewport shrinks to the content.
    const maximum = Math.max(4, height - footer.length - 2);
    const viewport = Math.min(maximum, Math.max(4, body.length));
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - viewport)));
    const visible = body.slice(this.scroll, this.scroll + viewport);

    const lines: string[] = [];
    const title = `review ${session.index + 1}/${total} · ${session.base} · side $${this.options.sideCost().toFixed(4)}`;
    const top = `╭─ ${title} `;
    lines.push(theme.fg("borderMuted", truncateToWidth(top + "─".repeat(Math.max(0, outer - visibleWidth(top) - 1)) + "╮", outer, "…")));
    const scrollbarWidth = body.length > viewport ? 1 : 0;
    const scaled = (index: number) => Math.round((index / Math.max(1, body.length - viewport)) * Math.max(0, viewport - 1));
    for (let index = 0; index < viewport; index++) {
      const text = visible[index];
      let bar = " ";
      if (scrollbarWidth) {
        const thumbStart = body.length > viewport ? scaled(this.scroll) : 0;
        const thumbSize = Math.max(1, Math.round((viewport / Math.max(viewport, body.length)) * (viewport - 1)));
        bar = index >= thumbStart && index < thumbStart + thumbSize ? "█" : "│";
      }
      const content = text === undefined ? "" : truncateToWidth(text, inner, "…");
      lines.push(`${theme.fg("borderMuted", "│")} ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${theme.fg("dim", bar)}${theme.fg("borderMuted", "│")}`);
    }
    lines.push(`${theme.fg("borderMuted", "├" + "─".repeat(outer - 2) + "┤")}`);
    for (const line of footer) {
      const content = truncateToWidth(line, inner, "…");
      lines.push(`${theme.fg("borderMuted", "│")} ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} ${theme.fg("borderMuted", "│")}`);
    }
    lines.push(theme.fg("borderMuted", `╰${"─".repeat(outer - 2)}╯`));

    this.cached = { width, lines };
    return lines;
  }

}

function pushThread(push: (text: string) => void, theme: Theme, turn: Turn, width: number): void {
  const label = turn.role === "user" ? "you" : "pi ";
  const color = turn.role === "user" ? "accent" : "text";
  const wrapped = wrapTextWithAnsi(turn.text.trim(), Math.max(12, width - 8));
  wrapped.forEach((line, index) => {
    push(`${theme.fg("dim", `  ${index === 0 ? label : "    "}`)} ${theme.fg(color, line)}`);
  });
}
