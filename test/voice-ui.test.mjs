import assert from "node:assert/strict";
import test from "node:test";
import { importHost, jiti } from "./host.mjs";
const { formatElapsed, voiceLines, VoicePanel } = await jiti.import("../extensions/voice/ui.ts");
const { visibleWidth } = await importHost("@earendil-works/pi-tui");

const theme = { fg: (_token, text) => text };

test("recording line shows backend, timer, meter and live partial text", () => {
  const lines = voiceLines({ backend: "nari", muted: false, level: 0.06, text: "Проверь KubeVirt", elapsed: 12 }, theme, 120);
  assert.match(lines[0], /recording · Nari/);
  assert.match(lines[0], /0:12/);
  assert.match(lines[1], /▮{3}·{7}/);
  assert.match(lines[1], /Проверь KubeVirt/);
  assert.match(lines[2], /Alt\+U mute/);
});

test("muted state is visually distinct, keeps the timer and explains that audio is not sent", () => {
  const lines = voiceLines({ backend: "nari", muted: true, level: 0, text: "Проверь", elapsed: 65 }, theme, 120);
  assert.match(lines[0], /🔇/);
  assert.match(lines[0], /muted · audio not sent/);
  assert.match(lines[0], /1:05/);
  assert.match(lines[1], /·{10}/);
  assert.match(lines[2], /unmute/);
});

test("elapsed formatting is bounded and zero-padded", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(9), "0:09");
  assert.equal(formatElapsed(60), "1:00");
  assert.equal(formatElapsed(3599), "59:59");
  assert.equal(formatElapsed(99_999), "99:59");
});

test("panel renders within narrow widths and repaints from state", () => {
  const renders = [];
  const tui = { requestRender: () => renders.push("render") };
  const panel = new VoicePanel(tui, theme);
  panel.set({ backend: "local", muted: false, level: 0.2, text: "x".repeat(200), elapsed: 3 });
  const narrow = panel.render(30);
  assert.ok(narrow.length >= 3 && narrow.length <= 5, `unexpected line count: ${narrow.length}`);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 30, `line too wide: ${visibleWidth(line)}`);
  panel.set({ backend: "local", muted: true, level: 0, text: "", elapsed: 3 });
  assert.notDeepEqual(panel.render(30), narrow);
  assert.deepEqual(renders, ["render", "render"]);
  panel.invalidate();
  assert.ok(panel.render(30)[0].includes("🔇"));
});

test("long dictation wraps onto several rows and keeps the newest words visible", () => {
  const text = `начало ${"слово ".repeat(80)}и самый конец`;
  const lines = voiceLines({ backend: "nari", muted: false, level: 0.5, text, elapsed: 30 }, theme, 44);
  assert.ok(lines.length > 3, "should wrap instead of truncating to one row");
  for (const line of lines) assert.ok(visibleWidth(line) <= 44, `line too wide: ${visibleWidth(line)}`);
  assert.match(lines.filter((line) => /слово|конец/.test(line)).join(" "), /и самый конец/);
  assert.doesNotMatch(lines.join(" "), /начало/);
});
