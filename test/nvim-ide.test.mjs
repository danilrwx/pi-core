import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";
const { discoverIde } = await jiti.import("../extensions/nvim/discovery.ts");
const { hasNvim, resolveEndpoint, nvimRequest } = await jiti.import("../extensions/nvim/nvim.ts");
const { openDiff } = await jiti.import("../extensions/nvim/diff.ts");
const { default: plugin } = await jiti.import("../extensions/nvim/index.ts");

async function fakeNvim(body) {
  const dir = await mkdtemp(join(tmpdir(), "pi-ide-bin-"));
  const bin = join(dir, "fake-nvim"), log = join(dir, "requests.log");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const req = JSON.parse(process.env.PI_TOUR_REQUEST);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
let result = { connected: true };
${body}
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
`);
  await chmod(bin, 0o755);
  return { bin, log, dir };
}
async function requests(log) { try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }

function harness() {
  const tools = new Map(), commands = new Map(), handlers = new Map(), messages = [];
  plugin({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {}, on(name, handler) { handlers.set(name, handler); },
    registerEntryRenderer() {}, appendEntry() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  });
  return { tools, commands, handlers, messages };
}

test("discovery finds a live lock file and passes its token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-cwd-"));
  const ide = await mkdtemp(join(tmpdir(), "pi-ide-dir-"));
  const socket = join(ide, "nvim.sock");
  await writeFile(socket, "");
  await writeFile(join(ide, "1.lock"), JSON.stringify({ pid: process.pid, socket, workspaceFolders: [cwd], authToken: "tok-123", ideName: "pi-nvim" }));
  const previous = { dir: process.env.PI_IDE_DIR, socket: process.env.PI_NVIM_SOCKET, duet: process.env.DUET_NVIM_SOCKET, listen: process.env.NVIM_LISTEN_ADDRESS };
  process.env.PI_IDE_DIR = ide; delete process.env.PI_NVIM_SOCKET; delete process.env.DUET_NVIM_SOCKET; delete process.env.NVIM_LISTEN_ADDRESS;
  const fake = await fakeNvim("");
  process.env.PI_TOUR_NVIM_BIN = fake.bin;
  try {
    assert.equal(discoverIde(cwd)?.socket, socket);
    assert.equal(discoverIde("/elsewhere/nope"), undefined);
    assert.equal(resolveEndpoint(cwd)?.token, "tok-123");
    await nvimRequest({ method: "status", root: cwd });
    const sent = await requests(fake.log);
    assert.equal(sent.at(-1).token, "tok-123");
  } finally {
    for (const [key, value] of [["PI_IDE_DIR", previous.dir], ["PI_NVIM_SOCKET", previous.socket], ["DUET_NVIM_SOCKET", previous.duet], ["NVIM_LISTEN_ADDRESS", previous.listen]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete process.env.PI_TOUR_NVIM_BIN;
  }
});

test("edit and write are blocked when the Neovim buffer is dirty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-dirty-"));
  const fake = await fakeNvim("result = { dirty: true, loaded: true };");
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  const h = harness();
  try {
    for (const toolName of ["edit", "write"]) {
      const blocked = await h.handlers.get("tool_call")({ toolName, input: { path: "a.ts" } }, { cwd });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /unsaved changes/);
    }
    assert.equal(await h.handlers.get("tool_call")({ toolName: "read", input: { path: "a.ts" } }, { cwd }), undefined);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("propose_change writes only after acceptance and honours rejection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-propose-"));
  const file = join(cwd, "a.ts");
  await writeFile(file, "old\n");
  const accept = await fakeNvim(`if (req.method === "diff.open") { result = { pending: true }; fs.writeFileSync(req.result_path, JSON.stringify({ status: "accepted", content: "new\\n" })); } else if (req.method === "document.dirty") result = { dirty: false };`);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = accept.bin;
  const h = harness();
  try {
    const applied = await h.tools.get("propose_change").execute("t", { file: "a.ts", content: "new\n" }, undefined, undefined, { cwd });
    assert.match(applied.content[0].text, /Applied a\.ts/);
    assert.equal(await readFile(file, "utf8"), "new\n");
    const reject = await fakeNvim(`if (req.method === "diff.open") { result = { pending: true }; fs.writeFileSync(req.result_path, JSON.stringify({ status: "rejected" })); } else if (req.method === "document.dirty") result = { dirty: false };`);
    process.env.PI_TOUR_NVIM_BIN = reject.bin;
    const denied = await h.tools.get("propose_change").execute("t", { file: "a.ts", content: "other\n" }, undefined, undefined, { cwd });
    assert.match(denied.content[0].text, /rejected/);
    assert.equal(await readFile(file, "utf8"), "new\n");
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("openDiff times out and asks Neovim to close the diff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-timeout-"));
  const file = join(cwd, "a.ts"); await writeFile(file, "old\n");
  const fake = await fakeNvim(`if (req.method === "diff.open") result = { pending: true };`);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  try {
    await assert.rejects(openDiff({ cwd, file, content: "new\n", timeoutMs: 250 }), /timed out/);
    const sent = await requests(fake.log);
    assert.ok(sent.some((request) => request.method === "diff.cancel"));
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("nvim_context reports workspace, modified editors and a stale selection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-context-"));
  const fake = await fakeNvim(`if (req.method === "context") result = { workspace: ${JSON.stringify(cwd)}, editors: [{ file: ${JSON.stringify(join(cwd, "a.ts"))}, current: true, modified: true }], selection: { file: ${JSON.stringify(join(cwd, "b.ts"))}, start: { line: 2 }, finish: { line: 4 }, text: "let x = 1;", stale: true } };`);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  const h = harness();
  try {
    const result = await h.tools.get("nvim_context").execute("t", {}, undefined, undefined, { cwd });
    const text = result.content[0].text;
    assert.match(text, /Open editors: 1/);
    assert.match(text, /a\.ts \(modified\)/);
    assert.match(text, /b\.ts:2-4 \(stale: buffer changed\)/);
    assert.match(text, /let x = 1;/);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("live follow opens the edited range in Neovim and can be disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-live-follow-"));
  const file = join(cwd, "a.ts"); await writeFile(file, "one\ntwo\nthree\n");
  const fake = await fakeNvim("");
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  const h = harness();
  const ctx = { cwd, ui: { notify() {} } };
  try {
    await h.handlers.get("tool_result")({ toolName: "edit", isError: false, input: { path: "a.ts" }, details: { firstChangedLine: 5 } }, ctx);
    for (let i = 0; i < 50 && (await requests(fake.log)).length === 0; i++) await new Promise((done) => setTimeout(done, 20));
    const sent = await requests(fake.log);
    assert.equal(sent.at(-1).method, "show");
    assert.equal(sent.at(-1).from_line, 5);
    assert.deepEqual(sent.at(-1).added, [5]);
    await h.commands.get("tour").handler("live off", ctx);
    await h.handlers.get("tool_result")({ toolName: "edit", isError: false, input: { path: "a.ts" }, details: { firstChangedLine: 9 } }, ctx);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await requests(fake.log)).length, sent.length);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("agent_end suggests one review after a large change set", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-hint-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "T"], { cwd });
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(cwd, name), "one\ntwo\n");
  execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(cwd, name), "one\ntwo\nthree\nfour\n");
  const fake = await fakeNvim("");
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  const h = harness();
  const notices = [];
  const ctx = { cwd, ui: { notify(message) { notices.push(message); } } };
  try {
    await h.handlers.get("agent_end")({}, ctx);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.customType, "pi-review-hint");
    assert.match(h.messages[0].message.content, /review_tour action=overview/);
    assert.deepEqual(h.messages[0].options, { triggerTurn: false, deliverAs: "nextTurn" });
    assert.match(notices[0], /Large change set/);
    await h.handlers.get("agent_end")({}, ctx);
    assert.equal(h.messages.length, 1, "the same change set must not hint twice");
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("show and selection tools use the unified bridge", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-tools-"));
  const fake = await fakeNvim(`if (req.method === "show") result = { file: req.file, from_line: req.from_line, to_line: req.to_line, text: "two\\nthree" }; else if (req.method === "selection.latest") result = { available: true, file: req.root + "/a.ts", start: { line: 2 }, finish: { line: 4 }, text: "let x = 1;", stale: false };`);
  const previous = { socket: process.env.PI_NVIM_SOCKET, bin: process.env.PI_TOUR_NVIM_BIN };
  process.env.PI_NVIM_SOCKET = "/tmp/fake.sock"; process.env.PI_TOUR_NVIM_BIN = fake.bin;
  try {
    const h = harness();
    const shown = await h.tools.get("show").execute("t", { file: "a.ts", from_line: 2, to_line: 4 }, undefined, undefined, { cwd });
    assert.equal(shown.details.text, "two\nthree");
    const selection = await h.tools.get("selection").execute("t", {}, undefined, undefined, { cwd });
    assert.equal(selection.details.text, "let x = 1;");
    const sent = await requests(fake.log);
    assert.equal(sent[0].method, "show");
    assert.equal(sent[0].file, join(cwd, "a.ts"));
    assert.equal(sent[1].method, "selection.latest");
    assert.equal(sent[1].root, cwd);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_NVIM_SOCKET; else process.env.PI_NVIM_SOCKET = previous.socket;
    if (previous.bin === undefined) delete process.env.PI_TOUR_NVIM_BIN; else process.env.PI_TOUR_NVIM_BIN = previous.bin;
  }
});

test("an explicit socket wins over another Neovim that published a lock", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ide-cwd2-"));
  const ide = await mkdtemp(join(tmpdir(), "pi-ide-dir2-"));
  const lockSocket = join(ide, "old-nvim.sock");
  const ownSocket = join(ide, "own-nvim.sock");
  await writeFile(lockSocket, "");
  await writeFile(ownSocket, "");
  // The other Neovim was seen more recently, so discovery would pick it.
  await writeFile(join(ide, "1.lock"), JSON.stringify({ pid: process.pid, socket: lockSocket, workspaceFolders: [cwd], authToken: "other-token" }));
  const previous = { dir: process.env.PI_IDE_DIR, socket: process.env.PI_NVIM_SOCKET, duet: process.env.DUET_NVIM_SOCKET, listen: process.env.NVIM_LISTEN_ADDRESS, token: process.env.PI_IDE_TOKEN };
  process.env.PI_IDE_DIR = ide;
  process.env.PI_NVIM_SOCKET = ownSocket;
  process.env.PI_IDE_TOKEN = "own-token";
  delete process.env.DUET_NVIM_SOCKET; delete process.env.NVIM_LISTEN_ADDRESS;
  try {
    // ensureNvim records the socket it spawned in the environment: that one must
    // win, otherwise the tour lands in the other window and the new one stays empty.
    assert.deepEqual(resolveEndpoint(cwd), { socket: ownSocket, token: "own-token" });
    assert.equal(hasNvim(cwd), true);

    // A stale variable must not shadow a live lock.
    process.env.PI_NVIM_SOCKET = join(ide, "gone.sock");
    const fromLock = resolveEndpoint(cwd);
    assert.equal(fromLock.socket, lockSocket);
    assert.equal(fromLock.token, "other-token");
  } finally {
    for (const [key, value] of [["PI_IDE_DIR", previous.dir], ["PI_NVIM_SOCKET", previous.socket], ["DUET_NVIM_SOCKET", previous.duet], ["NVIM_LISTEN_ADDRESS", previous.listen], ["PI_IDE_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
