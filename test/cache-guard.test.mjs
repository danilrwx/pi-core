import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { formatCacheReport, pct, formatTokens } = await jiti.import("../extensions/cache-guard/index.ts");

test("cache report formats hit history and cold turns", () => {
  const turns = [
    { index: 1, input: 500, output: 20, cacheRead: 3500, cacheWrite: 0, prompt: 4000, hit: 0.875, cost: 0.002, cold: false, aborted: false, at: 1 },
    { index: 2, input: 3000, output: 30, cacheRead: 100, cacheWrite: 0, prompt: 3100, hit: 0.032, cost: 0.01, cold: true, aborted: false, at: 2 },
  ];
  const text = formatCacheReport(turns);
  assert.match(text, /2 turns/);
  assert.match(text, /COLD/);
  assert.equal(pct(0.678), "68%");
  assert.equal(formatTokens(1_500_000), "1.5M");
});
