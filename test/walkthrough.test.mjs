import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const { parseUnifiedDiff, selectHunks, findFile, hunkSpan, clipHunk } = await jiti.import("../extensions/walkthrough/diff.ts");
const { TourView, tokenize, wordDiff, pairChanges } = await jiti.import("../extensions/walkthrough/render.ts");
const { default: plugin } = await jiti.import("../extensions/walkthrough/index.ts");

const plain = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
// Marks changed words so the pairing can be asserted without a terminal.
const theme = { ...plain, inverse: (text) => `⟦${text}⟧` };

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ function start
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
@@ -20,3 +21,3 @@ function other
 keep
-old
+new
 tail
diff --git a/docs/readme.md b/docs/readme.md
index 3333333..4444444 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1 @@
-hello
+world
`;

function load() {
  let definition;
  const sent = [];
  const renderers = new Map();
  plugin({
    registerTool(value) { definition = value; },
    sendMessage(message) { sent.push(message); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerCommand() {},
    events: { emit() {}, on() {} },
  });
  return Object.assign(definition, { sent, renderers });
}

async function repo(files) {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-walkthrough-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(dir, path), content);
    git("add", path);
  }
  git("commit", "-qm", "base");
  return { dir, git };
}

test("parses files, hunks and line numbers from a unified diff", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 2);
  const [app, docs] = files;
  assert.equal(app.path, "src/app.ts");
  assert.equal(app.hunks.length, 2);
  assert.equal(app.additions, 3);
  assert.equal(app.deletions, 2);
  assert.equal(app.hunks[0].context, "function start");
  assert.equal(app.hunks[0].header, "@@ -1,4 +1,5 @@");
  assert.deepEqual(app.hunks[0].lines.map((line) => line.kind), ["context", "del", "add", "add", "context"]);
  assert.deepEqual([app.hunks[0].lines[1].oldLine, app.hunks[0].lines[2].newLine], [2, 2]);
  assert.deepEqual(hunkSpan(app.hunks[1]), [21, 23]);
  assert.equal(docs.hunks[0].lines.at(-1).text, "world");
});

test("selects hunks by index, by line range, and defaults to the first ones", () => {
  const [app] = parseUnifiedDiff(SAMPLE);
  assert.deepEqual(selectHunks(app, { hunk: 2 }).hunks.map((h) => h.newStart), [21]);
  assert.deepEqual(selectHunks(app, { lines: [22, 22] }).hunks.map((h) => h.newStart), [21]);
  assert.deepEqual(selectHunks(app, { lines: [2, 3] }).hunks.map((h) => h.newStart), [1]);
  assert.equal(selectHunks(app, {}).hunks.length, 2);
  assert.match(selectHunks(app, { hunk: 9 }).reason, /does not exist/);
  assert.match(selectHunks(app, { lines: [900, 999] }).reason, /no hunk covers/);
  assert.equal(findFile(parseUnifiedDiff(SAMPLE), "app.ts").path, "src/app.ts");
  assert.equal(findFile(parseUnifiedDiff(SAMPLE), "./docs/readme.md").path, "docs/readme.md");
  assert.equal(findFile(parseUnifiedDiff(SAMPLE), "nope.ts"), undefined);
});

test("word diff marks only the tokens that changed and pairs -/+ runs", () => {
  assert.deepEqual(tokenize("a  b"), ["a", "  ", "b"]);
  assert.deepEqual(tokenize("2;"), ["2", ";"]);
  const diff = wordDiff("const b = 2;", "const b = 3;");
  assert.deepEqual(diff.before, [{ text: "const b = ", changed: false }, { text: "2", changed: true }, { text: ";", changed: false }]);
  assert.deepEqual(diff.after, [{ text: "const b = ", changed: false }, { text: "3", changed: true }, { text: ";", changed: false }]);
  assert.deepEqual(wordDiff("same", "same"), { before: [{ text: "same", changed: false }], after: [{ text: "same", changed: false }] });

  const lines = [
    { kind: "context" }, { kind: "del" }, { kind: "del" }, { kind: "add" }, { kind: "context" },
  ];
  assert.deepEqual([...pairChanges(lines)], [[1, 3]]);
});

test("registers a block renderer that draws the tour and ignores foreign payloads", () => {
  const definition = load();
  const renderer = definition.renderers.get("pi-core:walkthrough");
  assert.equal(typeof renderer, "function");
  const tour = { title: "T", base: "HEAD", fileCount: 1, additions: 1, deletions: 0, stops: [] };
  const component = renderer({ customType: "pi-core:walkthrough", content: "T", display: true, details: { tour } }, { expanded: false, outputPad: 1 }, theme);
  assert.ok(component);
  assert.match(component.render(60).join("\n"), /changes tour/);
  assert.equal(renderer({ customType: "pi-core:walkthrough", content: "x", display: true }, { expanded: false, outputPad: 0 }, theme), undefined);
});

test("an all-added hunk falls back to plain code when highlighting is unavailable", () => {
  const [file] = parseUnifiedDiff("diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n");
 const view = new TourView({
    title: "New file",
    base: "HEAD",
    fileCount: 1,
    additions: 2,
    deletions: 0,
    stops: [{ title: "New", why: "Whole file", file: "new.ts", hunks: file.hunks }],
  }, theme);
  const screen = view.render(80).join("\n");
  assert.match(screen, /\+ const a = 1;/);
  assert.match(screen, /\+ const b = 2;/);
});

test("a line range clips the hunk to the requested lines plus context", () => {
  const [app] = parseUnifiedDiff(SAMPLE);
  const clipped = clipHunk(app.hunks[0], 2, 3, 0);
  assert.deepEqual(clipped.lines.map((line) => line.text), ["const b = 3;", "const c = 4;"]);
  assert.equal(clipped.header, app.hunks[0].header);
  const withContext = clipHunk(app.hunks[0], 1, 1, 1);
  assert.deepEqual(withContext.lines.map((line) => line.newLine ?? line.oldLine), [1, 2, 2]);
  assert.equal(clipHunk(app.hunks[0], 900, 999), undefined);
});

test("renders the tour with diff colors, the reasoning and the header counts", () => {
  const view = new TourView({
    title: "Dictation reaches the dialog",
    intro: "The dialog now owns the recording.",
    base: "HEAD → working tree",
    fileCount: 2,
    additions: 3,
    deletions: 2,
    stops: [
      { title: "Borrow the microphone", why: "The overlay holds focus, so the global shortcut never fires.", file: "src/app.ts", hunkLabel: "hunk 1/2", hunks: parseUnifiedDiff(SAMPLE)[0].hunks.slice(0, 1) },
      { title: "Missing file", why: "Should warn.", file: "gone.ts", hunks: [], warning: "gone.ts is not part of this diff" },
    ],
  }, theme);
  const lines = view.render(72);
  const screen = lines.join("\n");
  assert.match(screen, /changes tour · Dictation reaches the dialog/);
  assert.match(screen, /2 files · \+3 −2 · 2 stops/);
  assert.match(screen, /function start/);
  assert.match(screen, /\+ const c = 4;/);
  assert.match(screen, /- const b = ⟦2⟧;/);
  assert.match(screen, /\+ const b = ⟦3⟧;/);
  assert.match(screen, /- const b = ⟦2⟧;/);
  assert.match(screen, /why {2}The overlay holds focus/);
  assert.match(screen, /gone\.ts is not part of this diff/);
  for (const line of lines) assert.ok(line.length <= 200, `unbounded line: ${line}`);
});

test("presents a real git diff, picks hunks and reports the summary", async () => {
  const padding = Array.from({ length: 30 }, (_, index) => `const n${index} = ${index};`).join("\n");
  const { dir, git } = await repo({ "app.js": `${padding}\n`, "other.txt": "keep\n" });
  try {
    await writeFile(join(dir, "app.js"), padding.replace("const n19 = 19;", "const n19 = 19;\nexport const b = 2;"));
    await writeFile(join(dir, "other.txt"), "changed\n");
    const definition = load();
    const result = await definition.execute("id", {
      title: "Two files",
      base: "HEAD",
      stops: [
        { title: "New export", why: "The dialog needs ab", file: "app.js", hunk: 1 },
        { title: "Copy change", why: "Words", file: "other.txt", lines: [1, 1] },
      ],
    }, undefined, undefined, { cwd: dir });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Walkthrough shown against HEAD → working tree: 2 files, \+3\/−2, 2 stops/);
    assert.match(result.content[0].text, /1\. New export \(app.js, hunk 1\)/);
    assert.equal(result.details.stops[0].file, "app.js");
    assert.deepEqual(result.details.stops[0].hunks, [1]);
    assert.equal(result.details.fileCount, 2);
    const block = definition.sent.at(-1);
    assert.equal(block.customType, "pi-core:walkthrough");
    assert.equal(block.display, true);
    assert.equal(block.details.tour.stops.length, 2);

    const focused = await definition.execute("id", {
      base: "HEAD",
      stops: [{ title: "Just b", why: "One line", file: "app.js", lines: [20, 20] }],
    }, undefined, undefined, { cwd: dir });
    const focusedHunk = definition.sent.at(-1).details.tour.stops[0].hunks[0];
    const wholeHunk = block.details.tour.stops[0].hunks[0];
    assert.ok(focusedHunk.lines.length < wholeHunk.lines.length, "a line range must show fewer lines than the whole hunk");
    assert.ok(focusedHunk.lines.some((line) => line.text === "export const b = 2;"));

    const screen = new TourView(block.details.tour, theme).render(70).join("\n");
    assert.match(screen, /\+ export const b = 2;/);
    assert.match(screen, /why {2}The dialog needs ab/);
    git("checkout", "--", ".");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compares against a named revision and rejects bad input", async () => {
  const { dir, git } = await repo({ "app.js": "one\n" });
  try {
    await writeFile(join(dir, "app.js"), "two\n");
    git("commit", "-qam", "change");
    const definition = load();
    const committed = await definition.execute("id", { base: "HEAD~1", stops: [{ title: "Diff vs parent", why: "Shows the commit", file: "app.js" }] }, undefined, undefined, { cwd: dir });
    assert.match(committed.content[0].text, /HEAD~1 → working tree/);
    assert.match(committed.content[0].text, /\+1\/−1/);

    const badBase = await definition.execute("id", { base: "no-such-ref", stops: [{ title: "x", why: "y", file: "app.js" }] }, undefined, undefined, { cwd: dir });
    assert.equal(badBase.isError, true);
    assert.match(badBase.content[0].text, /Unknown base revision "no-such-ref"/);

    const noStops = await definition.execute("id", { stops: [] }, undefined, undefined, { cwd: dir });
    assert.equal(noStops.isError, true);
    assert.match(noStops.content[0].text, /at least one stop/);

    const tooMany = await definition.execute("id", { stops: Array.from({ length: 13 }, () => ({ title: "t", why: "w" })) }, undefined, undefined, { cwd: dir });
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.content[0].text, /at most 12/);

    const missingFile = await definition.execute("id", { base: "HEAD~1", stops: [{ title: "Ghost", why: "Not there", file: "ghost.js" }] }, undefined, undefined, { cwd: dir });
    assert.match(missingFile.details.stops[0].warning, /file not in diff/);

    const notRepo = await definition.execute("id", { stops: [{ title: "x", why: "y" }] }, undefined, undefined, { cwd: tmpdir() });
    assert.equal(notRepo.isError, true);
    assert.match(notRepo.content[0].text, /Not a git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty change set says so instead of rendering an empty tour", async () => {
  const { dir } = await repo({ "app.js": "one\n" });
  try {
    const definition = load();
    const clean = await definition.execute("id", { stops: [{ title: "x", why: "y", file: "app.js" }] }, undefined, undefined, { cwd: dir });
    assert.equal(clean.isError, true);
    assert.match(clean.content[0].text, /no changes against HEAD/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walkthrough mirrors the explanations into open Neovim buffers", async () => {
  const { dir } = await repo({ "app.js": "one\ntwo\nthree\n" });
  const binDir = await mkdtemp(join(tmpdir(), "pi-core-walk-nvim-"));
  const log = join(binDir, "requests.log");
  const bin = join(binDir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(JSON.parse(process.env.PI_TOUR_REQUEST)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, result: { annotated: 1 } }) + "\\n");
`);
  await chmod(bin, 0o755);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-walk-annot.sock";
  process.env.PI_TOUR_NVIM_BIN = bin;
  try {
    await writeFile(join(dir, "app.js"), "one\nTWO\nthree\n");
    const definition = load();
    await definition.execute("id", {
      stops: [{ title: "Rename the constant", why: "The dialog needs it", file: "app.js", lines: [2, 2] }],
    }, undefined, undefined, { cwd: dir });
    const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "annotate");
    assert.equal(requests[0].file, "app.js");
    assert.deepEqual(requests[0].items, [{ from_line: 2, header: "Rename the constant", text: "The dialog needs it" }]);

    await writeFile(log, "");
    await definition.execute("id", { annotate: false, stops: [{ title: "x", why: "y", file: "app.js", lines: [2, 2] }] }, undefined, undefined, { cwd: dir });
    assert.equal((await readFile(log, "utf8")).trim(), "", "annotate:false must not talk to Neovim");
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
    await rm(dir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("/story starts a turn that narrates the change set and hands off to Neovim", async () => {
  const commands = new Map();
  const messages = [];
  plugin({
    registerTool() {},
    registerMessageRenderer() {},
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(content) { messages.push(content); },
  });
  const notified = [];
  await commands.get("story").handler("--base origin/main extensions/", { ui: { notify(text) { notified.push(text); } } });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /base origin\/main, limited to extensions\//);
  assert.match(messages[0], /Call the `walkthrough` tool with 3-6 stops/);
  assert.match(messages[0], /Stop there\. Do not ask me questions, do not propose options/);
  assert.doesNotMatch(messages[0], /`question` tool/);
  assert.match(messages[0], /the review panel opens on these stops by itself/);

  assert.deepEqual(notified, ["Walking through base origin/main, limited to extensions/."]);

  await commands.get("story").handler("", { ui: { notify() {} } });
  assert.match(messages[1], /the default base \(uncommitted work, the branch point, or the last commit\), the whole change set/);
});

test("without a base the tour shows the last commit when nothing else is left", async () => {
  const { dir, git } = await repo({ "app.js": "one\n" });
  try {
    await writeFile(join(dir, "app.js"), "one\ntwo\n");
    git("commit", "-qam", "second");
    const definition = load();
    const result = await definition.execute("id", { stops: [{ title: "The added line", why: "It is the change", file: "app.js" }] }, undefined, undefined, { cwd: dir });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /HEAD~1 → working tree/);
    assert.match(result.content[0].text, /\+1\/−0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the chat block is one slide; the stops are flipped in the slider", () => {
  const files = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n");
  const tour = {
    title: "Two stops", base: "HEAD", fileCount: 1, additions: 1, deletions: 0,
    stops: [
      { title: "First", why: "first reason", file: "a.ts", hunkLabel: "hunk 1/1", hunks: files[0].hunks },
      { title: "Second", why: "second reason", file: "a.ts", hunkLabel: "hunk 1/1", hunks: files[0].hunks },
    ],
  };
  const slider = new TourView(tour, theme, 0, true).render(70).join("\n");
  assert.match(slider, /1\/2 First/, "the first stop is the slide");
  assert.match(slider, /first reason/);
  assert.doesNotMatch(slider, /Second/, "the rest of the stops are not listed");
  assert.doesNotMatch(slider, /second reason/);
  assert.match(slider, /slide 1\/2 · \]t \[t flip the stops in the review slider/);

  // Without the slider flag the whole tour is still rendered (overview use).
  const full = new TourView(tour, theme).render(70).join("\n");
  assert.match(full, /Second/);
  assert.match(full, /second reason/);
});
