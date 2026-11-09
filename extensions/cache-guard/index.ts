import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Turn {
  index: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  prompt: number;
  hit: number;
  cost: number;
  cold: boolean;
  aborted: boolean;
  at: number;
}
const MAX_TURNS = 2000;
const COLD_MIN_PROMPT = 4_000;
const COLD_HIT = 0.5;
const COLD_DROP = 0.35;

export function pct(value: number): string { return `${Math.round(value * 100)}%`; }
export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}
function bar(hit: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round(hit * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function pad(value: string, width: number, right = true): string {
  return right ? value.padStart(width) : value.padEnd(width);
}
export function formatCacheReport(turns: Turn[]): string {
  if (!turns.length) return "No turns recorded in this session yet.";
  let cost = 0, prompt = 0, weighted = 0, cold = 0;
  for (const turn of turns) { cost += turn.cost; prompt += turn.prompt; weighted += turn.hit * turn.prompt; if (turn.cold) cold++; }
  const lines = [
    `Cache · ${turns.length} turns · $${cost.toFixed(2)} · ${pct(prompt ? weighted / prompt : 0)} cached · ${cold} cold`,
    "",
    `${pad("TURN", 4)}  ${pad("PROMPT", 8)}  ${pad("HIT", 14, false)}  ${pad("COST", 8)}  ${pad("OUT", 7)}`,
    "─".repeat(52),
  ];
  for (const turn of turns.slice(-10)) {
    lines.push(`${pad(String(turn.index), 4)}  ${pad(formatTokens(turn.prompt), 8)}  ${bar(turn.hit)} ${pad(pct(turn.hit), 3)}  ${pad(`$${turn.cost.toFixed(3)}`, 8)}  ${pad(formatTokens(turn.output), 7)}${turn.cold ? "  COLD" : ""}`);
  }
  return lines.join("\n");
}

export default function cacheGuard(pi: ExtensionAPI) {
  const sessions = new Map<string, Turn[]>();
  let ctx: ExtensionContext | undefined;
  const turns = () => {
    const id = ctx?.sessionManager.getSessionId();
    return id ? sessions.get(id) ?? (sessions.set(id, []), sessions.get(id)!) : [];
  };
  const touch = (context: ExtensionContext) => { ctx = context; };

  pi.on("turn_end", (event, context): any => {
    touch(context);
    const message = event.message as any;
    const usage = message?.usage;
    if (message?.role !== "assistant" || !usage) return;
    const input = Number(usage.input ?? 0);
    const output = Number(usage.output ?? 0);
    const cacheRead = Number(usage.cacheRead ?? 0);
    const cacheWrite = Number(usage.cacheWrite ?? 0);
    const prompt = input + cacheRead + cacheWrite;
    if (prompt <= 0) return;
    const history = turns();
    const previous = history.at(-1);
    const hit = cacheRead / prompt;
    const aborted = message.stopReason === "aborted";
    const cold = Boolean(previous && !aborted && prompt >= COLD_MIN_PROMPT && hit < COLD_HIT && previous.hit - hit >= COLD_DROP);
    history.push({
      index: (previous?.index ?? 0) + 1, input, output, cacheRead, cacheWrite, prompt, hit,
      cost: Number(usage.cost?.total ?? 0), cold, aborted, at: Date.now(),
    });
    if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);
    if (cold) {
      context.ui.notify(`Cache dropped to ${pct(hit)} (was ${pct(previous!.hit)}) on a ${formatTokens(prompt)} prompt — context rewritten?`, "warning");
    }
  });

  pi.on("session_before_compact", (_event, context) => {
    touch(context);
    context.ui.notify("Compacting context — prompt cache will reset.", "info");
  });
  pi.on("session_compact", (event, context) => {
    touch(context);
    const entry = event.compactionEntry as any;
    context.ui.notify(`Compaction done (${formatTokens(entry?.tokensBefore ?? 0)} → ${formatTokens(entry?.estimatedTokensAfter ?? 0)} tokens) — prompt cache starts over.`, "warning");
  });

  pi.registerCommand("cache", {
    description: "Prompt-cache hit history for this session ( /cache clear )",
    handler: async (args, context) => {
      touch(context);
      if (args.trim() === "clear") {
        const id = context.sessionManager.getSessionId();
        if (id) sessions.delete(id);
        context.ui.notify("Cache history cleared.", "info");
        return;
      }
      context.ui.notify(formatCacheReport(turns()), "info");
    },
  });
  pi.on("session_shutdown", () => { ctx = undefined; sessions.clear(); });
}
