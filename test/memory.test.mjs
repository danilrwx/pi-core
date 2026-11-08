import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const store = await jiti.import("../extensions/memory/store.ts");
const plugin = await jiti.import("../extensions/memory/index.ts");

test("memory store isolates projects, dedupes, searches and forgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = dir;
  try {
    const first = await store.addMemory("/repo/a", { text: "Uses pnpm and Vitest", tags: ["Tooling", "tooling"] });
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.memory.tags, ["tooling"]);
    const again = await store.addMemory("/repo/a", { text: "uses PNPM and Vitest" });
    assert.equal(again.duplicate, true);
    assert.equal(again.memory.id, first.memory.id);
    await store.addMemory("/repo/a", { text: "Never force-push main", scope: "global" });
    const all = await store.loadAll("/repo/a");
    assert.equal(all.length, 2);
    assert.equal((await store.loadAll("/repo/b")).length, 1, "project memory must not leak");
    const found = store.searchMemories(all, "pnpm vitest");
    assert.equal(found.length, 1);
    assert.equal(found[0].text, "Uses pnpm and Vitest");
    assert.equal(store.searchMemories(all, "nothing-here").length, 0);
    const removed = await store.forgetMemory("/repo/a", first.memory.id);
    assert.equal(removed.length, 1);
    assert.equal((await store.loadAll("/repo/a")).length, 1);
    assert.equal(await store.clearScope("/repo/a", "global"), 1);
    assert.equal((await store.loadAll("/repo/a")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous;
  }
});

test("memory extension recalls relevant notes into a prompt section and drops it when irrelevant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-ext-"));
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = dir;
  try {
    await store.addMemory("/repo/a", { text: "Deploy uses the staging cluster first", tags: ["deploy"] });
    const handlers = new Map();
    plugin.default({ on(name, fn) { handlers.set(name, fn); }, registerTool() {}, registerCommand() {} });
    const event = { messageType: "user", prompt: "How do we deploy?", systemPromptOptions: { sections: {} } };
    await handlers.get("before_agent_start")(event, { cwd: "/repo/a" });
    assert.match(event.systemPromptOptions.sections.long_term_memory, /staging cluster/);
    const other = { messageType: "user", prompt: "Rename a local variable", systemPromptOptions: { sections: { memory: "old" } } };
    await handlers.get("before_agent_start")(other, { cwd: "/repo/a" });
    assert.equal(other.systemPromptOptions.sections.long_term_memory, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous;
  }
});
