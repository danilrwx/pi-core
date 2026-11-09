import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const data = await jiti.import("../extensions/usage/data.ts");
const { renderUsage, renderTabs, renderModelTable, summaryFor } = await jiti.import("../extensions/usage/index.ts");
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

test("the panel has five periods and shows cost, tokens, cache and hit rate", () => {
  const empty = data.summarize([]);
  const summary = data.summarize([
    point({ id: "a", provider: "deepseek", model: "deepseek-flash", cost: 1.5, input: 12_000, output: 900, cacheRead: 380_000, cacheWrite: 40_000 }),
    point({ id: "b", provider: "tools", model: "summaries", cost: 0.3, input: 900_000, output: 38_000, cacheRead: 0, cacheWrite: 0, source: "auxiliary" }),
  ]);
  const usage = { currentSessionId: "s1", current: summary, today: summary, week: summary, month: empty, all: summary };

  const session = renderUsage(usage, 100, theme, "session").join("\n");
  assert.match(session, /session/);
  assert.match(session, /today/);
  assert.match(session, /week/);
  assert.match(session, /month/);
  assert.match(session, /all time/);
  assert.match(session, /\$1\.80/, "total cost for the period");
  assert.match(session, /in 912\.0k · out 38\.9k/, "totals aggregate every model of the period");
  assert.match(session, /cached 380\.0k/);
  assert.match(session, /hit 29%/, "cache hit rate is the cached share of the prompt");
  assert.match(session, /deepseek\/deepseek-flash/);
  assert.match(session, /tools\/summaries/);
  assert.match(session, /cost/, "the table is labelled");
  assert.match(session, /msgs/);
  assert.doesNotMatch(session, /limit/i, "no invented subscription limits");

  // Another tab is another period, and the context bar belongs to the session only.
  const month = renderUsage(usage, 100, theme, "month").join("\n");
  assert.match(month, /since the 1st/);
  assert.doesNotMatch(month, /context /);
  assert.match(month, /no recorded model usage in this period/);
  assert.equal(summaryFor(usage, "month"), empty);
  assert.equal(summaryFor(usage, "all"), summary);
});

test("the tab strip marks the active period and the table fits any width", () => {
  const strip = renderTabs("week", 80, theme);
  assert.match(strip, /week/);
  assert.match(renderTabs("all", 80, { ...theme, bg: (_token, text) => `[${text}]` }), /\[ all time \]/);

  const summary = data.summarize([point()]);
  for (const width of [56, 78, 100, 140]) {
    const lines = renderModelTable(summary, width, theme);
    for (const line of lines) {
      const visible = line.replace(/\u001b\[[0-9;]*m/g, "").length;
      assert.ok(visible <= width, `line overflows ${width}: ${line}`);
    }
    const header = lines[0];
    assert.match(header, /model/);
    assert.match(header, /cost/);
    if (width >= 78) assert.match(header, /hit/, "the hit rate column needs room");
    if (width < 78) assert.doesNotMatch(header, /msgs/, "narrow panels drop the least useful column");
  }
});

test("the month period starts on the 1st and is its own summary", () => {
  const now = new Date(2026, 7, 20, 12).getTime(); // Aug 20
  assert.equal(new Date(data.startOfMonth(now)).getDate(), 1);
  const points = [
    point({ id: "aug", timestamp: new Date(2026, 7, 2, 10).getTime() }),
    point({ id: "jul", timestamp: new Date(2026, 6, 28, 10).getTime() }),
  ];
  assert.equal(data.summarize(points, data.startOfMonth(now), now + 1).messages, 1);
  assert.equal(data.summarize(points, data.startOfDay(now), now + 1).messages, 0);
});
