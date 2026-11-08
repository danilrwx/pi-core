import { truncateToWidth } from "@earendil-works/pi-tui";
import { counts, type Todo } from "./state.js";

const GLYPH: Record<Todo["status"], string> = {
  completed: "[✓]", in_progress: "[•]", pending: "[ ]", cancelled: "[x]",
};
interface ThemeLike { fg(token: string, text: string): string; bold?(text: string): string }

export function todoLines(todos: Todo[], options: { collapsed?: boolean; maxRows?: number; width?: number; theme: ThemeLike }): string[] {
  if (!todos.length) return [];
  const { collapsed = false, maxRows = 10, width = 200, theme } = options;
  const totals = counts(todos);
  const active = todos.find((todo) => todo.status === "in_progress");
  const title = `Todos (${totals.completed}/${totals.total})`;
  const head = theme.fg("accent", theme.bold ? theme.bold(title) : title) +
    (active ? theme.fg("muted", ` · ${active.activeForm ?? active.content}`) : "") +
    (collapsed ? theme.fg("dim", " · ctrl+shift+t expand") : "");
  if (collapsed) return [truncateToWidth(head, width, "")];
  const pick = (budget: number) => {
    const nonCompleted = todos.filter((todo) => todo.status !== "completed");
    if (nonCompleted.length >= budget) return new Set(nonCompleted.slice(0, budget));
    const roomForCompleted = budget - nonCompleted.length;
    return new Set([...nonCompleted, ...todos.filter((todo) => todo.status === "completed").slice(0, roomForCompleted)]);
  };
  // One row is the heading. When the overflow footer is needed it takes a row too.
  let budget = Math.max(1, maxRows - 1);
  let keepIds = pick(budget);
  if (todos.length - keepIds.size > 0 && budget > 1) { budget -= 1; keepIds = pick(budget); }
  const visible = todos.filter((todo) => keepIds.has(todo));
  const hidden = todos.length - visible.length;
  const lines = [truncateToWidth(head, width, "")];
  for (const todo of visible) {
    const text = todo.status === "completed"
      ? theme.fg("success", todo.content)
      : todo.status === "in_progress"
        ? theme.fg("accent", `${todo.content}${todo.activeForm ? ` — ${todo.activeForm}` : ""}`)
        : todo.status === "cancelled" ? theme.fg("muted", todo.content) : theme.fg("text", todo.content);
    lines.push(truncateToWidth(`${theme.fg("muted", `${GLYPH[todo.status]} `)}${text}`, width, ""));
  }
  if (hidden > 0) {
    const hiddenCompleted = todos.filter((todo) => !keepIds.has(todo) && todo.status === "completed").length;
    const hiddenOther = hidden - hiddenCompleted;
    lines.push(truncateToWidth(theme.fg("dim", `+${hidden} more (${hiddenCompleted} completed, ${hiddenOther} other)`), width, ""));
  }
  return lines;
}

/** Persistent panel above the editor; updates repaint in place instead of re-registering. */
export class TodoPanel {
  private state: { todos: Todo[]; collapsed: boolean } = { todos: [], collapsed: false };
  private cached?: { width: number; lines: string[] };
  constructor(private tui: { requestRender(): void }, private theme: ThemeLike) {}
  set(todos: Todo[], collapsed: boolean): void { this.state = { todos, collapsed }; this.cached = undefined; this.tui.requestRender(); }
  invalidate(): void { this.cached = undefined; }
  render(width: number): string[] {
    if (!this.cached || this.cached.width !== width) {
      this.cached = { width, lines: todoLines(this.state.todos, { ...this.state, theme: this.theme, width }) };
    }
    return this.cached.lines;
  }
}
