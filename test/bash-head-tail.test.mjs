import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const { default: plugin, readHead } = await jiti.import("../extensions/bash-head-tail/index.ts");

test("bash head-tail prepends the beginning to a truncated tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-head-tail-"));
  const path = join(dir, "full.log");
  await writeFile(path, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.equal(await readHead(path, 3), "line 1\nline 2\nline 3");
  const handlers = new Map();
  plugin({ on(name, fn) { handlers.set(name, fn); } });
  const event = {
    toolName: "bash",
    content: [{ type: "text", text: "line 101\nline 300\n[Showing last 200 lines]" }],
    details: { fullOutputPath: path, truncation: { truncated: true, totalLines: 300, outputLines: 200 } },
  };
  await handlers.get("tool_result")(event);
  assert.match(event.content[0].text, /^\[first lines of output\]\nline 1/);
  assert.match(event.content[0].text, /line 101\nline 300/);
  const small = { ...event, content: [{ type: "text", text: "tail" }], details: { fullOutputPath: path, truncation: { truncated: true, totalLines: 50, outputLines: 40 } } };
  await handlers.get("tool_result")(small);
  assert.equal(small.content[0].text, "tail");
});
