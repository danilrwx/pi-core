import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text, getCapabilities, matchesKey } from "@earendil-works/pi-tui";
import { imageReferences, previewData, previewFile, removeReference, type PreviewImage } from "./images.js";

export default function imagePreview(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let editor: CustomEditor | undefined;
  let draft: PreviewImage[] = [], returned: PreviewImage[] = [];
  let timer: NodeJS.Timeout | undefined;
  let epoch = 0;
  let lastSignature = "", loadingSignature: string | undefined;
  let ownFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let warnedInline = false;

  function inlineImages(): boolean { return Boolean(getCapabilities().images); }

  function external(path: string) {
    const kitty = Boolean(process.env.KITTY_WINDOW_ID) || /kitty/i.test(process.env.TERM_PROGRAM ?? "") || /kitty/i.test(process.env.TERM ?? "");
    const fallback = () => {
      const child = spawn("xdg-open", [path], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); child.unref();
    };
    if (!kitty) { fallback(); return; }
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    const child = spawn("kitty", ["--title", `pi: ${basename(path)}`, "sh", "-c", 'exec kitty +kitten icat --hold "$1"', "sh", path], { detached: true, stdio: "ignore", env });
    child.on("error", fallback);
    child.unref();
  }
  async function openExternal(item: PreviewImage) {
    if (item.path) { external(item.path); return; }
    const ext = item.mimeType === "image/png" ? ".png" : item.mimeType === "image/jpeg" ? ".jpg" : item.mimeType === "image/gif" ? ".gif" : ".webp";
    const path = join(tmpdir(), `pi-image-${randomUUID()}${ext}`);
    await writeFile(path, Buffer.from(item.data, "base64"), { mode: 0o600 });
    external(path);
  }

  function widget() {
    if (!ctx || ctx.mode !== "tui") return;
    const items = draft.length ? draft.slice(0, 3) : returned.slice(-1);
    if (!items.length) { ctx.ui.setWidget("image-preview", undefined); return; }
    ctx.ui.setWidget("image-preview", (_tui, theme) => {
      const box = new Container();
      box.addChild(new Text(theme.fg("muted", `${draft.length ? "Attachments" : "Latest tool image"} · Alt+I view / remove${inlineImages() ? "" : " · inline off (tmux)"}`), 0, 0));
      for (const item of items) {
        box.addChild(new Text(item.label, 0, 0));
        box.addChild(new Image(item.data, item.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 28, maxHeightCells: 5, filename: item.label }));
      }
      return box;
    }, { placement: "aboveEditor" });
  }
  function changed() {
    const generation = epoch;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = undefined;
      const context = ctx;
      if (!context || !editor) return;
      const refs = imageReferences(editor.getExpandedText(), context.cwd).slice(0, 3);
      const signature = refs.map((ref) => ref.path).join("\0");
      if (signature === lastSignature || signature === loadingSignature) return;
      loadingSignature = signature;
      const results = await Promise.allSettled(refs.map((ref) => previewFile(ref.path)));
      if (loadingSignature === signature) loadingSignature = undefined;
      if (generation !== epoch || !editor || imageReferences(editor.getExpandedText(), context.cwd).slice(0, 3).map((ref) => ref.path).join("\0") !== signature) return;
      lastSignature = signature;
      draft = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      widget();
    }, 100);
  }
  async function gallery(context: ExtensionContext) {
    if (context.mode !== "tui") return;
    const generation = epoch;
    const refs = editor ? imageReferences(editor.getExpandedText(), context.cwd).slice(0, 3) : [];
    const refreshed = await Promise.allSettled(refs.map((ref) => previewFile(ref.path)));
    if (generation !== epoch) return;
    draft = refreshed.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    lastSignature = refs.map((ref) => ref.path).join("\0");
    widget();
    if (!draft.length && !returned.length) { context.ui.notify("No image previews yet. Paste an image, or read/generate one.", "info"); return; }
    await context.ui.custom<void>((tui, theme, _keys, done) => {
      let index = 0;
      let shown: Image | undefined;
      let chosen: PreviewImage | undefined;
      return {
        render(width) {
          const items = [...draft, ...returned];
          if (!items.length) { done(); return []; }
          index = Math.min(index, items.length - 1);
          const item = items[index];
          if (chosen !== item) {
            chosen = item;
            shown = new Image(item.data, item.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 90, maxHeightCells: 25, filename: item.label });
          }
          const hint = inlineImages() ? "" : " · o open in Kitty";
          return [...new Text(`${index + 1}/${items.length} · ${item.label}\n←/→ switch · d remove draft attachment${hint} · Esc close`, 0, 0).render(width), ...shown!.render(width)];
        },
        handleInput(data) {
          if (matchesKey(data, "escape") || data === "q") { done(); return; }
          const items = [...draft, ...returned];
          if (matchesKey(data, "right")) index = (index + 1) % items.length;
          if (matchesKey(data, "left")) index = Math.max(0, index - 1);
          if (data === "o" || (matchesKey(data, "return") && !inlineImages())) { const item = items[index]; if (item) void openExternal(item); }
          if (data === "d") {
            const item = [...draft, ...returned][index];
            if (item?.path && draft.includes(item) && editor) {
              const text = editor.getExpandedText();
              const ref = imageReferences(text, context.cwd).find((ref) => ref.path === item.path);
              if (ref) editor.setText(removeReference(text, ref));
              draft = draft.filter((image) => image !== item); widget();
            }
          }
          tui.requestRender();
        },
        invalidate() { shown?.invalidate(); },
      };
    }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
  }
  pi.on("session_start", (_event, context) => {
    ctx = context;
    if (context.mode !== "tui") return;
    if (!inlineImages() && !warnedInline) {
      warnedInline = true;
      context.ui.notify("Inline images are unavailable inside tmux. Alt+I → o opens the selected image in a Kitty window.", "info");
    }
    if (context.ui.getEditorComponent()) {
      context.ui.notify("Image gallery is available, but automatic draft previews are disabled to preserve another custom editor.", "info");
      return;
    }
    ownFactory = (tui, theme, keys) => {
      class PreviewEditor extends CustomEditor {
        handleInput(data: string) { super.handleInput(data); changed(); }
        insertTextAtCursor(text: string) { super.insertTextAtCursor(text); changed(); }
        setText(text: string) { super.setText(text); changed(); }
      }
      editor = new PreviewEditor(tui, theme, keys);
      return editor;
    };
    context.ui.setEditorComponent(ownFactory);
  });
  pi.on("tool_result", async (event) => {
    if (ctx?.mode !== "tui") return;
    const generation = epoch;
    let added = false;
    for (const part of event.content.filter((part) => part.type === "image").slice(0, 2)) {
      if (part.type !== "image") continue;
      const image = await previewData(part.data, part.mimeType, `${event.toolName} image`);
      if (generation !== epoch) return;
      if (image) { returned.push(image); added = true; }
    }
    returned = returned.slice(-8);
    if (added) widget();
  });
  pi.registerCommand("images", { description: "View draft and recent tool images (Alt+I while composing)", handler: (_args, context) => gallery(context) });
  pi.registerShortcut("alt+i", { description: "Preview images / remove draft attachments", handler: gallery });
  pi.on("session_shutdown", () => {
    epoch++; clearTimeout(timer); lastSignature = ""; loadingSignature = undefined;
    if (ctx?.mode === "tui") {
      ctx.ui.setWidget("image-preview", undefined);
      if (ctx.ui.getEditorComponent() === ownFactory) ctx.ui.setEditorComponent(undefined);
    }
    draft = []; returned = []; editor = undefined; ctx = undefined;
  });
}
