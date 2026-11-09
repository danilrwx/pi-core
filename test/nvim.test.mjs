import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";
const { parseDiffHunks, buildStops, newFileStop, deletedLineCount } = await jiti.import("../extensions/nvim/plan.ts");
const { planTour, resolveTourBase, default: nvimTour } = await jiti.import("../extensions/nvim/index.ts");

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-tour-"));
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "T");
  await writeFile(join(cwd, "a.ts"), Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
  git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "init");
  const lines = Array.from({ length: 30 }, (_, i) => i === 2 || i === 24 ? `changed-${i + 1}` : `line-${i + 1}`);
  await writeFile(join(cwd, "a.ts"), lines.join("\n") + "\n");
  await writeFile(join(cwd, "b.ts"), "new-1\nnew-2\n");
  return cwd;
}

test("diff parser reads hunk ranges, including deletions", () => {
  const diff = [
    "+++ b/a.ts", "@@ -1,2 +1,3 @@ x", "@@ -10 +11 @@ y", "@@ -20,3 +20,0 @@ gone",
    "+++ /dev/null", "@@ -1 +0,0 @@", "+++ b/new.ts", "@@ -0,0 +1,2 @@",
  ].join("\n");
  assert.deepEqual(parseDiffHunks(diff), [
    { file: "a.ts", from: 1, to: 3, added: [], deleted: [] },
    { file: "a.ts", from: 11, to: 11, added: [], deleted: [] },
    { file: "a.ts", from: 20, to: 21, added: [], deleted: [] },
    { file: "new.ts", from: 1, to: 2, added: [], deleted: [] },
  ]);
});

test("removed lines keep the position and the old line number they had", () => {
  const diff = [
    "+++ b/a.ts",
    "@@ -10,4 +10,0 @@ gone",
    "-one",
    "-two",
    "@@ -30,1 +27,1 @@ swap",
    "-old",
    "+new",
  ].join("\n");
  const [removed, swapped] = parseDiffHunks(diff);
  assert.deepEqual(removed.deleted, [{ at: 10, lines: [{ old: 10, text: "one" }, { old: 11, text: "two" }] }]);
  assert.deepEqual(swapped.deleted, [{ at: 27, lines: [{ old: 30, text: "old" }] }]);
  assert.deepEqual(swapped.added, [27]);
  assert.equal(deletedLineCount(removed), 2);
  assert.equal(deletedLineCount({ deleted: [] }), 0);
});

test("buildStops expands context, merges nearby hunks and caps sizes", () => {
  const merged = buildStops([{ file: "a", from: 10, to: 10 }, { file: "a", from: 14, to: 14 }], { context: 5 });
  assert.equal(merged.stops.length, 1);
  assert.equal(merged.stops[0].expandedFrom, 5);
  assert.equal(merged.stops[0].expandedTo, 19);
  const capped = buildStops([{ file: "a", from: 100, to: 110 }], { context: 20, maxLines: 5 });
  assert.equal(capped.stops[0].expandedFrom, 80);
  assert.equal(capped.stops[0].expandedTo, 89);
  assert.equal(buildStops([{ file: "a", from: 1, to: 1 }], { maxStops: 1 }).stops.length, 1);
  assert.deepEqual(newFileStop("n", 100, 40), { file: "n", from: 1, to: 40, expandedFrom: 1, expandedTo: 40, kind: "new-file", added: Array.from({ length: 40 }, (_, i) => i + 1), deleted: [] });
});

test("planTour combines working-tree hunks and untracked files, and filters paths", async () => {
  const cwd = await repo();
  const plan = await planTour(cwd);
  assert.equal(plan.base, "HEAD");
  assert.ok(plan.stops.some((stop) => stop.file === "b.ts" && stop.kind === "new-file"));
  const aStops = plan.stops.filter((stop) => stop.file === "a.ts");
  assert.equal(aStops.length, 2);
  const onlyB = await planTour(cwd, { paths: ["b.ts"] });
  assert.deepEqual(onlyB.stops.map((stop) => stop.file), ["b.ts"]);
});

test("review_tour drives Neovim stops and finishes with a question hint", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "pi-core-tour-bin-"));
  const bin = join(dir, "fake-nvim");
  const stateFile = join(dir, "fake-state.json");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
const file = ${JSON.stringify(stateFile)};
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { index: 0, stops: [] };
const save = (state) => fs.writeFileSync(file, JSON.stringify(state));
const state = load();
let result;
if (req.method === "status") result = { connected: true };
else if (req.method === "install") { state.stops = req.stops || []; state.index = 0; save(state); result = { installed: true }; }
else if (req.method === "tour.clear") { state.stops = []; state.index = 0; save(state); result = { cleared: true }; }
else if (req.method === "tour.status") result = { index: state.index, total: state.stops.length, file: state.stops[state.index - 1]?.file };
else if (req.method === "tour.next" || req.method === "tour.prev") {
  state.index = Math.max(1, Math.min(state.stops.length, state.index + (req.method === "tour.next" ? 1 : -1)));
  save(state);
  const stop = state.stops[state.index - 1];
  result = { file: stop.file, from_line: stop.expandedFrom, to_line: stop.expandedTo, text: "shown " + stop.file.split("/").pop() };
} else result = { file: req.file, from_line: req.from_line, to_line: req.to_line, text: "shown " + (req.file || "").split("/").pop() };
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-fake.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  const tools = new Map();
  nvimTour({ registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {} });
  const tool = tools.get("review_tour");
  const context = { cwd, mode: "tui", sessionManager: { getSessionId: () => "tour-test" } };
  try {
    const start = await tool.execute("t", { action: "start", context: 2 }, undefined, undefined, context);
    assert.match(start.content[0].text, /Tour 1\/3/);
    assert.match(start.content[0].text, /shown (a|b)\.ts/);
    assert.equal(start.details.index, 0);
    const next = await tool.execute("t", { action: "next" }, undefined, undefined, context);
    assert.match(next.content[0].text, /Tour 2\/3/);
    const status = await tool.execute("t", { action: "status" }, undefined, undefined, context);
    assert.match(status.content[0].text, /Tour 2\/3/);
    const prev = await tool.execute("t", { action: "prev" }, undefined, undefined, context);
    assert.match(prev.content[0].text, /Tour 1\/3/);
    const end = await tool.execute("t", { action: "prev" }, undefined, undefined, context);
    assert.match(end.content[0].text, /Already at the first stop/);
    await tool.execute("t", { action: "stop" }, undefined, undefined, context);
    const gone = await tool.execute("t", { action: "status" }, undefined, undefined, context);
    assert.match(gone.content[0].text, /No tour/);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("review_tour reports a missing Neovim connection", async () => {
  const previous = { socket: process.env.PI_NVIM_SOCKET, session: process.env.TMUX };
  delete process.env.PI_NVIM_SOCKET; delete process.env.DUET_NVIM_SOCKET; delete process.env.NVIM_LISTEN_ADDRESS; delete process.env.TMUX;
  const tools = new Map();
  nvimTour({ registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {} });
  const tool = tools.get("review_tour");
  try {
    await assert.rejects(tool.execute("t", { action: "start" }, undefined, undefined, { cwd: process.cwd(), mode: "tui", sessionManager: { getSessionId: () => "s" } }), /tmux|not connected/);
  } finally {
    if (previous.socket !== undefined) process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.session !== undefined) process.env.TMUX = previous.session;
  }
});

test("overview opens one snapshot and tells the model to ask once about direction", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "pi-core-tour-snap-"));
  const log = join(dir, "requests.log");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
fs.appendFileSync(${JSON.stringify(log)}, req.method + "\\n");
process.stdout.write(JSON.stringify({ ok: true, result: { file: "pi://review", text: "snapshot", lines: (req.lines || []).length } }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN, tmux: process.env.TMUX };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-fake.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  const tools = new Map();
  nvimTour({ registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {} });
  const tool = tools.get("review_tour");
  try {
    const result = await tool.execute("t", { action: "overview" }, undefined, undefined, { cwd, mode: "tui", sessionManager: { getSessionId: () => "overview-test" } });
    assert.match(result.content[0].text, /Snapshot of 3 stops/);
    assert.match(result.content[0].text, /Ask the user with the question tool about the architecture/);
    assert.match(execFileSync("cat", [log], { encoding: "utf8" }), /snapshot/);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
    if (previous.tmux === undefined) delete process.env.TMUX; else process.env.TMUX = previous.tmux;
  }
});

test("ensureNvim opens a new tmux window when no socket responds", async () => {
  const { ensureNvim } = await import("../extensions/nvim/spawn.ts").catch(() => import("./host.mjs").then(async ({ jiti }) => jiti.import("../extensions/nvim/spawn.ts")));
  const dir = await mkdtemp(join(tmpdir(), "pi-core-tour-tmux-"));
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
process.stdout.write(JSON.stringify({ ok: true, result: { connected: true } }) + "\\n");
`);
  const tmux = join(dir, "fake-tmux");
  await writeFile(tmux, `#!${process.execPath}
const fs = require("node:fs");
const command = process.argv.at(-1) || "";
const match = /--listen '([^']+)'/.exec(command);
if (!match) { console.error("no socket in " + command); process.exit(2); }
fs.writeFileSync(match[1], "");
`);
  execFileSync("chmod", ["755", bin, tmux]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN, tmux: process.env.PI_TOUR_TMUX_BIN, session: process.env.TMUX };
  delete process.env.PI_NVIM_SOCKET; delete process.env.DUET_NVIM_SOCKET; delete process.env.NVIM_LISTEN_ADDRESS;
  process.env.PI_TOUR_NVIM_BIN = bin; process.env.PI_TOUR_TMUX_BIN = tmux; process.env.TMUX = "fake-session";
  try {
    const result = await ensureNvim(dir);
    assert.equal(result.opened, true);
    assert.ok(result.socket.startsWith("/tmp/pi-tour-"));
    assert.equal(process.env.PI_NVIM_SOCKET, result.socket);
  } finally {
    for (const [key, value] of [["PI_NVIM_SOCKET", previous.socket], ["PI_TOUR_NVIM_BIN", previous.bin], ["PI_TOUR_TMUX_BIN", previous.tmux], ["TMUX", previous.session]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("ensureNvim refuses to auto-open outside tmux", async () => {
  const { jiti } = await import("./host.mjs");
  const { ensureNvim } = await jiti.import("../extensions/nvim/spawn.ts");
  const previous = { socket: process.env.PI_NVIM_SOCKET, session: process.env.TMUX };
  delete process.env.PI_NVIM_SOCKET; delete process.env.DUET_NVIM_SOCKET; delete process.env.NVIM_LISTEN_ADDRESS; delete process.env.TMUX;
  try { await assert.rejects(ensureNvim(process.cwd()), /tmux/); }
  finally {
    if (previous.socket !== undefined) process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.session !== undefined) process.env.TMUX = previous.session;
  }
});

test("Neovim comments arrive in pi over the session socket", async () => {
  const { jiti } = await import("./host.mjs");
  const { connect } = await import("node:net");
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { commentSocketPath } = await jiti.import("../extensions/nvim/index.ts");
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-comments-"));
  const handlers = new Map(), messages = [];
  const pi = {
    registerTool() {}, registerCommand() {}, on(name, handler) { handlers.set(name, handler); },
    registerEntryRenderer() {}, appendEntry() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const previous = process.env.PI_NVIM_SOCKET; delete process.env.PI_NVIM_SOCKET;
  nvimTour(pi);
  const statuses = [];
  const context = { cwd, mode: "tui", sessionManager: { getSessionId: () => "comments-test" },
    ui: { setStatus(key, value) { statuses.push([key, value]); } } };
  await handlers.get("session_start")({}, context);
  const path = commentSocketPath("comments-test");
  try {
    const socket = connect(path);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(JSON.stringify({ type: "comment", id: "12", file: join(cwd, "a.ts"), from: 4, to: 6, text: "Why this branch?" }) + "\n");
    for (let i = 0; i < 100 && !messages.length; i++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.customType, "nvim-comment");
    assert.match(messages[0].message.content, /a\.ts:4-6/);
    assert.match(messages[0].message.content, /Why this branch\?/);
    assert.match(messages[0].message.content, /comment_reply/);
    assert.equal(messages[0].message.details.id, "12");
    assert.equal(messages[0].options.deliverAs, "steer");
    socket.write(JSON.stringify({ type: "status", file: join(cwd, "a.ts"), lsp: ["gopls"], errors: 2, warnings: 1, dirty: 3 }) + "\n");
    for (let i = 0; i < 100 && !statuses.some(([key]) => key === "nvim"); i++) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(statuses.at(-1), ["nvim", "NVIM · gopls · 2E 1W · 3 dirty"]);
    socket.end();
  } finally {
    await handlers.get("session_shutdown")({}, context);
    if (previous !== undefined) process.env.PI_NVIM_SOCKET = previous;
  }
});

test("diff parser records added line numbers and removed text", () => {
  const diff = ["+++ b/a.ts", "@@ -2,2 +2,3 @@", "-old line", "+new one", "+new two", " context"].join("\n");
  const [hunk] = parseDiffHunks(diff);
  assert.deepEqual(hunk.added, [2, 3]);
  assert.deepEqual(hunk.deleted, [{ at: 2, lines: [{ old: 2, text: "old line" }] }]);
  assert.equal(hunk.from, 2);
  assert.equal(hunk.to, 4);
});

test("comment_reply posts the answer into the Neovim thread and can resolve it", async () => {
  const { jiti } = await import("./host.mjs");
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "pi-comment-reply-"));
  const log = join(dir, "requests.log");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, result: { id: req.id, status: req.resolve ? "resolved" : "answered" } }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  const tools = new Map();
  nvimTour({ registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {} });
  try {
    const result = await tools.get("comment_reply").execute("t", { id: "7", text: "Fixed in controller.go", resolve: true }, undefined, undefined, { cwd: dir });
    assert.match(result.content[0].text, /comment #7 \(resolved\)/);
    const sent = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1));
    assert.equal(sent.method, "comment.reply");
    assert.equal(sent.id, "7");
    assert.equal(sent.resolve, true);
    assert.equal(sent.author, "pi");
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("/tour start leaves a breadcrumb, a footer status and a hint for the model", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "pi-core-tour-cmd-"));
  const stateFile = join(dir, "fake-state.json");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
const file = ${JSON.stringify(stateFile)};
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { index: 0, stops: [] };
const save = (state) => fs.writeFileSync(file, JSON.stringify(state));
const state = load();
let result;
if (req.method === "status") result = { connected: true };
else if (req.method === "install") { state.stops = req.stops || []; state.index = 0; save(state); result = { installed: true }; }
else if (req.method === "tour.clear") { state.stops = []; save(state); result = { cleared: true }; }
else if (req.method === "tour.status") result = { index: state.index, total: state.stops.length };
else if (req.method === "tour.next" || req.method === "tour.prev") {
  state.index = Math.max(1, Math.min(state.stops.length, state.index + (req.method === "tour.next" ? 1 : -1)));
  save(state);
  const stop = state.stops[state.index - 1];
  result = { file: stop.file, from_line: stop.expandedFrom, to_line: stop.expandedTo, text: "shown" };
} else result = { file: req.file, from_line: req.from_line, to_line: req.to_line, text: "shown" };
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-fake-cmd.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  const commands = new Map(), entries = [], statuses = [], messages = [], userMessages = [], renderers = new Map();
  nvimTour({
    registerTool() {}, on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerEntryRenderer(type, renderer) { renderers.set(type, renderer); },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(message, options) { messages.push({ message, options }); },
    sendUserMessage(content) { userMessages.push(content); },
  });
  const context = {
    cwd, mode: "tui",
    sessionManager: { getSessionId: () => "tour-cmd" },
    ui: { notify() {}, setStatus(key, value) { statuses.push([key, value]); } },
  };
  try {
    await commands.get("tour").handler("start --plain", context);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "pi-core:tour");
    assert.equal(entries[0].data.index, 1);
    assert.equal(entries[0].data.total, 3);
    assert.match(entries[0].data.file, /\.ts$/);
    assert.deepEqual(statuses.at(-1), ["tour", "tour 1/3"]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.display, false);
    assert.equal(messages[0].options.deliverAs, "nextTurn");
    assert.match(messages[0].message.content, /stop 1\/3/);

    await commands.get("tour").handler("next", context);
    assert.equal(entries.at(-1).data.index, 2);
    assert.deepEqual(statuses.at(-1), ["tour", "tour 2/3"]);

    await commands.get("tour").handler("stop", context);
    assert.deepEqual(statuses.at(-1), ["tour", undefined]);

    // The breadcrumb renders where the chat is; without data it stays invisible.
    const theme = { fg: (_token, text) => text, bold: (text) => text };
    const renderer = renderers.get("pi-core:tour");
    const card = renderer({ data: entries[0].data }, { expanded: false }, theme).render(60).join("\n");
    assert.match(card, /tour 1\/3/);
    assert.match(card, /\]t \[t move/);
    assert.equal(renderer({ data: undefined }, { expanded: false }, theme), undefined);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("review_tour stores the explanation as an annotation on the stop", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "pi-core-tour-note-"));
  const log = join(dir, "requests.log");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
const stops = [{ expandedFrom: 1, expandedTo: 6 }, { expandedFrom: 20, expandedTo: 26 }];
let result = { connected: true };
if (req.method === "install") result = { installed: true };
else if (req.method === "tour.next" || req.method === "tour.prev") {
  const index = req.method === "tour.next" ? 1 : 0;
  result = { file: "a.ts", from_line: stops[index].expandedFrom, to_line: stops[index].expandedTo, text: "shown" };
} else if (req.method === "tour.note") result = { index: req.index, rendered: true };
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-fake-note.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  const tools = new Map();
  nvimTour({ registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {} });
  const tool = tools.get("review_tour");
  const context = { cwd, mode: "tui", sessionManager: { getSessionId: () => "note-test" } };
  try {
    await tool.execute("t", { action: "start", context: 1, note: "Why the first stop exists" }, undefined, undefined, context);
    await tool.execute("t", { action: "next", note: "Why the second stop exists" }, undefined, undefined, context);
    await tool.execute("t", { action: "next" }, undefined, undefined, context);
    const notes = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((req) => req.method === "tour.note");
    assert.deepEqual(notes.map((req) => [req.index, req.text]), [
      [1, "Why the first stop exists"],
      [2, "Why the second stop exists"],
    ], "a note is only sent when the call carries one");
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
    await rm(dir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a tour of committed work falls back to the branch point instead of saying nothing changed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-base-"));
  try {
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.email", "t@example.com");
    git(cwd, "config", "user.name", "T");
    await writeFile(join(cwd, "a.ts"), "line-1\nline-2\nline-3\n");
    git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "init");
    const mainSha = git(cwd, "rev-parse", "HEAD").trim();
    git(cwd, "switch", "-q", "-c", "feature");
    await writeFile(join(cwd, "a.ts"), "line-1\nline-2 changed\nline-3\nline-4\n");
    git(cwd, "commit", "-qam", "feature work");

    // Clean tree: HEAD alone would show nothing.
    assert.equal(git(cwd, "diff", "--name-only", "HEAD").trim(), "");
    const base = await resolveTourBase(cwd);
    assert.equal(base, mainSha);
    const plan = await planTour(cwd);
    assert.equal(plan.base, mainSha);
    assert.ok(plan.stops.length > 0, "the committed change must be part of the tour");

    // Uncommitted work keeps HEAD as the base, and an explicit base wins.
    await writeFile(join(cwd, "a.ts"), "line-1\nline-2 changed again\nline-3\nline-4\n");
    assert.equal(await resolveTourBase(cwd), "HEAD");
    assert.equal((await planTour(cwd, { base: mainSha })).base, mainSha);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/tour start takes --base and explains an empty tour", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-base-cmd-"));
  const dir = await mkdtemp(join(tmpdir(), "pi-core-base-bin-"));
  const log = join(dir, "requests.log");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(JSON.parse(process.env.PI_TOUR_REQUEST)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, result: { connected: true, file: "a.ts", from_line: 1, to_line: 2, text: "shown" } }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-base.sock"; process.env.PI_TOUR_NVIM_BIN = bin;
  try {
    git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "T");
    await writeFile(join(cwd, "a.ts"), "one\n");
    git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "init");
    const base = git(cwd, "rev-parse", "HEAD").trim();
    await writeFile(join(cwd, "a.ts"), "one\ntwo\n");
    git(cwd, "commit", "-qam", "second");

    const commands = new Map(), messages = [];
    nvimTour({
      registerTool() {}, on() {}, registerEntryRenderer() {}, appendEntry() {},
      sendMessage(message) { messages.push(message); },
      registerCommand(name, command) { commands.set(name, command); },
    });
    const notified = [];
    const context = {
      cwd, mode: "tui", sessionManager: { getSessionId: () => "base-cmd" },
      ui: { notify(text) { notified.push(text); }, setStatus() {} },
    };
    await commands.get("tour").handler(`start --base ${base} --plain`, context);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(requests.some((request) => request.method === "install"));
    assert.match(notified.at(-1), /Tour 1\//);

    // Empty diff against the given base: say what was compared and how to fix it.
    notified.length = 0;
    await commands.get("tour").handler("start --base HEAD --plain", context);
    assert.match(notified.at(-1), /No changes against HEAD/);
    assert.match(notified.at(-1), /--base origin\/main/);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
    await rm(cwd, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("/tour start reuses the walkthrough of this session and re-plans when the diff moved on", async () => {
  const cwd = await repo();
  const dir = await mkdtemp(join(tmpdir(), "pi-core-reuse-"));
  const log = join(dir, "requests.log");
  const bin = join(dir, "fake-nvim");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
let result = { connected: true, annotated: 1, installed: true };
if (req.method === "tour.next" || req.method === "tour.prev") {
  const stop = (req.stops && req.stops[0]) || {};
  result = { file: "a.ts", from_line: 1, to_line: 2, text: "shown" };
}
if (req.method === "status") result = { connected: true };
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
`);
  execFileSync("chmod", ["755", bin]);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/pi-tour-reuse.sock";
  process.env.PI_TOUR_NVIM_BIN = bin;
  try {
    const { default: walkthroughPlugin } = await jiti.import("../extensions/walkthrough/index.ts");
    let walkthrough;
    walkthroughPlugin({ registerTool(definition) { walkthrough = definition; }, sendMessage() {}, registerMessageRenderer() {}, registerCommand() {}, events: { emit() {}, on() {} } });
    await walkthrough.execute("w", {
      base: "HEAD",
      stops: [{ title: "First stop", why: "Because the dialog needs it", file: "a.ts", lines: [3, 3] }],
    }, undefined, undefined, { cwd });

    const commands = new Map(), notified = [];
    nvimTour({
      registerTool() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
      registerCommand(name, command) { commands.set(name, command); },
    });
    const context = {
      cwd, mode: "tui", sessionManager: { getSessionId: () => "reuse" },
      ui: { notify(text) { notified.push(text); }, setStatus() {} },
    };

    await commands.get("tour").handler("start", context);
    let install = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((request) => request.method === "install").at(-1);
    assert.equal(install.stops.length, 1);
    assert.equal(install.stops[0].note, "Because the dialog needs it", "the walkthrough explanation becomes the annotation");
    assert.equal(install.stops[0].expandedFrom, install.stops[0].from);
    assert.ok(notified.some((text) => /Reused the walkthrough: 1 stop/.test(text)));

    // The diff moves: the remembered stops no longer describe the tree.
    await writeFile(join(cwd, "a.ts"), Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n") + "\nchanged-tail\n");
    const installs = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((request) => request.method === "install");
    const before = (await installs()).length;
    notified.length = 0;
    await commands.get("tour").handler("start", context);
    assert.equal((await installs()).length, before, "a stale walkthrough must not be installed with old line numbers");
    assert.equal(notified.some((text) => /Reused the walkthrough/.test(text)), false);
    assert.ok(notified.some((text) => /asked pi to narrate/.test(text)), "without a usable walkthrough the tour asks for explanations");

    // --plain keeps the instant tour, planned from the current tree.
    await commands.get("tour").handler("start --plain", context);
    install = (await installs()).at(-1);
    assert.ok(install.stops.length > 1);
    assert.equal(install.stops[0].note, undefined);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
    await rm(cwd, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing start reports the reason and keeps it for status", async () => {
  const cwd = await repo();
  const commands = new Map();
  nvimTour({
    registerTool() {}, on() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {},
    registerCommand(name, command) { commands.set(name, command); },
  });
  const notified = [];
  const statuses = [];
  const context = {
    cwd, mode: "tui", sessionManager: { getSessionId: () => "fail" },
    ui: { notify(text, level) { notified.push([text, level]); }, setStatus(key, value) { statuses.push([key, value]); } },
  };
  // Unknown base: planning fails deep inside git, and that must reach the user.
  await commands.get("tour").handler("start --base no-such-ref", context);
  const failure = notified.at(-1);
  assert.match(failure[0], /^Tour: /);
  assert.equal(failure[1], "error");
  assert.deepEqual(statuses.at(-1), ["tour", "tour failed"]);

  await commands.get("tour").handler("status", context);
  assert.match(notified.at(-1)[0], /No tour is running\. Last error: Unknown base revision "no-such-ref"/);
});

test("opening Neovim survives a slow handshake and closes the window when it never answers", async () => {
  const { ensureNvim } = await jiti.import("../extensions/nvim/spawn.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-core-spawn-"));
  const log = join(dir, "tmux.log");
  const counter = join(dir, "attempts");
  const tmuxBin = join(dir, "fake-tmux");
  const nvimBin = join(dir, "fake-nvim");
  // The fake tmux creates the socket the spawned Neovim would create, and records
  // the calls so a failed open can be checked for its cleanup.
  await writeFile(tmuxBin, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] === "new-window") {
  const command = args.at(-1);
  const socket = /--listen '?([^' ]+)/.exec(command)[1];
  setTimeout(() => fs.writeFileSync(socket, ""), ${"${DELAY}"});
  process.stdout.write("%99\\n");
}
`);
  await writeFile(nvimBin, `#!${process.execPath}
const fs = require("node:fs");
const counter = ${JSON.stringify(counter)};
const attempts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(attempts + 1));
if (attempts < 2) { process.stdout.write(JSON.stringify({ ok: false, error: "channel closed" }) + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ ok: true, result: { connected: true } }) + "\\n");
`);
  execFileSync("chmod", ["755", tmuxBin, nvimBin]);
  const previous = { tmux: process.env.TMUX, socket: process.env.PI_NVIM_SOCKET, ide: process.env.PI_IDE_TOKEN, bin: process.env.PI_TOUR_NVIM_BIN, tmuxBin: process.env.PI_TOUR_TMUX_BIN, budget: process.env.PI_NVIM_OPEN_TIMEOUT_MS };
  delete process.env.PI_NVIM_SOCKET;
  process.env.TMUX = "/tmp/tmux-fake";
  process.env.PI_TOUR_NVIM_BIN = nvimBin;
  process.env.PI_TOUR_TMUX_BIN = tmuxBin;
  try {
    // Fast socket, flaky first two handshakes: retrying wins.
    await writeFile(tmuxBin, (await readFile(tmuxBin, "utf8")).replace("${DELAY}", "50"));
    process.env.PI_NVIM_OPEN_TIMEOUT_MS = "5000";
    const opened = await ensureNvim(dir);
    assert.equal(opened.opened, true);
    assert.equal(Number(await readFile(counter, "utf8")), 3, "the handshake is retried, not given up on");

    // Never answers: the window is closed and the error says why.
    const nvimDead = join(dir, "fake-nvim-dead");
    await writeFile(nvimDead, `#!${process.execPath}
process.stdout.write(JSON.stringify({ ok: false, error: "channel closed" }) + "\\n");
process.exit(1);
`);
    execFileSync("chmod", ["755", nvimDead]);
    process.env.PI_TOUR_NVIM_BIN = nvimDead;
    delete process.env.PI_NVIM_SOCKET;
    process.env.PI_NVIM_OPEN_TIMEOUT_MS = "1200";
    await assert.rejects(ensureNvim(dir), /did not answer within/);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.ok(calls.some((call) => call.startsWith("kill-pane -t %99")), `expected a cleanup call, got ${calls.join(" | ")}`);
    assert.equal(process.env.PI_NVIM_SOCKET, undefined, "a failed open must not leave a socket behind");
  } finally {
    for (const [key, value] of [["TMUX", previous.tmux], ["PI_NVIM_SOCKET", previous.socket], ["PI_IDE_TOKEN", previous.ide], ["PI_TOUR_NVIM_BIN", previous.bin], ["PI_TOUR_TMUX_BIN", previous.tmuxBin], ["PI_NVIM_OPEN_TIMEOUT_MS", previous.budget]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("the default base follows what there is to review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-bases-"));
  try {
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "T");
    await writeFile(join(cwd, "a.ts"), "one\n");
    git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "init");
    // A single commit, clean: nothing to compare against at all.
    assert.equal(await resolveTourBase(cwd), "HEAD");

    // A clean default branch: review the commit that just landed.
    await writeFile(join(cwd, "a.ts"), "one\ntwo\n");
    git(cwd, "commit", "-qam", "second");
    assert.equal(await resolveTourBase(cwd), "HEAD~1");

    // A branch ahead of main wins over the last commit.
    git(cwd, "switch", "-q", "-c", "feature");
    await writeFile(join(cwd, "b.ts"), "new\n");
    git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "feature");
    const base = await resolveTourBase(cwd);
    assert.notEqual(base, "HEAD~1");
    assert.match(git(cwd, "log", "--oneline", `${base}..HEAD`), /feature/);

    // Uncommitted work always wins.
    await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n");
    assert.equal(await resolveTourBase(cwd), "HEAD");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
