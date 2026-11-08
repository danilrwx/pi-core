import { createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface ObservedFile { path: string; fingerprint: string }
export async function fingerprint(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return "not-a-file";
    if (info.size > 4 * 1024 * 1024) return `stat:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) return "unstable";
    return `sha256:${createHash("sha256").update(bytes.subarray(0, offset)).digest("hex")}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  } finally { await file?.close(); }
}

/** One OS watch per parent directory; no polling and no inference about which process wrote a file. */
export class ReadTracker {
  private files = new Map<string, { baseline: string; notified?: string }>();
  private dirs = new Map<string, FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();
  private writing = new Map<string, number>();
  private closed = false;
  constructor(private changed: (path: string, observed: string) => void, private maxFiles = 256) {}

  observe(record: ObservedFile): void {
    if (this.closed) return;
    const path = resolve(record.path);
    this.files.delete(path);
    this.files.set(path, { baseline: record.fingerprint });
    while (this.files.size > this.maxFiles) this.files.delete(this.files.keys().next().value!);
    this.pruneDirs();
    const dir = dirname(path);
    if (!this.dirs.has(dir)) {
      try {
        const watcher = watch(dir, (_event, name) => {
          for (const file of this.files.keys()) {
            if (dirname(file) === dir && (name === null || basename(file) === name.toString())) this.schedule(file);
          }
        });
        watcher.on("error", () => { watcher.close(); this.dirs.delete(dir); });
        this.dirs.set(dir, watcher);
      } catch { /* Missing/inaccessible directory: explicit checks on resume still work. */ }
    }
  }

  private pruneDirs(): void {
    const needed = new Set([...this.files.keys()].map(dirname));
    for (const [dir, watcher] of this.dirs) if (!needed.has(dir)) { watcher.close(); this.dirs.delete(dir); }
  }
  private schedule(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.set(path, setTimeout(() => { this.timers.delete(path); void this.check(path); }, 200));
  }
  async check(path: string): Promise<boolean> {
    const record = this.files.get(path);
    if (!record || this.closed || this.writing.has(path)) return false;
    const current = await fingerprint(path);
    if (this.closed || this.files.get(path) !== record || this.writing.has(path)) return false;
    if (current !== record.baseline && current !== record.notified) {
      record.notified = current;
      this.changed(path, current);
    }
    return current !== record.baseline;
  }
  beginWrite(path: string): void { this.writing.set(path, (this.writing.get(path) ?? 0) + 1); }
  async endWrite(path: string, success: boolean): Promise<ObservedFile | undefined> {
    const count = (this.writing.get(path) ?? 1) - 1;
    if (count > 0) { this.writing.set(path, count); return; }
    this.writing.delete(path);
    if (!this.files.has(path) || this.closed) return;
    if (success) {
      const record = { path, fingerprint: await fingerprint(path) };
      this.observe(record);
      return record;
    }
    await this.check(path);
  }
  records(): ObservedFile[] { return [...this.files].map(([path, record]) => ({ path, fingerprint: record.baseline })); }
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const watcher of this.dirs.values()) watcher.close();
    this.files.clear(); this.dirs.clear(); this.timers.clear(); this.writing.clear();
  }
}
