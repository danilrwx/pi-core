import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const store = await jiti.import("../extensions/checkpoint/store.ts");
const plugin = await jiti.import("../extensions/checkpoint/index.ts");

async function withCheckpointDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
  const previous = process.env.PI_CHECKPOINT_DIR;
  process.env.PI_CHECKPOINT_DIR = dir;
  try { return await fn(dir); } finally {
    if (previous === undefined) delete process.env.PI_CHECKPOINT_DIR; else process.env.PI_CHECKPOINT_DIR = previous;
  }
}
function harness() {
  const handlers = new Map(), commands = new Map(), tools = new Map(), entries = [];
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data, id: `e${entries.length + 1}` }); },
  };
  plugin.default(pi);
  const notices = [];
  const ctx = {
    cwd: "", hasUI: true,
    sessionManager: {
      getSessionId: () => "s1",
      getLeafEntry: () => entries.at(-1) ?? { id: "u1" },
      getBranch: () => entries,
      getEntry: (id) => entries.find((entry) => entry.id === id) ?? { type: "message", message: { role: "user", content: "turn" } },
    },
    ui: {
      notify(message) { notices.push(message); },
      confirm: async () => true,
      select: async (_title, options) => options[0],
    },
    async navigateTree() { return { cancelled: false }; },
  };
  return { pi, handlers, commands, tools, entries, notices, ctx };
}

test("checkpoint store compresses blobs and restores contents", async () => {
  await withCheckpointDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-file-"));
    const path = join(dir, "a.txt");
    await writeFile(path, "before\n");
    const snap = await store.snapshot(dir, path);
    assert.equal(snap.file.existed, true);
    await store.commitBlob(snap.file.before, snap.bytes);
    assert.equal((await store.readBlob(snap.file.before)).toString(), "before\n");
    await writeFile(path, "after\n");
    assert.equal(await store.restoreFile(dir, snap.file), "restored");
    assert.equal(await readFile(path, "utf8"), "before\n");
  });
});

test("edit checkpoints are grouped per turn and restore the pre-state", async () => {
  await withCheckpointDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-edit-"));
    const h = harness(); h.ctx.cwd = dir;
    const file = join(dir, "a.ts");
    await writeFile(file, "original\n");
    await h.handlers.get("turn_start")({ turnIndex: 1 }, h.ctx);
    await h.handlers.get("tool_call")({ toolCallId: "e1", toolName: "edit", input: { path: file } }, h.ctx);
    await writeFile(file, "changed\n");
    await h.handlers.get("tool_result")({ toolCallId: "e1", toolName: "edit", isError: false }, h.ctx);
    await h.handlers.get("agent_settled")({}, h.ctx);
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].customType, "pi-core:checkpoint");
    assert.equal(h.entries[0].data.files[0].existed, true);
    assert.equal(await readFile(file, "utf8"), "changed\n");
    await h.commands.get("checkpoint").handler("restore 1", h.ctx);
    assert.equal(await readFile(file, "utf8"), "original\n");
    assert.equal(h.entries.length, 2, "a safety checkpoint must be added");
    assert.equal(h.entries[1].data.safety, true);
  });
});

test("a newly created file is deleted on restore, and rejected propose_change is ignored", async () => {
  await withCheckpointDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-new-"));
    const h = harness(); h.ctx.cwd = dir;
    const file = join(dir, "new.ts");
    await h.handlers.get("turn_start")({ turnIndex: 1 }, h.ctx);
    await h.handlers.get("tool_call")({ toolCallId: "w1", toolName: "write", input: { path: file } }, h.ctx);
    await writeFile(file, "new\n");
    await h.handlers.get("tool_result")({ toolCallId: "w1", toolName: "write", isError: false }, h.ctx);
    await h.handlers.get("agent_settled")({}, h.ctx);
    assert.equal(h.entries[0].data.files[0].existed, false);
    await h.handlers.get("tool_call")({ toolCallId: "p1", toolName: "propose_change", input: { file: join(dir, "other.ts") } }, h.ctx);
    await h.handlers.get("tool_result")({ toolCallId: "p1", toolName: "propose_change", isError: false, details: { status: "rejected" } }, h.ctx);
    await h.handlers.get("agent_settled")({}, h.ctx);
    assert.equal(h.entries.length, 1, "rejected proposal adds no checkpoint");
    await h.commands.get("checkpoint").handler("restore 1", h.ctx);
    await assert.rejects(readFile(file, "utf8"), /ENOENT/);
  });
});

test("the checkpoint tool lists snapshots and restores only after confirmation", async () => {
  await withCheckpointDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-tool-"));
    const h = harness(); h.ctx.cwd = dir;
    const file = join(dir, "a.ts");
    await writeFile(file, "original\n");
    await h.handlers.get("turn_start")({ turnIndex: 1 }, h.ctx);
    await h.handlers.get("tool_call")({ toolCallId: "e1", toolName: "edit", input: { path: file } }, h.ctx);
    await writeFile(file, "changed\n");
    await h.handlers.get("tool_result")({ toolCallId: "e1", toolName: "edit", isError: false }, h.ctx);
    await h.handlers.get("agent_settled")({}, h.ctx);
    const tool = h.tools.get("checkpoint");
    const listed = await tool.execute("t", { action: "list" }, undefined, undefined, h.ctx);
    assert.match(listed.content[0].text, /1\./);
    assert.equal((await readFile(file, "utf8")), "changed\n");
    const restored = await tool.execute("t", { action: "restore", target: "1" }, undefined, undefined, h.ctx);
    assert.match(restored.content[0].text, /1 restored/);
    assert.equal(await readFile(file, "utf8"), "original\n");
  });
});
