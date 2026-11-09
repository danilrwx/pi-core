import { createHash, randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface CheckpointFile {
  path: string;
  before?: string;
  existed: boolean;
  mode?: number;
}
export interface CheckpointData {
  id: string;
  turnEntryId?: string;
  createdAt: string;
  files: CheckpointFile[];
  skipped: string[];
  safety?: boolean;
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_STORE_BYTES = 256 * 1024 * 1024;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const EXCLUDED = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "vendor", "__pycache__"]);

export function checkpointRoot(): string {
  return process.env.PI_CHECKPOINT_DIR || join(homedir(), ".pi", "agent", "checkpoints");
}
function blobDir(): string { return join(checkpointRoot(), "blobs"); }
function blobPath(hash: string): string { return join(blobDir(), `${hash}.gz`); }

export function pathInside(cwd: string, path: string): boolean {
  const root = resolve(cwd) + sep;
  return resolve(path).startsWith(root);
}
function excluded(path: string, cwd: string): boolean {
  const parts = relative(cwd, path).split(sep);
  return parts.some((part) => EXCLUDED.has(part));
}

export interface ReadSnapshot { file: CheckpointFile; bytes?: Buffer }
/** Read the pre-state in memory; the blob is written only after the tool succeeds. */
export async function snapshot(cwd: string, path: string): Promise<ReadSnapshot | { error: string }> {
  const absolute = resolve(path);
  if (!pathInside(cwd, absolute)) return { error: "outside the project" };
  if (excluded(absolute, cwd)) return { error: "generated/vendor directory" };
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { error: "symlink" };
    if (!info.isFile()) return { error: "not a regular file" };
    if (info.size > MAX_FILE_BYTES) return { error: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB` };
    const bytes = await readFile(absolute);
    const before = createHash("sha256").update(bytes).digest("hex");
    return { file: { path: absolute, before, existed: true, mode: info.mode & 0o777 }, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { file: { path: absolute, existed: false } };
    return { error: (error as Error).message };
  }
}

export async function commitBlob(hash: string, bytes: Buffer): Promise<void> {
  const path = blobPath(hash);
  try { await access(path); return; } catch { /* Missing. */ }
  await withFileMutationQueue(path, async () => {
    try { await access(path); return; } catch { /* Missing. */ }
    await mkdir(blobDir(), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    // No fsync: losing a checkpoint on a crash is preferable to paying for an SSD flush here.
    await writeFile(temp, gzipSync(bytes, { level: 1 }), { mode: 0o600 });
    await rename(temp, path);
  });
}

export async function readBlob(hash: string): Promise<Buffer | undefined> {
  try { return gunzipSync(await readFile(blobPath(hash))); } catch { return undefined; }
}

/** Atomic restore without fsync; preserve the original mode when known. */
export async function restoreFile(cwd: string, file: CheckpointFile): Promise<"restored" | "deleted" | "skipped"> {
  const path = resolve(file.path);
  if (!pathInside(cwd, path) || excluded(path, cwd)) return "skipped";
  if (!file.existed) {
    try {
      const info = await lstat(path);
      if (!info.isFile()) return "skipped";
      await unlink(path);
      return "deleted";
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "deleted";
      return "skipped";
    }
  }
  if (!file.before) return "skipped";
  const bytes = await readBlob(file.before);
  if (!bytes) return "skipped";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.pi-restore`;
  await writeFile(temp, bytes, { mode: file.mode ?? 0o644 });
  await rename(temp, path);
  if (file.mode !== undefined) await chmod(path, file.mode);
  return "restored";
}

async function listBlobs(): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  let names: string[];
  try { names = await readdir(blobDir()); } catch { return []; }
  const result: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".gz")) continue;
    const path = join(blobDir(), name);
    try { const info = await stat(path); result.push({ path, size: info.size, mtimeMs: info.mtimeMs }); } catch { /* Gone. */ }
  }
  return result;
}

/** Best-effort TTL and size cap; never touches files outside the checkpoint store. */
export async function prune(now = Date.now()): Promise<void> {
  const blobs = await listBlobs();
  let total = 0;
  const alive: typeof blobs = [];
  for (const blob of blobs) {
    if (now - blob.mtimeMs > RETENTION_MS) { try { await unlink(blob.path); } catch { /* Gone. */ } }
    else { alive.push(blob); total += blob.size; }
  }
  alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const blob of alive) {
    if (total <= MAX_STORE_BYTES) break;
    try { await unlink(blob.path); total -= blob.size; } catch { /* Gone. */ }
  }
}

export function newCheckpointId(): string { return randomBytes(4).toString("hex"); }
export function absolutePath(cwd: string, path: string): string { return resolve(isAbsolute(path) ? path : join(cwd, path)); }
