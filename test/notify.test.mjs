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
