/**
 * Compact local usage accounting.
 *
 * This is intentionally smaller than a full dashboard: it reads persisted
 * assistant/compaction/summary usage, caches per-file extraction by mtime/size,
 * and exposes period summaries for /usage. No provider subscription limits are
 * invented; the bars show observed context and cache reuse.
 */

import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import {
  getAgentDir,
  SessionManager,
  withFileMutationQueue,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface UsagePoint {
  id: string;
  sessionId: string;
  timestamp: number;
  provider: string;
  model: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: "assistant" | "auxiliary";
}

export interface Totals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

export interface ModelTotal extends Totals { provider: string; model: string }

export interface Summary extends Totals { models: ModelTotal[] }

export interface UsageData {
  currentSessionId: string;
  current: Summary;
  today: Summary;
  week: Summary;
  all: Summary;
  context?: { tokens: number; contextWindow: number };
}

const CACHE_VERSION = 1;
const CACHE_FILE = "usage-cache.json";

interface CachedFile {
  size: number;
  mtimeMs: number;
  sessionId: string;
  points: UsagePoint[];
}
interface CacheFile { version: number; files: Record<string, CachedFile> }

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function costOf(usage: any): number {
  const value = usage?.cost?.total ?? usage?.cost;
  return finite(value);
}
function timestampOf(value: unknown, fallback = Date.now()): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? ms : fallback;
}
function emptyTotals(): Totals {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}
function addPoint(target: Totals, point: UsagePoint): void {
  target.cost += point.cost;
  target.input += point.input;
  target.output += point.output;
  target.cacheRead += point.cacheRead;
  target.cacheWrite += point.cacheWrite;
  target.messages++;
}

export function summarize(points: UsagePoint[], since = 0, until = Number.POSITIVE_INFINITY): Summary {
  const totals = emptyTotals();
  const models = new Map<string, ModelTotal>();
  for (const point of points) {
    if (point.timestamp < since || point.timestamp >= until) continue;
    addPoint(totals, point);
    const key = `${point.provider}\0${point.model}`;
    let model = models.get(key);
    if (!model) {
      model = { provider: point.provider, model: point.model, ...emptyTotals() };
      models.set(key, model);
    }
    addPoint(model, point);
  }
  return {
    ...totals,
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.messages - a.messages || a.model.localeCompare(b.model)),
  };
}

export function startOfDay(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
export function startOfWeek(now = Date.now()): number {
  const date = new Date(startOfDay(now));
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date.getTime();
}

export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export function cacheRate(summary: Totals): number {
  const prompt = summary.input + summary.cacheRead + summary.cacheWrite;
  return prompt > 0 ? summary.cacheRead / prompt : 0;
}

function pointFromEntry(entry: any, sessionId: string, fallbackModel?: { provider: string; model: string }): UsagePoint | undefined {
  const usage = entry?.usage ?? entry?.message?.usage;
  if (!usage) return;
  const message = entry?.message;
  const provider = String(message?.provider ?? entry?.provider ?? fallbackModel?.provider ?? "unknown");
  const model = String(message?.model ?? entry?.model ?? fallbackModel?.model ?? "unknown");
  const id = String(entry?.id ?? `${sessionId}:${entry?.timestamp ?? ""}:${provider}:${model}`);
  return {
    id,
    sessionId,
    timestamp: timestampOf(entry?.timestamp ?? message?.timestamp),
    provider,
    model,
    cost: costOf(usage),
    input: finite(usage.input),
    output: finite(usage.output),
    cacheRead: finite(usage.cacheRead),
    cacheWrite: finite(usage.cacheWrite),
    source: entry?.type === "message" ? "assistant" : "auxiliary",
  };
}

/** Parse a branch already loaded by the session manager. */
export function parseBranch(entries: any[], sessionId: string): UsagePoint[] {
  const points: UsagePoint[] = [];
  let current: { provider: string; model: string } | undefined;
  for (const entry of entries) {
    if (entry?.type === "model_change") {
      current = { provider: String(entry.provider ?? "unknown"), model: String(entry.modelId ?? "unknown") };
      if (entry.provider || entry.modelId) continue;
    }
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const point = pointFromEntry(entry, sessionId, current);
      if (point) points.push(point);
      continue;
    }
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      const point = pointFromEntry({ ...entry, provider: "tools", model: "summaries" }, sessionId);
      if (point) points.push({ ...point, source: "auxiliary" });
      continue;
    }
    if (entry?.type === "usage") {
      const point = pointFromEntry(entry, sessionId);
      if (point) points.push({ ...point, source: "auxiliary" });
    }
  }
  return points;
}

/** Parse one session JSONL file, skipping non-accounting lines. */
export async function parseSessionFile(path: string): Promise<{ sessionId: string; points: UsagePoint[] }> {
  let sessionId = basename(path).replace(/^.*?_/, "").replace(/\.jsonl$/, "");
  const points: UsagePoint[] = [];
  let current: { provider: string; model: string } | undefined;
  let lineNumber = 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.includes('"usage"') && !line.includes('"model_change"') && !line.includes('"type":"session"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "session" && typeof entry.id === "string") { sessionId = entry.id; continue; }
      if (entry?.type === "model_change") {
        current = { provider: String(entry.provider ?? "unknown"), model: String(entry.modelId ?? "unknown") };
        continue;
      }
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        const point = pointFromEntry({ ...entry, id: entry.id ?? `${sessionId}:${lineNumber}` }, sessionId, current);
        if (point) points.push(point);
        continue;
      }
      if (entry?.type === "compaction" || entry?.type === "branch_summary") {
        const point = pointFromEntry({ ...entry, provider: "tools", model: "summaries", id: entry.id ?? `${sessionId}:${lineNumber}` }, sessionId);
        if (point) points.push({ ...point, source: "auxiliary" });
        continue;
      }
      if (entry?.type === "usage") {
        const point = pointFromEntry({ ...entry, id: entry.id ?? `${sessionId}:${lineNumber}` }, sessionId);
        if (point) points.push({ ...point, source: "auxiliary" });
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { sessionId, points };
}

async function loadCache(): Promise<CacheFile> {
  try {
    const data = JSON.parse(await readFile(join(getAgentDir(), CACHE_FILE), "utf8")) as CacheFile;
    if (data?.version === CACHE_VERSION && data.files && typeof data.files === "object") return data;
  } catch { /* Missing/corrupt cache is an empty cache. */ }
  return { version: CACHE_VERSION, files: {} };
}

async function saveCache(cache: CacheFile): Promise<void> {
  const path = join(getAgentDir(), CACHE_FILE);
  await withFileMutationQueue(path, async () => {
    await mkdir(getAgentDir(), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(cache), { mode: 0o600 });
    await rename(temp, path);
  });
}

async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]);
    }
  });
  await Promise.all(workers);
}

export async function collectUsage(ctx: ExtensionContext): Promise<UsageData> {
  const currentSessionId = ctx.sessionManager.getSessionId();
  const branchPoints = parseBranch(ctx.sessionManager.getBranch(), currentSessionId);
  const points = new Map<string, UsagePoint>();
  for (const point of branchPoints) points.set(point.id, point);

  const cache = await loadCache();
  const nextFiles: Record<string, CachedFile> = {};
  let changed = false;
  const paths = new Set<string>();
  try {
    const sessions = await SessionManager.listAll();
    for (const session of sessions) paths.add(session.path);
  } catch { /* Session listing is best effort. */ }
  const currentFile = ctx.sessionManager.getSessionFile();
  if (currentFile) paths.add(currentFile);

  const files = [...paths];
  await pooled(files, 8, async (path) => {
    let info;
    try { info = await stat(path); } catch { return; }
    if (!info.isFile()) return;
    const cached = cache.files[path];
    let record: CachedFile;
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      record = cached;
    } else {
      try {
        const parsed = await parseSessionFile(path);
        record = { size: info.size, mtimeMs: info.mtimeMs, sessionId: parsed.sessionId, points: parsed.points };
      } catch {
        return;
      }
      changed = true;
    }
    nextFiles[path] = record;
    for (const point of record.points) if (!points.has(point.id)) points.set(point.id, point);
  });

  // Remove records for deleted/renamed files.
  if (Object.keys(cache.files).length !== Object.keys(nextFiles).length) changed = true;
  if (changed) {
    cache.files = nextFiles;
    await saveCache(cache).catch(() => {});
  }

  const allPoints = [...points.values()];
  const now = Date.now();
  const current = summarize(branchPoints.length ? branchPoints : allPoints.filter((point) => point.sessionId === currentSessionId));
  const context = ctx.getContextUsage();
  return {
    currentSessionId,
    current,
    today: summarize(allPoints, startOfDay(now), now + 1),
    week: summarize(allPoints, startOfWeek(now), now + 1),
    all: summarize(allPoints, 0, now + 1),
    ...(context ? { context: { tokens: context.tokens ?? 0, contextWindow: context.contextWindow } } : {}),
  };
}
