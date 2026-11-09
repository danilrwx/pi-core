import {
  Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi,
  type Component, type EditorTheme, type TUI,
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

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.options.close(); return; }
    if (data === "\x13") { this.options.submit(); return; } // ctrl+s
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
    const w = Math.max(30, width);
    const { session, files } = this.options;
    const stop = currentStop(session)!;
    const turns = thread(session);
    const lines: string[] = [];
    const push = (text: string) => lines.push(...wrapTextWithAnsi(text, w));
    const pushRaw = (text: string) => lines.push(text);

    push(theme.fg("borderMuted", "─".repeat(w)));
    const total = session.stops.length;
    push(`${theme.fg("accent", theme.bold(`review ${session.index + 1}/${total}`))}${theme.fg("dim", ` · ${session.base} · side $${this.options.sideCost().toFixed(4)}`)}`);
    push(`${theme.fg("text", theme.bold(stop.title))}`);
    push(theme.fg("dim", `${stop.file}:${stop.from}-${stop.to} · ${theme.fg("success", `+${stop.added.length}`)} ${theme.fg("error", `−${stop.deleted.reduce((sum, block) => sum + block.lines.length, 0)}`)}`));
    push("");

    // The code itself, with the same presentation as the chat tour.
    const file = findFile(files, stop.file);
    if (!file) {
      push(theme.fg("warning", "  this file is not part of the diff any more"));
    } else if (file.binary) {
      push(theme.fg("dim", "  binary file"));
    } else {
      const picked = selectHunks(file, { lines: [stop.from, stop.to] }, 2);
      for (const hunk of picked.hunks) {
        push(`${theme.fg("dim", `  ${hunk.header}`)}${hunk.context ? theme.fg("muted", ` ${hunk.context}`) : ""}`);
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
          pushRaw(`  ${theme.fg(token, `${gutter} ${marker} ${code}`.slice(0, w - 2))}`);
        });
        const hidden = hunk.lines.length - Math.min(hunk.lines.length, MAX_DIFF_LINES);
        if (hidden > 0) push(theme.fg("dim", `  … ${hidden} more line${hidden === 1 ? "" : "s"}`));
      }
    }

    push("");
    const whyIndent = "  ";
    const whyWidth = Math.max(12, w - visibleWidth(whyIndent) - 5);
    wrapTextWithAnsi(stop.why || "no explanation for this stop", whyWidth).forEach((line, index) => {
      pushRaw(`${whyIndent}${index === 0 ? theme.fg("accent", "why") : "     "}${theme.fg(stop.why ? "muted" : "warning", ` ${line}`)}`);
    });
    if (stop.note) {
      wrapTextWithAnsi(stop.note, whyWidth).forEach((line, index) => {
        pushRaw(`${whyIndent}${index === 0 ? theme.fg("warning", "note") : "      "}${theme.fg("dim", ` ${line}`)}`);
      });
    }

    if (turns.length) {
      push("");
      const shown = turns.slice(-MAX_THREAD_TURNS * 2);
      const hidden = turns.length - shown.length;
      if (hidden > 0) push(theme.fg("dim", `  … ${hidden} earlier thread turn${hidden === 1 ? "" : "s"}`));
      for (const turn of shown) pushThread(push, theme, turn, w);
      if (this.busy) push(theme.fg("accent", "  thinking…"));
    }

    push("");
    push(theme.fg("muted", "  ask about this stop:"));
    for (const line of this.editor.render(Math.max(10, w - 4))) pushRaw(`  ${line}`);
    push("");
    push(theme.fg("dim", `  ]t [t move · ${session.index + 1 < total ? "/story submit to finish" : "last stop · /story submit to finish"} · Esc close (the panel stays above the editor)`));
    push(theme.fg("borderMuted", "─".repeat(w)));

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
