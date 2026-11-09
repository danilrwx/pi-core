import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { isInside } = await jiti.import("../extensions/lib/path-safety.ts");

test("path containment rejects siblings, traversal and absolute escapes", () => {
  assert.equal(isInside("/repo", "/repo/a.ts"), true);
  assert.equal(isInside("/repo", "/repo/sub/../a.ts"), true);
  assert.equal(isInside("/repo", "/repo"), true);
  assert.equal(isInside("/repo", "/repo2/a.ts"), false);
  assert.equal(isInside("/repo", "/etc/passwd"), false);
  assert.equal(isInside("/repo", "/repo/../etc/passwd"), false);
  assert.equal(isInside("/", "/tmp/a"), true);
});
