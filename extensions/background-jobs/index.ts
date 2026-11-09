/** Copyright 2026 GhabiX. Apache-2.0; see licenses/Apache-2.0-GhabiX.txt.
 * Vendored from pi-background-job 08389a0; modified for pi-core: permissions, private capped logs, path watches.
 */
import { delimiter, join, resolve } from "node:path";
import { isInside } from "../lib/path-safety.js";
import { authorizeShell } from "../lib/shell-permission.js";
import { startPathWatch, type PathWatch } from "./watch-path.ts";
import { MAX_LOG_BYTES } from "./private-log.ts";
import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bootRegistryDir,
  assertName,
  harvest,
  jobAlive,
  liveness,
  spawnDetached,
  startJob,
  statusJobs,
  stopGroup,
  stopJob,
  sweepRegistry,
  tailLog,
  type EndReason,
  type Job,
  type JobEnd,
  type Liveness,
  type OnEnd,
  type SpawnCommand,
} from "./core.ts";
import {
  EVENT_WINDOW_MS,
  EXIT_TAIL_LINES,
  FLOOD_MAX_EVENTS,
  LineBatcher,
  MONITOR_DEFAULT_MS,
  MONITOR_MAX_MS,
  captureStdout,
  eventMessage,
  exitMessage,
  floodGate,
  monitorEndMessage,
  monitorTimeout,
  oneLine,
  untrusted,
} from "./events.ts";

export const MESSAGE_TYPE = "background-job";

const BACKGROUND_JOB_GUIDELINES = [
  "background_job action=start runs a command in its own process group and returns at once. When the command exits, a message with its exit code and last output arrives and starts a turn if you are idle; do not poll status or sleep to wait for it.",
  "Use background_job for long builds, test runs, and servers when there is other work to do meanwhile; use bash when you need the result before anything else.",
  "To be told when something becomes true, start a command that exits when it does, for example `until curl -sf localhost:3000/health; do sleep 1; done`.",
  "The full output is in the log file named in the start result; read it with read. status lists jobs, and stop ends the processes in the job's process group (a process that left the group, for example with setsid, is not reached).",
  "Jobs end when Pi quits; daemons that must outlive Pi belong to systemd or tmux. Do not start background processes with `cmd &` in bash.",
];

const MONITOR_GUIDELINES = [
  `monitor runs a command whose stdout lines are events: lines that arrive within ${EVENT_WINDOW_MS} ms form one message, which starts a turn if you are idle. The watch ends when the command exits, after timeout_ms, or when it sends more than ${FLOOD_MAX_EVENTS} messages in a minute.`,
  "Use monitor for one message per occurrence (each error line, each CI step). For a single notice when something finishes, use background_job action=start instead.",
  "Filter to the lines you would act on, and include failure signatures as well as success, for example `tail -f app.log | grep --line-buffered -E 'ready|ERROR|Traceback'`. Silence is not success.",
  "Every pipe stage must flush per line (grep --line-buffered, awk fflush()). Only stdout is an event; stderr goes to the log, so merge it with 2>&1 when the command's own errors matter.",
  "When a monitor expires and you still need it, start it again. Stop one early with background_job action=stop.",
];

type Stdout = ReturnType<typeof captureStdout>;
type Ended = { end: JobEnd; error?: Error };
/** `toolCallId`: the call that started the job, so a host can treat the message as that call's deferred output. */
type MessageDetails = { name: string; kind: "exit" | "event" | "end" | "error"; end?: JobEnd; toolCallId?: string };
/**
 * A job of this process whose end has not been reported yet. `exited`: its shell has exited.
 * `reason`: this extension is stopping it, and why; the first accepted reason, kept here as well as
 * in the record, which a failed write can leave without it.
 */
type Live = { job: Job; events: number; exited: boolean; reason?: EndReason; deadline?: NodeJS.Timeout };
type Pending = { sessionId?: string; content: string; details: MessageDetails };
/** `live` is keyed by leader pid: a name can be reused while the previous job of that name is still draining. */
type Runtime = { api?: ExtensionAPI; ui?: ExtensionUIContext; sessionId?: string; live: Map<number, Live>; pending: Pending[]; watchers: Map<string, PathWatch> };

// One runtime per Pi process. /reload and session replacement load this extension again and make
// the previous `pi` stale, so exit handlers deliver through the instance that is current then.
const runtimeKey = Symbol.for("pi-core.background-jobs.v1");
const runtime = ((globalThis as Record<symbol, unknown>)[runtimeKey] ??= { live: new Map(), pending: [], watchers: new Map() }) as Runtime;

async function authorizedCommand(pi: ExtensionAPI, command: string, ctx: ExtensionContext): Promise<string> {
  const prefix = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getShellCommandPrefix();
  const prepared = prefix ? `${prefix}\n${command}` : command;
  await authorizeShell(pi, prepared, ctx);
  return prepared;
}

function ensureFreeName(name?: string): void {
  if (name && (runtime.watchers.has(name) || [...runtime.live.values()].some((live) => live.job.name === name))) {
    throw new Error(`Task name ${name} is already in use`);
  }
}

export function getBackgroundShellEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const binDir = join(getAgentDir(), "bin");
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const updatedPath = pathEntries.includes(binDir)
    ? currentPath
    : [binDir, currentPath].filter(Boolean).join(delimiter);
  return { ...process.env, [pathKey]: updatedPath };
}

function stateRoot(): string {
  return join(getAgentDir(), "state", "background-job");
}

function registryRoot(): string {
  return bootRegistryDir(stateRoot());
}

/** After a monitor's shell exits and its group is stopped, its remaining stdout is read for at most this long. */
const DRAIN_MS = 1000;

/**
 * The spawn for startJob, plus the two things track() needs from it. A monitor's stdout is taken at
 * once (Node discards the unread stdout of a child that has exited); its end arrives through `onEnd`.
 */
function spawnWithEnd() {
  let stdout: Stdout | undefined;
  let logError: (() => Error | undefined) | undefined;
  let resolveEnd: (ended: Ended) => void = () => {};
  const ended = new Promise<Ended>((resolve) => (resolveEnd = resolve));
  const onEnd: OnEnd = (end, error) => resolveEnd({ end, error });
  const spawnCommand: SpawnCommand = (opts) => {
    const config = getShellConfig();
    const spawned = spawnDetached({
      ...opts,
      shell: config.shell,
      shellArgs: config.args,
      commandTransport: config.commandTransport ?? "argv",
      env: getBackgroundShellEnv(),
    });
    // A monitor's stdout goes to its log and, buffered until track() reads it, to the event batcher.
    logError = spawned.logError;
    if (opts.stdout === "pipe" && spawned.handle.stdout) stdout = captureStdout(spawned.handle.stdout, opts.logPath);
    return spawned;
  };
  return { spawnCommand, onEnd, track: (job: Job, timeoutMs?: number) => track(job, ended, stdout, timeoutMs, logError) };
}

/** Send a message to the session that started the job; a job of another session keeps its result in the record. */
function deliver(job: Job, content: string, details: MessageDetails): void {
  if (job.sessionId !== runtime.sessionId) return;
  const message = { sessionId: job.sessionId, content, details: job.toolCallId === undefined ? details : { ...details, toolCallId: job.toolCallId } };
  if (runtime.api === undefined || !send(runtime.api, message)) runtime.pending.push(message);
}

/**
 * Between a session_shutdown and the next session_start (a reload) there is no live instance. A host
 * can also dispose a session without session_shutdown (the SDK's dispose()); Pi then throws on any
 * use of the instance and offers no way to ask first. Either way the message waits for a session_start.
 */
function send(api: ExtensionAPI, message: Pending): boolean {
  try {
    api.sendMessage(
      { customType: MESSAGE_TYPE, content: message.content, display: true, details: message.details },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return true;
  } catch {
    runtime.api = undefined;
    runtime.ui = undefined;
    return false;
  }
}

/** Footer: how many jobs and monitors of the current session are running. */
function showStatus(): void {
  if (runtime.ui === undefined) return;
  const mine = [...runtime.live.values()].filter((live) => live.job.sessionId === runtime.sessionId);
  const monitors = mine.filter((live) => live.job.watch === "lines").length;
  const jobs = mine.length - monitors;
  const watchers = [...runtime.watchers.values()].filter((watch) => watch.sessionId === runtime.sessionId).length;
  const parts = [
    ...(watchers > 0 ? [`${watchers} file watch${watchers === 1 ? "" : "es"}`] : []),
    ...(jobs > 0 ? [`${jobs} background job${jobs === 1 ? "" : "s"}`] : []),
    ...(monitors > 0 ? [`${monitors} monitor${monitors === 1 ? "" : "s"}`] : []),
  ];
  try {
    runtime.ui.setStatus("background-job", parts.length === 0 ? undefined : parts.join(" · "));
  } catch {
    // Disposed without session_shutdown (see send()); the next session_start sets a live ui.
    runtime.ui = undefined;
  }
}

/** A note for the user, not the model; dropped when the session is gone (see showStatus). */
function warn(text: string): void {
  try {
    runtime.ui?.notify(text, "warning");
  } catch {
    runtime.ui = undefined;
  }
}

function report(job: Job, error: unknown): void {
  deliver(job, `background_job could not handle the end of job ${job.name}: ${(error as Error).message}`, {
    name: job.name,
    kind: "error",
  });
}

function track(job: Job, ended: Promise<Ended>, stdout: Stdout | undefined, timeoutMs?: number, logError?: () => Error | undefined): void {
  const live: Live = { job, events: 0, exited: false };
  runtime.live.set(job.pid, live);
  showStatus();
  const exited = ended.then((result) => {
    live.exited = true;
    clearTimeout(live.deadline);
    return result;
  });
  let finished = exited;
  if (stdout !== undefined) {
    const admit = floodGate();
    const batcher = new LineBatcher((lines, dropped) => {
      if (live.reason !== undefined) return;
      if (!admit()) {
        halt(live, "flooded");
        return;
      }
      live.events++;
      deliver(job, eventMessage(job, lines, dropped), { name: job.name, kind: "event" });
    });
    stdout.stream.on("data", (chunk: string) => batcher.push(chunk));
    // The watch ends when its shell exits. Processes left in its group are stopped; output already
    // written is still read, for at most DRAIN_MS, because a process outside the group (setsid) can
    // hold stdout open. The end message follows the last batch.
    // The end carries the processes left in the group, which identify it now that the leader is gone.
    const cleaned = exited.then(({ end }) => stopGroup({ ...job, end }));
    const drained = new Promise<void>((resolve) => {
      stdout.stream.on("end", resolve);
      const arm = () => setTimeout(resolve, DRAIN_MS).unref();
      cleaned.then(arm, arm);
    }).then(async () => {
      await stdout.release();
      batcher.end();
    });
    finished = Promise.all([exited, cleaned, drained]).then(([result]) => result);
    live.deadline = setTimeout(() => halt(live, "expired"), timeoutMs);
    live.deadline.unref();
  }
  finished.then((result) => finish(live, result, stdout?.logError() ?? logError?.())).catch((error) => report(job, error));
}

/** End a running job from this side; the reason is recorded and its end is reported accordingly. */
function halt(live: Live, reason: EndReason): void {
  if (live.reason !== undefined || live.exited) return;
  live.reason = reason;
  stopGroup(live.job, { reason })
    .then((stopped) => {
      if (stopped.recordError !== undefined) report(live.job, new Error(`recording the stop reason failed: ${stopped.recordError}`));
    })
    .catch((error) => report(live.job, error));
}

async function finish(live: Live, ended: Ended, logError: Error | undefined): Promise<void> {
  const { job } = live;
  const { error } = ended;
  // The recorded reason is the first accepted one; the one in memory covers a record that could not take it.
  const reason = ended.end.reason ?? live.reason;
  const end: JobEnd = reason === undefined ? ended.end : { ...ended.end, reason };
  runtime.live.delete(job.pid);
  showStatus();
  const notes = [
    ...(logError === undefined ? [] : [`Writing its stdout to the log failed: ${logError.message}`]),
    ...(error === undefined ? [] : [`Recording its end failed: ${error.message}`]),
  ];
  // The model's own stop: its result reports the end.
  if (reason === "stopped") {
    if (notes.length > 0) deliver(job, notes.join("\n"), { name: job.name, kind: "error", end });
    return;
  }
  const content =
    job.watch === "lines"
      ? monitorEndMessage(job, end, live.events, reason)
      : exitMessage(job, end, await tailLog(job.log, EXIT_TAIL_LINES), jobAlive({ ...job, end }));
  deliver(job, [content, `Log cap: ${MAX_LOG_BYTES / 1024 / 1024} MiB per run; excess output is discarded.`, ...notes].join("\n"), { name: job.name, kind: job.watch === "lines" ? "end" : "exit", end });
}

function stateText(job: Job & { liveness: Liveness }): string {
  if (job.liveness !== "Dead") return job.liveness === "Mine" ? "running" : `running (${job.liveness})`;
  if (job.end === undefined) return "ended";
  return job.end.signal === null ? `exit ${job.end.code}` : `killed by ${job.end.signal}`;
}

/** /jobs: list this process's view of the jobs; choosing a running one offers to stop it. */
async function jobsCommand(ctx: ExtensionContext): Promise<void> {
  const jobs = (await statusJobs({ cwd: ctx.cwd, registryRoot: registryRoot() })) as Array<Job & { liveness: Liveness }>;
  const watches = [...runtime.watchers.values()].filter((watch) => watch.sessionId === ctx.sessionManager.getSessionId());
  if (jobs.length === 0 && watches.length === 0) {
    ctx.ui.notify("No background jobs or file watches.", "info");
    return;
  }
  const watchOptions = new Map(watches.map((watch) => [`watch: ${watch.name} · ${watch.path}`, watch]));
  // Numbered, since name and command can repeat across Pi processes.
  const options = new Map(
    jobs.map((job, i) => [
      `${i + 1}. ${job.name}  ${job.watch === "lines" ? "monitor  " : ""}${stateText(job)}  pgid ${job.pgid}  ${oneLine(job.command)}`,
      job,
    ]),
  );
  const choice = await ctx.ui.select("Background jobs / watches (choose one to stop it)", [...options.keys(), ...watchOptions.keys()]);
  const watch = choice === undefined ? undefined : watchOptions.get(choice);
  if (watch) {
    if (await ctx.ui.confirm(`Stop ${watch.name}?`, watch.path)) watch.stop();
    return;
  }
  const job = choice === undefined ? undefined : options.get(choice);
  if (job === undefined || (job.liveness !== "Mine" && job.liveness !== "Orphan")) return;
  if (!(await ctx.ui.confirm(`Stop ${job.name}?`, oneLine(job.command)))) return;
  // The chosen run itself, not whatever its name resolves to now: names repeat across Pi processes.
  const now = liveness(job);
  if (now !== "Mine" && now !== "Orphan") {
    ctx.ui.notify(`${job.name} is no longer running.`, "info");
    return;
  }
  // No stop reason: a job of this process reports its exit to its session as usual.
  const stopped = await stopGroup(job);
  ctx.ui.notify(stopped.gone ? `Stopped ${job.name}.` : `${job.name} still has processes after SIGKILL.`, stopped.gone ? "info" : "warning");
}

type BackgroundJobParams = { action: "start" | "status" | "stop"; command?: string; name?: string };

async function backgroundJobAction(pi: ExtensionAPI, params: BackgroundJobParams, toolCallId: string, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  switch (params.action) {
    case "start": {
      if (params.command === undefined) throw new Error("start requires command");
      ensureFreeName(params.name);
      const command = await authorizedCommand(pi, params.command, ctx);
      const spawn = spawnWithEnd();
      const job = await startJob({
        cwd: ctx.cwd,
        command,
        name: params.name,
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId,
        onEnd: spawn.onEnd,
        registryRoot: registryRoot(),
        spawnCommand: spawn.spawnCommand,
        signal,
      });
      spawn.track(job);
      return job;
    }
    case "status":
      if (params.command !== undefined) throw new Error("status does not take command");
      if (params.name && runtime.watchers.has(params.name)) {
        const { stop, ...watch } = runtime.watchers.get(params.name)!;
        if (watch.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("File watch belongs to another session");
        return watch;
      }
      if (params.name) return statusJobs({ cwd: ctx.cwd, name: params.name, registryRoot: registryRoot() });
      const listed = await statusJobs({ cwd: ctx.cwd, registryRoot: registryRoot() });
      return [
        ...(Array.isArray(listed) ? listed : [listed]),
        ...[...runtime.watchers.values()].filter((watch) => watch.sessionId === ctx.sessionManager.getSessionId()).map(({ stop, ...watch }) => watch),
      ];
    case "stop": {
      if (params.name === undefined) throw new Error("stop requires name");
      if (params.command !== undefined) throw new Error("stop does not take command");
      const watch = runtime.watchers.get(params.name);
      if (watch) {
        if (watch.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("File watch belongs to another session");
        watch.stop();
        return { name: params.name, stopped: true };
      }
      // The model's own stop: its result reports the end, so no exit message follows. A running job of
      // this process is stopped by identity, its reason accepted here with nothing asynchronous in
      // between; a reason accepted earlier (an expiry already under way) stands and is the one recorded.
      // Any other job (another Pi's orphan, one that has ended) is stopped by name.
      const live = [...runtime.live.values()].find((entry) => entry.job.name === params.name && !entry.exited);
      if (live === undefined) return stopJob({ name: params.name, reason: "stopped", registryRoot: registryRoot() });
      live.reason ??= "stopped";
      return { ...live.job, liveness: "Mine" as const, ...(await stopGroup(live.job, { reason: live.reason })) };
    }
  }
}

function formatResult(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function modeNote(ctx: ExtensionContext): string {
  return ctx.mode === "print" || ctx.mode === "json"
    ? "\nThis Pi run is non-interactive and ends when you stop working; messages that would arrive after that are lost.\n"
    : "";
}

function installBackgroundJob(pi: ExtensionAPI) {
  // The current process-group implementation is Unix-only. Keep the public
  // name platform-neutral so a later Windows adapter does not change the API.
  if (process.platform === "win32") return;

  pi.registerTool({
    name: "background_job",
    executionMode: "sequential",
    label: "Background Job",
    description:
      "Start, inspect, or stop a shell command that runs in the background of this Pi process. start returns at once; when the command exits, a message with its exit code and last output arrives.",
    promptSnippet: "Run shell commands in the background; their exit arrives as a message",
    promptGuidelines: BACKGROUND_JOB_GUIDELINES,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")], {
        description: "start a job, list or inspect jobs, or stop a job by name",
      }),
      command: Type.Optional(
        Type.String({
          description: "Shell command. Required for start. Forbidden for status/stop.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Job name [A-Za-z0-9._-]{1,64}. Optional for start/status, required for stop.",
        }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const result = await backgroundJobAction(pi, params, toolCallId, signal, ctx);
      return {
        content: [{ type: "text" as const, text: formatResult(result) + (params.action === "start" ? modeNote(ctx) : "") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "monitor",
    executionMode: "sequential",
    label: "Monitor",
    description:
      "Run a command in the background and turn each line it prints to stdout into a message. The watch ends when the command exits, on timeout, or when it floods. Stop it early with background_job action=stop.",
    promptSnippet: "Watch a command's stdout in the background; each new line arrives as a message",
    promptGuidelines: MONITOR_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command or script. Each stdout line is an event; exit ends the watch." }),
      description: Type.String({ description: "Short description of what is watched, shown in every message." }),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 1000,
          description: `Stop the watch after this many ms. Default ${MONITOR_DEFAULT_MS}; values above ${MONITOR_MAX_MS} are capped.`,
        }),
      ),
      name: Type.Optional(Type.String({ description: "Job name [A-Za-z0-9._-]{1,64}; generated when omitted." })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const timeoutMs = monitorTimeout(params.timeout_ms);
      ensureFreeName(params.name);
      const command = await authorizedCommand(pi, params.command, ctx);
      const spawn = spawnWithEnd();
      const job = await startJob({
        cwd: ctx.cwd,
        command,
        name: params.name,
        watch: "lines",
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId,
        description: params.description,
        onEnd: spawn.onEnd,
        registryRoot: registryRoot(),
        spawnCommand: spawn.spawnCommand,
        signal,
      });
      spawn.track(job, timeoutMs);
      const result = { ...job, timeoutMs };
      return { content: [{ type: "text" as const, text: formatResult(result) + modeNote(ctx) }], details: result };
    },
  });

  pi.registerTool({
    name: "watch_path",
    label: "Watch Path",
    executionMode: "sequential",
    description: "Watch a file or directory for filesystem events, without polling. Changes arrive as messages. Stop by name with background_job. Watches end on session switch, reload, quit or timeout.",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({
      name: Type.String({ description: "Unique task name [A-Za-z0-9._-]{1,64}" }),
      path: Type.String(),
      description: Type.String(),
      recursive: Type.Optional(Type.Boolean()),
      timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: MONITOR_MAX_MS })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      assertName(params.name);
      ensureFreeName(params.name);
      const target = resolve(ctx.cwd, params.path);
      if (!isInside(ctx.cwd, target)) {
        if (!ctx.hasUI) {
          return { content: [{ type: "text" as const, text: "Error: watching a path outside the project requires the interactive UI." }], details: {}, isError: true };
        }
        if (!await ctx.ui.confirm("Watch outside the project?", target)) {
          return { content: [{ type: "text" as const, text: "Cancelled: the path is outside the project." }], details: {}, isError: true };
        }
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const watch = await startPathWatch({
        name: params.name, path: target, cwd: ctx.cwd, description: params.description,
        sessionId, recursive: params.recursive, timeoutMs: params.timeout_ms, signal,
      }, (text) => {
        if (runtime.sessionId === sessionId && runtime.api) send(runtime.api, {
          sessionId, content: `File watch ${params.name}:\n${untrusted(text)}`, details: { name: params.name, kind: "event" },
        });
      }, (reason, silent) => {
        runtime.watchers.delete(params.name);
        showStatus();
        if (!silent && runtime.sessionId === sessionId && runtime.api) send(runtime.api, {
          sessionId, content: `File watch ${params.name} ended: ${reason}`, details: { name: params.name, kind: "end" },
        });
      });
      runtime.watchers.set(params.name, watch);
      showStatus();
      const { stop, ...details } = watch;
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });

  pi.registerCommand("jobs", {
    description: "List background jobs and monitors; choose a running one to stop it",
    handler: async (_args, ctx) => jobsCommand(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.api = pi;
    runtime.ui = ctx.hasUI ? ctx.ui : undefined;
    runtime.sessionId = ctx.sessionManager.getSessionId();
    showStatus();
    try {
      sweepRegistry({ root: stateRoot() });
    } catch (error) {
      warn(`background_job: removing old logs failed: ${(error as Error).message}`);
    }
    const pending = runtime.pending;
    runtime.pending = [];
    for (const message of pending) {
      if (message.sessionId === runtime.sessionId) send(pi, message);
    }
  });

  pi.on("session_shutdown", async (event) => {
    runtime.ui?.setStatus("background-job", undefined);
    runtime.api = undefined;
    runtime.ui = undefined;
    runtime.pending = [];
    for (const watch of runtime.watchers.values()) watch.stop(true);
    runtime.watchers.clear();
    if (event.reason === "quit") {
      await harvest({ registryRoot: registryRoot() });
      return;
    }
    if (event.reason === "reload") return;
    // A monitor only produces messages for its session; it ends when that session is left.
    for (const live of runtime.live.values()) {
      if (live.job.watch === "lines" && live.job.sessionId === runtime.sessionId) halt(live, "stopped");
    }
  });
}

export default function backgroundJob(pi: ExtensionAPI) {
  installBackgroundJob(pi);
}
