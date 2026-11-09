import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WarmingInput {
  now: number;
  lastActivity: number;
  active: boolean;
  warmSpent: number;
  maxIdleMs: number;
  maxIdleCost: number;
  minSavings: number;
  warmCost: number;
  missCost: number;
  continuationProbability: number;
}
export type WarmingAction = "warm" | "stop" | undefined;

/** Decide whether one idle refresh is worth it; undefined delegates to pi while a run is active. */
export function warmingDecision(input: WarmingInput): WarmingAction {
  if (input.active) return undefined;
  if (input.now - input.lastActivity > input.maxIdleMs) return "stop";
  if (input.warmSpent >= input.maxIdleCost) return "stop";
  const expected = input.continuationProbability * input.missCost - input.warmCost;
  if (!Number.isFinite(expected) || expected < input.minSavings) return "stop";
  return "warm";
}

/** Parse a numeric environment override; invalid values fall back instead of poisoning a limit with NaN. */
export function envNumber(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

export default function cacheWarming(pi: ExtensionAPI) {
  let enabled = process.env.PI_CACHE_WARM_POLICY !== "0";
  let active = false;
  let lastActivity = Date.now();
  let warmSpent = 0;
  const maxIdleMs = Math.max(60_000, envNumber("PI_CACHE_WARM_IDLE_MINUTES", 30) * 60_000);
  const maxIdleCost = envNumber("PI_CACHE_WARM_IDLE_BUDGET", 0.05);
  const minSavings = envNumber("PI_CACHE_WARM_MIN_SAVINGS", 0.005);

  const touch = () => { lastActivity = Date.now(); warmSpent = 0; };
  pi.on("session_start", () => { touch(); active = false; });
  pi.on("turn_start", () => touch());
  pi.on("before_agent_start", () => touch());
  pi.on("input", () => touch());
  pi.on("agent_start", () => { active = true; touch(); });
  pi.on("agent_settled", () => { active = false; lastActivity = Date.now(); warmSpent = 0; });
  pi.on("session_shutdown", () => { active = false; warmSpent = 0; });

  pi.on("cache_warming_decision", (event) => {
    if (!enabled) return { action: "stop" as const };
    const action = warmingDecision({
      now: Date.now(), lastActivity, active, warmSpent, maxIdleMs, maxIdleCost, minSavings,
      warmCost: event.warmCost, missCost: event.missCost, continuationProbability: event.continuationProbability,
    });
    if (action === undefined) return;
    if (action === "warm") warmSpent += event.warmCost;
    return { action };
  });

  pi.registerCommand("warming", {
    description: "Prompt-cache warming policy: /warming status | on | off (requires cacheWarming: idle)",
    handler: async (args, context) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") enabled = action === "on";
      context.ui.notify([
        `Cache warming policy: ${enabled ? "on" : "off"}`,
        `idle window: ${Math.round(maxIdleMs / 60_000)} min · idle budget: $${maxIdleCost.toFixed(2)} · min savings: $${minSavings.toFixed(3)}`,
        `spent this idle window: $${warmSpent.toFixed(4)} · active: ${active ? "yes" : "no"}`,
        "Pi setting cacheWarming must be \"idle\" and the model must declare promptCache.",
      ].join("\n"), "info");
    },
  });
}
