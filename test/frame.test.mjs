import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { frameLines, innerWidth, scrollbarColumn } = await jiti.import("../extensions/lib/frame.ts");
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const theme = { fg: (_token, text) => text, bold: (text) => text };

test("the frame is rectangular, titled and separates the footer", () => {
  const lines = frameLines({
    theme, title: "review 2/5 · HEAD", width: 60,
    body: ["first line", "второй line with кириллицей", ""],
    footer: ["hints go here"],
  });
  assert.ok(lines[0].startsWith("╭─ review 2/5 · HEAD ─"));
  assert.ok(lines.at(-1).startsWith("╰") && lines.at(-1).endsWith("╯"));
  for (const line of lines) assert.equal(visibleWidth(line), 60, `line is not 60 wide: ${line}`);
  assert.equal(lines.filter((line) => line.startsWith("├")).length, 1, "footer is separated once");
  assert.match(lines.join("\n"), /второй line with кириллицей/);
});

test("a long body is truncated to the frame, a long title too", () => {
  const lines = frameLines({ theme, title: "x".repeat(200), width: 40, body: ["y".repeat(200)] });
  for (const line of lines) assert.equal(visibleWidth(line), 40);
  assert.match(lines[0], /…/, "the title is cut with an ellipsis");
  assert.match(lines[1], /…/, "the body line is cut with an ellipsis");
});

test("a scrollbar column marks the view without changing the width", () => {
  assert.deepEqual(scrollbarColumn(10, 10, 0), [], "no bar when everything fits");
  const full = scrollbarColumn(100, 10, 0);
  assert.equal(full.length, 10);
  assert.ok(full[0] === "█", "at the top the thumb is at the top");
  assert.ok(full.filter((char) => char === "█").length < 10, "the thumb is shorter than the track");
  const bottom = scrollbarColumn(100, 10, 90);
  assert.ok(bottom.at(-1) === "█", "scrolled down the thumb reaches the bottom");

  const lines = frameLines({ theme, title: "t", width: 40, body: ["a", "b"], scrollbar: ["█", "│"] });
  for (const line of lines) assert.equal(visibleWidth(line), 40);
  assert.match(lines[1], /█/);
});

test("innerWidth matches what the frame leaves for content", () => {
  assert.equal(innerWidth(60), 56);
  assert.equal(innerWidth(60, true), 55);
  assert.equal(innerWidth(10), 26, "a very narrow terminal keeps a readable minimum");
});
