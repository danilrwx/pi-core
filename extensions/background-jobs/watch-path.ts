import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { LineBatcher, floodGate, monitorTimeout } from "./events.ts";

export interface PathWatch {
  name: string;
  path: string;
  description: string;
  sessionId: string;
  startedAt: string;
  stop(silent?: boolean): void;
}

/** Watch the parent of a file so an atomic editor save doesn't detach the watch from its new inode. */
export async function startPathWatch(
  params: { name: string; path: string; cwd: string; description: string; sessionId: string; recursive?: boolean; timeoutMs?: number; signal?: AbortSignal },
  notify: (text: string) => void,
  finished: (reason: string, silent?: boolean) => void,
): Promise<PathWatch> {
  if (params.signal?.aborted) throw new Error("Watch cancelled before start");
  const timeoutMs = monitorTimeout(params.timeoutMs);
  const path = resolve(params.cwd, params.path);
  const info = await stat(path);
  if (params.signal?.aborted) throw new Error("Watch cancelled before start");
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  const admit = floodGate(10);
  const batcher = new LineBatcher((lines, dropped) => {
    if (closed) return;
    if (!admit()) return stop("too many events; use a narrower path");
    const unique = [...new Set(lines)];
    notify(`${unique.join("\n")}${dropped ? `\n(${dropped} events omitted)` : ""}`);
  });
  function stop(reason: string, silent = false) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    batcher.end();
    finished(reason, silent);
  }
  watcher = watch(info.isDirectory() ? path : dirname(path), { recursive: info.isDirectory() && (params.recursive ?? false) });
  watcher.on("change", (event, file) => {
    if (closed || (!info.isDirectory() && file !== null && file.toString() !== basename(path))) return;
    batcher.push(`${event}: ${file?.toString() ?? path}\n`);
  });
  watcher.on("error", () => stop("filesystem watch failed"));
  timer = setTimeout(() => stop("expired"), timeoutMs);
  timer.unref();
  return {
    name: params.name, path, description: params.description, sessionId: params.sessionId,
    startedAt: new Date().toISOString(), stop: (silent) => stop("stopped", silent),
  };
}
