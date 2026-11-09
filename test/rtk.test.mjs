import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { acceptableRewrite, hasUnsupportedFind, isSafeRewrite, parseVersion, shouldSkipRewrite } = await jiti.import("../extensions/rtk/rewrite.ts");

test("rtk version parser and skip rules", () => {
  assert.deepEqual(parseVersion("rtk 1.0.1"), [1, 0, 1]);
  assert.equal(parseVersion("nope"), null);
  assert.equal(shouldSkipRewrite("rtk git status"), true);
  assert.equal(shouldSkipRewrite("RTK_DISABLED=1 git status"), true);
  assert.equal(shouldSkipRewrite("git status"), false);
});

test("rtk accepts prepended rewrites and read shortcuts", () => {
  assert.equal(acceptableRewrite("git status", "rtk git status"), "rtk git status");
  assert.equal(acceptableRewrite("cat src/a.ts", "rtk read src/a.ts"), "rtk read src/a.ts");
  assert.equal(acceptableRewrite("head -20 src/a.ts", "rtk read src/a.ts --head-lines 20"), "rtk read src/a.ts --head-lines 20");
  assert.equal(acceptableRewrite("git status", "rm -rf /"), undefined);
});

test("rtk rejects compound lines and unsafe find predicates", () => {
  assert.equal(isSafeRewrite("git status && ls", "rtk git status && rtk ls"), false);
  assert.equal(isSafeRewrite("git commit -m \"fix (bug)\"", "rtk git commit -m \"fix (bug)\""), true);
  assert.equal(hasUnsupportedFind("rtk find . -name foo -print0"), true);
  assert.equal(hasUnsupportedFind("rtk find . -name foo"), false);
  assert.equal(acceptableRewrite("node -e 'console.log(1)'", "rtk node -e 'console.log(1)'"), undefined);
});

test("rtk extension mutates safe bash calls only", async () => {
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    async exec(command, args) {
      assert.equal(command, "rtk");
      if (args[0] === "--version") return { code: 0, stdout: "rtk 1.0.1" };
      assert.deepEqual(args, ["rewrite", "git status"]);
      return { code: 3, stdout: "rtk git status" };
    },
  };
  const { default: plugin } = await jiti.import("../extensions/rtk/index.ts");
  plugin(pi);
  const event = { type: "tool_call", toolName: "bash", input: { command: "git status" } };
  await handlers.get("tool_call")(event, { hasUI: false, signal: undefined });
  assert.equal(event.input.command, "rtk git status");
});
