import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArgs } from "../lib/complete.js";
import {
  absolutePath, commitBlob, newCheckpointId, prune, restoreFile, snapshot,
  type CheckpointData, type CheckpointFile,
} from "./store.js";

const ENTRY = "pi-core:checkpoint";

interface StoredCheckpoint { data: CheckpointData; entryId: string }
interface Pending { builder: Builder; file: CheckpointFile; bytes?: Buffer }
interface Builder {
  sessionId: string;
  turnEntryId?: string;
  createdAt: string;
  files: Map<string, CheckpointFile>;
  skipped: Set<string>;
}

function loadCheckpoints(ctx: ExtensionContext): StoredCheckpoint[] {
  const result: StoredCheckpoint[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const data = entry.data as CheckpointData | undefined;
    if (!data || typeof data.id !== "string" || !Array.isArray(data.files)) continue;
    const files = data.files.filter((file): file is CheckpointFile =>
      Boolean(file) && typeof file.path === "string" && typeof file.existed === "boolean" &&
      (file.before === undefined || typeof file.before === "string"));
    result.push({ data: { ...data, files, skipped: Array.isArray(data.skipped) ? data.skipped.filter((item) => typeof item === "string") : [] }, entryId: entry.id });
  }
  return result;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join(" ");
}
function label(ctx: ExtensionContext, checkpoint: StoredCheckpoint): string {
  const target = checkpoint.data.turnEntryId ? ctx.sessionManager.getEntry(checkpoint.data.turnEntryId) : undefined;
  let text = "";
  if (target?.type === "message" && target.message.role === "user") text = textOf(target.message.content);
  text = text.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 90) : checkpoint.data.safety ? "before restore" : "turn";
}
function display(checkpoint: StoredCheckpoint, index: number, ctx: ExtensionContext): string {
  const time = checkpoint.data.createdAt.slice(11, 16);
  return `${index + 1}. ${time} · ${label(ctx, checkpoint)} · ${checkpoint.data.files.length} file${checkpoint.data.files.length === 1 ? "" : "s"}${checkpoint.data.safety ? " · safety" : ""}`;
}

async function restoreTo(context: ExtensionCommandContext, target: StoredCheckpoint, all: StoredCheckpoint[], append: (customType: string, data: unknown) => void): Promise<{ restored: number; deleted: number; skipped: number }> {
  const index = all.findIndex((item) => item.entryId === target.entryId);
  if (index === -1) return { restored: 0, deleted: 0, skipped: 0 };
  const selection = all.slice(index).reverse();
  const paths = new Set<string>();
  for (const checkpoint of selection) for (const file of checkpoint.data.files) paths.add(file.path);

  // Capture the current state first so a restore itself can be undone.
  const safetyFiles: CheckpointFile[] = [];
  for (const path of paths) {
    const current = await snapshot(context.cwd, path);
    if ("file" in current) {
      if (current.file.existed && current.file.before && current.bytes) await commitBlob(current.file.before, current.bytes);
      safetyFiles.push(current.file);
    }
  }
  if (safetyFiles.length) {
    append(ENTRY, {
      id: newCheckpointId(), turnEntryId: context.sessionManager.getLeafEntry()?.id,
      createdAt: new Date().toISOString(), files: safetyFiles, skipped: [], safety: true,
    } satisfies CheckpointData);
  }

  let restored = 0, deleted = 0, skipped = 0;
  for (const checkpoint of selection) {
    for (const file of checkpoint.data.files) {
      try {
        const result = await restoreFile(context.cwd, file);
        if (result === "restored") restored++;
        else if (result === "deleted") deleted++;
        else skipped++;
      } catch { skipped++; }
    }
  }
  return { restored, deleted, skipped };
}

export default function checkpoint(pi: ExtensionAPI) {
  let enabled = process.env.PI_CHECKPOINT !== "0";
  let builder: Builder | undefined;
  const pending = new Map<string, Pending>();

  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  function ensureBuilder(ctx: ExtensionContext): Builder {
    const id = sessionId(ctx);
    if (!builder || builder.sessionId !== id) {
      builder = {
        sessionId: id, turnEntryId: ctx.sessionManager.getLeafEntry()?.id,
        createdAt: new Date().toISOString(), files: new Map(), skipped: new Set(),
      };
    }
    return builder;
  }
  function reset() { builder = undefined; pending.clear(); }

  pi.on("turn_start", (_event, ctx) => { if (enabled) ensureBuilder(ctx); });
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "propose_change") return;
    const input = event.input as { path?: unknown; file?: unknown };
    const raw = typeof input.path === "string" ? input.path : typeof input.file === "string" ? input.file : undefined;
    if (!raw) return;
    const path = absolutePath(ctx.cwd, raw);
    const current = ensureBuilder(ctx);
    if (current.files.has(path)) return;
    for (const item of pending.values()) if (item.file.path === path) return;
    const snap = await snapshot(ctx.cwd, path);
    if ("error" in snap) { current.skipped.add(`${path}: ${snap.error}`); return; }
    pending.set(event.toolCallId, { builder: current, file: snap.file, ...(snap.bytes ? { bytes: snap.bytes } : {}) });
  });
  pi.on("tool_result", async (event) => {
    const item = pending.get(event.toolCallId);
    if (!item) return;
    pending.delete(event.toolCallId);
    const accepted = event.toolName !== "propose_change" || (event.details as { status?: string } | undefined)?.status === "accepted";
    if (event.isError || !accepted) return;
    if (item.builder.files.has(item.file.path)) return;
    try {
      if (item.file.existed && item.file.before && item.bytes) await commitBlob(item.file.before, item.bytes);
      item.builder.files.set(item.file.path, item.file);
    } catch (error) {
      item.builder.skipped.add(`${item.file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!builder) return;
    const current = builder;
    builder = undefined;
    pending.clear();
    if (!current.files.size) return;
    pi.appendEntry(ENTRY, {
      id: newCheckpointId(), turnEntryId: current.turnEntryId, createdAt: current.createdAt,
      files: [...current.files.values()], skipped: [...current.skipped],
    } satisfies CheckpointData);
  });
  pi.on("session_start", (_event, _ctx) => {
    reset();
    if (enabled) void prune().catch(() => {});
  });
  pi.on("session_tree", () => reset());
  pi.on("session_shutdown", () => reset());

  pi.on("session_before_fork", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;
    const all = loadCheckpoints(ctx);
    const target = all.find((item) => item.data.turnEntryId === event.entryId && !item.data.safety);
    if (!target) return;
    const choice = await ctx.ui.confirm("Restore code checkpoint?", `${target.data.files.length} file${target.data.files.length === 1 ? "" : "s"} will be restored to before: ${label(ctx, target)}`);
    if (!choice) return;
    const result = await restoreTo(ctx as ExtensionCommandContext, target, all, (type, data) => pi.appendEntry(type, data));
    ctx.ui.notify(`Checkpoint: restored ${result.restored}, deleted ${result.deleted}, skipped ${result.skipped}.`, result.skipped ? "warning" : "info");
  });

  pi.registerCommand("checkpoint", {
    description: "Code checkpoints: /checkpoint list | restore <n|id> | on | off",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["list", "restore", "on", "off"], {},
      { list: "show checkpoints", restore: "restore code before a checkpoint", on: "enable checkpoints", off: "disable checkpoints" }),
    handler: async (args, context) => {
      const [action = "list", value] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "off" || action === "on") {
        enabled = action === "on"; reset();
        context.ui.notify(`Checkpoints ${enabled ? "on" : "off"}.`, "info"); return;
      }
      const all = loadCheckpoints(context);
      if (action === "restore") {
        if (!enabled) { context.ui.notify("Checkpoints are off; /checkpoint on first.", "warning"); return; }
        const target = value && /^\d+$/.test(value)
          ? all[Number(value) - 1]
          : all.find((item) => item.data.id === value);
        if (!target) { context.ui.notify(value ? `Checkpoint ${value} not found.` : "Usage: /checkpoint restore <n|id>", "warning"); return; }
        if (!context.hasUI) { context.ui.notify("Restore needs the interactive UI.", "warning"); return; }
        if (!await context.ui.confirm("Restore code checkpoint?", `${display(target, all.indexOf(target), context)}\nRestore ${target.data.files.length} file(s)?`)) return;
        const result = await restoreTo(context, target, all, (type, data) => pi.appendEntry(type, data));
        context.ui.notify(`Checkpoint: restored ${result.restored}, deleted ${result.deleted}, skipped ${result.skipped}.`, result.skipped ? "warning" : "info");
        return;
      }
      if (!all.length) { context.ui.notify("No code checkpoints yet.", "info"); return; }
      context.ui.notify(all.map((item, index) => display(item, index, context)).join("\n"), "info");
    },
  });

  pi.registerCommand("rewind", {
    description: "Restore code and optionally navigate conversation to a checkpoint",
    handler: async (_args, context) => {
      if (!enabled) { context.ui.notify("Checkpoints are off; /checkpoint on first.", "warning"); return; }
      const all = loadCheckpoints(context);
      if (!all.length) { context.ui.notify("No code checkpoints yet.", "info"); return; }
      if (!context.hasUI) { context.ui.notify("Rewind needs the interactive UI.", "warning"); return; }
      const choice = await context.ui.select("Rewind to", all.map((item, index) => display(item, index, context)));
      if (!choice) return;
      const index = Number(choice.split(".")[0]) - 1;
      const target = all[index];
      if (!target) return;
      if (!await context.ui.confirm("Restore code?", `${target.data.files.length} file(s) will be restored to before: ${label(context, target)}`)) return;
      const result = await restoreTo(context, target, all, (type, data) => pi.appendEntry(type, data));
      context.ui.notify(`Checkpoint: restored ${result.restored}, deleted ${result.deleted}, skipped ${result.skipped}.`, result.skipped ? "warning" : "info");
      if (!target.data.turnEntryId) return;
      if (await context.ui.confirm("Rewind conversation too?", "Navigate the session tree to this point?")) {
        await context.navigateTree(target.data.turnEntryId, { summarize: false });
      }
    },
  });
}
