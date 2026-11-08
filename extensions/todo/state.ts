export const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof STATUSES)[number];
export interface Todo { content: string; status: TodoStatus; activeForm?: string }
export interface TodoSnapshot { todos: Todo[]; updatedAt: string }
export const MAX_TODOS = 50;
const MAX_CONTENT = 500;
const MAX_ACTIVE_FORM = 200;

/** Terminal control sequences and other control characters never belong in a task label. */
export function sanitizeText(value: unknown, max = MAX_CONTENT): string {
  if (typeof value !== "string") throw new Error("Task content must be a string");
  const text = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("Task content must not be empty");
  return text.slice(0, max);
}

/** Replace-all semantics: the model sends the complete list on every call. */
export function normalizeTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) throw new Error("todos must be an array");
  if (input.length > MAX_TODOS) throw new Error(`At most ${MAX_TODOS} todos are allowed`);
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Todo ${index + 1} must be an object`);
    const item = raw as Record<string, unknown>;
    const status = item.status ?? "pending";
    if (!STATUSES.includes(status as TodoStatus)) throw new Error(`Todo ${index + 1} has an invalid status`);
    const todo: Todo = { content: sanitizeText(item.content), status: status as TodoStatus };
    if (item.activeForm !== undefined) todo.activeForm = sanitizeText(item.activeForm, MAX_ACTIVE_FORM);
    return todo;
  });
}
export function counts(todos: Todo[]) {
  return {
    total: todos.length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
  };
}
export function summary(todos: Todo[]): string {
  if (!todos.length) return "Todos cleared";
  const { total, completed, inProgress } = counts(todos);
  const active = todos.find((todo) => todo.status === "in_progress");
  return `Todos updated: ${completed}/${total} completed${active ? ` · in progress: ${active.activeForm ?? active.content}` : ""}`;
}
export function sameTodos(a: Todo[], b: Todo[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
