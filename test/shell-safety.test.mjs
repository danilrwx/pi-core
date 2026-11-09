import assert from "node:assert/strict";
import test from "node:test";
import { jiti, sdk } from "./host.mjs";
const { classifyShellCommand } = await jiti.import("../extensions/permission/shell-ast.ts");
const partial = await jiti.import("../extensions/partial-output/index.ts");

for (const command of [
  "git diff && rm -rf /", "git status\nrm -rf /", "git diff | sudo true", "env X=1 rm -rf /",
  "command rm -rf /", "bash -c 'git status; rm -rf /'", "'ba'sh -c 'rm -rf /'", "if true; then rm -rf /; fi",
  'echo "$(rm -rf /)"', "echo `rm -rf /`", "cat <(rm -rf /)", "f(){ rm -rf /; }; f",
  "cat <<EOF\n$(rm -rf /)\nEOF", "find . -delete", "xargs rm -rf", '"$CMD" foo', "git diff && (",
]) test(`AST requires approval: ${command}`, async () => {
  const result = await classifyShellCommand(command, {});
  assert.equal(result.level, "high"); assert.equal(result.dangerous, true);
});

test("AST applies allow patterns per command, never to a whole compound prefix", async () => {
  const result = await classifyShellCommand("git diff && rm -rf /", { overrides: { minimal: ["git *", "rm *"] } });
  assert.equal(result.dangerous, true);
});
for (const command of ["git status", "git diff | head -20", "printf 'literal $(not executed)'", "cat <<'EOF'\n$(not executed)\nEOF"]) {
  test(`AST recognises literal read-only command: ${command}`, async () => {
    const result = await classifyShellCommand(command, {});
    assert.equal(result.level, "minimal"); assert.equal(result.dangerous, false);
  });
}
test("AST classifies redirects independently", async () => {
  assert.equal((await classifyShellCommand("echo hello > output", {})).level, "low");
  assert.equal((await classifyShellCommand("echo hello > /dev/null", {})).level, "minimal");
  assert.equal((await classifyShellCommand("echo hello > /etc/test", {})).dangerous, true);
});

test("real bash abort retains output and partial hook exposes it to codemode", async () => {
  const hooks = new Map();
  partial.default({ on(name, handler) { hooks.set(name, handler); } });
  const controller = new AbortController();
  const ctx = { cwd: process.cwd(), signal: controller.signal,
    sessionManager: { getSessionId: () => "partial-test", getSessionFile: () => undefined } };
  hooks.get("tool_call")({ toolCallId: "aborted" });
  const bash = sdk.createBashToolDefinition(process.cwd());
  let message;
  try {
    await bash.execute("aborted", { command: "printf 'completed-step\\n'; sleep 30" }, controller.signal, (update) => {
      if (update.content.some((part) => part.type === "text" && part.text.includes("completed-step"))) controller.abort();
    }, ctx);
    assert.fail("Expected bash cancellation");
  } catch (error) { message = error.message; }
  assert.match(message, /completed-step/);
  const result = hooks.get("tool_result")({ toolCallId: "aborted", toolName: "bash", content: [{ type: "text", text: message }], isError: true }, ctx);
  assert.equal(result.details.partial, true);
  assert.equal(result.structuredContent.exit_code, 130);
  assert.match(result.structuredContent.output, /completed-step/);
  assert.match(result.content[0].text, /Partial result: aborted/);
});

test("read-only sed and awk are not treated as dangerous", async () => {
  const command = "cd /home/danil/w/pi-core && sed -n '108,140p' extensions/permission/index.ts; rg -n 'LEVEL_INFO' extensions/permission/index.ts | head -20; sed -n '140,165p' extensions/permission/index.ts";
  assert.equal((await classifyShellCommand(command, {})).dangerous, false);
  assert.equal((await classifyShellCommand("sed -n '1,5p' file", {})).dangerous, false);
  assert.equal((await classifyShellCommand("awk '{print $1}' file", {})).dangerous, false);
  assert.equal((await classifyShellCommand("sed -i 's/a/b/' file", {})).dangerous, true);
  assert.equal((await classifyShellCommand("awk '{system(\"rm -rf /\")}' file", {})).dangerous, true);
});
