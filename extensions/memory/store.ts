import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type MemoryScope = "global" | "project";
export type MemoryType = "feedback" | "project" | "reference" | "user";
export interface Memory {
  id: string;
  text: string;
  description: string;
  tags: string[];
  type: MemoryType;
  scope: MemoryScope;
  createdAt: string;
  updatedAt: string;
  importedFrom?: string;
  originSessionId?: string;
}

export const MAX_MEMORIES = 500;
const MAX_TEXT = 20000;
const MAX_DESCRIPTION = 240;
const MAX_TAGS = 12;
const MAX_TAG = 64;
const INDEX = "MEMORY.md";

export function memoryRoot(): string {
  return process.env.PI_MEMORY_DIR || join(homedir(), ".pi", "agent", "memory");
}
/** Same project directory naming as Claude Code: /home/me/repo -> -home-me-repo. */
export function projectSlug(cwd: string): string {
  return `-${cwd.replace(/^\/+/, "").replace(/\/+/g, "-")}`;
}
export function projectMemoryDir(cwd: string): string { return join(memoryRoot(), "projects", projectSlug(cwd)); }
export function scopeDir(scope: MemoryScope, cwd: string): string {
  return scope === "global" ? join(memoryRoot(), "global") : projectMemoryDir(cwd);
}
export function claudeMemoryDir(cwd: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(config, "projects", projectSlug(cwd), "memory");
}

function clean(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text.slice(0, max);
}
/** Keep Markdown structure and line breaks; only strip terminal control characters. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("text must be a string");
  const text = value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (!text) throw new Error("text must not be empty");
  return text.slice(0, max);
}
function cleanTags(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("tags must be an array");
  return [...new Set(input.map((tag) => clean(tag, MAX_TAG, "tag").toLowerCase()))].slice(0, MAX_TAGS);
}
function slug(text: string, fallback: string): string {
  const base = text.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 7).join("-").slice(0, 60);
  return base || fallback;
}
function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}
function titleOf(memory: Memory): string {
  return memory.description || memory.text.split("\n")[0].slice(0, 120) || memory.id;
}
function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { /* Fall through. */ }
  }
  return trimmed.replace(/^'|'$/g, "");
}
function parseFrontmatter(raw: string, file: string, scope: MemoryScope): Memory | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const body = (match ? match[2] : raw).trim();
  if (!body) return;
  const front = match ? match[1] : "";
  let name = basename(file, ".md");
  let description = "";
  let type: MemoryType = scope === "global" ? "user" : "project";
  let modified = new Date(0).toISOString();
  let originSessionId: string | undefined;
  let importedFrom: string | undefined;
  const tags: string[] = [];
  let inMetadata = false;
  for (const line of front.split(/\r?\n/)) {
    if (/^metadata:\s*/.test(line)) { inMetadata = true; continue; }
    if (inMetadata && /^\s+tags:\s*$/.test(line)) continue;
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (inMetadata && nested) {
      const [, key, value] = nested;
      if (key === "type" && ["feedback", "project", "reference", "user"].includes(value.trim())) type = value.trim() as MemoryType;
      else if (key === "modified" && value.trim()) modified = value.trim();
      else if (key === "originSessionId" && value.trim()) originSessionId = value.trim();
      else if (key === "importedFrom" && value.trim()) importedFrom = value.trim();
      continue;
    }
    const tag = /^\s+-\s+(.+)$/.exec(line);
    if (inMetadata && tag) { tags.push(parseScalar(tag[1]).toLowerCase()); continue; }
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    const [, key, value] = top;
    if (key === "name") name = parseScalar(value) || name;
    else if (key === "description") description = parseScalar(value);
  }
  return {
    id: name.replace(/[^a-zA-Z0-9._-]/g, "-"),
    text: body.slice(0, MAX_TEXT),
    description: (description || body.split("\n")[0]).replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION),
    tags: [...new Set(tags)].slice(0, MAX_TAGS),
    type,
    scope,
    createdAt: modified,
    updatedAt: modified,
    ...(originSessionId ? { originSessionId } : {}),
    ...(importedFrom ? { importedFrom } : {}),
  };
}
function serialize(memory: Memory): string {
  const lines = [
    "---",
    `name: ${yamlString(memory.id)}`,
    `description: ${yamlString(memory.description)}`,
    "metadata:",
    "  node_type: memory",
    `  type: ${memory.type}`,
    ...(memory.originSessionId ? [`  originSessionId: ${yamlString(memory.originSessionId)}`] : []),
    ...(memory.importedFrom ? [`  importedFrom: ${yamlString(memory.importedFrom)}`] : []),
    `  modified: ${memory.updatedAt}`,
  ];
  if (memory.tags.length) {
    lines.push("  tags:");
    for (const tag of memory.tags) lines.push(`    - ${yamlString(tag)}`);
  }
  lines.push("---", "", memory.text, "");
  return lines.join("\n");
}
async function atomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}
async function updateIndex(dir: string): Promise<void> {
  const memories = await loadDir(dir, "project");
  const lines = memories
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map((memory) => `- [${titleOf(memory).replace(/[[\]]/g, "")}](${memory.id}.md) — ${memory.description}`);
  await atomic(join(dir, INDEX), lines.length ? `${lines.join("\n")}\n` : "# Memory\n");
}
async function loadDir(dir: string, scope: MemoryScope): Promise<Memory[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const memories: Memory[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === INDEX) continue;
    try { const memory = parseFrontmatter(await readFile(join(dir, name), "utf8"), name, scope); if (memory) memories.push(memory); } catch { /* Ignore malformed files. */ }
  }
  return memories;
}

export async function loadScope(scope: MemoryScope, cwd: string): Promise<Memory[]> {
  return loadDir(scopeDir(scope, cwd), scope);
}
export async function loadAll(cwd: string): Promise<Memory[]> {
  const [global, project] = await Promise.all([loadScope("global", cwd), loadScope("project", cwd)]);
  return [...global, ...project];
}

export async function addMemory(cwd: string, input: {
  text: unknown; tags?: unknown; scope?: unknown; description?: unknown; type?: unknown; id?: unknown; importedFrom?: string;
}): Promise<{ memory: Memory; duplicate: boolean }> {
  const scope: MemoryScope = input.scope === "global" ? "global" : "project";
  const text = cleanText(input.text, MAX_TEXT);
  const tags = cleanTags(input.tags);
  const description = input.description === undefined ? clean(text.split("\n")[0], MAX_DESCRIPTION, "description") : clean(input.description, MAX_DESCRIPTION, "description");
  const type: MemoryType = ["feedback", "project", "reference", "user"].includes(String(input.type))
    ? input.type as MemoryType : scope === "global" ? "user" : "project";
  const dir = scopeDir(scope, cwd);
  const target = join(dir, INDEX);
  let result: { memory: Memory; duplicate: boolean } | undefined;
  await withFileMutationQueue(target, async () => {
    const existing = await loadDir(dir, scope);
    const duplicate = existing.find((memory) => memory.text.toLowerCase() === text.toLowerCase());
    if (duplicate) { result = { memory: duplicate, duplicate: true }; return; }
    if (existing.length >= MAX_MEMORIES) throw new Error(`Memory limit reached (${MAX_MEMORIES} per scope); forget something first`);
    const now = new Date().toISOString();
    let id = typeof input.id === "string" && input.id.trim()
      ? input.id.trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
      : slug(text, `memory-${randomBytes(3).toString("hex")}`);
    if (!id) id = `memory-${randomBytes(3).toString("hex")}`;
    const used = new Set(existing.map((memory) => memory.id));
    if (used.has(id)) id = `${id}-${randomBytes(2).toString("hex")}`;
    const memory: Memory = {
      id, text, description, tags, type, scope, createdAt: now, updatedAt: now,
      ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
    };
    await atomic(join(dir, `${id}.md`), serialize(memory));
    await updateIndex(dir);
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
    const haystack = `${memory.text} ${memory.description} ${memory.tags.join(" ")} ${memory.type}`.toLowerCase();
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
    const dir = scopeDir(scope, cwd);
    const target = join(dir, INDEX);
    await withFileMutationQueue(target, async () => {
      const existing = await loadDir(dir, scope);
      const memory = existing.find((entry) => entry.id === id);
      if (!memory) return;
      try { await unlink(join(dir, `${memory.id}.md`)); } catch { /* Already gone. */ }
      removed.push(memory);
      await updateIndex(dir);
    });
  }
  return removed;
}

export async function clearScope(cwd: string, scope: MemoryScope): Promise<number> {
  const dir = scopeDir(scope, cwd);
  let count = 0;
  await withFileMutationQueue(join(dir, INDEX), async () => {
    const existing = await loadDir(dir, scope);
    count = existing.length;
    for (const memory of existing) { try { await unlink(join(dir, `${memory.id}.md`)); } catch { /* Already gone. */ } }
    await atomic(join(dir, INDEX), "# Memory\n");
  });
  return count;
}

/** Import memories written by Claude Code's memory tool, preserving its Markdown format. */
export async function importClaude(cwd: string): Promise<number> {
  const source = claudeMemoryDir(cwd);
  let names: string[];
  try { names = await readdir(source); } catch { return 0; }
  const dir = scopeDir("project", cwd);
  let changed = 0;
  await withFileMutationQueue(join(dir, INDEX), async () => {
    const existing = await loadDir(dir, "project");
    for (const name of names) {
      if (!name.endsWith(".md") || name === INDEX) continue;
      let memory: Memory | undefined;
      try { memory = parseFrontmatter(await readFile(join(source, name), "utf8"), name, "project"); } catch { continue; }
      if (!memory) continue;
      const sameId = existing.find((entry) => entry.id === memory.id);
      if (sameId) {
        const unchanged = sameId.text === memory.text && sameId.description === memory.description &&
          sameId.type === memory.type && sameId.tags.join("\0") === memory.tags.join("\0");
        if (unchanged) continue;
        const updated: Memory = {
          ...sameId, text: memory.text, description: memory.description, tags: memory.tags,
          type: memory.type, updatedAt: memory.updatedAt, importedFrom: "claude",
          ...(memory.originSessionId ? { originSessionId: memory.originSessionId } : {}),
        };
        await atomic(join(dir, `${updated.id}.md`), serialize(updated));
        changed++;
        continue;
      }
      const sameText = existing.find((entry) => entry.text.toLowerCase() === memory.text.toLowerCase());
      if (sameText) continue;
      if (existing.length >= MAX_MEMORIES) break;
      const stored: Memory = { ...memory, importedFrom: "claude" };
      await atomic(join(dir, `${stored.id}.md`), serialize(stored));
      existing.push(stored);
      changed++;
    }
    if (changed) await updateIndex(dir);
  });
  return changed;
}
