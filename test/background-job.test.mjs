/** Copyright 2026 GhabiX. Apache-2.0. Modified for pi-core paths and portable TS test loading. */
import { jiti } from "./host.mjs";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const core = await jiti.import(pathToFileURL(join(here, "../extensions/background-jobs/core.ts")).href);

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function ctx() {
  return { cwd: await tempDir("background-job-cwd-"), registryRoot: await tempDir("background-job-reg-") };
}

function reap(job) {
  if (!job?.pgid) return;
  try {
    core.killGroup(job.pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Ignores SIGTERM and says so in its log once the handler is installed; see ready().
const STUBBORN = "node -e \"process.on('SIGTERM',()=>{}); console.log('ready'); setTimeout(()=>{}, 30000)\"";

/** Wait until `count` STUBBORN processes of the job have written "ready" to its log. */
async function ready(job, count = 1) {
  for (let i = 0; i < 200; i++) {
    const log = await readFile(job.log, "utf8").catch(() => "");
    if ((log.match(/^ready$/gm) ?? []).length >= count) return;
    await delay(25);
  }
  throw new Error(`${job.name} did not get ready`);
}

test("spawn executable errors do not crash the host", async () => {
  if (process.platform === "win32") return;
  const cwd = await tempDir("background-job-spawn-error-");
  const shell = join(cwd, "not-executable");
  await writeFile(shell, "#!/bin/sh\n");
  await chmod(shell, 0o644);

  assert.throws(
    () => core.spawnDetached({
      command: "true",
      cwd,
      logPath: join(cwd, "spawn-error.log"),
      shell,
    }),
    /spawn produced no pid/,
  );
  await delay(50);
});

test("default registry follows Pi's configured agent directory", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "background-job-custom-agent");
    assert.equal(
      core.defaultRegistryRoot(),
      join(process.env.PI_CODING_AGENT_DIR, "state", "background-job"),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("start returns immediately with its own pgid; abort before start does not spawn", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    command: "sleep 30",
    name: "keep",
    cwd,
    registryRoot,
  });
  t.after(() => reap(job));

  assert.equal(job.name, "keep");
  assert.equal(job.pgid, job.pid);
  assert.equal(job.bootId, undefined);
  assert.equal(core.groupAlive(job.pgid), true);
  assert.notEqual(job.pgid, process.pid);

  const aborted = await core.startJob({
    command: "sleep 30",
    name: "after-abort",
    cwd,
    registryRoot,
    signal: AbortSignal.abort(),
  }).then(
    () => {
      throw new Error("expected abort before start");
    },
    (error) => error,
  );
  assert.match(String(aborted.message), /aborted before start/);
  assert.equal(await core.readJob(registryRoot, "after-abort"), null);
  assert.equal(core.groupAlive(job.pgid), true);
});

test("abort after spawn does not kill the job; status recovers the handle", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const controller = new AbortController();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "keep-after-abort",
    command: "sleep 30",
    signal: controller.signal,
    persist: async (record, root) => {
      controller.abort();
      await core.writeJob(record, root);
    },
  });
  t.after(() => reap(job));

  assert.equal(controller.signal.aborted, true);
  assert.equal(core.groupAlive(job.pgid), true);
  const listed = await core.statusJobs({ cwd, registryRoot, name: "keep-after-abort" });
  assert.equal(listed.liveness, "Mine");
  assert.equal(listed.pid, job.pid);
});

test("harvest kills this process's running jobs", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const mine = await core.startJob({ cwd, registryRoot, command: "sleep 30", name: "mine" });
  t.after(() => reap(mine));
  assert.equal((await core.statusJobs({ cwd, registryRoot, name: "mine" })).liveness, "Mine");

  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  assert.deepEqual(quit.killed, ["mine"]);
  await delay(50);
  assert.equal(core.groupAlive(mine.pgid), false);
});

test("stop refuses Other; stop kills Orphan; quit harvest leaves both", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const ownerSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd,
    logPath: join(cwd, "owner.log"),
  });
  const otherSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd,
    logPath: join(cwd, "other.log"),
  });
  const orphanSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd,
    logPath: join(cwd, "orphan.log"),
  });
  t.after(() => {
    core.killGroup(ownerSpawn.spawned.pgid, "SIGKILL");
    core.killGroup(otherSpawn.spawned.pgid, "SIGKILL");
    core.killGroup(orphanSpawn.spawned.pgid, "SIGKILL");
  });

  const other = {
    name: "other",
    command: "sleep 30",
    pid: otherSpawn.spawned.pid,
    pgid: otherSpawn.spawned.pgid,
    log: join(cwd, "other.log"),
    cwd,
    ownerPid: ownerSpawn.spawned.pid,
    startedAt: new Date().toISOString(),
  };
  const orphan = {
    name: "orphan",
    command: "sleep 30",
    pid: orphanSpawn.spawned.pid,
    pgid: orphanSpawn.spawned.pgid,
    log: join(cwd, "orphan.log"),
    cwd,
    ownerPid: 2_147_483_647,
    startedAt: new Date().toISOString(),
  };
  await core.writeJob(other, registryRoot);
  await core.writeJob(orphan, registryRoot);

  assert.equal(core.liveness(other), "Other");
  assert.equal(core.liveness(orphan), "Orphan");

  await assert.rejects(
    () => core.stopJob({ name: "other", registryRoot }),
    new RegExp(`owned by live pid ${other.ownerPid}`),
  );
  assert.equal(core.groupAlive(other.pgid), true);

  const quit = await core.harvest({ registryRoot });
  assert.deepEqual(quit.killed, []);
  assert.equal(core.groupAlive(other.pgid), true);
  assert.equal(core.groupAlive(orphan.pgid), true);

  const stopped = await core.stopJob({ name: "orphan", registryRoot });
  assert.equal(stopped.signaled, "SIGTERM");
  await delay(50);
  assert.equal(core.groupAlive(orphan.pgid), false);
  assert.equal(core.groupAlive(other.pgid), true);
});

test("quit SIGKILLs a job that ignores SIGTERM", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "stubborn",
    command: STUBBORN,
  });
  t.after(() => reap(job));
  await ready(job);

  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  assert.deepEqual(quit.killed, ["stubborn"]);
  await delay(50);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("leader exit with live descendant stays Mine; quit kills the group", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "leader-exit",
    command: "sleep 30 &",
  });
  t.after(() => reap(job));

  let leaderGone = false;
  for (let i = 0; i < 20; i++) {
    if (!core.alive(job.pid) && core.groupAlive(job.pgid)) {
      leaderGone = true;
      break;
    }
    await delay(50);
  }
  assert.equal(leaderGone, true);
  const listed = await core.statusJobs({ cwd, registryRoot, name: "leader-exit" });
  assert.equal(listed.liveness, "Mine");

  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  assert.deepEqual(quit.killed, ["leader-exit"]);
  await delay(50);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("leader exit plus stubborn descendant is SIGKILLed on quit", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "stubborn-desc",
    command: `${STUBBORN} &`,
  });
  t.after(() => reap(job));
  await ready(job);

  let leaderGone = false;
  for (let i = 0; i < 20; i++) {
    if (!core.alive(job.pid) && core.groupAlive(job.pgid)) {
      leaderGone = true;
      break;
    }
    await delay(50);
  }
  assert.equal(leaderGone, true);

  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  assert.deepEqual(quit.killed, ["stubborn-desc"]);
  await delay(50);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("status lists Mine after resume to another cwd; stop from there works", async (t) => {
  const cwdA = await tempDir("background-job-a-");
  const cwdB = await tempDir("background-job-b-");
  const registryRoot = await tempDir("background-job-reg-");
  const job = await core.startJob({
    cwd: cwdA,
    registryRoot,
    name: "server",
    command: "sleep 30",
  });
  t.after(() => reap(job));

  const listedB = await core.statusJobs({ cwd: cwdB, registryRoot });
  assert.equal(listedB.length, 1);
  assert.equal(listedB[0].name, "server");
  assert.equal(listedB[0].liveness, "Mine");

  const stopped = await core.stopJob({ cwd: cwdB, registryRoot, name: "server" });
  assert.equal(stopped.signaled, "SIGTERM");
  await delay(50);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("harvest SIGTERMs all Mine then waits once", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const jobs = [];
  for (const name of ["a", "b", "c"]) {
    jobs.push(await core.startJob({ cwd, registryRoot, name, command: STUBBORN }));
  }
  t.after(() => {
    for (const job of jobs) reap(job);
  });
  for (const job of jobs) await ready(job);

  const started = Date.now();
  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  const elapsed = Date.now() - started;
  assert.deepEqual(quit.killed.sort(), ["a", "b", "c"]);
  assert.equal(elapsed < 500, true, `expected one 200ms wait, got ${elapsed}ms`);
  await delay(50);
  for (const job of jobs) assert.equal(core.groupAlive(job.pgid), false);
});

test("persist failure after spawn kills the process group and releases the name", async () => {
  const { cwd, registryRoot } = await ctx();
  let spawned;
  await assert.rejects(
    () =>
      core.startJob({
        cwd,
        registryRoot,
        name: "no-record",
        command: "sleep 30",
        spawnCommand: (opts) => {
          const result = core.spawnDetached(opts);
          spawned = result.spawned;
          return result;
        },
        persist: async () => {
          throw new Error("disk full");
        },
      }),
    /disk full/,
  );
  assert.ok(spawned?.pgid);
  await delay(50);
  assert.equal(core.groupAlive(spawned.pgid), false);
  assert.equal(await core.readJob(registryRoot, "no-record"), null);
});

test("stdout goes to the log, not the parent; dead name can be reused", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "logger",
    command: "printf 'hello-bg\\n'; sleep 30",
  });
  t.after(() => reap(job));

  let tail = "";
  for (let i = 0; i < 20; i++) {
    tail = await readFile(job.log, "utf8");
    if (tail.includes("hello-bg")) break;
    await delay(50);
  }
  assert.match(tail, /hello-bg/);

  await core.stopJob({ cwd, registryRoot, name: "logger" });
  await delay(80);
  const dead = await core.statusJobs({ cwd, registryRoot, name: "logger" });
  assert.equal(dead.liveness, "Dead");

  const reused = await core.startJob({
    cwd,
    registryRoot,
    name: "logger",
    command: "printf 'second\\n'; sleep 30",
  });
  t.after(() => reap(reused));
  assert.equal(reused.pid !== job.pid, true);

  let second = "";
  for (let i = 0; i < 20; i++) {
    second = await readFile(reused.log, "utf8");
    if (second.includes("second")) break;
    await delay(50);
  }
  assert.match(second, /second/);
  assert.equal(second.includes("hello-bg"), false);
});

test("bad json is skipped; status of current cwd still works", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "ok", command: "sleep 30" });
  t.after(() => reap(job));
  await writeFile(core.jobPaths(registryRoot, "broken").json, "{not json");
  const listed = await core.statusJobs({ cwd, registryRoot });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "ok");
});

test("corrupt json at a name does not block start reuse", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const paths = core.jobPaths(registryRoot, "broken");
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.json, "{not json");
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "broken",
    command: "sleep 30",
  });
  t.after(() => reap(job));
  assert.equal(job.name, "broken");
  assert.equal(core.groupAlive(job.pgid), true);
});

test("record without cwd does not crash status; pgid 1 is not harvested", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "ok", command: "sleep 30" });
  t.after(() => reap(job));

  await writeFile(
    core.jobPaths(registryRoot, "nocwd").json,
    JSON.stringify({
      name: "nocwd",
      command: "x",
      pid: 999,
      pgid: job.pgid,
      log: join(cwd, "x.log"),
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const listed = await core.statusJobs({ cwd, registryRoot });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "ok");

  const broadcast = {
    name: "broadcast",
    command: "x",
    pid: 1,
    pgid: 1,
    log: join(cwd, "broadcast.log"),
    cwd,
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await core.writeJob(broadcast, registryRoot);
  assert.equal(core.liveness(broadcast), "Dead");
  assert.equal(core.killGroup(1, 0), false);
  const quit = await core.harvest({ registryRoot, graceMs: 200 });
  assert.deepEqual(quit.killed, ["ok"]);
  await delay(50);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("live jobs from another cwd are listed; Other is visible; Orphan is stoppable", async (t) => {
  const cwdA = await tempDir("background-job-a-");
  const cwdB = await tempDir("background-job-b-");
  const registryRoot = await tempDir("background-job-reg-");

  const ownerSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd: cwdA,
    logPath: join(cwdA, "owner.log"),
  });
  const otherSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd: cwdA,
    logPath: join(cwdA, "other.log"),
  });
  const orphanSpawn = core.spawnDetached({
    command: "sleep 30",
    cwd: cwdA,
    logPath: join(cwdA, "orphan.log"),
  });
  t.after(() => {
    core.killGroup(ownerSpawn.spawned.pgid, "SIGKILL");
    core.killGroup(otherSpawn.spawned.pgid, "SIGKILL");
    core.killGroup(orphanSpawn.spawned.pgid, "SIGKILL");
  });

  await core.writeJob(
    {
      name: "other",
      command: "sleep 30",
      pid: otherSpawn.spawned.pid,
      pgid: otherSpawn.spawned.pgid,
      log: join(cwdA, "other.log"),
      cwd: cwdA,
      ownerPid: ownerSpawn.spawned.pid,
      startedAt: new Date().toISOString(),
    },
    registryRoot,
  );
  await core.writeJob(
    {
      name: "orphan",
      command: "sleep 30",
      pid: orphanSpawn.spawned.pid,
      pgid: orphanSpawn.spawned.pgid,
      log: join(cwdA, "orphan.log"),
      cwd: cwdA,
      ownerPid: 2_147_483_647,
      startedAt: new Date().toISOString(),
    },
    registryRoot,
  );

  const listedB = await core.statusJobs({ cwd: cwdB, registryRoot });
  assert.deepEqual(
    listedB.map((job) => job.name).sort(),
    ["orphan", "other"],
  );

  const stopped = await core.stopJob({ cwd: cwdB, registryRoot, name: "orphan" });
  assert.equal(stopped.signaled, "SIGTERM");
  await delay(50);
  assert.equal(core.groupAlive(orphanSpawn.spawned.pgid), false);
  assert.equal(core.groupAlive(otherSpawn.spawned.pgid), true);
});

test("a different boot directory does not harvest this boot's jobs", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const otherBoot = await tempDir("background-job-boot-");
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "rebooted",
    command: "sleep 30",
  });
  t.after(() => reap(job));

  const quit = await core.harvest({ registryRoot: otherBoot, graceMs: 200 });
  assert.deepEqual(quit.killed, []);
  assert.equal(core.groupAlive(job.pgid), true);
  const listed = await core.statusJobs({ cwd, registryRoot: otherBoot });
  assert.deepEqual(listed, []);
});

test("names are per Pi process: another process's job of the same name neither blocks nor shadows this one's", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const holder = core.spawnDetached({ command: "sleep 30", cwd, logPath: join(cwd, "holder.log") });
  t.after(() => core.killGroup(holder.spawned.pgid, "SIGKILL"));
  const otherJob = (name) => ({
    name,
    command: "sleep 30",
    pid: holder.spawned.pid,
    pgid: holder.spawned.pgid,
    log: join(core.jobPaths(registryRoot, name, holder.spawned.pid).dir, `${name}.log`),
    cwd,
    ownerPid: holder.spawned.pid,
    startedAt: new Date().toISOString(),
    watch: "exit",
  });
  await core.writeJob(otherJob("shared"), registryRoot);
  await core.writeJob(otherJob("theirs"), registryRoot);

  const mine = await core.startJob({ cwd, registryRoot, name: "shared", command: "sleep 30" });
  t.after(() => reap(mine));
  assert.equal((await core.statusJobs({ cwd, registryRoot, name: "shared" })).liveness, "Mine");
  assert.equal((await core.stopJob({ registryRoot, name: "shared" })).gone, true);
  assert.equal(core.groupAlive(holder.spawned.pgid), true);

  assert.equal((await core.statusJobs({ cwd, registryRoot, name: "theirs" })).liveness, "Other");
  await assert.rejects(() => core.stopJob({ registryRoot, name: "theirs" }), /owned by live pid/);
});

test("live occupy by this process is not stolen; concurrent start keeps one name", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const paths = core.jobPaths(registryRoot, "self");
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.json,
    `${JSON.stringify({
      name: "self",
      command: "x",
      pid: 0,
      pgid: 0,
      log: paths.log,
      cwd,
      ownerPid: process.pid,
      occupying: true,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  await assert.rejects(
    () => core.startJob({ cwd, registryRoot, name: "self", command: "sleep 30" }),
    /being started/,
  );

  const raced = await Promise.allSettled([
    core.startJob({ cwd, registryRoot, name: "race", command: "sleep 30" }),
    core.startJob({ cwd, registryRoot, name: "race", command: "sleep 30" }),
  ]);
  const started = raced.filter((result) => result.status === "fulfilled").map((result) => result.value);
  t.after(() => {
    for (const job of started) reap(job);
  });
  assert.equal(started.length, 1);
  assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
  assert.equal(core.groupAlive(started[0].pgid), true);
});

test("a name is unique within a Pi process; a second cwd cannot start it", async (t) => {
  const cwdA = await tempDir("background-job-a-");
  const cwdB = await tempDir("background-job-b-");
  const registryRoot = await tempDir("background-job-reg-");
  const a = await core.startJob({
    cwd: cwdA,
    registryRoot,
    name: "server",
    command: "sleep 30",
  });
  t.after(() => reap(a));

  await assert.rejects(
    () => core.startJob({ cwd: cwdB, registryRoot, name: "server", command: "sleep 30" }),
    /name server is Mine/,
  );
  const stopped = await core.stopJob({ cwd: cwdB, registryRoot, name: "server" });
  assert.equal(stopped.cwd, a.cwd);
  assert.equal(stopped.signaled, "SIGTERM");
});

test("status tail reads the last lines of a large log without the head", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "biglog",
    command: "sleep 30",
  });
  t.after(() => reap(job));
  const lines = [];
  for (let i = 0; i < 2000; i++) {
    lines.push(`line-${String(i).padStart(4, "0")}-${"x".repeat(40)}`);
  }
  await writeFile(job.log, `${lines.join("\n")}\n`);
  const listed = await core.statusJobs({ cwd, registryRoot, name: "biglog" });
  assert.match(listed.logTail, /line-1999-/);
  assert.doesNotMatch(listed.logTail, /line-0000-/);
  const tailLines = listed.logTail.split("\n").filter((line) => line.length > 0);
  assert.equal(tailLines.length <= core.LOG_TAIL_LINES, true);
});

test("writeJob failure does not leave a tmp file", async () => {
  const { cwd, registryRoot } = await ctx();
  const paths = core.jobPaths(registryRoot, "blocked");
  await mkdir(paths.dir, { recursive: true });
  await mkdir(paths.json);
  await writeFile(join(paths.json, "keep"), "x");
  await assert.rejects(
    () =>
      core.writeJob(
        {
          name: "blocked",
          command: "x",
          pid: 99,
          pgid: 99,
          log: paths.log,
          cwd,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        },
        registryRoot,
      ),
  );
  const leftovers = (await readdir(paths.dir)).filter((file) => file.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("killGroup treats missing or unsignalable groups as false", () => {
  assert.equal(core.killGroup(1, "SIGTERM"), false);
  assert.equal(core.killGroup(0, "SIGTERM"), false);
  assert.equal(core.killGroup(2_147_483_647, "SIGTERM"), false);
});

test("Dead in another cwd is hidden from list but live jobs are not", async (t) => {
  const cwdA = await tempDir("background-job-a-");
  const cwdB = await tempDir("background-job-b-");
  const registryRoot = await tempDir("background-job-reg-");
  const live = await core.startJob({
    cwd: cwdA,
    registryRoot,
    name: "live",
    command: "sleep 30",
  });
  t.after(() => reap(live));
  await core.writeJob(
    {
      name: "dead",
      command: "x",
      pid: 2_147_483_647,
      pgid: 2_147_483_646,
      log: join(cwdA, "dead.log"),
      cwd: cwdA,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
    },
    registryRoot,
  );

  const fromB = await core.statusJobs({ cwd: cwdB, registryRoot });
  assert.deepEqual(
    fromB.map((job) => job.name),
    ["live"],
  );
  const fromA = await core.statusJobs({ cwd: cwdA, registryRoot });
  assert.deepEqual(
    fromA.map((job) => job.name).sort(),
    ["dead", "live"],
  );
});

test("same-process occupying is a lock, not Dead", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const paths = core.jobPaths(registryRoot, "self-lock");
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.json,
    `${JSON.stringify({
      name: "self-lock",
      command: "x",
      pid: 0,
      pgid: 0,
      log: paths.log,
      cwd,
      ownerPid: process.pid,
      occupying: true,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { flag: "wx" },
  );
  const placeholder = await core.readJob(registryRoot, "self-lock");
  assert.equal(core.liveness(placeholder), "Other");
  await assert.rejects(
    () => core.startJob({ cwd, registryRoot, name: "self-lock", command: "sleep 30" }),
    /being started/,
  );
});

test("missing cwd fails before occupy", async () => {
  const { registryRoot } = await ctx();
  const missing = join(tmpdir(), `background-job-missing-${process.pid}-${Date.now()}`);
  await assert.rejects(
    () => core.startJob({ cwd: missing, registryRoot, name: "no-cwd", command: "sleep 30" }),
    /Working directory does not exist/,
  );
  assert.equal(await core.readJob(registryRoot, "no-cwd"), null);
});

test("stop escalates to SIGKILL when the group ignores SIGTERM", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "stubborn-stop", command: STUBBORN });
  t.after(() => reap(job));
  await ready(job);

  const stopped = await core.stopJob({ registryRoot, name: "stubborn-stop", graceMs: 200 });
  assert.equal(stopped.signaled, "SIGKILL");
  assert.equal(stopped.gone, true);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("stop reports SIGTERM when the group ends in time", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "polite", command: "sleep 30" });
  t.after(() => reap(job));

  const stopped = await core.stopJob({ registryRoot, name: "polite" });
  assert.equal(stopped.signaled, "SIGTERM");
  assert.equal(stopped.gone, true);
});

test("a lines job hands stdout to the caller and appends stderr to the log", async (t) => {
  const { cwd, registryRoot } = await ctx();
  let stdout = "";
  let closed;
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "lines",
    watch: "lines",
    sessionId: "session-1",
    description: "lines test",
    command: "echo out-1; echo err-1 >&2; echo out-2",
    spawnCommand: (opts) => {
      const result = core.spawnDetached(opts);
      // Read at once: Node discards the unread stdout of a child that has exited.
      result.handle.stdout.setEncoding("utf8");
      result.handle.stdout.on("data", (chunk) => (stdout += chunk));
      closed = new Promise((resolve) => result.handle.once("close", resolve));
      return result;
    },
  });
  t.after(() => reap(job));
  await closed;

  assert.equal(stdout, "out-1\nout-2\n");
  assert.equal(await readFile(job.log, "utf8"), "err-1\n");
  const record = await core.readJob(registryRoot, "lines");
  assert.equal(record.watch, "lines");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.description, "lines test");
});

test("the log is opened for append, so a second writer does not overwrite the child", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({
    cwd,
    registryRoot,
    name: "append",
    command: "sleep 0.2; echo from-child",
  });
  t.after(() => reap(job));
  await writeFile(job.log, "from-parent\n", { flag: "a" });
  await delay(600);
  assert.equal(await readFile(job.log, "utf8"), "from-parent\nfrom-child\n");
});

test("a reused process-group id is Dead and not harvested", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "reused", command: "sleep 30" });
  t.after(() => reap(job));
  assert.equal(job.leaderStart, core.processStart(job.pid));
  assert.equal(core.liveness(job), "Mine");

  // The same live group under a record whose leader started at another time: an id taken by a new group.
  await core.writeJob({ ...job, leaderStart: "1" }, registryRoot);
  const listed = await core.statusJobs({ cwd, registryRoot, name: "reused" });
  assert.equal(listed.liveness, "Dead");
  const quit = await core.harvest({ registryRoot, graceMs: 50 });
  assert.deepEqual(quit.killed, []);
  assert.equal(core.groupAlive(job.pgid), true);
});

test("stopGroup acts on the job's identity, not on whoever holds its group id now", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "identity", command: "sleep 30" });
  t.after(() => reap(job));

  const stopped = await core.stopGroup({ ...job, leaderStart: "1" }, { graceMs: 50 });
  assert.deepEqual(stopped, { signaled: false, gone: true });
  assert.equal(core.groupAlive(job.pgid), true);
  assert.equal((await core.stopGroup(job, { graceMs: 1000 })).gone, true);
});

// Jobs are unref'd children; while a test waits for an end, a timer keeps the event loop alive.
function ends() {
  let resolve;
  const keep = setInterval(() => {}, 1000);
  const ended = new Promise((r) => (resolve = r)).finally(() => clearInterval(keep));
  return { ended, onEnd: (end, error) => resolve({ end, error }) };
}

test("the end is recorded at exit, with the code and a stop reason written before the signal", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const exits = ends();
  const exiting = await core.startJob({ cwd, registryRoot, name: "exits", command: "exit 3", onEnd: exits.onEnd });
  t.after(() => reap(exiting));
  const { end, error } = await exits.ended;
  assert.equal(error, undefined);
  assert.equal(end.code, 3);
  assert.deepEqual((await core.readJob(registryRoot, "exits")).end, end);

  const stops = ends();
  const stopped = await core.startJob({ cwd, registryRoot, name: "expires", command: "sleep 30", onEnd: stops.onEnd });
  t.after(() => reap(stopped));
  await core.stopGroup(stopped, { reason: "expired" });
  const result = await stops.ended;
  assert.equal(result.end.signal, "SIGTERM");
  assert.equal(result.end.reason, "expired");
  assert.equal((await core.readJob(registryRoot, "expires")).end.reason, "expired");
});

test("stopJob records its reason in the end, and the final record keeps it only there", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const { ended, onEnd } = ends();
  const job = await core.startJob({ cwd, registryRoot, name: "guarded", command: "sleep 30", onEnd });
  t.after(() => reap(job));
  assert.equal((await core.readJob(registryRoot, "guarded")).stopping, undefined);
  await core.stopJob({ name: "guarded", reason: "stopped", registryRoot });
  assert.equal((await ended).end.reason, "stopped");
  const record = await core.readJob(registryRoot, "guarded");
  assert.equal(record.end.reason, "stopped");
  assert.equal(record.stopping, undefined);
});

test("within a Pi process the end is recorded before the name can be reused", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const first = ends();
  const a = await core.startJob({ cwd, registryRoot, name: "reuse", command: "exit 7", onEnd: first.onEnd });
  t.after(() => reap(a));
  while (core.jobAlive(a)) await delay(5);
  const b = await core.startJob({ cwd, registryRoot, name: "reuse", command: "sleep 30" });
  t.after(() => reap(b));

  const { end, error } = await first.ended;
  assert.equal(error, undefined);
  assert.equal(end.code, 7);
  const record = await core.readJob(registryRoot, "reuse");
  assert.equal(record.pid, b.pid);
  assert.equal(record.end, undefined);
});

test("each run of a name has its own log file, which a process left by an earlier run cannot reach", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const first = ends();
  const a = await core.startJob({
    cwd,
    registryRoot,
    name: "reused-log",
    command: "setsid sh -c 'sleep 0.4; echo stray' & echo a-out",
    onEnd: first.onEnd,
  });
  t.after(() => reap(a));
  await first.ended;
  await delay(50);
  const second = ends();
  const b = await core.startJob({ cwd, registryRoot, name: "reused-log", command: "sleep 0.8; echo b-out", onEnd: second.onEnd });
  t.after(() => reap(b));
  await second.ended;
  assert.equal(await readFile(b.log, "utf8"), "b-out\n");
});

test("the first accepted stop reason stands", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const { ended, onEnd } = ends();
  const job = await core.startJob({ cwd, registryRoot, name: "first-reason", command: STUBBORN, onEnd });
  t.after(() => reap(job));
  await ready(job);
  const stop = core.stopGroup(job, { reason: "stopped", graceMs: 300 });
  await delay(50);
  const deadline = core.stopGroup(job, { reason: "expired", graceMs: 300 });
  await Promise.all([stop, deadline]);
  assert.equal((await ended).end.reason, "stopped");
});

test("the retention sweep removes old files of jobs that no longer run, and nothing else", async (t) => {
  const root = await tempDir("background-job-sweep-");
  const registryRoot = core.bootRegistryDir(root);
  const cwd = await tempDir("background-job-sweep-cwd-");
  const old = new Date(Date.now() - core.RETENTION_MS - 60_000);
  const age = (...paths) => Promise.all(paths.map((path) => utimes(path, old, old)));

  const live = await core.startJob({ cwd, registryRoot, name: "live", command: "sleep 30" });
  t.after(() => reap(live));
  const doneEnd = ends();
  const done = await core.startJob({ cwd, registryRoot, name: "done", command: "true", onEnd: doneEnd.onEnd });
  await doneEnd.ended;
  const recentEnd = ends();
  const recent = await core.startJob({ cwd, registryRoot, name: "recent", command: "true", onEnd: recentEnd.onEnd });
  await recentEnd.ended;
  const ownDir = core.jobPaths(registryRoot, "live").dir;
  await age(join(ownDir, "live.json"), live.log, join(ownDir, "done.json"), done.log);

  // Another live Pi's directory: left to that process, whatever its age.
  const holder = core.spawnDetached({ command: "sleep 30", cwd, logPath: join(cwd, "holder.log") });
  t.after(() => core.killGroup(holder.spawned.pgid, "SIGKILL"));
  const otherDir = core.jobPaths(registryRoot, "x", holder.spawned.pid).dir;
  await mkdir(otherDir, { recursive: true });
  await writeFile(join(otherDir, "x.json"), "{}");
  await age(join(otherDir, "x.json"));

  // A dead Pi's directory in this boot, and an earlier boot.
  const deadDir = core.jobPaths(registryRoot, "y", spawnSync("true").pid).dir;
  await mkdir(deadDir, { recursive: true });
  await writeFile(join(deadDir, "y.json"), "{}");
  await age(join(deadDir, "y.json"));
  const oldBoot = join(root, "earlier-boot", "123-456");
  await mkdir(oldBoot, { recursive: true });
  await writeFile(join(oldBoot, "z.json"), "{}");
  await writeFile(join(oldBoot, "z.1234abcd.log"), "z\n");
  await age(join(oldBoot, "z.json"), join(oldBoot, "z.1234abcd.log"));
  const newerBoot = join(root, "newer-boot", "789");
  await mkdir(newerBoot, { recursive: true });
  await writeFile(join(newerBoot, "w.json"), "{}");

  core.sweepRegistry({ root });

  assert.equal(existsSync(join(ownDir, "live.json")), true);
  assert.equal(existsSync(live.log), true);
  assert.equal(existsSync(join(ownDir, "done.json")), false);
  assert.equal(existsSync(done.log), false);
  assert.equal(existsSync(join(ownDir, "recent.json")), true);
  assert.equal(existsSync(recent.log), true);
  assert.equal(existsSync(join(otherDir, "x.json")), true);
  assert.equal(existsSync(deadDir), false);
  assert.equal(existsSync(join(root, "earlier-boot")), false);
  assert.equal(existsSync(join(newerBoot, "w.json")), true);
  assert.equal(existsSync(registryRoot), true);
});

test("the sweep removes an old placeholder of a dead Pi and an earlier boot's directory named like this process's", async () => {
  const root = await tempDir("background-job-sweep2-");
  const registryRoot = core.bootRegistryDir(root);
  const old = new Date(Date.now() - core.RETENTION_MS - 60_000);
  const deadOwner = spawnSync("true").pid;
  const deadDir = core.jobPaths(registryRoot, "half", deadOwner).dir;
  await mkdir(deadDir, { recursive: true });
  const placeholder = join(deadDir, "half.json");
  await writeFile(placeholder, JSON.stringify({ name: "half", command: "x", pid: 0, pgid: 0, log: join(deadDir, "half.0000aaaa.log"),
    cwd: "/", ownerPid: deadOwner, startedAt: old.toISOString(), watch: "exit", occupying: true }));
  await utimes(placeholder, old, old);
  const sameName = join(root, "earlier-boot", core.ownerKey(process.pid));
  await mkdir(sameName, { recursive: true });

  core.sweepRegistry({ root });
  assert.equal(existsSync(placeholder), false);
  assert.equal(existsSync(join(root, "earlier-boot")), false);
});

test("listing jobs survives an owner directory that another Pi's sweep removes meanwhile", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "survivor", command: "sleep 30" });
  t.after(() => reap(job));
  const vanishing = join(registryRoot, "99999-1");
  // Not deterministic: each round removes the directory while a listing is in flight, so that the
  // listing sometimes enumerates it and then cannot read it. Without the fix this fails within a few rounds.
  for (let i = 0; i < 300; i++) {
    mkdirSync(vanishing);
    const listing = core.listJobs(registryRoot);
    await new Promise((resolve) => setImmediate(resolve));
    rmdirSync(vanishing);
    const jobs = await listing;
    assert.equal(jobs.some((j) => j.name === "survivor"), true);
  }
});

test("two Pi processes can sweep the same old directories at once", async () => {
  const root = await tempDir("background-job-sweep3-");
  const registryRoot = core.bootRegistryDir(root);
  const old = new Date(Date.now() - core.RETENTION_MS - 60_000);
  for (let owner = 0; owner < 40; owner++) {
    const dir = join(registryRoot, `${4_000_000 + owner}-1`);
    await mkdir(dir, { recursive: true });
    for (let file = 0; file < 25; file++) {
      const path = join(dir, `j${file}.0000aaaa.log`);
      await writeFile(path, "x");
      await utimes(path, old, old);
    }
  }
  const coreUrl = pathToFileURL(join(here, "../extensions/background-jobs/core.ts")).href;
  const hostUrl = new URL("./host.mjs", import.meta.url).href;
  const script = `const {jiti} = await import(${JSON.stringify(hostUrl)}); const core = await jiti.import(${JSON.stringify(coreUrl)}); core.sweepRegistry({ root: ${JSON.stringify(root)} });`;
  const sweep = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  const results = await Promise.all([sweep(), sweep()]);
  assert.deepEqual(results.map((r) => r.code), [0, 0], results.map((r) => r.stderr).join("\n"));
  assert.deepEqual(await readdir(registryRoot), []);
});

test("stopping an orphan whose record another Pi's sweep removed still stops it", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const orphan = core.spawnDetached({ command: "sleep 30", cwd, logPath: join(cwd, "orphan.log") });
  t.after(() => core.killGroup(orphan.spawned.pgid, "SIGKILL"));
  const deadOwner = spawnSync("true").pid;
  const dir = core.jobPaths(registryRoot, "swept", deadOwner).dir;
  const job = { name: "swept", command: "sleep 30", pid: orphan.spawned.pid, pgid: orphan.spawned.pgid,
    leaderStart: core.processStart(orphan.spawned.pid), log: join(dir, "swept.0000aaaa.log"), cwd,
    ownerPid: deadOwner, startedAt: new Date().toISOString(), watch: "exit" };
  // The record is already gone when the stop reason is written.
  const stopped = await core.stopGroup(job, { reason: "stopped", graceMs: 1000 });
  assert.equal(stopped.gone, true);
  assert.equal(core.groupAlive(orphan.spawned.pgid), false);
});

test("the log tail returns exactly the last lines, with or without a final newline", async () => {
  const dir = await tempDir("background-job-tail-");
  const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
  const want = lines.slice(-core.LOG_TAIL_LINES).join("\n");
  await writeFile(join(dir, "terminated.log"), `${lines.join("\n")}\n`);
  await writeFile(join(dir, "open.log"), lines.join("\n"));
  assert.equal(await core.tailLog(join(dir, "terminated.log")), want);
  assert.equal(await core.tailLog(join(dir, "open.log")), want);
});

test("unnamed starts in the same millisecond get different names", () => {
  const now = new Date();
  assert.notEqual(core.defaultName(now), core.defaultName(now));
});

test("a group whose leader exited is identified by the processes recorded at that exit", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const { ended, onEnd } = ends();
  const job = await core.startJob({ cwd, registryRoot, name: "leaderless", command: "sleep 30 & exit 0", onEnd });
  t.after(() => reap(job));
  const { end } = await ended;
  assert.equal(end.leftovers.length, 1);
  assert.equal(core.processStart(end.leftovers[0].pid), end.leftovers[0].start);
  assert.equal((await core.statusJobs({ cwd, registryRoot, name: "leaderless" })).liveness, "Mine");

  // The same group id, but none of the recorded processes: a newer group whose leader has exited.
  const record = await core.readJob(registryRoot, "leaderless");
  await core.writeJob({ ...record, end: { ...record.end, leftovers: [{ ...end.leftovers[0], start: "1" }] } }, registryRoot);
  assert.equal((await core.statusJobs({ cwd, registryRoot, name: "leaderless" })).liveness, "Dead");
  assert.deepEqual((await core.harvest({ registryRoot, graceMs: 50 })).killed, []);
  assert.equal(core.groupAlive(job.pgid), true);
});

test("a stop whose reason cannot be recorded still stops the job and reports the failure", async (t) => {
  const { cwd, registryRoot } = await ctx();
  const job = await core.startJob({ cwd, registryRoot, name: "unrecorded", command: "sleep 30" });
  t.after(() => reap(job));
  // An unreadable record: reading it fails with EACCES, not ENOENT.
  const json = core.jobPaths(registryRoot, "unrecorded").json;
  await chmod(json, 0o000);
  t.after(() => chmod(json, 0o644));
  const stopped = await core.stopGroup(job, { reason: "expired", graceMs: 1000 });
  assert.equal(stopped.gone, true);
  assert.match(stopped.recordError, /EACCES/);
  assert.equal(core.groupAlive(job.pgid), false);
});

test("a stop reaches every process of a large group that ignores SIGTERM after its leader exits", async (t) => {
  const { cwd, registryRoot } = await ctx();
  // More processes than LEFTOVER_MAX that end on SIGTERM, then a few that ignore it: what survives
  // SIGTERM may be none of the first processes of the group.
  const command = "for i in $(seq 70); do sleep 30 & done; for i in $(seq 6); do (trap '' TERM; exec sleep 30) & done; echo ready; wait";
  const job = await core.startJob({ cwd, registryRoot, name: "crowd", command });
  t.after(() => reap(job));
  await ready(job);
  const stopped = await core.stopGroup(job, { graceMs: 300 });
  assert.equal(stopped.signaled, "SIGKILL");
  assert.equal(stopped.gone, true);
  assert.equal(core.groupAlive(job.pgid), false);
});
