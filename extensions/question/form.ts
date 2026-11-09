import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi,
  type Component, type EditorTheme, type TUI,
} from "@earendil-works/pi-tui";
import { getDictationService, type DictationService } from "../lib/dictation.js";
import type { Question, QuestionResult } from "./normalize.js";

const CUSTOM_LABEL = "Type your own answer";

export function createQuestionForm(
  tui: TUI, theme: Theme, questions: Question[], done: (result: QuestionResult) => void,
  /** Injected in tests; by default whatever the `voice` extension registered. */
  dictation: DictationService | undefined = getDictationService(),
): Component {
  let tab = 0;
  let cursor = 0;
  let inputMode = false;
  let cached: string[] | undefined;
  const selections: Set<number>[] = questions.map(() => new Set());
  const custom: (string | undefined)[] = questions.map(() => undefined);
  const answers: (string[] | undefined)[] = questions.map(() => undefined);
  const isMulti = questions.length > 1;
  /** True while this form owns the recording, so leaving it can stop dictation. */
  let dictating = false;
  let dictationNotice: string | undefined;
  /** A transcript that lands after the form closed must not vanish silently. */
  let closed = false;

  const refresh = () => { cached = undefined; tui.requestRender(); };
  const question = () => questions[tab];
  const rows = () => {
    const current = question();
    return current ? [...current.options.map((option) => option.label), CUSTOM_LABEL] : [];
  };
  const finish = (dismissed: boolean) => {
    stopDictation();
    closed = true;
    done({ questions, answers: answers.map((answer) => answer ?? []), dismissed });
  };
  function stopDictation() {
    dictationNotice = undefined;
    if (!dictating || !dictation) return;
    dictating = false;
    void dictation.cancel();
  }
  /**
   * Alt+M inside the answer editor: dictate and insert at the cursor, so a
   * spoken answer can be mixed with typed text before submitting. The global
   * voice shortcut raises the recording first if it wins the race; the service
   * adopts this form as the target either way.
   */
  async function dictate() {
    if (!dictation) { dictationNotice = "Dictation is not available: the voice extension is not loaded."; refresh(); return; }
    if (dictating && dictation.phase() === "recording") { await dictation.stop(); return; }
    dictationNotice = undefined;
    const attached = await dictation.start({
      partial: () => refresh(),
      state: () => refresh(),
      final: (text) => {
        dictating = false;
        if (closed) { void dictation?.cancel(); return; }
        const spoken = text.trim();
        if (spoken) editor.insertTextAtCursor(editor.getText().trim() ? ` ${spoken}` : spoken);
        refresh();
      },
      error: (message) => {
        dictating = false;
        if (closed) { void dictation?.cancel(); return; }
        dictationNotice = message; refresh();
      },
    });
    if (attached) { dictating = true; if (closed) await dictation.cancel(); refresh(); }
    else refresh();
  }
  function advance() {
    if (!isMulti) { finish(false); return; }
    tab = Math.min(tab + 1, questions.length);
    cursor = 0; refresh();
  }
  function confirmMulti() {
    const current = question();
    if (!current) return;
    const picked = [...selections[tab]].sort((a, b) => a - b).map((index) => current.options[index].label);
    const written = custom[tab]?.trim();
    const value = [...picked, ...(written ? [written] : [])];
    answers[tab] = value.length ? value : undefined;
    advance();
  }

  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  const editor = new Editor(tui, editorTheme);
  editor.onSubmit = (value: string) => {
    const text = value.trim();
    inputMode = false;
    stopDictation();
    editor.setText("");
    if (!text) { refresh(); return; }
    custom[tab] = text;
    if (questions[tab].multiSelect) { refresh(); return; }
    answers[tab] = [text];
    advance();
  };

  function handleInput(data: string) {
    if (inputMode) {
      if (matchesKey(data, Key.escape)) { inputMode = false; stopDictation(); editor.setText(""); refresh(); return; }
      if (matchesKey(data, "alt+m")) { void dictate(); return; }
      editor.handleInput(data);
      refresh();
      return;
    }
    const current = question();
    if (matchesKey(data, Key.escape)) { finish(true); return; }
    if (tab === questions.length) {
      if (matchesKey(data, Key.enter)) finish(false);
      return;
    }
    if (!current) return;
    if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
      tab = (tab + 1) % (questions.length + 1); cursor = 0; refresh(); return;
    }
    if (isMulti && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
      tab = (tab - 1 + questions.length + 1) % (questions.length + 1); cursor = 0; refresh(); return;
    }
    const options = rows();
    if (matchesKey(data, Key.up)) { cursor = Math.max(0, cursor - 1); refresh(); return; }
    if (matchesKey(data, Key.down)) { cursor = Math.min(options.length - 1, cursor + 1); refresh(); return; }
    const isCustom = cursor === current.options.length;
    if (current.multiSelect) {
      if (data === " ") {
        if (isCustom) { inputMode = true; editor.setText(custom[tab] ?? ""); }
        else if (selections[tab].has(cursor)) selections[tab].delete(cursor);
        else selections[tab].add(cursor);
        refresh(); return;
      }
      if (matchesKey(data, Key.enter)) confirmMulti();
      return;
    }
    if (!matchesKey(data, Key.enter)) return;
    if (isCustom) { inputMode = true; editor.setText(custom[tab] ?? ""); refresh(); return; }
    answers[tab] = [current.options[cursor].label];
    advance();
  }

  function render(width: number): string[] {
    if (cached) return cached;
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
    const addPrefixed = (prefix: string, text: string) => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) { add(prefix + text); return; }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[i]}`);
    };
    const current = question();
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    if (isMulti) {
      const tabs: string[] = [" "];
      for (let index = 0; index < questions.length; index++) {
        const active = index === tab;
        const answered = answers[index] !== undefined;
        const text = ` ${answered ? "■" : "□"} ${questions[index].header} `;
        tabs.push(`${active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text)} `);
      }
      const submit = " ✓ Submit ";
      tabs.push(`${tab === questions.length ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg("dim", submit)}`);
      addPrefixed(" ", tabs.join(""));
      lines.push("");
    }
    if (inputMode && current) {
      addPrefixed(" ", theme.fg("accent", theme.bold(current.question)));
      lines.push("");
      addPrefixed(" ", theme.fg("muted", "Your answer:"));
      for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
      const live = dictation?.snapshot();
      if (dictating && live && live.phase !== "idle") {
        const seconds = `${Math.floor(live.elapsed / 60)}:${String(live.elapsed % 60).padStart(2, "0")}`;
        const what = live.muted ? "muted" : live.text.trim() || (live.phase === "transcribing" ? "transcribing…" : "listening…");
        lines.push("");
        addPrefixed(" ", theme.fg("accent", `🎙 ${seconds} · ${what}`));
      }
      if (dictationNotice) {
        lines.push("");
        addPrefixed(" ", theme.fg("warning", dictationNotice));
      }
      lines.push("");
      const dictateHint = dictation ? " · Alt+M dictate" : "";
      addPrefixed(" ", theme.fg("dim", `Enter submit · Esc back${dictateHint}`));
    } else if (tab === questions.length) {
      addPrefixed(" ", theme.fg("accent", theme.bold("Answers")));
      lines.push("");
      questions.forEach((entry, index) => {
        const value = answers[index]?.join(", ");
        addPrefixed(" ", value
          ? `${theme.fg("muted", `${entry.header}: `)}${theme.fg("text", value)}`
          : theme.fg("warning", `${entry.header}: (no answer)`));
      });
      lines.push("");
      addPrefixed(" ", theme.fg("dim", "Enter submit · Esc dismiss"));
    } else if (current) {
      addPrefixed(" ", theme.fg("accent", theme.bold(current.question)));
      lines.push("");
      current.options.forEach((option, index) => {
        const active = index === cursor;
        const checked = current.multiSelect ? (selections[tab].has(index) ? "[x] " : "[ ] ") : "";
        const label = `${current.multiSelect ? checked : `${index + 1}. `}${option.label}`;
        addPrefixed(active ? theme.fg("accent", "> ") : "  ", theme.fg(active ? "accent" : "text", label));
        if (option.description) addPrefixed("      ", theme.fg("muted", option.description));
      });
      const active = cursor === current.options.length;
      const written = custom[tab] ? ` ✎ ${custom[tab]}` : "";
      addPrefixed(active ? theme.fg("accent", "> ") : "  ", theme.fg(active ? "accent" : "muted", `${current.multiSelect ? "[ ] " : ""}${CUSTOM_LABEL}${written}`));
      lines.push("");
      const hint = current.multiSelect
        ? "↑↓ navigate · Space toggle/edit · Enter confirm · Tab questions · Esc dismiss"
        : isMulti ? "↑↓ navigate · Enter select · Tab questions · Esc dismiss" : "↑↓ navigate · Enter select · Esc dismiss";
      addPrefixed(" ", theme.fg("dim", hint));
    }
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    cached = lines;
    return lines;
  }

  return { render, handleInput, invalidate: () => { cached = undefined; } };
}
