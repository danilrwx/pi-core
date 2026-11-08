import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";
const { normalizeTodos, counts, summary } = await jiti.import("../extensions/todo/state.ts");
const { todoLines } = await jiti.import("../extensions/todo/view.ts");
const plugin = await jiti.import("../extensions/todo/index.ts");

const theme = { fg: (_token, text) => text, bold: (text) => text };
const tui = { requestRender() {} };

function harness(branch = [], sessionId = "s1") {
  const tools = new Map(), commands = new Map(), shortcuts = new Map(), handlers = new Map();
  const entries = [], widgets = new Map(), notices = [];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  plugin.default(pi);
  const context = {
    mode: "tui", sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: {
      setWidget(key, value) { value === undefined ? widgets.delete(key) : widgets.set(key, value); },
      notify(message, type) { notices.push({ message, type }); },
    },
  };
  return {
    pi, tools, commands, shortcuts, handlers, entries, widgets, notices, context,
    async emit(name, event = {}, ctx = context) { await handlers.get(name)?.(event, ctx); },
    render() {
      const factory = widgets.get("todo");
      return typeof factory === "function" ? factory(tui, theme).render(80) : [];
    },
    call: (args, ctx = context) => tools.get("todo_write").execute("call", args, undefined, undefined, ctx),
    command: (args, ctx = context) => commands.get("todos").handler(args, ctx),
  };
}

test("todo normalization trims, defaults and rejects invalid input", () => {
  assert.deepEqual(normalizeTodos([{ content: "  Write\x1b[31m parser ", status: "in_progress", activeForm: " writing " }]),
    [{ content: "Write parser", status: "in_progress", activeForm: "writing" }]);
  assert.deepEqual(normalizeTodos([{ content: "A" }]), [{ content: "A", status: "pending" }]);
  assert.throws(() => normalizeTodos({}), /must be an array/);
  assert.throws(() => normalizeTodos([{ content: " " }]), /must not be empty/);
  assert.throws(() => normalizeTodos([{ content: "A", status: "done" }]), /invalid status/);
  assert.throws(() => normalizeTodos(Array.from({ length: 51 }, (_, i) => ({ content: `t${i}` }))), /At most 50/);
});

test("counts and summary describe progress and the active item", () => {
  const todos = normalizeTodos([
    { content: "A", status: "completed" }, { content: "B", status: "in_progress", activeForm: "doing B" }, { content: "C" },
  ]);
  assert.deepEqual(counts(todos), { total: 3, completed: 1, inProgress: 1, cancelled: 0 });
  assert.equal(summary(todos), "Todos updated: 1/3 completed · in progress: doing B");
  assert.equal(summary([]), "Todos cleared");
});

test("panel shows glyphs, active label, overflow and collapsed state", () => {
  const todos = normalizeTodos([
    { content: "Write parser", status: "completed" },
    { content: "Wire CLI", status: "in_progress", activeForm: "wiring CLI" },
    { content: "Add tests", status: "pending" },
  ]);
  const lines = todoLines(todos, { theme, width: 80, maxRows: 10 });
  assert.match(lines[0], /Todos \(1\/3\)/);
  assert.match(lines.join("\n"), /\[✓\] Write parser/);
  assert.match(lines.join("\n"), /\[•\] Wire CLI — wiring CLI/);
  const capped = todoLines(todos, { theme, width: 80, maxRows: 3 });
  assert.equal(capped.length, 3);
  assert.match(capped.at(-1), /\+2 more \(1 completed, 1 other\)/);
  const collapsed = todoLines(todos, { theme, width: 80, collapsed: true });
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0], /ctrl\+shift\+t expand/);
  assert.deepEqual(todoLines([], { theme }), []);
});

test("todo_write persists snapshots, skips no-ops and renders the panel", async () => {
  const h = harness();
  await h.emit("session_start");
  const first = await h.call({ todos: [{ content: "Plan", status: "completed" }, { content: "Build", status: "in_progress" }] });
  assert.equal(first.content[0].text, "Todos updated: 1/2 completed · in progress: Build");
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, "pi-core:todo");
  assert.equal(h.entries[0].data.todos.length, 2);
  assert.deepEqual(first.details.counts, { total: 2, completed: 1, inProgress: 1, cancelled: 0 });
  assert.match(h.render().join("\n"), /\[•\] Build/);
  const again = await h.call({ todos: [{ content: "Plan", status: "completed" }, { content: "Build", status: "in_progress" }] });
  assert.match(again.content[0].text, /No change/);
  assert.equal(h.entries.length, 1);
  await h.call({ todos: [] });
  assert.deepEqual(h.render(), []);
  assert.equal(h.entries.length, 2);
});

test("state restores from custom entries, falls back to tool details and stays per session", async () => {
  const branch = [
    { type: "custom", customType: "pi-core:todo", data: { todos: [{ content: "Old", status: "pending" }] } },
    { type: "custom", customType: "pi-core:todo", data: { todos: [{ content: "Latest", status: "completed" }, { content: "Next" }] } },
  ];
  const h = harness(branch);
  await h.emit("session_start");
  assert.match(h.render().join("\n"), /Latest/);
  await h.command("");
  assert.match(h.notices.at(-1).message, /Todos \(1\/2\)/);

  const fallback = harness([{ type: "message", message: { role: "toolResult", toolName: "todo_write", details: { todos: [{ content: "From details", status: "pending" }] } } }]);
  await fallback.emit("session_start");
  assert.match(fallback.render().join("\n"), /From details/);

  const other = harness([], "s2");
  await other.emit("session_start");
  await h.call({ todos: [{ content: "Only s1", status: "pending" }] });
  assert.doesNotMatch(other.render().join("\n"), /Only s1/);
});

test("/todos clear, collapse shortcut and argument completions work", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.call({ todos: [{ content: "A", status: "pending" }] });
  await h.command("collapse");
  assert.equal(h.render().length, 1);
  h.shortcuts.get("ctrl+shift+t").handler();
  assert.ok(h.render().length > 1);
  await h.command("clear");
  assert.equal(h.entries.at(-1).data.todos.length, 0);
  const completions = h.commands.get("todos").getArgumentCompletions("");
  assert.deepEqual(completions.map((item) => item.value), ["clear", "collapse", "expand"]);
});

test("invalid tool input is reported as a tool error without changing state", async () => {
  const h = harness();
  await h.emit("session_start");
  const result = await h.call({ todos: [{ content: "" }] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must not be empty/);
  assert.equal(h.entries.length, 0);
});

test("completed todos clear on the next user message, not on custom runs", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.call({ todos: [{ content: "Build", status: "completed" }, { content: "Ship", status: "cancelled" }] });
  await h.emit("agent_end");
  assert.match(h.render().join("\n"), /Build/);
  await h.emit("before_agent_start", { messageType: "custom" });
  assert.match(h.render().join("\n"), /Build/);
  assert.equal(h.entries.length, 1);
  await h.emit("before_agent_start", { messageType: "user" });
  assert.deepEqual(h.render(), []);
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.entries[1].data.todos, []);
});

test("incomplete todos survive agent_end and the next user message", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.call({ todos: [{ content: "Build", status: "completed" }, { content: "Test", status: "pending" }] });
  await h.emit("agent_end");
  await h.emit("before_agent_start", { messageType: "user" });
  assert.match(h.render().join("\n"), /Test/);
  assert.equal(h.entries.length, 1);
});

test("a restored all-completed list clears on the next user message", async () => {
  const branch = [
    { type: "custom", customType: "pi-core:todo", data: { todos: [{ content: "Done", status: "completed" }] } },
  ];
  const h = harness(branch);
  await h.emit("session_start");
  assert.match(h.render().join("\n"), /Done/);
  await h.emit("before_agent_start", { messageType: "user" });
  assert.deepEqual(h.render(), []);
  assert.equal(h.entries.length, 1);
});
