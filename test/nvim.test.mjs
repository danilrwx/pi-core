import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";
const { parseDiffHunks, buildStops, newFileStop, deletedLineCount } = await jiti.import("../extensions/nvim/plan.ts");
const { planTour, default: nvimTour } = await jiti.import("../extensions/nvim/index.ts");

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
  const commands = new Map(), entries = [], statuses = [], messages = [], renderers = new Map();
  nvimTour({
    registerTool() {}, on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerEntryRenderer(type, renderer) { renderers.set(type, renderer); },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(message, options) { messages.push({ message, options }); },
  });
  const context = {
    cwd, mode: "tui",
    sessionManager: { getSessionId: () => "tour-cmd" },
    ui: { notify() {}, setStatus(key, value) { statuses.push([key, value]); } },
  };
  try {
    await commands.get("tour").handler("start", context);
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
