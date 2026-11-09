/**
 * `/usage` — one panel, five tabs (session / today / week / month / all time).
 *
 * Each tab answers the same question for its period: what it cost, how many
 * tokens went in and out, how much of the prompt came from the cache and what
 * the hit rate was, per model. No subscription limits are invented.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { frameLines } from "../lib/frame.js";
import {
  USAGE_PERIODS, cacheRate, collectUsage, formatMoney, formatTokens,
  type Summary, type UsageData, type UsagePeriod,
} from "./data.js";

interface ThemeLike { fg(token: string, text: string): string; bold(text: string): string; bg?(token: string, text: string): string }

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}
function bar(theme: ThemeLike, ratio: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((Number.isFinite(ratio) ? ratio : 0) * width)));
  return theme.fg("success", "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

export function summaryFor(data: UsageData, period: UsagePeriod): Summary {
  switch (period) {
    case "session": return data.current;
    case "day": return data.today;
    case "week": return data.week;
    case "month": return data.month;
    default: return data.all;
  }
}

/** The tab strip: the active period is filled, answered counts are dim. */
export function renderTabs(active: UsagePeriod, width: number, theme: ThemeLike): string {
  const parts = USAGE_PERIODS.map((period) => {
    const text = ` ${period.label} `;
    if (period.key === active) return theme.bg ? theme.bg("selectedBg", theme.fg("text", text)) : theme.bold(text);
    return theme.fg("muted", text);
  });
  return truncateToWidth(parts.join(" "), width, "…");
}

interface Column {
  title: string;
  width: number;
  right: boolean;
  value(summary: Summary, model: Summary["models"][number]): string;
}

const COLUMNS: Column[] = [
  { title: "cost", width: 9, right: true, value: (_summary, model) => formatMoney(model.cost) },
  { title: "tokens", width: 7, right: true, value: (_summary, model) => formatTokens(model.input + model.output + model.cacheWrite) },
  { title: "in", width: 7, right: true, value: (_summary, model) => formatTokens(model.input) },
  { title: "out", width: 6, right: true, value: (_summary, model) => formatTokens(model.output) },
  { title: "cached", width: 7, right: true, value: (_summary, model) => formatTokens(model.cacheRead) },
  { title: "hit", width: 4, right: true, value: (_summary, model) => `${Math.round(cacheRate(model) * 100)}%` },
  { title: "msgs", width: 6, right: true, value: (_summary, model) => String(model.messages) },
];

/** The per-model table, dropping the least important columns on a narrow panel. */
export function renderModelTable(summary: Summary, width: number, theme: ThemeLike): string[] {
  // Two columns of prefix, two of gap before each numeric column.
  const nameWidth = (columns: Column[]) => width - 2 - columns.reduce((sum, column) => sum + column.width + 2, 0);

  let columns = [...COLUMNS];
  let name = nameWidth(columns);
  while (columns.length > 2 && name < 18) {
    columns = columns.slice(0, -1);
    name = nameWidth(columns);
  }
  name = Math.max(10, name);

  const header = `  ${padRight(theme.fg("dim", "model"), name)}${columns.map((column) => padLeft(theme.fg("dim", column.title), column.width + 2)).join("")}`;
  const lines = [header];
  if (!summary.models.length) {
    lines.push(theme.fg("dim", "  no recorded model usage in this period"));
    return lines;
  }
  summary.models.slice(0, 8).forEach((model, index) => {
    const label = `${model.provider}/${model.model}`;
    const shade = index % 2 === 1 ? "muted" : "text";
    lines.push(`  ${padRight(theme.fg(shade, truncateToWidth(label, name, "…")), name)}${columns.map((column) => padLeft(theme.fg(shade, column.value(summary, model)), column.width + 2)).join("")}`);
  });
  if (summary.models.length > 8) lines.push(theme.fg("dim", `  … ${summary.models.length - 8} more models`));
  return lines;
}

export function renderUsage(data: UsageData, width: number, theme: ThemeLike, active: UsagePeriod = "session"): string[] {
  const w = Math.max(40, width);
  const summary = summaryFor(data, active);
  const prompt = summary.input + summary.cacheRead + summary.cacheWrite;
  const lines: string[] = [];

  lines.push(renderTabs(active, w, theme));
  lines.push(theme.fg("dim", "─".repeat(w)));
  lines.push(`${theme.fg("accent", theme.bold(formatMoney(summary.cost)))}${theme.fg("dim", `   ${summary.messages} messages · ${formatTokens(prompt + summary.output)} tokens`)}`);
  lines.push([
    theme.fg("muted", "in "), theme.fg("text", formatTokens(summary.input)),
    theme.fg("muted", " · out "), theme.fg("text", formatTokens(summary.output)),
    theme.fg("muted", " · cached "), theme.fg("text", formatTokens(summary.cacheRead)),
    theme.fg("muted", " · write "), theme.fg("text", formatTokens(summary.cacheWrite)),
    theme.fg("muted", " · hit "), theme.fg("accent", `${Math.round(cacheRate(summary) * 100)}%`),
  ].join(""));

  if (active === "session") {
    if (data.context && data.context.contextWindow > 0) {
      const ratio = data.context.tokens / data.context.contextWindow;
      lines.push(`${theme.fg("muted", "context")} ${bar(theme, ratio)} ${padLeft(`${Math.round(ratio * 100)}%`, 4)} ${theme.fg("dim", `${formatTokens(data.context.tokens)} / ${formatTokens(data.context.contextWindow)}`)}`);
    } else {
      lines.push(`${theme.fg("muted", "cache")}   ${bar(theme, cacheRate(summary))} ${padLeft(`${Math.round(cacheRate(summary) * 100)}%`, 4)}`);
    }
  } else {
    const since = {
      day: "since midnight", week: "since Monday", month: "since the 1st", all: "everything on this machine",
    }[active as Exclude<UsagePeriod, "session">];
    lines.push(theme.fg("dim", since));
  }

  lines.push("");
  lines.push(...renderModelTable(summary, w, theme));
  return lines.map((line) => truncateToWidth(line, w, ""));
}

const plainTheme: ThemeLike = { fg: (_token, text) => text, bold: (text) => text };

/** Text mode (`ctx.hasUI === false`): every period, compact. */
function usageText(data: UsageData): string {
  const sections = USAGE_PERIODS.map((period) => {
    const summary = summaryFor(data, period.key);
    const prompt = summary.input + summary.cacheRead + summary.cacheWrite;
    return `${period.label}: ${formatMoney(summary.cost)} · ${summary.messages} messages · ${formatTokens(prompt + summary.output)} tokens · hit ${Math.round(cacheRate(summary) * 100)}%`;
  });
  const table = renderUsage(data, 80, plainTheme, "all").join("\n");
  return ["Usage", ...sections, "", table].join("\n");
}

async function showUsage(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const data = await collectUsage(ctx);
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: "usage", content: usageText(data), display: true }, { triggerTurn: false });
    return;
  }
  const open = async (start: UsagePeriod) => ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let index = Math.max(0, USAGE_PERIODS.findIndex((period) => period.key === start));
    let width = -1;
    let lines: string[] = [];
    const rows = () => tui.terminal?.rows ?? 40;
    return {
      render(currentWidth: number) {
        if (currentWidth === width) return lines;
        width = currentWidth;
        const period = USAGE_PERIODS[index].key;
        const body = renderUsage(data, Math.max(20, currentWidth - 4), theme as unknown as ThemeLike, period);
        const maxBody = Math.max(6, Math.floor(rows() * 0.8) - 5);
        lines = frameLines({
          theme: theme as unknown as Theme,
          title: `usage · ${period}`,
          width: currentWidth,
          body: body.slice(0, maxBody),
          footer: [theme.fg("dim", "←/→ or tab switch period · 1-5 jump · Esc close")],
        });
        return lines;
      },
      handleInput(input: string) {
        const step = matchesKey(input, "right") || matchesKey(input, "tab") || input === "l" ? 1
          : matchesKey(input, "left") || matchesKey(input, "shift+tab") || input === "h" ? -1 : 0;
        if (step) {
          index = (index + step + USAGE_PERIODS.length) % USAGE_PERIODS.length;
          width = -1;
          tui.requestRender();
          return;
        }
        const digit = /^[1-5]$/.test(input) ? Number(input) - 1 : undefined;
        if (digit !== undefined) { index = digit; width = -1; tui.requestRender(); return; }
        if (matchesKey(input, "escape") || input === "q" || matchesKey(input, "return")) done();
      },
      invalidate() { width = -1; },
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 56, anchor: "center" } });

  await open("session");
}

export default function usage(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Usage by period: session, today, week, month, all time — cost, tokens, cache and hit rate per model",
    handler: async (_args, ctx) => showUsage(pi, ctx),
  });
}
