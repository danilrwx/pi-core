import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jiti } from "./host.mjs";

const { loadLock, verifyLock } = await jiti.import("../scripts/third-party.mjs");

test("third-party lock hashes every vendored file", async () => {
  const result = await verifyLock(await loadLock());
  assert.deepEqual(result.errors, []);
  assert.ok(result.sources >= 8);
  assert.ok(result.files >= 30);
});

test("third-party check rejects a changed vendored file", async () => {
  const lock = structuredClone(await loadLock());
  lock.sources[0].files[0].sha256 = "0".repeat(64);
  const result = await verifyLock(lock);
  assert.ok(result.errors.some((error) => error.includes(lock.sources[0].files[0].path)));
});

test("third-party check rejects an unlisted file under vendor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-third-party-"));
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "surprise.wasm"), "not in the lock");
  const result = await verifyLock({ version: 1, licenses: {}, sources: [] }, { root, strict: true });
  assert.ok(result.errors.some((error) => error.includes("unlisted vendor file")));
});
