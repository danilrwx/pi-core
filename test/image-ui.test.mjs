import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { jiti } from "./host.mjs";
import { tinyPng } from "./png.mjs";
const plugin = await jiti.import("../extensions/image-preview/index.ts");

test("draft image preview survives clipboard insertion and gallery removes only the attachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-image-ui-")), path = join(dir, "shot.png");
  await writeFile(path, tinyPng());
  const hooks = new Map(), commands = new Map(), widgets = new Map();
  let factory, editor, galleryLines;
  const tui = { requestRender() {}, terminal: { columns: 100, rows: 40 } };
  const theme = { fg: (_token, text) => text };
  const keys = { matches: () => false, getKeys: () => [] };
  plugin.default({ on(name, fn) { hooks.set(name, fn); }, registerCommand(name, cmd) { commands.set(name, cmd); }, registerShortcut() {} });
  const ctx = { mode: "tui", cwd: dir, ui: {
    getEditorComponent: () => factory,
    setEditorComponent(value) { factory = value; if (value) editor = value(tui, { borderColor: (text) => text }, keys); },
    setWidget(key, value) { widgets.set(key, value); }, notify() {},
    async custom(make) {
      return new Promise((resolve) => {
        const component = make(tui, theme, keys, resolve);
        galleryLines = component.render(80);
        component.handleInput("d"); component.handleInput("\x1b");
      });
    },
  } };
  await hooks.get("session_start")({}, ctx);
  try {
    editor.setText("explain "); editor.insertTextAtCursor(path);
    for (let i = 0; i < 100 && !widgets.get("image-preview"); i++) await delay(20);
    assert.equal(typeof widgets.get("image-preview"), "function");
    const component = widgets.get("image-preview")(tui, theme);
    assert.ok(component.render(80).length > 0);
    await commands.get("images").handler("", ctx);
    assert.ok(galleryLines.length > 0);
    assert.equal(editor.getExpandedText().trim(), "explain");
  } finally { hooks.get("session_shutdown")({}, ctx); }
  assert.equal(factory, undefined);
});

test("Kitty placeholder geometry encodes rows, columns and a truecolor id", async () => {
  const { planKittyPlacement, kittyPlaceholderLines } = await jiti.import("../extensions/image-preview/kitty.ts");
  const item = { data: tinyPng().toString("base64"), mimeType: "image/png", label: "shot.png" };
  const placement = planKittyPlacement(item, 10, 5);
  assert.ok(placement);
  assert.ok(placement.cols >= 1 && placement.cols <= 10);
  assert.ok(placement.rows >= 1 && placement.rows <= 5);
  const lines = kittyPlaceholderLines(placement);
  assert.equal(lines.length, placement.rows);
  assert.match(lines[0], /\u{10EEEE}/u);
  assert.match(lines[0], /\x1b\[38;2;\d+;\d+;\d+m/);
  assert.equal(planKittyPlacement({ ...item, mimeType: "image/jpeg" }, 10, 5), undefined);
});

test("Kitty upload is a tmux DCS-wrapped virtual placement", async () => {
  const { planKittyPlacement, kittyUploadPayload } = await jiti.import("../extensions/image-preview/kitty.ts");
  const item = { data: tinyPng().toString("base64"), mimeType: "image/png", label: "shot.png" };
  const placement = planKittyPlacement(item, 10, 5);
  assert.ok(placement);
  const payload = kittyUploadPayload(item, placement);
  assert.ok(payload.startsWith("\x1bPtmux;"));
  assert.ok(payload.endsWith("\x1b\\"));
  assert.match(payload, new RegExp(`a=T,U=1,f=100,q=2,i=${placement.id},c=${placement.cols},r=${placement.rows}`));
  assert.match(payload, /\x1b\x1b_G/);
  assert.match(payload, /\x1b\x1b\\/);
});

test("pasted image path becomes a short token and is attached on submit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-image-token-")), path = join(dir, "clipboard.png");
  await writeFile(path, tinyPng());
  const hooks = new Map();
  let factory, editor;
  const tui = { requestRender() {}, terminal: { columns: 100, rows: 40 } };
  const keys = { matches: () => false, getKeys: () => [] };
  plugin.default({ on(name, fn) { hooks.set(name, fn); }, registerCommand() {}, registerShortcut() {} });
  const ctx = { mode: "tui", cwd: dir, ui: {
    getEditorComponent: () => factory,
    setEditorComponent(value) { factory = value; if (value) editor = value(tui, { borderColor: (text) => text }, keys); },
    setWidget() {}, notify() {},
  } };
  await hooks.get("session_start")({}, ctx);
  try {
    editor.setText("look ");
    editor.insertTextAtCursor(path);
    const draft = editor.getExpandedText();
    assert.ok(!draft.includes(path), "the temporary path must not stay in the draft");
    assert.match(draft, /\u{1F5BC}1/u);
    const token = draft.match(/\u{1F5BC}\d+/u)[0];
    const result = await hooks.get("input")({ text: `look ${token}`, source: "interactive" }, ctx);
    assert.equal(result.action, "transform");
    assert.equal(result.text, "look");
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].type, "image");
    assert.equal(result.images[0].mimeType, "image/png");
    assert.ok(result.images[0].data.length > 0);
  } finally { hooks.get("session_shutdown")({}, ctx); }
});
