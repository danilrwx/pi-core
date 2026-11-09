import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const data = await jiti.import("../extensions/usage/data.ts");
const { renderUsage } = await jiti.import("../extensions/usage/index.ts");
const theme = { fg: (_token, text) => text, bold: (text) => text };

function point(overrides = {}) {
  return {
    id: "p1", sessionId: "s1", timestamp: Date.now(), provider: "deepseek", model: "deepseek-flash",
    cost: 0.01, input: 100, output: 20, cacheRead: 400, cacheWrite: 0, source: "assistant", ...overrides,
  };
}

test("usage summarizes periods, models and cache rate", () => {
  const now = new Date(2026, 6, 15, 12).getTime();
  const points = [
    point({ id: "a", timestamp: now - 60_000, provider: "deepseek", model: "flash", cost: 0.02 }),
    point({ id: "b", timestamp: now - 86400000, provider: "openrouter", model: "haiku", cost: 0.03 }),
    point({ id: "c", timestamp: now - 8 * 86400000, provider: "deepseek", model: "flash", cost: 0.04 }),
  ];
  const all = data.summarize(points);
  assert.equal(all.messages, 3);
  assert.ok(Math.abs(all.cost - 0.09) < 1e-9);
  assert.equal(all.models[0].provider, "deepseek");
  assert.equal(data.summarize(points, data.startOfDay(now)).messages, 1);
  assert.equal(data.startOfWeek(now) <= now, true);
  assert.equal(data.cacheRate(point()), 0.8);
  assert.equal(data.formatMoney(1.234), "$1.23");
  assert.equal(data.formatTokens(1234), "1.2k");
});

test("usage parses assistant, model_change and auxiliary entries", () => {
  const now = Date.now();
  const points = data.parseBranch([
    { type: "model_change", provider: "openai", modelId: "gpt-5" },
    { type: "message", id: "m1", timestamp: new Date(now).toISOString(), message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 8, cost: { total: 0.001 } } } },
    { type: "compaction", id: "c1", timestamp: new Date(now).toISOString(), usage: { input: 5, output: 1, cost: { total: 0.0005 } } },
  ], "s1");
  assert.equal(points.length, 2);
  assert.equal(points[0].provider, "openai");
  assert.equal(points[0].model, "gpt-5");
  assert.equal(points[1].source, "auxiliary");
});

test("usage panel has a Claude-Code-like compact layout", () => {
  const empty = data.summarize([]);
  const lines = renderUsage({
    currentSessionId: "s1", current: empty, today: empty, week: empty, all: empty,
    context: { tokens: 50_000, contextWindow: 100_000 },
  }, 80, theme).join("\n");
  assert.match(lines, /^Usage/m);
  assert.match(lines, /Current session/);
  assert.match(lines, /Today/);
  assert.match(lines, /Current week/);
  assert.match(lines, /All time/);
  assert.match(lines, /context/);
  assert.doesNotMatch(lines, /limit/i, "no invented subscription limits");
});
