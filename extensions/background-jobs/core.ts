/** Copyright 2026 GhabiX. Apache-2.0; see licenses/Apache-2.0-GhabiX.txt.
 * Vendored from pi-background-job 08389a0; modified for pi-core: private bounded logs.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendPrivateLog } from "./private-log.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const QUIT_GRACE_MS = 200;
export const STOP_GRACE_MS = 2000;
export const KILL_WAIT_MS = 1000;
export const LOG_TAIL_LINES = 20;
export const TAIL_READ_MAX = 64 * 1024;
/** Records and logs of jobs that no longer run are removed once they are this old. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many processes of a group are recorded when its leader exits. */
export const LEFTOVER_MAX = 64;

export type Liveness = "Mine" | "Other" | "Orphan" | "Dead";
/** What a job reports: its exit only, or also every stdout line (a monitor). */
export type Watch = "exit" | "lines";
/** Why this plugin ended a job itself; absent when the command ended on its own or was killed from outside. */
export type EndReason = "stopped" | "expired" | "flooded";
/** A process of the job's group when its leader exited, identified by pid and start time. */
export type Leftover = { pid: number; start: string };
export type JobEnd = {
  at: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: EndReason;
  /** Processes still in the group when the leader exited (Linux); they identify the group afterwards. */
  leftovers?: Leftover[];
};
/** How the shell exited, before the stop reason is attached. */
export type Exit = Omit<JobEnd, "reason">;
/** Called once the end of a run is recorded; `error` when writing it failed. Must not throw. */
export type OnEnd = (end: JobEnd, error?: Error) => void;

export type Job = {
  name: string;
  command: string;
  pid: number;
  pgid: number;
  log: string;
  cwd: string;
  ownerPid: number;
  /** Start time of the owning Pi process (Linux): a later process with the same pid is another owner. */
  ownerStart?: string;
  startedAt: string;
  watch: Watch;
  /** Session that started the job; its messages go only there. */
  sessionId?: string;
  /** Tool call that started the job; its messages are that call's deferred output. */
  toolCallId?: string;
  /** Monitor description, shown in each of its messages. */
  description?: string;
  /** Why this extension is stopping the job; written before the signal, copied into `end`. */
  stopping?: EndReason;
  /** Written by the owner when the shell exits; the process group may outlive it. */
  end?: JobEnd;
  /** Start time of the group leader (Linux), to tell a reused process-group id from this job. */
  leaderStart?: string;
  occupying?: boolean;
};

export type Spawned = { pid: number; pgid: number };

export type SpawnCommand = (opts: {
  command: string;
  cwd: string;
  logPath: string;
  stdout?: "log" | "pipe";
}) => { spawned: Spawned; handle?: ChildProcess; logError?: () => Error | undefined } | Promise<{ spawned: Spawned; handle?: ChildProcess; logError?: () => Error | undefined }>;

export function defaultRegistryRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "state", "background-job");
}

let cachedBootId: string | undefined;

export function currentBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = detectBootId();
  return cachedBootId;
}

function detectBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    const result = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    return "unknown-boot";
  }
}

export function sanitizeBootId(id: string): string {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return cleaned || "unknown-boot";
}

export function bootRegistryDir(root = defaultRegistryRoot(), bootId = currentBootId()): string {
  return join(root, sanitizeBootId(bootId));
}

/**
 * Each Pi process keeps its records in its own directory under the boot directory, and only that
 * process writes there (an orphan's stop reason is the one exception). Names are unique within a
 * Pi process; every run gets its own log file.
 */
export function ownerKey(pid: number): string {
  const start = processStart(pid);
  return start === undefined ? String(pid) : `${pid}-${start}`;
}

export function jobPaths(registryRoot: string, name: string, ownerPid = process.pid) {
  const dir = join(registryRoot, ownerKey(ownerPid));
  return { dir, json: join(dir, `${name}.json`) };
}

function runLogPath(dir: string, name: string): string {
  return join(dir, `${name}.${randomUUID().slice(0, 8)}.log`);
}

function validPgid(pgid: unknown): pgid is number {
  return Number.isInteger(pgid) && (pgid as number) > 1;
}

function exists(pidOrPgid: number, asGroup: boolean): boolean {
  if (asGroup) {
    if (!validPgid(pidOrPgid)) return false;
  } else if (!Number.isInteger(pidOrPgid) || pidOrPgid <= 0) {
    return false;
  }
  const target = asGroup ? -pidOrPgid : pidOrPgid;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function alive(pid: number): boolean {
  return exists(pid, false);
}

export function groupAlive(pgid: number): boolean {
  return exists(pgid, true);
}

/** Start time of a process in clock ticks since boot, from /proc; undefined without /proc or once the pid is gone. */
export function processStart(pid: number): string | undefined {
  return procStat(pid)?.start;
}

/** A process's group and start time, from /proc; undefined without /proc or once the pid is gone. */
function procStat(pid: number): { pgrp: number; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces, so count from its closing parenthesis:
    // field 5 is the process group, field 22 the start time.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pgrp: Number(fields[2]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/** Up to LEFTOVER_MAX processes of a group; undefined without /proc. */
function groupMembers(pgid: number): Leftover[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  const members: Leftover[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (stat?.pgrp === pgid) members.push({ pid: Number(entry), start: stat.start });
    if (members.length === LEFTOVER_MAX) break;
  }
  return members;
}

/**
 * Whether a live group with the job's id is still the job's. After every process of a group has ended,
 * a new process can get the same id and lead a new group, whose leader may exit in turn. While a
 * process with the group's id exists, it is the leader, and its start time decides. Once the leader is
 * gone, the group is the job's only if a process recorded in it when the leader exited
 * (`end.leftovers`) is still there. A leaderless group that cannot be identified counts as someone
 * else's, so it is never signaled. Without /proc (no `leaderStart`) the id is trusted.
 */
function groupIsJobs(job: Job): boolean {
  if (job.leaderStart === undefined) return true;
  const leader = processStart(job.pgid);
  if (leader !== undefined) return leader === job.leaderStart;
  return (job.end?.leftovers ?? []).some((leftover) => {
    const stat = procStat(leftover.pid);
    return stat?.pgrp === job.pgid && stat.start === leftover.start;
  });
}

/** The job's process group still has processes, and it is still this job's group. */
export function jobAlive(job: Job): boolean {
  return validPgid(job.pgid) && groupAlive(job.pgid) && groupIsJobs(job);
}

/**
 * During a stop that has just verified the group as the job's: the group still has processes and no
 * other process has become its leader. A group id cannot be reused while any process is left in it,
 * so for the few seconds of a stop this follows the job's processes, including any they fork after
 * the check. (Identity from an old record needs more evidence; see groupIsJobs.)
 */
function groupContinues(job: Job): boolean {
  if (!groupAlive(job.pgid)) return false;
  const leader = processStart(job.pgid);
  return leader === undefined || job.leaderStart === undefined || leader === job.leaderStart;
}

function sameOwner(job: Job, pid: number): boolean {
  return job.ownerPid === pid && (job.ownerStart === undefined || job.ownerStart === processStart(pid));
}

function ownerAlive(job: Job): boolean {
  return alive(job.ownerPid) && (job.ownerStart === undefined || job.ownerStart === processStart(job.ownerPid));
}

export function liveness(job: Job | null | undefined, me = process.pid): Liveness {
  if (job?.occupying) {
    return ownerAlive(job) ? "Other" : "Dead";
  }
  if (!job || !jobAlive(job)) return "Dead";
  if (sameOwner(job, me)) return "Mine";
  if (ownerAlive(job)) return "Other";
  return "Orphan";
}

export function sameCwd(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export function visibleInStatus(job: Job, cwd: string, me = process.pid): boolean {
  const live = liveness(job, me);
  return live !== "Dead" || sameCwd(job.cwd, cwd);
}

export function assertName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`Invalid name: expected ${NAME_RE}`);
  }
  return name;
}

let unnamed = 0;

/** A name for an unnamed start: time, owner pid, and a counter, since two starts can share a millisecond. */
export function defaultName(now = new Date(), ownerPid = process.pid): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `j-${y}${mo}${d}-${h}${mi}${s}${ms}-${ownerPid}-${++unnamed}`;
}

export function killGroup(pgid: number, signal: NodeJS.Signals | number): boolean {
  if (!validPgid(pgid)) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

/** This process's record of `name`. */
export async function readJob(registryRoot: string, name: string, ownerPid = process.pid): Promise<Job | null> {
  const { json } = jobPaths(registryRoot, name, ownerPid);
  try {
    const job = JSON.parse(await readFile(json, "utf8"));
    return job && typeof job === "object" ? job : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The job a name refers to: this process's own, else the newest job of that name of another process. */
export async function findJob(registryRoot: string, name: string, ownerPid = process.pid): Promise<Job | null> {
  const own = await readJob(registryRoot, name, ownerPid);
  if (own && !own.occupying && validPgid(own.pgid)) return own;
  const others = (await listJobs(registryRoot)).filter((job) => job.name === name);
  others.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return others[0] ?? null;
}

export async function writeJob(job: Job, registryRoot: string): Promise<void> {
  const { dir, json } = jobPaths(registryRoot, job.name, job.ownerPid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${json}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, json);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

function readRecordSync(path: string): Job | null {
  try {
    const job = JSON.parse(readFileSync(path, "utf8"));
    return job && typeof job === "object" ? job : null;
  } catch {
    return null;
  }
}

/**
 * Claim a name in this process's directory. Only this process writes there and the claim is
 * synchronous, so no other start can come between checking an earlier record and replacing it.
 */
export function occupyName(jsonPath: string, placeholder: Job, ownerPid = process.pid): void {
  const claim = () => writeFileSync(jsonPath, `${JSON.stringify(placeholder, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    claim();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  const existing = readRecordSync(jsonPath);
  if (existing?.occupying) throw new Error(`name ${existing.name} is being started`);
  if (existing && liveness(existing, ownerPid) !== "Dead") {
    throw new Error(`name ${existing.name} is ${liveness(existing, ownerPid)}; stop it or pick another name`);
  }
  unlinkSync(jsonPath);
  claim();
}

/** Every record of this boot, of every Pi process. */
export async function listJobs(registryRoot: string): Promise<Job[]> {
  let owners;
  try {
    owners = await readdir(registryRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const jobs: Job[] = [];
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    const dir = join(registryRoot, owner.name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      // Another Pi's retention sweep may remove an empty dead owner's directory after the listing above.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(join(dir, file), "utf8"));
        if (job && typeof job.cwd === "string" && validPgid(job.pgid) && !job.occupying) {
          jobs.push(job);
        }
      } catch {
        // Skip unreadable records so one bad file cannot disable status/harvest.
      }
    }
  }
  return jobs;
}

export type SpawnDetachedOptions = {
  command: string;
  cwd: string;
  /** A new file for each run; opened for append (a monitor's stdout is appended by Pi). */
  logPath: string;
  /** "pipe" hands stdout to the caller (monitor events); stderr always goes to the log. */
  stdout?: "log" | "pipe";
  shell?: string;
  shellArgs?: string[];
  commandTransport?: "argv" | "stdin";
  env?: NodeJS.ProcessEnv;
};

export function spawnDetached({
  command,
  cwd,
  logPath,
  stdout = "log",
  shell = "/bin/sh",
  shellArgs = ["-c"],
  commandTransport = "argv",
  env = process.env,
}: SpawnDetachedOptions) {
  appendPrivateLog(logPath, "");
  const fromStdin = commandTransport === "stdin";
  const child = spawn(shell, fromStdin ? shellArgs : [...shellArgs, command], {
    cwd,
    detached: true,
    stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    env,
  });
  // Drain output even after the log cap or a write failure; never block the child on a full pipe.
  let failure: Error | undefined;
  const log = (chunk: Buffer) => {
    if (failure) return;
    try { appendPrivateLog(logPath, chunk); } catch (error) { failure = error as Error; }
  };
  child.stderr?.on("data", log);
  if (stdout === "log") child.stdout?.on("data", log);
  child.once("error", () => {});
  if (fromStdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(command);
  }
  if (!child.pid) throw new Error("spawn produced no pid");
  child.unref();
  return { spawned: { pid: child.pid, pgid: child.pid }, handle: child, logError: () => failure };
}

export async function startJob({
  cwd,
  command,
  name,
  watch = "exit",
  sessionId,
  toolCallId,
  description,
  onEnd,
  ownerPid = process.pid,
  registryRoot = bootRegistryDir(),
  spawnCommand = spawnDetached,
  persist = writeJob,
  signal,
}: {
  cwd: string;
  command: string;
  name?: string;
  watch?: Watch;
  sessionId?: string;
  toolCallId?: string;
  description?: string;
  /** Receives the end once it is recorded; the end is recorded whenever the spawn returns its child. */
  onEnd?: OnEnd;
  ownerPid?: number;
  registryRoot?: string;
  spawnCommand?: SpawnCommand;
  persist?: (job: Job, registryRoot: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<Job> {
  if (signal?.aborted) throw new Error("aborted before start");
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("start requires command");
  }
  const jobCwd = resolve(cwd);
  try {
    await access(jobCwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${jobCwd}`);
  }
  const jobName = assertName(name ?? defaultName(new Date(), ownerPid));
  const paths = jobPaths(registryRoot, jobName, ownerPid);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const log = runLogPath(paths.dir, jobName);
  const ownerStart = processStart(ownerPid);
  const placeholder: Job = {
    name: jobName,
    command,
    pid: 0,
    pgid: 0,
    log,
    cwd: jobCwd,
    ownerPid,
    ...(ownerStart === undefined ? {} : { ownerStart }),
    watch,
    occupying: true,
    startedAt: new Date().toISOString(),
  };
  occupyName(paths.json, placeholder, ownerPid);
  let spawned: Spawned | undefined;
  try {
    if (signal?.aborted) throw new Error("aborted before start");
    const child = await spawnCommand({
      command,
      cwd: jobCwd,
      logPath: log,
      stdout: watch === "lines" ? "pipe" : "log",
    });
    spawned = child.spawned;
    // Taken now: a fast command can exit before its record is written below.
    const exited = child.handle === undefined ? undefined : exitOf(child.handle);
    const job: Job = {
      name: jobName,
      command,
      pid: spawned.pid,
      pgid: spawned.pgid,
      log,
      cwd: jobCwd,
      ownerPid,
      ...(ownerStart === undefined ? {} : { ownerStart }),
      startedAt: placeholder.startedAt,
      watch,
      ...leaderStartOf(spawned.pid),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(description === undefined ? {} : { description }),
    };
    await persist(job, registryRoot);
    if (exited !== undefined) void exited.then((exit) => endRun(job, exit, onEnd));
    return job;
  } catch (error) {
    if (spawned?.pgid) killGroup(spawned.pgid, "SIGKILL");
    await unlink(paths.json).catch(() => {});
    throw error;
  }
}

function exitOf(handle: ChildProcess): Promise<Exit> {
  const pgid = handle.pid!;
  return new Promise((resolve) =>
    handle.once("exit", (code, signal) => {
      // Taken in the exit callback itself. Until Node reaped the leader, just before this callback,
      // its pid, which is the group id, could not be reused, so the processes in the group now are
      // the job's. They identify the group once its leader is gone (see groupIsJobs).
      const leftovers = groupAlive(pgid) ? groupMembers(pgid) : undefined;
      resolve({ at: new Date().toISOString(), code, signal, ...(leftovers?.length ? { leftovers } : {}) });
    }),
  );
}

/** Record the end of a run and pass it to `onEnd`; a failed write is passed along, not thrown. */
function endRun(job: Job, exit: Exit, onEnd: OnEnd | undefined): void {
  let end: JobEnd = exit;
  let error: Error | undefined;
  try {
    end = recordEnd(job, exit);
  } catch (cause) {
    error = cause as Error;
  }
  onEnd?.(end, error);
}

/** The record next to the job's log (both live in the owner's directory, see jobPaths). */
function recordPath(job: Job): string {
  return join(dirname(job.log), `${job.name}.json`);
}

function writeRecordSync(json: string, job: Job): void {
  const tmp = `${json}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, json);
}

/**
 * Write the end of this run into its record, with the stop reason recorded before the signal. It
 * runs right after the exit (or right after the record is first written), with no other work of this
 * process in between, and only this process can reuse the name, so the record is still this run's.
 */
export function recordEnd(job: Job, exit: Exit): JobEnd {
  const json = recordPath(job);
  const { stopping, ...record } = JSON.parse(readFileSync(json, "utf8")) as Job;
  const end: JobEnd = { ...exit, ...(stopping === undefined ? {} : { reason: stopping }) };
  writeRecordSync(json, { ...record, end });
  return end;
}

function leaderStartOf(pid: number): { leaderStart?: string } {
  const start = processStart(pid);
  return start === undefined ? {} : { leaderStart: start };
}

export async function tailLog(path: string, n = LOG_TAIL_LINES): Promise<string> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
  try {
    const size = (await fh.stat()).size;
    if (size === 0 || n <= 0) return "";
    const chunk = Math.min(size, TAIL_READ_MAX);
    const buf = Buffer.alloc(chunk);
    const { bytesRead } = await fh.read(buf, 0, chunk, size - chunk);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (size > chunk) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    // The final newline ends the last line; it does not start another one.
    return text.replace(/\n$/, "").split("\n").slice(-n).join("\n");
  } finally {
    await fh.close();
  }
}

export async function statusJobs({
  cwd,
  name,
  ownerPid = process.pid,
  registryRoot = bootRegistryDir(),
  tailLines = LOG_TAIL_LINES,
}: {
  cwd: string;
  name?: string;
  ownerPid?: number;
  registryRoot?: string;
  tailLines?: number;
}) {
  if (name !== undefined) {
    const job = await findJob(registryRoot, assertName(name), ownerPid);
    if (!job || job.occupying || !validPgid(job.pgid)) {
      throw new Error(`unknown job ${name}`);
    }
    return {
      ...job,
      liveness: liveness(job, ownerPid),
      logTail: await tailLog(job.log, tailLines),
    };
  }
  const jobs = await listJobs(registryRoot);
  return jobs
    .filter((job) => visibleInStatus(job, cwd, ownerPid))
    .map((job) => ({ ...job, liveness: liveness(job, ownerPid) }));
}

/** Wait until the group of a job being stopped has no process left; false when `ms` passes first. */
export async function groupGone(job: Job, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupContinues(job)) {
    if (Date.now() >= until) return false;
    await delay(25);
  }
  return true;
}

/**
 * SIGTERM this job's group, SIGKILL whatever is left after `graceMs`, and report whether it is gone.
 * Acts on the job's identity, never on a name, so it cannot reach a newer job of the same name.
 * `reason` is written to the record first, unless an earlier stop already wrote one (the first
 * accepted reason stands) or the run has already ended (its shell exited while processes it started
 * still run); the check and the write are synchronous. Failing to write it does not keep the job
 * running: the signals still go out, and the error is returned as `recordError`.
 */
/** What a stop did: the last signal sent, whether the group is gone, and a failure to record the reason. */
export type Stopped = { signaled: false | "SIGTERM" | "SIGKILL"; gone: boolean; recordError?: string };

export async function stopGroup(
  job: Job,
  { reason, graceMs = STOP_GRACE_MS }: { reason?: EndReason; graceMs?: number } = {},
): Promise<Stopped> {
  if (!jobAlive(job)) return { signaled: false, gone: true };
  let recordError: string | undefined;
  if (reason !== undefined) {
    try {
      // An orphan's record can be removed by another Pi's retention sweep once the job has ended.
      if (!recordStopping(job, reason) && !jobAlive(job)) return { signaled: false, gone: true };
    } catch (error) {
      recordError = (error as Error).message;
    }
  }
  const failure = recordError === undefined ? {} : { recordError };
  killGroup(job.pgid, "SIGTERM");
  if (await groupGone(job, graceMs)) return { signaled: "SIGTERM", gone: true, ...failure };
  killGroup(job.pgid, "SIGKILL");
  return { signaled: "SIGKILL", gone: await groupGone(job, KILL_WAIT_MS), ...failure };
}

/** Write the stop reason unless the record already has one or an end; false when the record is gone. */
function recordStopping(job: Job, reason: EndReason): boolean {
  const json = recordPath(job);
  return (
    unlessGone(() => {
      const record = JSON.parse(readFileSync(json, "utf8")) as Job;
      if (record.stopping === undefined && record.end === undefined) writeRecordSync(json, { ...record, stopping: reason });
      return true;
    }) ?? false
  );
}

/** stop by name (see findJob); refuses a job owned by another live Pi. */
export async function stopJob({
  name,
  reason,
  ownerPid = process.pid,
  registryRoot = bootRegistryDir(),
  graceMs = STOP_GRACE_MS,
}: {
  cwd?: string;
  name: string;
  reason?: EndReason;
  ownerPid?: number;
  registryRoot?: string;
  graceMs?: number;
}) {
  const job = await findJob(registryRoot, assertName(name), ownerPid);
  if (!job || job.occupying || !validPgid(job.pgid)) {
    throw new Error(`unknown job ${name}`);
  }
  const live = liveness(job, ownerPid);
  if (live === "Dead") {
    return { ...job, liveness: live, signaled: false as const, reason: "already dead", gone: true };
  }
  if (live === "Other") {
    throw new Error(`job ${name} is owned by live pid ${job.ownerPid}`);
  }
  return { ...job, liveness: live, ...(await stopGroup(job, { reason, graceMs })) };
}

/** Quit: SIGTERM every running job of this process, wait `graceMs` once, then SIGKILL what is left. */
export async function harvest({
  ownerPid = process.pid,
  registryRoot = bootRegistryDir(),
  graceMs = QUIT_GRACE_MS,
}: {
  ownerPid?: number;
  registryRoot?: string;
  graceMs?: number;
} = {}) {
  const mine = (await listJobs(registryRoot)).filter((job) => liveness(job, ownerPid) === "Mine");
  for (const job of mine) killGroup(job.pgid, "SIGTERM");
  if (mine.length > 0) await delay(graceMs);
  for (const job of mine) {
    if (groupContinues(job)) killGroup(job.pgid, "SIGKILL");
  }
  return { killed: mine.map((job) => job.name) };
}

/** An owner directory (see ownerKey) whose Pi process is still running. */
function ownerDirAlive(dirName: string): boolean {
  const [pid, start] = dirName.split("-");
  return alive(Number(pid)) && (start === undefined || processStart(Number(pid)) === start);
}

/**
 * Remove records and logs older than `retentionMs` whose job no longer runs. `root` holds one directory per boot. The directory of
 * another live Pi process is left to that process, so each directory keeps a single writer; a job
 * still running keeps its record and log at any age. Empty directories of earlier boots and of dead
 * owners are removed; this process's own directory in this boot is kept.
 *
 * Synchronous: this process's own record writes (occupyName, recordEnd, the stop reason) are
 * synchronous too, so none of them can fall between a file's check and its removal. The one
 * asynchronous write, a run's first record, only writes new files, which are far from the cutoff.
 * Two Pi processes starting together can sweep the same dead directories; a file or directory the
 * other one removed first is skipped.
 */
export function sweepRegistry({
  root,
  retentionMs = RETENTION_MS,
  ownerPid = process.pid,
}: {
  root: string;
  retentionMs?: number;
  ownerPid?: number;
}) {
  const cutoff = Date.now() - retentionMs;
  const currentBoot = sanitizeBootId(currentBootId());
  const own = ownerKey(ownerPid);
  const removed: string[] = [];
  for (const boot of subdirectories(root)) {
    const thisBoot = boot === currentBoot;
    for (const owner of subdirectories(join(root, boot))) {
      const ownDir = thisBoot && owner === own;
      if (thisBoot && !ownDir && ownerDirAlive(owner)) continue;
      const dir = join(root, boot, owner);
      const files = unlessGone(() => readdirSync(dir)) ?? [];
      // Only this boot can have running jobs; in an earlier boot every pid belongs to another process.
      const keep = new Set<string>();
      if (thisBoot) {
        for (const file of files.filter((f) => f.endsWith(".json"))) {
          const job = readRecordSync(join(dir, file));
          if (job && liveness(job, ownerPid) !== "Dead") {
            keep.add(file);
            keep.add(basename(job.log));
          }
        }
      }
      for (const file of files) {
        const path = join(dir, file);
        if (keep.has(file) || (unlessGone(() => statSync(path).mtimeMs) ?? cutoff) >= cutoff) continue;
        if (unlessGone(() => (unlinkSync(path), true))) removed.push(path);
      }
      if (!ownDir) removeIfEmpty(dir);
    }
    if (!thisBoot) removeIfEmpty(join(root, boot));
  }
  return { removed };
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

function removeIfEmpty(dir: string): void {
  if (unlessGone(() => readdirSync(dir))?.length !== 0) return;
  try {
    rmdirSync(dir);
  } catch (error) {
    // Gone already, or a file was written into it meanwhile (an orphan's stop reason).
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

/** `fn()`, or undefined when its path is gone (another Pi's sweep removed it first). */
function unlessGone<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}
