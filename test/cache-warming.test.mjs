import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { warmingDecision } = await jiti.import("../extensions/cache-warming/index.ts");

test("cache warming is limited by idle age, budget and expected savings", () => {
  const base = { now: 1_000_000, lastActivity: 999_000, active: false, warmSpent: 0,
    maxIdleMs: 30 * 60_000, maxIdleCost: 0.05, minSavings: 0.005,
    warmCost: 0.0029, missCost: 0.145, continuationProbability: 0.15 };
  assert.equal(warmingDecision(base), "warm");
  assert.equal(warmingDecision({ ...base, active: true }), undefined);
  assert.equal(warmingDecision({ ...base, now: base.lastActivity + 31 * 60_000 }), "stop");
  assert.equal(warmingDecision({ ...base, warmSpent: 0.05 }), "stop");
  assert.equal(warmingDecision({ ...base, missCost: 0.01 }), "stop", "a small cache miss is not worth warming");
});

test("cache warming env overrides reject invalid numbers", async () => {
  const { envNumber } = await jiti.import("../extensions/cache-warming/index.ts");
  assert.equal(envNumber("X", 30, { X: "10" }), 10);
  assert.equal(envNumber("X", 30, { X: "abc" }), 30);
  assert.equal(envNumber("X", 30, { X: "" }), 30);
  assert.equal(envNumber("X", 30, { X: "-4" }), 0);
  assert.equal(Number.isFinite(envNumber("X", 30, { X: "NaN" })), true);
});
