import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { default: plugin } = await jiti.import("../extensions/batch/index.ts");

function load() {
  let definition;
  const pi = { registerTool(value) { definition = value; } };
  plugin(pi);
  return definition;
}

test("batch runs read-only calls in parallel and preserves input order", async () => {
  const definition = load();
  const calls = [];
  const context = {
    signal: undefined,
    async executeTool(name, args) {
      calls.push([name, args]);
      await new Promise((resolve) => setTimeout(resolve, name === "read" ? 10 : 1));
      return { isError: false, result: { content: [{ type: "text", text: `${name}:${args.path ?? args.pattern}` }] }, durationMs: 1 };
    },
  };
  const result = await definition.execute("id", { tool_calls: [
    { tool: "read", parameters: { path: "a.ts" } },
    { tool: "grep", parameters: { pattern: "foo" } },
  ] }, undefined, undefined, context);
  assert.equal(result.isError, false);
  assert.deepEqual(calls.map(([name]) => name), ["read", "grep"]);
  assert.match(result.content[0].text, /^Batch: 2\/2 succeeded/);
  assert.ok(result.content[0].text.indexOf("read:a.ts") < result.content[0].text.indexOf("grep:foo"));
  assert.equal(result.details.calls.length, 2);
});

test("batch rejects mutating tools and caps large output", async () => {
  const definition = load();
  const rejected = await definition.execute("id", { tool_calls: [{ tool: "bash", parameters: { command: "rm -rf /" } }] }, undefined, undefined, { signal: undefined, executeTool: async () => { throw new Error("must not run"); } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /read-only/);

  const context = {
    signal: undefined,
    async executeTool() {
      return { isError: false, result: { content: [{ type: "text", text: "x".repeat(10_000) }] } };
    },
  };
  const result = await definition.execute("id", { tool_calls: [{ tool: "read", parameters: { path: "a" } }] }, undefined, undefined, context);
  assert.equal(result.details.calls[0].truncated, true);
  assert.ok(result.content[0].text.length < 9_000);
  assert.match(result.content[0].text, /truncated/);
});

test("batch reports partial failures without hiding successes", async () => {
  const definition = load();
  const context = {
    signal: undefined,
    async executeTool(name) {
      if (name === "grep") return { isError: true, result: { content: [{ type: "text", text: "bad pattern" }] } };
      return { isError: false, result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
  const result = await definition.execute("id", { tool_calls: [
    { tool: "read", parameters: { path: "a" } },
    { tool: "grep", parameters: { pattern: "[" } },
  ] }, undefined, undefined, context);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /1\/2 succeeded/);
  assert.match(result.content[0].text, /grep \(failed\)/);
  assert.match(result.content[0].text, /bad pattern/);
});

test("batch preserves image content from read calls", async () => {
  const definition = load();
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const context = {
    signal: undefined,
    async executeTool() {
      return { isError: false, result: { content: [image] } };
    },
  };
  const result = await definition.execute("id", { tool_calls: [{ tool: "read", parameters: { path: "a.png" } }] }, undefined, undefined, context);
  assert.equal(result.isError, false);
  assert.equal(result.details.images, 1);
  assert.ok(result.content.some((part) => part.type === "image"));
  assert.match(result.content[0].text, /image attached below/);
});
