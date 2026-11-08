import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { jiti } from "./host.mjs";
import { tinyPng } from "./png.mjs";
const { ReadTracker, fingerprint } = await jiti.import("../extensions/read-watch/tracker.ts");
const readWatch = await jiti.import("../extensions/read-watch/index.ts");
const images = await jiti.import("../extensions/image-preview/images.ts");

async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(30); } assert.fail("Timed out"); }

test("read tracker detects changed contents, survives atomic replacement and deduplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-read-watch-")), path = join(dir, "code.ts");
  await writeFile(path, "first");
  const seen = [], tracker = new ReadTracker((path) => seen.push(path));
  tracker.observe({ path, fingerprint: await fingerprint(path) });
  try {
    await writeFile(join(dir, "replacement"), "second"); await rename(join(dir, "replacement"), path);
    await until(() => seen.length === 1);
    assert.equal(await tracker.check(path), true); assert.equal(seen.length, 1);
    tracker.observe({ path, fingerprint: await fingerprint(path) });
    assert.equal(await tracker.check(path), false);
    await writeFile(path, "second"); await delay(300); assert.equal(seen.length, 1);
    await unlink(path); await until(() => seen.length === 2);
    await writeFile(path, "recreated"); await until(() => seen.length === 3);
  } finally { tracker.close(); }
});

test("read tracker acknowledges own successful writes and cleans up watches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-own-write-")), path = join(dir, "code.ts");
  await writeFile(path, "a"); const seen = [], tracker = new ReadTracker((path) => seen.push(path));
  tracker.observe({ path, fingerprint: await fingerprint(path) });
  tracker.beginWrite(path); await writeFile(path, "b"); await tracker.endWrite(path, true);
  await delay(300); assert.equal(seen.length, 0); assert.equal(await tracker.check(path), false);
  tracker.close(); await writeFile(path, "c"); await delay(300); assert.equal(seen.length, 0);
});

test("read-watch blocks stale edits, permits reread, persists fingerprints outside model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-stale-gate-")), path = join(dir, "code.ts");
  await writeFile(path, "a");
  const hooks = new Map(), entries = [], messages = [];
  readWatch.default({ on(name, fn) { hooks.set(name, fn); }, registerCommand() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); }, sendMessage(...args) { messages.push(args); } });
  const ctx = { cwd: dir, sessionManager: { getBranch: () => entries }, ui: { setStatus() {} } };
  await hooks.get("session_start")({}, ctx);
  try {
    await hooks.get("tool_call")({ toolCallId: "r1", toolName: "read", input: { path } }, ctx);
    await hooks.get("tool_result")({ toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "a" }], isError: false }, ctx);
    assert.equal(entries.length, 1); assert.equal(entries[0].type, "custom");
    await writeFile(path, "external");
    const denied = await hooks.get("tool_call")({ toolCallId: "e1", toolName: "edit", input: { path } }, ctx);
    assert.equal(denied.block, true);
    await hooks.get("tool_call")({ toolCallId: "r2", toolName: "read", input: { path } }, ctx);
    await hooks.get("tool_result")({ toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "external" }], isError: false }, ctx);
    assert.equal(await hooks.get("tool_call")({ toolCallId: "e2", toolName: "edit", input: { path } }, ctx), undefined);
    await writeFile(path, "own change");
    await hooks.get("tool_result")({ toolCallId: "e2", toolName: "edit", content: [], isError: false }, ctx);
  } finally { hooks.get("session_shutdown")({}, ctx); }
});

test("image references support quoted paths and never fetch URLs", () => {
  const text = `look @"dir/a b.png" and ./two.jpg https://example.com/no.png`;
  const refs = images.imageReferences(text, "/project");
  assert.deepEqual(refs.map((ref) => ref.path), ["/project/dir/a b.png", "/project/two.jpg"]);
  assert.equal(images.removeReference(text, refs[0]), "look  and ./two.jpg https://example.com/no.png");
});

test("local image preview uses bounded UI data without modifying the original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-images-")), path = join(dir, "tiny.png");
  const bytes = tinyPng();
  await writeFile(path, bytes);
  const preview = await images.previewFile(path);
  assert.ok(preview); assert.equal(preview.path, path); assert.ok(preview.data.length < 1024 * 1024);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(await images.previewFile(join(dir, "missing.png")), undefined);
  assert.equal(await images.previewFile(dir), undefined);
});

test("read-watch restore ignores stale records for deleted or renamed files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-stale-restore-"));
  const missing = join(dir, "removed.ts");
  const hooks = new Map(), messages = [];
  readWatch.default({ on(name, fn) { hooks.set(name, fn); }, registerCommand() {}, appendEntry() {},
    sendMessage(...args) { messages.push(args); } });
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [
    { type: "custom", customType: "pi-core:read-fingerprint", data: { path: missing, fingerprint: "sha256:gone" } },
  ] }, ui: { setStatus() {} } };
  await hooks.get("session_start")({}, ctx);
  await delay(350);
  assert.equal(messages.length, 0);
  hooks.get("session_shutdown")({}, ctx);
});
