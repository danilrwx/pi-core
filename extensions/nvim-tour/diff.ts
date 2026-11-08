import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nvimRequest } from "./nvim.js";

export interface DiffOutcome { status: "accepted" | "rejected" | "cancelled"; content?: string; id: string }
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Ask Neovim to show a native diff; resolve when the user accepts (:w), rejects (:q) or we time out. */
export async function openDiff(options: { cwd: string; file: string; content: string; reason?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<DiffOutcome> {
  const id = randomUUID();
  const resultPath = join(tmpdir(), `pi-diff-${id}.json`);
  try { unlinkSync(resultPath); } catch { /* fresh */ }
  if (options.signal?.aborted) throw new Error("Diff review cancelled");
  try {
    await nvimRequest({ method: "diff.open", file: options.file, content: options.content, result_path: resultPath, diff_id: id, root: options.cwd });
  } catch (error) {
    try { unlinkSync(resultPath); } catch { /* gone */ }
    throw error;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        await nvimRequest({ method: "diff.cancel", diff_id: id, root: options.cwd }).catch(() => {});
        throw new Error("Diff review cancelled");
      }
      if (existsSync(resultPath)) {
        const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as { status?: string; content?: string };
        if (parsed.status === "accepted" || parsed.status === "rejected" || parsed.status === "cancelled") {
          return { status: parsed.status, content: parsed.content, id };
        }
      }
      await wait(150);
    }
    await nvimRequest({ method: "diff.cancel", diff_id: id, root: options.cwd }).catch(() => {});
    throw new Error("Diff review timed out; nothing was written");
  } finally {
    try { unlinkSync(resultPath); } catch { /* gone */ }
  }
}
