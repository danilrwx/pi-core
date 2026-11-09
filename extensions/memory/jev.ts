import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Memory } from "./store.js";

export const JEV_POLICY = "memory-relevance-v1";
export const JEV_MODELS = [
  ["openrouter", "typesafe/jev-1.13"],
  ["openrouter", "typesafe/jev-1.14"],
  ["openrouter", "~typesafe/jev-latest"],
  ["typesafe", "jev-latest"],
  ["opencode", "jev-1.13"],
] as const;
export interface JevSelection { id: string; probability: number }
export interface JevResult {
  selected: JevSelection[];
  model: string;
  usage?: unknown;
  error?: string;
  skipped?: boolean;
}

const failureTimes: number[] = [];
let openUntil = 0;
const BREAKER_WINDOW = 60_000;
const BREAKER_COOLDOWN = 5 * 60_000;
const BREAKER_FAILURES = 3;

export function jevBreakerOpen(now = Date.now()): boolean {
  if (now < openUntil) return true;
  while (failureTimes.length && now - failureTimes[0] > BREAKER_WINDOW) failureTimes.shift();
  return false;
}
function recordFailure(now = Date.now()): void {
  failureTimes.push(now);
  if (failureTimes.length >= BREAKER_FAILURES) openUntil = now + BREAKER_COOLDOWN;
}
export function jevBreakerReset(): void {
  failureTimes.length = 0;
  openUntil = 0;
}

export function resolveJev(ctx: ExtensionContext): { model: any; key: string } | undefined {
  if (!ctx.modelRegistry || typeof ctx.modelRegistry.findOfType !== "function") return undefined;
  for (const [provider, id] of JEV_MODELS) {
    const model = ctx.modelRegistry.findOfType("classifier", provider, id) as any;
    if (model) return { model, key: `${provider}/${id}` };
  }
  return undefined;
}

/** Ask Jev which memory summaries help with the current prompt. Bodies are never sent. */
export async function classifyMemories(
  ctx: ExtensionContext,
  prompt: string,
  candidates: Memory[],
  options: { threshold?: number; timeoutMs?: number } = {},
): Promise<JevResult> {
  const resolved = resolveJev(ctx);
  if (!resolved) return { selected: [], model: "none", error: "no classifier model", skipped: true };
  if (!candidates.length) return { selected: [], model: resolved.key };
  if (jevBreakerOpen()) return { selected: [], model: resolved.key, error: "classifier circuit breaker open", skipped: true };

  const threshold = options.threshold ?? Number(process.env.PI_MEMORY_JEV_THRESHOLD ?? 0.8);
  const timeoutMs = options.timeoutMs ?? Number(process.env.PI_MEMORY_JEV_TIMEOUT_MS ?? 2_500);
  const state = {
    query: prompt.slice(0, 8_000),
    candidates: candidates.slice(0, 50).map((memory) => ({
      id: memory.id, description: memory.description, type: memory.type, tags: memory.tags,
    })),
  };
  const questions = Object.fromEntries(state.candidates.map((candidate, index) => [`c${index}`, {
    type: "bool" as const,
    instructions: `Does candidate ${candidate.id} (${candidate.description}) directly help answer the query?`,
    criteria: { true: "Directly useful", false: "Not useful" },
  }]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  timer.unref();
  const abort = () => controller.abort();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await ctx.modelRegistry.classify(resolved.model, { state, questions }, { signal: controller.signal } as any) as any;
    if (result?.stopReason !== "stop") throw new Error(result?.errorMessage || `classifier stopped: ${result?.stopReason ?? "unknown"}`);
    const selected: JevSelection[] = [];
    for (let index = 0; index < state.candidates.length; index++) {
      const answer = result.answers?.[`c${index}`];
      if (answer?.type !== "bool") continue;
      const probability = Number(answer.probability);
      if (Number.isFinite(probability) && probability >= threshold) selected.push({ id: state.candidates[index].id, probability });
    }
    selected.sort((a, b) => b.probability - a.probability);
    return { selected, model: resolved.key, usage: result.usage };
  } catch (error) {
    recordFailure();
    return { selected: [], model: resolved.key, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}
