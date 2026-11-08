import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { jiti } from "./host.mjs";

const logs = await jiti.import("../extensions/background-jobs/private-log.ts");
const core = await jiti.import("../extensions/background-jobs/core.ts");
const watches = await jiti.import("../extensions/background-jobs/watch-path.ts");
const permissions = await jiti.import("../extensions/permission/index.ts");
const background = await jiti.import("../extensions/background-jobs/index.ts");

async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(30); }
  assert.fail("Timed out waiting for event");
}

function fakePi() {
  const tools = new Map(), commands = new Map(), handlers = new Map(), messages = [];
  const emitter = new EventEmitter();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, value) { commands.set(name, value); },
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    events: {
      emit(name, data) { emitter.emit(name, data); },
      on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); },
    },
    sendMessage(message) { messages.push(message); },
  };
  return { pi, tools, commands, messages,
    async emit(name, event, ctx) { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); },
  };
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-integration-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  const f = fakePi();
  permissions.default(f.pi);
  background.default(f.pi);
  const ctx = { cwd, mode: "print", hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "fixture" }, ui: { notify() {}, setStatus() {} } };
  await f.emit("session_start", {}, ctx);
  t.after(async () => {
    await f.emit("session_shutdown", { reason: "quit" }, ctx);
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  });
  const call = (name, args) => f.tools.get(name).execute("test-call", args, undefined, undefined, ctx);
  const level = (value) => f.commands.get("permission").handler(value, ctx);
  return { ...f, cwd, ctx, call, level };
}

test("job/monitor authorization uses live session policy and fails closed without it", async (t) => {
  const f = await fixture(t);
  await f.level("minimal");
  await assert.rejects(f.call("background_job", { action: "start", name: "denied", command: "touch denied" }), /Blocked by permission/);
  await assert.rejects(f.call("monitor", { name: "denied-monitor", description: "blocked", command: "touch denied" }), /Blocked by permission/);
  await assert.rejects(stat(join(f.cwd, "denied")), /ENOENT/);
  await f.level("high");
  const result = await f.call("background_job", { action: "start", name: "permitted", command: "printf 'hello\\n'" });
  const job = result.details;
  await until(() => f.messages.some((message) => message.details.kind === "exit"));
  assert.equal((await stat(job.log)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(job.log))).mode & 0o777, 0o700);
  assert.match(f.messages.at(-1).content, /Untrusted external output/);
  await f.emit("session_shutdown", { reason: "reload" }, f.ctx);
  await assert.rejects(f.call("background_job", { action: "start", name: "no-policy", command: "true" }), /permission extension/);
});

test("dangerous background commands remain blocked at high in headless mode", async (t) => {
  const f = await fixture(t);
  await f.level("high");
  await assert.rejects(f.call("background_job", { action: "start", command: "rm -rf /nonexistent-pi-core-test" }), /Dangerous command requires confirmation/);
});

test("private log cap is shared across writes, and excess output keeps draining", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-log-"));
  const path = join(cwd, "bounded.log");
  logs.appendPrivateLog(path, "x".repeat(80), 128);
  logs.appendPrivateLog(path, "y".repeat(1000), 128);
  logs.appendPrivateLog(path, "z".repeat(1000), 128);
  assert.equal((await stat(path)).size, 128);
  assert.match(await readFile(path, "utf8"), /log size limit/);
  // Jobs are unref'd; keep the test process alive until its exit callback is dispatched.
  const keep = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(keep));
  let finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  const job = await core.startJob({ cwd, registryRoot: join(cwd, "reg"), name: "loud",
    command: `node -e 'process.stdout.write("x".repeat(10*1024*1024)); process.stderr.write("y".repeat(1024*1024))'`, onEnd: finish });
  t.after(() => core.killGroup(job.pgid, "SIGKILL"));
  const end = await ended;
  assert.equal(end.code, 0);
  assert.equal((await stat(job.log)).size, logs.MAX_LOG_BYTES);
});

test("path watcher survives atomic saves and stops without late notifications", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-watch-"));
  const path = join(cwd, "code.ts");
  await writeFile(path, "first");
  const seen = [], endings = [];
  const watch = await watches.startPathWatch({ name: "code", path, cwd, description: "source", sessionId: "s" },
    (event) => seen.push(event), (reason, silent) => endings.push({ reason, silent }));
  try {
    await writeFile(join(cwd, "replacement"), "second");
    await rename(join(cwd, "replacement"), path);
    await until(() => seen.length > 0);
    const before = seen.length;
    await writeFile(path, "third");
    await until(() => seen.length > before);
    watch.stop(true);
    assert.deepEqual(endings, [{ reason: "stopped", silent: true }]);
    const stopped = seen.length;
    await writeFile(path, "fourth");
    await delay(300);
    assert.equal(seen.length, stopped);
  } finally { watch.stop(true); }
});

test("path watcher rejects pre-aborted work and expires", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-core-watch-timeout-"));
  const params = { name: "timeout", path: cwd, cwd, description: "timeout", sessionId: "s" };
  await assert.rejects(watches.startPathWatch({ ...params, signal: AbortSignal.abort() }, () => {}, () => {}), /cancelled/);
  let reason;
  const watch = await watches.startPathWatch({ ...params, timeoutMs: 1000 }, () => {}, (value) => { reason = value; });
  try { await until(() => reason === "expired"); } finally { watch.stop(true); }
});

test("watch_path is available in /jobs status and stop; lifecycle closes it", async (t) => {
  const f = await fixture(t);
  await f.call("watch_path", { name: "source", path: f.cwd, description: "changes" });
  const result = await f.call("background_job", { action: "status", name: "source" });
  assert.equal(result.details.name, "source");
  await f.call("background_job", { action: "stop", name: "source" });
  await f.call("watch_path", { name: "source", path: f.cwd, description: "changes" });
  const before = f.messages.length;
  await f.emit("session_shutdown", { reason: "reload" }, f.ctx);
  await writeFile(join(f.cwd, "after-reload"), "no stale event");
  await delay(300);
  assert.equal(f.messages.length, before);
});
