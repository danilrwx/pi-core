import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { completeArgs } from "../lib/complete.js";
import { counts, normalizeTodos, sameTodos, summary, type Todo } from "./state.js";
import { TodoPanel } from "./view.js";

const ENTRY = "pi-core:todo";

export default function todo(pi: ExtensionAPI) {
  const states = new Map<string, Todo[]>();
  let collapsed = false;
  let panel: TodoPanel | undefined;
  let ctx: ExtensionContext | undefined;
  const clearPending = new Set<string>();

  const sessionId = () => ctx?.sessionManager.getSessionId();
  const isTerminal = (todos: Todo[]) => todos.length > 0 && todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
  const current = () => {
    const id = sessionId();
    return id ? states.get(id) ?? [] : [];
  };
  function render() {
    if (!ctx || ctx.mode !== "tui") return;
    const todos = current();
    if (!todos.length) { panel = undefined; ctx.ui.setWidget("todo", undefined); return; }
    if (!panel) {
      ctx.ui.setWidget("todo", (tui, theme) => {
        panel = new TodoPanel(tui, theme);
        panel.set(current(), collapsed);
        return panel;
      }, { placement: "aboveEditor" });
    } else panel.set(todos, collapsed);
  }
  function store(todos: Todo[], save = true) {
    const id = sessionId();
    if (!id) return;
    states.set(id, todos);
    if (!todos.length) clearPending.delete(id);
    if (save) pi.appendEntry(ENTRY, { todos, updatedAt: new Date().toISOString() });
    render();
  }
  function restore(_event: unknown, context: ExtensionContext) {
    ctx = context;
    const id = context.sessionManager.getSessionId();
    panel = undefined;
    let todos: Todo[] | undefined;
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY) {
        const data = entry.data as { todos?: unknown } | undefined;
        try { if (data?.todos !== undefined) todos = normalizeTodos(data.todos); } catch { /* Ignore a malformed historical snapshot. */ }
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_write") {
        const details = entry.message.details as { todos?: unknown } | undefined;
        try { if (!todos && details?.todos !== undefined) todos = normalizeTodos(details.todos); } catch { /* Ignore malformed details. */ }
      }
    }
    if (todos?.length) { states.set(id, todos); if (isTerminal(todos)) clearPending.add(id); else clearPending.delete(id); render(); }
    else { states.set(id, []); clearPending.delete(id); render(); }
  }

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("agent_end", () => {
    const id = sessionId();
    if (!id) return;
    if (isTerminal(current())) clearPending.add(id); else clearPending.delete(id);
  });
  pi.on("before_agent_start", (event, context) => {
    if (event.messageType !== "user") return;
    ctx = context;
    const id = sessionId();
    if (!id || !clearPending.has(id)) return;
    clearPending.delete(id);
    if (isTerminal(current())) store([]);
  });
  pi.on("session_shutdown", () => {
    const id = sessionId();
    if (id) {
      states.delete(id);
      clearPending.delete(id);
    }
    if (ctx?.mode === "tui") ctx.ui.setWidget("todo", undefined);
    panel = undefined; ctx = undefined;
  });

  pi.registerTool({
    name: "todo_write",
    label: "Todo",
    executionMode: "sequential",
    description: "Create or update the visible task list. Send the complete list every call (replace-all); an empty list clears it. Use for work with three or more steps, and update it after each step so the user can see progress.",
    promptSnippet: "Track multi-step work in the visible todo list",
    promptGuidelines: [
      "Use todo_write for multi-step work (3+ steps), not for trivial tasks.",
      "Send the full list each time; keep exactly one item in_progress while you work, and mark it completed as soon as it is done.",
      "Keep items short and imperative, and use activeForm for the present-continuous label shown while an item is in progress.",
    ],
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        content: Type.String({ description: "Short imperative task label" }),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]),
        activeForm: Type.Optional(Type.String({ description: "Present-continuous label, e.g. writing the parser" })),
      }), { description: "The complete list; replaces the previous one" }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      let todos: Todo[];
      try { todos = normalizeTodos(params.todos); }
      catch (error) { return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { todos: current() }, isError: true }; }
      const previous = current();
      if (sameTodos(previous, todos)) {
        return { content: [{ type: "text", text: "No change: todos already match the requested list" }], details: { todos, counts: counts(todos) } };
      }
      store(todos);
      return {
        content: [{ type: "text", text: summary(todos) }],
        details: { todos, counts: counts(todos), updatedAt: new Date().toISOString() },
      };
    },
  });

  pi.registerShortcut("ctrl+shift+t", { description: "Collapse or expand the todo panel", handler: () => { collapsed = !collapsed; render(); } });
  pi.registerCommand("todos", {
    description: "Show the task list; /todos clear | collapse | expand",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["clear", "collapse", "expand"], {},
      { clear: "remove every task", collapse: "hide task rows", expand: "show task rows" }),
    handler: async (args, context) => {
      ctx = context;
      const arg = args.trim();
      if (arg === "clear") { store([]); context.ui.notify("Todos cleared", "info"); return; }
      if (arg === "collapse" || arg === "expand") { collapsed = arg === "collapse"; render(); return; }
      const todos = current();
      if (!todos.length) { context.ui.notify("No todos yet. Ask the agent to add some.", "info"); return; }
      const totals = counts(todos);
      const lines = [
        `Todos (${totals.completed}/${totals.total})`,
        ...todos.map((todo) => `[${todo.status}] ${todo.content}${todo.activeForm ? ` (${todo.activeForm})` : ""}`),
      ];
      context.ui.notify(lines.join("\n"), "info");
    },
  });
}
