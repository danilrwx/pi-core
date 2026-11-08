import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type MemoryScope = "global" | "project";
export interface Memory {
  id: string;
  text: string;
  tags: string[];
  scope: MemoryScope;
  createdAt: string;
  updatedAt: string;
}
interface MemoryFile { version: 1; cwd?: string; memories: Memory[] }

export const MAX_MEMORIES = 500;
const MAX_TEXT = 2000;
const MAX_TAGS = 12;
const MAX_TAG = 64;

export function memoryRoot(): string {
  return process.env.PI_MEMORY_DIR || join(homedir(), ".pi", "agent", "memory");
}
export function projectMemoryFile(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(memoryRoot(), "projects", `${hash}.json`);
}
function globalMemoryFile(): string { return join(memoryRoot(), "global.json"); }
function fileFor(scope: MemoryScope, cwd: string): string {
  return scope === "global" ? globalMemoryFile() : projectMemoryFile(cwd);
}

function clean(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text.slice(0, max);
}
function cleanTags(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("tags must be an array");
  const tags = input.map((tag) => clean(tag, MAX_TAG, "tag").toLowerCase());
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

async function readFileSafe(path: string): Promise<MemoryFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MemoryFile>;
    if (!Array.isArray(parsed.memories)) return { version: 1, memories: [] };
    const memories = parsed.memories.filter((entry): entry is Memory =>
      Boolean(entry) && typeof entry === "object" &&
      typeof entry.id === "string" && typeof entry.text === "string" &&
      (entry.scope === "global" || entry.scope === "project") &&
      Array.isArray(entry.tags) && typeof entry.createdAt === "string" && typeof entry.updatedAt === "string");
    return { version: 1, ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}), memories };
  } catch { return { version: 1, memories: [] }; }
}

/** Callers hold the file mutation queue; this only performs the atomic replace. */
async function writeFileSafe(path: string, data: MemoryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

export async function loadScope(scope: MemoryScope, cwd: string): Promise<Memory[]> {
  const data = await readFileSafe(fileFor(scope, cwd));
  return data.memories.map((memory) => ({ ...memory, scope }));
}
export async function loadAll(cwd: string): Promise<Memory[]> {
  const [global, project] = await Promise.all([loadScope("global", cwd), loadScope("project", cwd)]);
  return [...global, ...project];
}

export async function addMemory(cwd: string, input: { text: unknown; tags?: unknown; scope?: unknown }): Promise<{ memory: Memory; duplicate: boolean }> {
  const scope: MemoryScope = input.scope === "global" ? "global" : "project";
  const text = clean(input.text, MAX_TEXT, "text");
  const tags = cleanTags(input.tags);
  const path = fileFor(scope, cwd);
  let result: { memory: Memory; duplicate: boolean } | undefined;
  await withFileMutationQueue(path, async () => {
    const data = await readFileSafe(path);
    const duplicate = data.memories.find((memory) => memory.text.toLowerCase() === text.toLowerCase());
    if (duplicate) { result = { memory: duplicate, duplicate: true }; return; }
    if (data.memories.length >= MAX_MEMORIES) throw new Error(`Memory limit reached (${MAX_MEMORIES} per scope); forget something first`);
    const now = new Date().toISOString();
    const memory: Memory = { id: randomBytes(4).toString("hex"), text, tags, scope, createdAt: now, updatedAt: now };
    data.memories.push(memory);
    if (scope === "project") data.cwd = cwd;
    await writeFileSafe(path, data);
    result = { memory, duplicate: false };
  });
  if (!result) throw new Error("Memory write failed");
  return result;
}

export function searchMemories(memories: Memory[], query: string, limit = 8): Memory[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const tokens = [...new Set(needle.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2))];
  const scored = memories.map((memory) => {
    const haystack = `${memory.text} ${memory.tags.join(" ")}`.toLowerCase();
    let score = haystack.includes(needle) ? 10 : 0;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    return { memory, score };
  }).filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
  return scored.slice(0, limit).map((entry) => entry.memory);
}

export async function forgetMemory(cwd: string, id: string): Promise<Memory[]> {
  const removed: Memory[] = [];
  for (const scope of ["project", "global"] as const) {
    const path = fileFor(scope, cwd);
    await withFileMutationQueue(path, async () => {
      const data = await readFileSafe(path);
      const index = data.memories.findIndex((memory) => memory.id === id);
      if (index === -1) return;
      removed.push(data.memories[index]);
      data.memories.splice(index, 1);
      await writeFileSafe(path, data);
    });
  }
  return removed;
}

export async function clearScope(cwd: string, scope: MemoryScope): Promise<number> {
  const path = fileFor(scope, cwd);
  let count = 0;
  await withFileMutationQueue(path, async () => {
    const data = await readFileSafe(path);
    count = data.memories.length;
    await writeFileSafe(path, { version: 1, ...(scope === "project" ? { cwd } : {}), memories: [] });
  });
  return count;
}
