/**
 * Compact /usage panel in a Claude-Code-like style: current session first,
 * then today/current-week/all-time summaries and a per-model cost table.
 * No subscription limits are invented; bars show context and cache reuse.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { frameLines } from "../lib/frame.js";
import { cacheRate, collectUsage, formatMoney, formatTokens, type Summary, type UsageData } from "./data.js";

interface ThemeLike { fg(token: string, text: string): string; bold(text: string): string }

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
function modelLine(summary: Summary, width: number, theme: ThemeLike): string[] {
  if (!summary.models.length) return [theme.fg("dim", "  no recorded model usage yet")];
  return summary.models.slice(0, 6).map((model) => {
    const name = `${model.provider}/${model.model}`;
    const left = `  ${padRight(name, Math.max(12, width - 32))}`;
    return `${left}${padLeft(formatMoney(model.cost), 9)}  ${padLeft(formatTokens(model.input + model.output + model.cacheWrite), 7)}  ${padLeft(`${model.messages} msg`, 7)}`;
  });
}
function section(title: string, summary: Summary, width: number, theme: ThemeLike): string[] {
  const label = padRight(title, Math.max(1, width - 10));
  return [
    theme.fg("accent", theme.bold(label)) + padLeft(formatMoney(summary.cost), 10),
    theme.fg("dim", `  ${summary.messages} messages · ${formatTokens(summary.input + summary.output + summary.cacheWrite)} tokens · ${Math.round(cacheRate(summary) * 100)}% cached`),
  ];
}

export function renderUsage(data: UsageData, width: number, theme: ThemeLike): string[] {
  const w = Math.max(40, width);
  const lines: string[] = [];
  const border = theme.fg("dim", "─".repeat(w));
  lines.push(theme.fg("accent", theme.bold("Usage")));
  lines.push(border);

  const current = data.current;
  const currentLabel = padRight("Current session", Math.max(1, w - 10));
  lines.push(theme.fg("text", currentLabel) + padLeft(formatMoney(current.cost), 10));
  const models = current.models.map((model) => `${model.provider}/${model.model}`);
  lines.push(theme.fg("dim", `  ${models.length ? models.join(", ") : "no assistant usage yet"}`));
  lines.push(theme.fg("dim", `  ${current.messages} messages · ${formatTokens(current.input)} in · ${formatTokens(current.output)} out · ${Math.round(cacheRate(current) * 100)}% cached`));
  if (data.context && data.context.contextWindow > 0) {
    const ratio = data.context.tokens / data.context.contextWindow;
    lines.push(`  ${theme.fg("muted", "context")}  ${bar(theme, ratio)}  ${padLeft(`${Math.round(ratio * 100)}%`, 4)}  ${theme.fg("dim", `${formatTokens(data.context.tokens)} / ${formatTokens(data.context.contextWindow)}`)}`);
  } else {
    lines.push(`  ${theme.fg("muted", "cache")}    ${bar(theme, cacheRate(current))}  ${padLeft(`${Math.round(cacheRate(current) * 100)}%`, 4)}`);
  }
  lines.push("");

  lines.push(...section("Today", data.today, w, theme));
  lines.push("");
  lines.push(...section("Current week", data.week, w, theme));
  lines.push("");
  lines.push(...section("All time", data.all, w, theme));
  lines.push("");
  lines.push(theme.fg("accent", theme.bold("By model · this week")));
  lines.push(...modelLine(data.week, w, theme));
  lines.push(border);
  lines.push(theme.fg("dim", "Esc / q close"));
  return lines.map((line) => truncateToWidth(line, w, ""));
}

const plainTheme: ThemeLike = { fg: (_token, text) => text, bold: (text) => text };

function usageText(data: UsageData): string {
  return renderUsage(data, 80, plainTheme).join("\n");
}

async function showUsage(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const data = await collectUsage(ctx);
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: "usage", content: usageText(data), display: true }, { triggerTurn: false });
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _keys, done) => {
    let width = -1;
    let lines: string[] = [];
    return {
      render(currentWidth: number) {
        if (currentWidth !== width) {
          width = currentWidth;
          lines = frameLines({
            theme,
            title: "usage",
            width: currentWidth,
            body: renderUsage(data, Math.max(20, currentWidth - 4), theme),
            footer: [theme.fg("dim", "Esc or q to close")],
          });
        }
        return lines;
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "return")) done();
      },
      invalidate() { width = -1; },
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 52, anchor: "center" } });
}

export default function usage(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show compact usage statistics for this session, today, this week and all time",
    handler: async (_args, ctx) => showUsage(pi, ctx),
  });
}
