import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const { buildStats, formatStats } = await jiti.import("../extensions/stats/index.ts");

test("stats aggregate pi session JSONL by model and project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-"));
  const project = join(root, "sessions", "--repo--");
  await mkdir(project, { recursive: true });
  const now = Date.now();
  const lines = [
    { type: "session", version: 3, cwd: "/repo", timestamp: new Date(now).toISOString() },
    { type: "session_info", id: "1", name: "test session", timestamp: new Date(now).toISOString() },
    { type: "message", id: "2", timestamp: new Date(now).toISOString(), message: {
      role: "assistant", model: "deepseek-flash", provider: "deepseek", timestamp: now, stopReason: "stop",
      usage: { input: 1000, output: 100, cacheRead: 3000, cacheWrite: 0, cost: { total: 0.01 } },
    } },
    { type: "usage", id: "3", timestamp: new Date(now).toISOString(), provider: "deepseek", model: "deepseek-flash",
      usage: { input: 0, output: 0, cacheRead: 500, cacheWrite: 0, cost: { total: 0.001 } } },
  ];
  await writeFile(join(project, "s.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const report = await buildStats(join(root, "sessions"), 7);
  assert.equal(report.sessions, 1);
  assert.equal(report.turns, 1);
  assert.equal(report.input, 1000);
  assert.equal(report.output, 100);
  assert.equal(report.cacheRead, 3500);
  assert.ok(Math.abs(report.cost - 0.011) < 1e-9);
  assert.equal(report.models.get("deepseek-flash").turns, 1);
  assert.equal(report.projects.get("/repo").sessions.size, 1);
  assert.equal(report.top[0].name, "test session");
  const text = formatStats(report, "last 7 days");
  assert.match(text, /Sessions 1/);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /test session/);
});
