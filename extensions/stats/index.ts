import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeArgs } from "../lib/complete.js";

interface ModelStats { turns: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; sessions: Set<string> }
interface ProjectStats { cost: number; sessions: Set<string>; turns: number }
interface SessionStats { file: string; name?: string; cwd: string; cost: number; turns: number; at: number }
export interface StatsReport {
  sessions: number; turns: number; cost: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cold: number;
  models: Map<string, ModelStats>; projects: Map<string, ProjectStats>; top: SessionStats[];
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtMoney(n: number): string { return `$${n.toFixed(2)}`; }
function pct(n: number): string { return `${Math.round(n * 100)}%`; }

async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "archive" || entry.name === "locks") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
      if (out.length >= 5000) return;
    }
  };
  await walk(root);
  return out;
}

/** Aggregate pi session JSONL files. Exported so the command and tests share one implementation. */
export async function buildStats(root = join(getAgentDir(), "sessions"), days?: number): Promise<StatsReport> {
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const report: StatsReport = { sessions: 0, turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cold: 0, models: new Map(), projects: new Map(), top: [] };
  for (const file of await files(root)) {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (text.length > 20 * 1024 * 1024) continue;
    let cwd = "", name: string | undefined, touched = false;
    let previousHit: number | undefined;
    let sessionCost = 0, sessionTurns = 0, sessionAt = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session") { cwd = typeof entry.cwd === "string" ? entry.cwd : ""; continue; }
      if (entry.type === "session_info" && typeof entry.name === "string") { name = entry.name; continue; }
      const at = Number(entry.message?.timestamp ?? Date.parse(entry.timestamp));
      if (cutoff && (!Number.isFinite(at) || at < cutoff)) continue;
      const usage = entry.message?.usage ?? (entry.type === "usage" ? entry.usage : undefined);
      if (!usage) continue;
      const input = Number(usage.input ?? 0), output = Number(usage.output ?? 0);
      const cacheRead = Number(usage.cacheRead ?? 0), cacheWrite = Number(usage.cacheWrite ?? 0);
      const cost = Number(usage.cost?.total ?? 0);
      const modelName = String(entry.message?.model ?? entry.model ?? "unknown").split("/").at(-1)!;
      touched = true; sessionCost += cost; sessionAt = Math.max(sessionAt, Number.isFinite(at) ? at : 0);
      report.cost += cost; report.input += input; report.output += output; report.cacheRead += cacheRead; report.cacheWrite += cacheWrite;
      let model = report.models.get(modelName);
      if (!model) { model = { turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }; report.models.set(modelName, model); }
      model.cost += cost; model.input += input; model.output += output; model.cacheRead += cacheRead; model.cacheWrite += cacheWrite; model.sessions.add(file);
      let project = report.projects.get(cwd || "?");
      if (!project) { project = { cost: 0, sessions: new Set(), turns: 0 }; report.projects.set(cwd || "?", project); }
      project.cost += cost; project.sessions.add(file);
      if (entry.type === "message" && entry.message?.role === "assistant") {
        sessionTurns++; report.turns++; model.turns++; project.turns++;
        const prompt = input + cacheRead + cacheWrite;
        const hit = prompt > 0 ? cacheRead / prompt : 0;
        if (previousHit !== undefined && entry.message.stopReason !== "aborted" && prompt >= 4000 && hit < 0.5 && previousHit - hit >= 0.35) report.cold++;
        previousHit = hit;
      }
    }
    if (touched) {
      report.sessions++;
      report.top.push({ file, name, cwd, cost: sessionCost, turns: sessionTurns, at: sessionAt });
    }
  }
  report.top.sort((a, b) => b.cost - a.cost || b.at - a.at);
  report.top = report.top.slice(0, 10);
  return report;
}

export function formatStats(report: StatsReport, label: string): string {
  const prompt = report.input + report.cacheRead + report.cacheWrite;
  const lines = [
    `Stats · ${label}`,
    `Sessions ${report.sessions} · turns ${report.turns} · cost ${fmtMoney(report.cost)}`,
    `Tokens in ${fmtTokens(report.input)} · out ${fmtTokens(report.output)} · cache read ${fmtTokens(report.cacheRead)} (${pct(prompt ? report.cacheRead / prompt : 0)} hit)`,
    ...(report.cold ? [`Cold cache turns: ${report.cold}`] : []),
    "", "Models",
  ];
  const models = [...report.models].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
  for (const [name, model] of models) {
    lines.push(`  ${name.padEnd(24).slice(0, 24)} ${String(model.turns).padStart(5)} turns  ${fmtMoney(model.cost).padStart(9)}  ${fmtTokens(model.input + model.output + model.cacheRead).padStart(7)} tok`);
  }
  lines.push("", "Projects");
  const projects = [...report.projects].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8);
  for (const [cwd, project] of projects) {
    const short = cwd.replace(/^\/home\/[^/]+/, "~");
    lines.push(`  ${short.slice(0, 44).padEnd(44)} ${String(project.sessions.size).padStart(3)} sess  ${fmtMoney(project.cost).padStart(9)}`);
  }
  if (report.top.length) {
    lines.push("", "Top sessions");
    for (const session of report.top.slice(0, 5)) {
      lines.push(`  ${fmtMoney(session.cost).padStart(9)}  ${String(session.turns).padStart(4)} turns  ${(session.name || session.cwd || session.file).slice(0, 70)}`);
    }
  }
  return lines.join("\n");
}

export default function stats(pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Session/model cost statistics: /stats [all|7|30]",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["all", "7", "30"], {},
      { all: "all sessions", "7": "last 7 days", "30": "last 30 days" }),
    handler: async (args, context) => {
      const value = args.trim() || "7";
      const days = value === "all" ? undefined : value === "30" ? 30 : 7;
      const label = days === undefined ? "all time" : `last ${days} days`;
      context.ui.notify(`Reading sessions for ${label}…`, "info");
      const report = await buildStats(undefined, days);
      context.ui.notify(formatStats(report, label), "info");
    },
  });
}
