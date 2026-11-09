import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const sessionApi = await jiti.import("../extensions/review/session.ts");
const { ReviewPanel } = await jiti.import("../extensions/review/view.ts");
const { default: review, reviewState } = await jiti.import("../extensions/review/index.ts");

const theme = { fg: (_token, text) => text, bold: (text) => text, inverse: (text) => `«${text}»` };
const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };

const STOP = (index) => ({
  file: `src/file${index}.go`,
  from: 10 + index,
  to: 20 + index,
  title: `Stop ${index}`,
  why: `Because reason ${index}`,
  added: [11 + index],
  deleted: [],
});

function fakeContext({ answer = "An answer.", fail = false, cwd = process.cwd() } = {}) {
  const notifications = [];
  const statuses = [];
  const widgets = [];
  const asked = [];
  return {
    cwd,
    mode: "tui",
    model: { provider: "test", api: "openai-completions", id: "test-model" },
    sessionManager: { getSessionId: () => "review-session" },
    modelRegistry: {
      streamSimple(model, context) {
        asked.push({ model, messages: context.messages });
        if (fail) throw new Error("model exploded");
        return { result: async () => ({ content: [{ type: "text", text: answer }], usage: { cost: { total: 0.002 } }, stopReason: "stop" }) };
      },
    },
    ui: {
      notify(text, level) { notifications.push([text, level]); },
      setStatus(key, value) { statuses.push([key, value]); },
      setWidget(key, widget) { widgets.push([key, widget]); },
      onTerminalInput() { return () => {}; },
    },
    _notifications: notifications,
    _statuses: statuses,
    _widgets: widgets,
    _asked: asked,
  };
}

function load(pi = {}) {
  const commands = new Map();
  const tools = new Map();
  const renderers = new Map();
  const sent = [];
  const listeners = new Map();
  const handlers = new Map();
  review({
    registerCommand(name, command) { commands.set(name, command); },
    events: { on(name, handler) { listeners.set(name, handler); }, emit() {} },
    _listeners: listeners,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerProvider() {},
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    sendMessage(message) { sent.push(message); },
    ...pi,
  });
  return { commands, sent, listeners, handlers };
}

test("the slider moves, refuses the ends and remembers threads per stop", () => {
  const session = sessionApi.createSession([STOP(0), STOP(1)], "HEAD~1");
  assert.equal(sessionApi.currentStop(session).title, "Stop 0");
  assert.equal(sessionApi.move(session, 1), true);
  assert.equal(sessionApi.currentStop(session).title, "Stop 1");
  assert.equal(sessionApi.move(session, 1), false, "the slider stops at the end");
  assert.equal(sessionApi.move(session, -2), false, "and at the beginning");

  sessionApi.appendTurn(session, { role: "user", text: "why this?" }, 1);
  sessionApi.appendTurn(session, { role: "assistant", text: "because" }, 1);
  assert.equal(sessionApi.thread(session).length, 2);
  assert.equal(sessionApi.thread(session, 0).length, 0);
  assert.deepEqual(sessionApi.acceptedWithoutDiscussion(session).map((stop) => stop.title), ["Stop 0"]);

  const digest = sessionApi.fallbackSummary(session);
  assert.match(digest, /Review of 2 stops against HEAD~1/);
  assert.match(digest, /1\. Stop 0 — src\/file0\.go:10-20/);
  assert.match(digest, /discussed: why this\?/);
  assert.match(sessionApi.threadTranscript(session), /## Stop 2: Stop 1/);
});

test("the panel shows the position, the reason and the keys", () => {
  const panel = new ReviewPanel(tui, theme, {
    position: "2/3", base: "origin/main", title: "Borrow the microphone",
    where: "src/form.ts:10-20", why: "The overlay holds focus, so the shortcut never fires.",
    replies: 2, side: 0.002,
  });
  const screen = panel.render(60).join("\n");
  assert.match(screen, /review 2\/3 · origin\/main · 2 replies · side \$0\.0020/);
  assert.match(screen, /Borrow the microphone · src\/form.ts:10-20/);
  assert.match(screen, /why The overlay holds focus/);
  assert.match(screen, /\]t \[t move · type a question/);
  assert.doesNotMatch(screen, /no explanation/);
  panel.update({ position: "1/1", base: "HEAD", title: "", where: "", why: "", replies: 0, side: 0 });
  assert.match(panel.render(60).join("\n"), /no explanation for this stop yet/);
});

test("a finished walkthrough arms the panel and it opens when the turn ends", async () => {
  const { listeners, handlers } = load();
  const context = fakeContext();
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  listeners.get("pi-core:tour-ready")({ base: "HEAD", stops: [STOP(0), STOP(1)] });
  assert.equal(reviewState()?.stops.length, 2);
  assert.match(context._notifications.at(-1)[0], /the panel opens when this turn ends/);
  assert.equal(context._widgets.at(-1)[0], "review", "the strip keeps the review visible");
});

test("typing a question goes to the current stop, not the conversation", async () => {
  const { listeners, handlers } = load();
  const context = fakeContext({ answer: "It moves the recording into the dialog." });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  listeners.get("pi-core:tour-ready")({ base: "HEAD", stops: [STOP(0), STOP(1)] });

  const input = (handlers.get("input") ?? [])[0];
  assert.equal(typeof input, "function", "review listens to typed input");
  const result = await input({ type: "input", text: "why does the dialog own it?", source: "user" }, context);
  assert.deepEqual(result, { action: "handled" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context._asked.length, 1);
  const prompt = context._asked[0].messages.at(-1).content;
  assert.match(prompt, /We are reviewing one stop of a change set: Stop 0/);
  assert.match(prompt, /why does the dialog own it\?\n\n\(Side question/);
  assert.equal(reviewState().threads.get(0).length, 2);

  // With no review, typing behaves as usual.
  listeners.get("pi-core:story-control")({ action: "stop" });
  assert.deepEqual(await input({ type: "input", text: "hello", source: "user" }, context), { action: "continue" });
});

test("story-control submits one digest and closes the review", async () => {
  const { listeners, handlers, sent } = load();
  const context = fakeContext({ answer: "We accepted the dialog-owned recording." });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  listeners.get("pi-core:tour-ready")({ base: "HEAD", stops: [STOP(0), STOP(1)] });
  await (handlers.get("input") ?? [])[0]({ type: "input", text: "why?", source: "user" }, context);
  listeners.get("pi-core:story-control")({ action: "submit" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "pi-core:review");
  assert.match(sent[0].content, /^Review submitted: 2 stops against HEAD\./);
  assert.equal(reviewState(), undefined);
});

test("submit falls back to a deterministic digest when the model is unavailable", async () => {
  const { listeners, handlers, sent } = load();
  const context = fakeContext({ fail: true });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  listeners.get("pi-core:tour-ready")({ base: "HEAD", stops: [{ ...STOP(0) }] });
  await (handlers.get("input") ?? [])[0]({ type: "input", text: "why?", source: "user" }, context);
  listeners.get("pi-core:story-control")({ action: "submit" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Review of 1 stop against HEAD/);
});

test("the big panel shows the diff, the reason, the thread and the input", async () => {
  const { ReviewOverlay } = await jiti.import("../extensions/review/overlay.ts");
  const { parseUnifiedDiff } = await jiti.import("../extensions/walkthrough/diff.ts");
  const session = sessionApi.createSession([STOP(0), STOP(1)], "HEAD~1");
  sessionApi.appendTurn(session, { role: "user", text: "why does it exist?" }, 0);
  sessionApi.appendTurn(session, { role: "assistant", text: "because the overlay holds focus" }, 0);
  const files = parseUnifiedDiff([
    "diff --git a/src/file0.go b/src/file0.go",
    "--- a/src/file0.go", "+++ b/src/file0.go",
    "@@ -9,3 +9,4 @@ func handle", " context", "-old line", "+new line", "+second line",
  ].join("\n"));
  const asked = [];
  const panel = new ReviewOverlay(tui, theme, {
    session, files, sideCost: () => 0.002,
    ask: (question) => { asked.push(question); },
    submit: () => {},
    close: () => {},
  });
  const screen = panel.render(80).join("\n");
  assert.match(screen, /review 1\/2 · HEAD~1 · side \$0\.0020/);
  assert.match(screen, /src\/file0\.go:10-20 · \+1 −0/);
  assert.match(screen, /@@ -9,3 \+9,4 @@ func handle/);
  assert.match(screen, /- «old» line/);
  assert.match(screen, /\+ «new» line/);
  assert.match(screen, /why Because reason 0/);
  assert.match(screen, /you +why does it exist\?/);
  assert.match(screen, /pi +because the overlay holds focus/);
  assert.match(screen, /ask about this stop:/);
  assert.match(screen, /\]t \[t move/);

  // `]t` moves inside the panel; a lone `[` still types a bracket.
  panel.handleInput("]");
  panel.handleInput("t");
  assert.equal(reviewState(), undefined);
  assert.match(panel.render(80).join("\n"), /review 2\/2/);
  panel.handleInput("[");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.match(panel.render(80).join("\n"), /review 2\/2/);

  panel.handleInput("w");
  panel.handleInput("h");
  panel.handleInput("y");
  panel.handleInput("\r");
  // The bracket that never became a shortcut stays in the field, like typed text.
  assert.deepEqual(asked, ["[why"]);
});
