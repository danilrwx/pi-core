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
