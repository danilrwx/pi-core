import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("memory is stored as Claude-compatible Markdown with MEMORY.md index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-md-"));
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = dir;
  try {
    const result = await store.addMemory("/repo/a", { text: "Use pnpm", description: "Package manager", tags: ["tooling"], type: "feedback" });
    const file = join(store.projectMemoryDir("/repo/a"), `${result.memory.id}.md`);
    const markdown = await readFile(file, "utf8");
    assert.match(markdown, /^---\nname: /);
    assert.match(markdown, /metadata:\n  node_type: memory\n  type: feedback/);
    assert.match(markdown, /description: "Package manager"/);
    const index = await readFile(join(store.projectMemoryDir("/repo/a"), "MEMORY.md"), "utf8");
    assert.match(index, new RegExp(`\\[Package manager\\]\\(${result.memory.id}\\.md\\)`));
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous;
  }
});

test("importClaude copies Claude project memory once and keeps its type and description", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-import-"));
  const claude = await mkdtemp(join(tmpdir(), "claude-config-"));
  const previous = { memory: process.env.PI_MEMORY_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.PI_MEMORY_DIR = dir; process.env.CLAUDE_CONFIG_DIR = claude;
  try {
    const source = join(claude, "projects", store.projectSlug("/repo/a"), "memory");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "MEMORY.md"), "- [Rule](rule.md) — do it\n");
    await writeFile(join(source, "rule.md"), `---\nname: rule\ndescription: "Never force push"\nmetadata: \n  node_type: memory\n  type: feedback\n  originSessionId: session-1\n---\n\nNever force push main.\n\n**Why:** shared branch.\n`);
    assert.equal(await store.importClaude("/repo/a"), 1);
    const all = await store.loadAll("/repo/a");
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "rule");
    assert.equal(all[0].type, "feedback");
    assert.equal(all[0].description, "Never force push");
    assert.match(all[0].text, /Never force push main/);
    assert.equal(await store.importClaude("/repo/a"), 0);
  } finally {
    if (previous.memory === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous.memory;
    if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.claude;
  }
});

test("explicit remember requests are captured automatically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-auto-"));
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = dir;
  try {
    const handlers = new Map();
    plugin.default({ on(name, fn) { handlers.set(name, fn); }, registerTool() {}, registerCommand() {} });
    const branch = [{ type: "message", message: { role: "user", content: "Remember: always run gofmt before committing" } }];
    const ctx = { cwd: "/repo/a", sessionManager: { getBranch: () => branch, getSessionId: () => "s" }, ui: { notify() {} } };
    await handlers.get("agent_settled")({}, ctx);
    const all = await store.loadAll("/repo/a");
    assert.equal(all.length, 1);
    assert.match(all[0].text, /always run gofmt/);
    assert.equal(all[0].type, "feedback");
    await handlers.get("agent_settled")({}, ctx);
    assert.equal((await store.loadAll("/repo/a")).length, 1, "the same request is deduplicated");
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous;
  }
});

test("Jev recall uses summaries, caches decisions and falls back to keywords on errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-jev-"));
  const previous = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = dir;
  try {
    await store.addMemory("/repo/a", { text: "Deploy uses the staging cluster first", description: "Deploy order" });
    await store.addMemory("/repo/a", { text: "Use pnpm for package installs", description: "Package manager" });
    const handlers = new Map();
    plugin.default({ on(name, fn) { handlers.set(name, fn); }, registerTool() {}, registerCommand() {} });
    let calls = 0;
    const ctx = {
      cwd: "/repo/a",
      sessionManager: { getBranch: () => [], getSessionId: () => "s" },
      ui: { notify() {} },
      signal: undefined,
      modelRegistry: {
        findOfType(_type, provider, id) { return provider === "openrouter" && id === "typesafe/jev-1.13" ? { provider, id } : undefined; },
        async classify(_model, request) {
          calls++;
          const answers = {};
          request.state.candidates.forEach((candidate, index) => {
            answers[`c${index}`] = { type: "bool", probability: /deploy/i.test(candidate.description) ? 0.95 : 0.1 };
          });
          return { stopReason: "stop", answers, usage: { input: 100, cost: { total: 0.000004 } } };
        },
      },
    };
    const event = { messageType: "user", prompt: "How do we deploy?", systemPromptOptions: { sections: {} } };
    await handlers.get("before_agent_start")(event, ctx);
    assert.match(event.systemPromptOptions.sections.long_term_memory, /staging cluster/);
    assert.doesNotMatch(event.systemPromptOptions.sections.long_term_memory, /pnpm/);
    assert.equal(calls, 1);
    const cached = { messageType: "user", prompt: "deploy how do we?", systemPromptOptions: { sections: {} } };
    await handlers.get("before_agent_start")(cached, ctx);
    assert.match(cached.systemPromptOptions.sections.long_term_memory, /staging cluster/);
    assert.equal(calls, 1, "normalized query and candidate hash should hit the local decision cache");

    const broken = { ...ctx, modelRegistry: { ...ctx.modelRegistry, async classify() { throw new Error("provider down"); } } };
    const fallback = { messageType: "user", prompt: "How do we deploy now?", systemPromptOptions: { sections: {} } };
    await handlers.get("before_agent_start")(fallback, broken);
    assert.match(fallback.systemPromptOptions.sections.long_term_memory, /staging cluster/);
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previous;
  }
});

test("auto-memory refuses secret-looking requests", async () => {
  const { autoCandidate, looksLikeSecret } = await jiti.import("../extensions/memory/index.ts");
  assert.equal(autoCandidate("remember that we use pnpm"), "remember that we use pnpm");
  assert.equal(autoCandidate("запомни: API key = sk-1234567890abcdefghijklmnop"), undefined);
  assert.equal(autoCandidate("remember password: correct horse battery staple"), undefined);
  assert.equal(looksLikeSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), true);
  assert.equal(looksLikeSecret("deploy to staging first"), false);
});
