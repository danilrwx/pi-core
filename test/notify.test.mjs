import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { notificationPayload } = await jiti.import("../extensions/notify/index.ts");

test("notify builds Kitty OSC 99 and generic OSC 777 payloads without control injection", () => {
  const kitty = notificationPayload("pi", "Ready\nfor input", { KITTY_WINDOW_ID: "1" });
  assert.ok(kitty.startsWith("\x1b]99;"));
  assert.ok(kitty.includes("Ready for input"));
  assert.ok(!kitty.includes("Ready\n"));
  const other = notificationPayload("pi;bad", "Done\x07", {});
  assert.equal(other, "\x1b]777;notify;pi bad;Done\x07");
});

test("needs-input events send a notification when enabled", async () => {
  const { default: notify } = await jiti.import("../extensions/notify/index.ts");
  const { emitNeedsInput } = await jiti.import("../extensions/lib/needs-input.ts");
  const handlers = new Map();
  notify({ on(name, fn) { handlers.set(name, fn); }, registerCommand() {} });
  const previousTTY = process.stdout.isTTY;
  let written = "";
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { written += String(chunk); return true; };
  try {
    handlers.get("session_start")({}, {});
    emitNeedsInput({ kind: "question", title: "Question", body: "Pick one" });
    assert.match(written, /Pick one/);
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: previousTTY, configurable: true });
    handlers.get("session_shutdown")?.({}, {});
  }
});

test("notify keeps a single needs-input listener across repeated session_start", async () => {
  const { default: notify } = await jiti.import("../extensions/notify/index.ts");
  const { needsInput } = await jiti.import("../extensions/lib/needs-input.ts");
  const handlers = new Map();
  let state = { on(name, fn) { handlers.set(name, fn); }, registerCommand() {} };
  notify(state);
  const before = needsInput.listenerCount("needs-input");
  handlers.get("session_start")({}, {});
  handlers.get("session_start")({}, {});
  assert.equal(needsInput.listenerCount("needs-input"), before + 1);
  handlers.get("session_shutdown")?.({}, {});
  assert.equal(needsInput.listenerCount("needs-input"), before);
});
