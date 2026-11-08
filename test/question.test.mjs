import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";
const { normalizeQuestions, answerLines, buildContent } = await jiti.import("../extensions/question/normalize.ts");
const { createQuestionForm } = await jiti.import("../extensions/question/form.ts");
const plugin = await jiti.import("../extensions/question/index.ts");

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
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
