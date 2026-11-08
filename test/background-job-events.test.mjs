/** Copyright 2026 GhabiX. Apache-2.0. Modified for pi-core paths and quoted events. */
import { jiti } from "./host.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const events = await jiti.import("../extensions/background-jobs/events.ts");

const job = {
  name: "build",
  command: "npm run build",
  pid: 10,
  pgid: 10,
  log: "/tmp/build.log",
  cwd: "/tmp",
  ownerPid: 1,
  startedAt: "2026-10-09T08:00:00.000Z",
  watch: "exit",
};
const end = (fields) => ({ at: "2026-10-09T08:01:05.000Z", code: 0, signal: null, ...fields });

test("lines inside one window form one batch; a partial line waits for its newline", async () => {
  const batches = [];
  const batcher = new events.LineBatcher((lines) => batches.push(lines), 50);
  batcher.push("a\nb");
  batcher.push("\r\n\nc\n");
  await delay(80);
  batcher.push("d\n");
  await delay(80);
  assert.deepEqual(batches, [["a", "b", "c"], ["d"]]);
});

test("end flushes the pending batch with an unterminated last line", () => {
  const batches = [];
  const batcher = new events.LineBatcher((lines) => batches.push(lines), 1000);
  batcher.push("a\ntail");
  batcher.end();
  assert.deepEqual(batches, [["a", "tail"]]);
});

test("the flood gate admits limit events per window", () => {
  const admit = events.floodGate(3, 1000);
  assert.deepEqual([0, 1, 2, 3].map((t) => admit(t)), [true, true, true, false]);
  assert.equal(admit(1000), true);
});

test("monitor timeout defaults and caps", () => {
  assert.equal(events.monitorTimeout(undefined), events.MONITOR_DEFAULT_MS);
  assert.equal(events.monitorTimeout(2000), 2000);
  assert.equal(events.monitorTimeout(10 * events.MONITOR_MAX_MS), events.MONITOR_MAX_MS);
});

test("clip keeps the newest lines within both caps and cuts a single long line", () => {
  assert.deepEqual(events.clip(["1", "2", "3"], 2, 100), { text: "2\n3", omitted: 1 });
  assert.deepEqual(events.clip(["aaaa", "bbbb"], 10, 6), { text: "bbbb", omitted: 1 });
  for (const line of ["x".repeat(50), "é".repeat(50), "日本語".repeat(20)]) {
    const long = events.clip([line], 10, 8);
    assert.equal(long.omitted, 0);
    assert.equal(Buffer.byteLength(long.text) <= 8, true);
    assert.equal(long.text.endsWith("…"), true);
    assert.equal(line.startsWith(long.text.slice(0, -1)), true);
  }
});

test("a line without a newline and a burst of lines stay bounded", () => {
  const batches = [];
  const batcher = new events.LineBatcher((lines, dropped) => batches.push({ lines, dropped }), 1000);
  for (let i = 0; i < 100; i++) batcher.push("x".repeat(10_000));
  batcher.push("\n");
  for (let i = 0; i < 1000; i++) batcher.push(`line-${i}\n`);
  batcher.end();
  assert.equal(batches.length, 1);
  const [{ lines, dropped }] = batches;
  assert.equal(lines.length, events.EVENT_MAX_LINES);
  assert.equal(dropped, 1001 - events.EVENT_MAX_LINES);
  assert.equal(lines.at(-1), "line-999");
  assert.match(events.eventMessage({ ...job, watch: "lines" }, lines, dropped), new RegExp(`${dropped} more lines`));
});

test("a cut line is at most EVENT_MAX_BYTES characters plus an ellipsis", () => {
  const batches = [];
  const batcher = new events.LineBatcher((lines) => batches.push(lines), 1000);
  batcher.push("y".repeat(3 * events.EVENT_MAX_BYTES));
  batcher.end();
  assert.equal(batches[0][0].length, events.EVENT_MAX_BYTES + 1);
});

test("plain removes terminal control sequences", () => {
  assert.equal(events.plain("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\tz"), "red ok\tz");
});

test("an exit message carries the code, log path, and tail", () => {
  const text = events.exitMessage(job, end({ code: 3 }), "one\ntwo\n", false);
  assert.match(text, /code 3/);
  assert.match(text, /1m 5s/);
  assert.match(text, /\/tmp\/build\.log/);
  assert.match(text, /\| one\n\| two$/);
  assert.match(events.exitMessage(job, end({ code: null, signal: "SIGKILL" }), "", false), /SIGKILL/);
  assert.notEqual(events.exitMessage(job, end(), "", true), events.exitMessage(job, end(), "", false));
});

test("an event message names the monitor and clips its lines", () => {
  const monitor = { ...job, watch: "lines", description: "errors in build.log" };
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
  const text = events.eventMessage(monitor, lines);
  assert.match(text, /errors in build\.log/);
  assert.match(text, /line-49/);
  assert.doesNotMatch(text, /line-0\n/);
  assert.match(text, /10 more lines/);
});

test("captureStdout releases after its log writer failed early, and reports the failure", async () => {
  const source = new PassThrough();
  const capture = events.captureStdout(source, "/nonexistent-pi-core-test/log");
  let seen = "";
  capture.stream.on("data", (chunk) => (seen += chunk));
  source.write("a\n");
  await delay(100);
  source.write("b\n");
  await capture.release();
  assert.match(capture.logError()?.message ?? "", /ENOENT/);
  assert.match(seen, /^a\n/);
});

test("captureStdout's release resolves after the last write is in the log", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "capture-")), "out.log");
  const source = new PassThrough();
  const capture = events.captureStdout(source, log);
  capture.stream.resume();
  source.write("x".repeat(2_000_000));
  source.end("\nlast\n");
  await new Promise((resolve) => capture.stream.on("end", resolve));
  await capture.release();
  assert.equal(capture.logError(), undefined);
  assert.equal(readFileSync(log, "utf8").endsWith("\nlast\n"), true);
});
