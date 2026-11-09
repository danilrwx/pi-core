import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const sessionApi = await jiti.import("../extensions/review/session.ts");
const { ReviewPanel } = await jiti.import("../extensions/review/view.ts");
const { default: review, reviewState } = await jiti.import("../extensions/review/index.ts");

const theme = { fg: (_token, text) => text, bold: (text) => text };
const tui = { requestRender() {} };

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
  review({
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerProvider() {},
    on() {},
    sendMessage(message) { sent.push(message); },
    ...pi,
  });
  return { commands, sent };
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
  assert.match(screen, /\]t \[t move · \/review ask/);
  assert.doesNotMatch(screen, /no explanation/);
  panel.update({ position: "1/1", base: "HEAD", title: "", where: "", why: "", replies: 0, side: 0 });
  assert.match(panel.render(60).join("\n"), /no explanation for this stop yet/);
});

test("/review start reuses the walkthrough stops and refuses without one", async () => {
  const { commands } = load();
  const context = fakeContext();
  await commands.get("review").handler("start", context);
  assert.match(context._notifications.at(-1)[0], /No walkthrough to review yet/);

  const { rememberTour } = await jiti.import("../extensions/lib/tour-state.ts");
  rememberTour({ base: "HEAD", signature: "1:2:0", stops: [STOP(0), STOP(1)].map((stop) => ({ ...stop, note: stop.why })) });
  await commands.get("review").handler("start", context);
  assert.equal(reviewState()?.stops.length, 2);
  assert.match(context._notifications.at(-1)[0], /Review: 2 stops against HEAD/);
  assert.deepEqual(context._statuses.at(-1), ["review", "review 1/2"]);
  const widgetCall = context._widgets.at(-1);
  assert.equal(widgetCall[0], "review");
  assert.equal(typeof widgetCall[1], "function", "a panel factory is installed");
});

test("/review ask discusses the current stop without touching the conversation", async () => {
  const { commands, sent } = load();
  const context = fakeContext({ answer: "It moves the recording into the dialog." });
  const { rememberTour } = await jiti.import("../extensions/lib/tour-state.ts");
  rememberTour({ base: "HEAD", signature: "1:2:0", stops: [STOP(0), STOP(1)].map((stop) => ({ ...stop, note: stop.why })) });
  await commands.get("review").handler("start", context);
  await commands.get("review").handler("ask why does the dialog own it?", context);

  assert.equal(sent.length, 0, "a thread turn must not reach the conversation");
  assert.equal(context._asked.length, 1);
  const prompt = context._asked[0].messages.at(-1).content;
  assert.match(prompt, /We are reviewing one stop of a change set: Stop 0/);
  assert.match(prompt, /File: src\/file0\.go, new-file lines 10-20/);
  assert.match(prompt, /why does the dialog own it\?\n\n\(Side question: answer from the conversation so far/);
  assert.match(prompt, /We are reviewing one stop/);
  assert.equal(reviewState().threads.get(0).length, 2, "question and answer are kept");
  assert.match(context._notifications.at(-1)[0], /It moves the recording into the dialog/);

  // A second question carries the thread so the model keeps its bearings.
  await commands.get("review").handler("ask and then?", context);
  const second = context._asked[1].messages.map((message) => message.content).join("\n---\n");
  assert.match(second, /Earlier in this review thread:\nQ: why does the dialog own it\?/);
});

test("a failing thread turn is reported and stays in the thread", async () => {
  const { commands } = load();
  const context = fakeContext({ fail: true });
  const { rememberTour } = await jiti.import("../extensions/lib/tour-state.ts");
  rememberTour({ base: "HEAD", signature: "1:2:0", stops: [{ ...STOP(0) }] });
  await commands.get("review").handler("start", context);
  await commands.get("review").handler("ask what is this?", context);
  assert.match(context._notifications.at(-1)[0], /Review question failed: model exploded/);
  assert.match(reviewState().threads.get(0).at(-1).text, /\(failed: model exploded\)/);
});

test("/review submit writes one digest and clears the review", async () => {
  const { commands, sent } = load();
  const context = fakeContext({ answer: "We accepted the dialog-owned recording; keep the global shortcut idle." });
  const { rememberTour } = await jiti.import("../extensions/lib/tour-state.ts");
  rememberTour({ base: "HEAD", signature: "1:2:0", stops: [STOP(0), STOP(1)].map((stop) => ({ ...stop, note: stop.why })) });
  await commands.get("review").handler("start", context);
  await commands.get("review").handler("ask why?", context);
  await commands.get("review").handler("submit", context);

  assert.equal(sent.length, 1, "exactly one message reaches the conversation");
  assert.equal(sent[0].customType, "pi-core:review");
  assert.match(sent[0].content, /^Review submitted: 2 stops against HEAD\./);
  assert.match(sent[0].content, /We accepted the dialog-owned recording/);
  assert.equal(reviewState(), undefined, "the review is closed after submit");
  assert.match(context._notifications.at(-1)[0], /Review submitted into the conversation/);
});

test("submit falls back to a deterministic digest when the model is unavailable", async () => {
  const { commands, sent } = load();
  const context = fakeContext({ fail: true });
  const { rememberTour } = await jiti.import("../extensions/lib/tour-state.ts");
  rememberTour({ base: "HEAD", signature: "1:2:0", stops: [{ ...STOP(0) }] });
  await commands.get("review").handler("start", context);
  await commands.get("review").handler("ask why?", context);
  await commands.get("review").handler("submit", context);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Review of 1 stop against HEAD/);
  assert.match(sent[0].content, /\(the digest could not be written: model exploded\)/);
});
