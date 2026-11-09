import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const { normalizeQuestions, answerLines, buildContent } = await jiti.import("../extensions/question/normalize.ts");
const { createQuestionForm } = await jiti.import("../extensions/question/form.ts");
const plugin = await jiti.import("../extensions/question/index.ts");

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", space: " ", tab: "\t" };

function run(questions, drive) {
  return new Promise((resolve) => {
    const form = createQuestionForm(tui, theme, normalizeQuestions(questions), resolve);
    drive(form);
  });
}

test("normalization applies defaults, rejects bad input and strips terminal escapes", () => {
  const [question] = normalizeQuestions([{ question: "  Pick\x1b[31m one  ", options: [{ label: "A" }, { label: "B", description: "second" }] }]);
  assert.equal(question.question, "Pick one");
  assert.equal(question.header, "Q1");
  assert.equal(question.multiSelect, false);
  assert.deepEqual(question.options, [{ label: "A" }, { label: "B", description: "second" }]);
  assert.throws(() => normalizeQuestions([]), /At least one/);
  assert.throws(() => normalizeQuestions(Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` }))), /At most 4/);
  assert.throws(() => normalizeQuestions([{ question: " " }]), /must not be empty/);
  assert.throws(() => normalizeQuestions([{ question: "q", options: [{ label: "A" }, { label: "A" }] }]), /duplicate/);
  assert.throws(() => normalizeQuestions([{ question: "q", options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }]), /At most 8/);
});

test("single-select answers on Enter and finishes immediately", async () => {
  const result = await run([{ question: "Scope?", options: [{ label: "CLI" }, { label: "Web" }] }], (form) => {
    form.handleInput(KEYS.down);
    form.handleInput(KEYS.enter);
  });
  assert.equal(result.dismissed, false);
  assert.deepEqual(result.answers, [["Web"]]);
  assert.equal(buildContent(result), "Q1: Web");
});

test("multi-select toggles with Space, confirms with Enter and submits from the Submit tab", async () => {
  const questions = [
    { question: "Targets?", header: "Targets", multiSelect: true, options: [{ label: "API" }, { label: "UI" }, { label: "Docs" }] },
    { question: "Priority?", header: "Priority", options: [{ label: "High" }, { label: "Low" }] },
  ];
  const result = await run(questions, (form) => {
    form.handleInput(KEYS.space);          // API
    form.handleInput(KEYS.down);
    form.handleInput(KEYS.space);          // UI
    form.handleInput(KEYS.enter);          // confirm -> Priority tab
    form.handleInput(KEYS.enter);          // High -> Submit tab
    form.handleInput(KEYS.enter);          // submit
  });
  assert.deepEqual(result.answers, [["API", "UI"], ["High"]]);
  assert.deepEqual(answerLines(result.questions, result.answers), ["Targets: API, UI", "Priority: High"]);
});

test("custom answer opens an editor for single and multi questions", async () => {
  const single = await run([{ question: "Name?", options: [{ label: "A" }] }], (form) => {
    form.handleInput(KEYS.down);           // custom row
    form.handleInput(KEYS.enter);
    for (const char of "custom text") form.handleInput(char);
    form.handleInput(KEYS.enter);
  });
  assert.deepEqual(single.answers, [["custom text"]]);

  const multi = await run([{ question: "Pick", multiSelect: true, options: [{ label: "A" }] }], (form) => {
    form.handleInput(KEYS.space);          // toggle A
    form.handleInput(KEYS.down);
    form.handleInput(KEYS.space);          // open custom editor
    for (const char of "note") form.handleInput(char);
    form.handleInput(KEYS.enter);          // back to options
    form.handleInput(KEYS.enter);          // confirm selections
  });
  assert.deepEqual(multi.answers, [["A", "note"]]);
});

test("Escape dismisses the whole dialog; unanswered questions stay empty", async () => {
  const result = await run([{ question: "A?" }, { question: "B?" }], (form) => form.handleInput(KEYS.escape));
  assert.equal(result.dismissed, true);
  assert.equal(buildContent(result), "(question dismissed by user)");
  assert.deepEqual(result.answers, [[], []]);
});

test("render shows tabs, options, checked state and key hints", async () => {
  const questions = normalizeQuestions([
    { question: "Targets?", header: "Targets", multiSelect: true, options: [{ label: "API" }, { label: "UI" }] },
    { question: "Priority?", header: "Priority", options: [{ label: "High" }] },
  ]);
  const form = createQuestionForm(tui, theme, questions, () => {});
  const initial = form.render(80).join("\n");
  assert.match(initial, /Targets/); assert.match(initial, /Priority/); assert.match(initial, /Submit/);
  assert.match(initial, /API/); assert.match(initial, /Type your own answer/);
  form.handleInput(KEYS.space);
  const checked = form.render(80).join("\n");
  assert.match(checked, /\[x\] API/);
  assert.match(checked, /Space toggle/);
});

test("tool returns an error outside the terminal, and returns answers inside it", async () => {
  let tool;
  plugin.default({ registerTool(definition) { tool = definition; } });
  const questions = [{ question: "Scope?", options: [{ label: "CLI" }] }];
  const printResult = await tool.execute("t", { questions }, undefined, undefined, { mode: "print" });
  assert.equal(printResult.isError, true);
  assert.match(printResult.content[0].text, /interactive terminal/);
  assert.equal(printResult.details.dismissed, true);

  const tuiResult = await tool.execute("t", { questions }, undefined, undefined, {
    mode: "tui",
    ui: { custom: (factory) => new Promise((resolve) => factory(tui, theme, {}, resolve).handleInput(KEYS.enter)) },
  });
  assert.equal(tuiResult.isError, undefined);
  assert.equal(tuiResult.content[0].text, "Q1: CLI");
  assert.deepEqual(tuiResult.details.answers, [["CLI"]]);
});

test("tool reports validation errors as tool errors", async () => {
  let tool;
  plugin.default({ registerTool(definition) { tool = definition; } });
  const result = await tool.execute("t", { questions: [] }, undefined, undefined, { mode: "tui" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /At least one question/);
});

const ALT_M = "\x1bm";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeDictation() {
  const events = { starts: 0, cancels: 0, stops: 0, mutes: 0 };
  let target;
  let phase = "idle";
  const service = {
    phase: () => phase,
    snapshot: () => ({ phase, muted: false, elapsed: 7, level: 0.4, text: "черновик ответа" }),
    async start(next) { events.starts++; target = next; phase = "recording"; return true; },
    async stop() { events.stops++; phase = "idle"; },
    async cancel() { events.cancels++; phase = "idle"; target = undefined; },
    toggleMute() { events.mutes++; },
  };
  return { service, events, target: () => target };
}

function runWithDictation(questions, dictation, drive) {
  return new Promise((resolve) => {
    const form = createQuestionForm(tui, theme, normalizeQuestions(questions), resolve, dictation);
    Promise.resolve(drive(form)).catch((error) => { throw error; });
  });
}

const openCustomEditor = (form) => { form.handleInput(KEYS.down); form.handleInput(KEYS.enter); };

test("Alt+M dictates into the answer editor and keeps typed text", async () => {
  const fake = fakeDictation();
  let liveRender = "";
  const result = await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], fake.service, async (form) => {
    openCustomEditor(form);
    form.handleInput("typed");
    form.handleInput(ALT_M);
    assert.equal(fake.events.starts, 1);
    await tick();
    assert.match(form.render(60).join("\n"), /🎙 0:07/);
    fake.target().partial("черновик");
    liveRender = form.render(60).join("\n");
    fake.target().final(" голосом");
    form.handleInput(KEYS.enter);
  });
  assert.deepEqual(result.answers, [["typed голосом"]]);
  assert.match(liveRender, /черновик/);
});

test("Alt+M stops the recording it started and inserts one transcript", async () => {
  const fake = fakeDictation();
  const result = await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], fake.service, async (form) => {
    openCustomEditor(form);
    form.handleInput(ALT_M);
    await tick();
    form.handleInput(ALT_M);          // second press stops instead of restarting
    await tick();
    assert.equal(fake.events.starts, 1);
    assert.equal(fake.events.stops, 1);
    fake.target().final("итог");
    form.handleInput(KEYS.enter);
  });
  assert.deepEqual(result.answers, [["итог"]]);
});

test("a failed start reports inside the dialog and leaves the editor usable", async () => {
  const failures = { starts: 0 };
  const service = {
    phase: () => "idle",
    snapshot: () => ({ phase: "idle", muted: false, elapsed: 0, level: 0, text: "" }),
    async start(target) { failures.starts++; target.error("No Whisper model configured"); return false; },
    async stop() {},
    async cancel() {},
    toggleMute() {},
  };
  const result = await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], service, async (form) => {
    openCustomEditor(form);
    form.handleInput(ALT_M);
    await tick();
    const screen = form.render(60).join("\n");
    assert.match(screen, /No Whisper model configured/);
    assert.doesNotMatch(screen, /🎙/);
    form.handleInput("typed answer");
    form.handleInput(KEYS.enter);
  });
  assert.equal(failures.starts, 1);
  assert.deepEqual(result.answers, [["typed answer"]]);
});

test("leaving the answer editor cancels an active recording", async () => {
  const fake = fakeDictation();
  await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], fake.service, async (form) => {
    openCustomEditor(form);
    form.handleInput(ALT_M);
    await tick();
    form.handleInput(KEYS.escape);    // back out of the editor
    form.handleInput(KEYS.escape);    // dismiss the dialog
  });
  assert.equal(fake.events.cancels, 1);
});

test("a transcript that arrives after the dialog closed is dropped", async () => {
  const fake = fakeDictation();
  let lateTarget;
  await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], fake.service, async (form) => {
    openCustomEditor(form);
    form.handleInput(ALT_M);
    await tick();
    lateTarget = fake.target();
    form.handleInput(KEYS.escape);
    form.handleInput(KEYS.escape);
  });
  const cancelsBefore = fake.events.cancels;
  lateTarget.final("поздний текст");
  assert.equal(fake.events.cancels > cancelsBefore, true, "a late transcript cancels the stale recording");
});

test("without the voice extension the dialog says so instead of failing", async () => {
  const result = await runWithDictation([{ question: "Name?", options: [{ label: "A" }] }], undefined, (form) => {
    openCustomEditor(form);
    form.handleInput(ALT_M);
    assert.match(form.render(60).join("\n"), /voice extension is not/);
    form.handleInput("x");
    form.handleInput(KEYS.enter);
  });
  assert.deepEqual(result.answers, [["x"]]);
});

test("the dialog body sits inside the frame without a second indent", () => {
  const form = createQuestionForm(tui, theme, normalizeQuestions([
    { question: "Куда кладём состояние?", header: "Scope", options: [{ label: "В модуль", description: "простое" }] },
  ]), () => {}, undefined);
  const lines = form.render(70);
  assert.ok(lines[0].startsWith("╭─ question · Scope ─"), "titled frame");
  assert.ok(lines.at(-1).startsWith("╰"), "closed box");
  for (const line of lines) assert.equal(visibleWidth(line), 70, `line is not 70 wide: ${line}`);
  // One column of padding comes from the frame; the body must not add its own.
  const questionLine = lines.find((line) => line.includes("Куда кладём состояние?"));
  assert.ok(questionLine.startsWith("│ Куда кладём"), `unexpected indent: ${questionLine}`);
  const optionLine = lines.find((line) => line.includes("1. В модуль"));
  assert.ok(optionLine.startsWith("│ > 1. В модуль"), `unexpected indent: ${optionLine}`);
});
