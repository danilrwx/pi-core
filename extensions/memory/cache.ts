import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface DecisionEntry {
  selected: { id: string; probability: number }[];
  usage?: unknown;
  createdAt: number;
  expiresAt: number;
}
interface CacheFile { version: 1; entries: Record<string, DecisionEntry> }
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 256;

export function decisionKey(input: { model: string; policy: string; query: string; candidatesHash: string }): string {
  return createHash("sha256")
    .update([input.model, input.policy, input.query, input.candidatesHash].join("\0"))
    .digest("hex");
}
/** Normalize a query for reuse across punctuation/case/order differences. */
export function normalizeQuery(text: string): string {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim().split(/\s+/).filter(Boolean).sort().join(" ");
}

export class DecisionCache {
  private entries = new Map<string, DecisionEntry>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  constructor(
    private path: string,
    private ttlMs = DEFAULT_TTL_MS,
    private maxEntries = DEFAULT_MAX_ENTRIES,
    private now = Date.now,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.load();
    await this.loading;
  }
  private async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Partial<CacheFile>;
      if (data.version === 1 && data.entries && typeof data.entries === "object") {
        for (const [key, entry] of Object.entries(data.entries)) {
          if (entry && typeof entry === "object" && Array.isArray((entry as DecisionEntry).selected)) {
            this.entries.set(key, entry as DecisionEntry);
          }
        }
      }
    } catch { /* Missing/corrupt cache is just an empty cache. */ }
    this.prune();
    this.loaded = true;
  }
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    const excess = this.entries.size - this.maxEntries;
    if (excess <= 0) return;
    const oldest = [...this.entries].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, excess);
    for (const [key] of oldest) this.entries.delete(key);
  }
  private async persist(): Promise<void> {
    const payload: CacheFile = { version: 1, entries: Object.fromEntries(this.entries) };
    await withFileMutationQueue(this.path, async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
      await rename(temp, this.path);
    });
  }
  async get(key: string): Promise<DecisionEntry | undefined> {
    await this.ensureLoaded();
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return; }
    // LRU: refresh insertion order.
    this.entries.delete(key); this.entries.set(key, entry);
    return entry;
  }
  async set(key: string, selected: DecisionEntry["selected"], usage?: unknown): Promise<void> {
    await this.ensureLoaded();
    const createdAt = this.now();
    this.entries.set(key, { selected, usage, createdAt, expiresAt: createdAt + this.ttlMs });
    this.prune();
    await this.persist();
  }
  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.entries.clear();
    await this.persist();
  }
  async size(): Promise<number> {
    await this.ensureLoaded();
    this.prune();
    return this.entries.size;
  }
}
