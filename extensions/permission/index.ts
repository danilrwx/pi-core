/**
 * Permission Extension for pi-coding-agent
 *
 * Implements layered permission control.
 *
 * Interactive mode:
 *   Use `/permission` command to view or change the level.
 *   Use `/permission-mode` to switch between ask vs block.
 *   When changing via command, you'll be asked: session-only or global?
 *
 * Print mode (pi -p):
 *   Set PI_PERMISSION_LEVEL env var: PI_PERMISSION_LEVEL=medium pi -p "task"
 *   Operations beyond level will exit with helpful error message.
 *   Use PI_PERMISSION_LEVEL=bypassed for CI/containers (dangerous!)
 *
 * Levels:
 *   minimal - Read-only mode (default)
 *             ✅ Read files, ls, grep, git status/log/diff
 *             ❌ No file modifications, no commands with side effects
 *
 *   low    - File operations only
 *            ✅ Create/edit files in project directory
 *            ❌ No package installs, no git commits, no builds
 *
 *   medium - Development operations
 *            ✅ npm/pip install, git commit/pull, make/build
 *            ❌ No git push, no sudo, no production changes
 *
 *   high   - Full operations
 *            ✅ git push, deployments, scripts
 *            ⚠️ Still prompts for destructive commands (rm -rf, etc.)
 *
 * Usage:
 *   pi --extension ./permission-hook.ts
 *
 * Or add to ~/.pi/agent/extensions/ or .pi/extensions/ for automatic loading.
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type PermissionLevel,
  type PermissionMode,
  LEVELS,
  LEVEL_INDEX,
  LEVEL_INFO,
  LEVEL_ALLOWED_DESC,
  PERMISSION_MODES,
  PERMISSION_MODE_INFO,
  loadGlobalPermission,
  saveGlobalPermission,
  loadGlobalPermissionMode,
  saveGlobalPermissionMode,
  classifyCommand,
  loadPermissionConfig,
  savePermissionConfig,
  invalidateConfigCache,
} from "./permission-core.js";

export {
  type PermissionLevel,
  type PermissionMode,
  LEVELS,
  LEVEL_INFO,
  PERMISSION_MODES,
  PERMISSION_MODE_INFO,
};

function playPermissionSound(): void {
  const isMac = process.platform === "darwin";

  if (isMac) {
    exec('afplay /System/Library/Sounds/Funk.aiff 2>/dev/null', (err) => {
      if (err) process.stdout.write("\x07");
    });
  } else {
    process.stdout.write("\x07");
  }
}

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const UI_TEXT = {
  statusIcon: "🔒",
  dangerousIcon: "⚠️",
  allowOnce: "Allow once",
  cancel: "Cancel",
  sessionOnly: "Session only",
  global: "Global (persists)",
  saveLevelPrompt: "Save permission level to:",
  saveModePrompt: "Save permission mode to:",
  levelSelectPrompt: "Select permission level",
  modeSelectPrompt: "Select permission mode",
  saveScopePrompt: "Save to:",
} as const;

const LEVEL_COLORS: Record<PermissionLevel, string> = {
  minimal: RED,
  low: YELLOW,
  medium: CYAN,
  high: GREEN,
  bypassed: DIM,
};

function getStatusText(level: PermissionLevel): string {
  const info = LEVEL_INFO[level];
  const color = LEVEL_COLORS[level];
  return `${UI_TEXT.statusIcon} ${BOLD}${color}${info.label}${RESET} ${DIM}· ${info.desc}${RESET}`;
}

function formatLevelSummary(level: PermissionLevel): string {
  const info = LEVEL_INFO[level];
  return `${info.label} · ${info.desc}`;
}

function formatModeSummary(mode: PermissionMode): string {
  const info = PERMISSION_MODE_INFO[mode];
  return `${info.label} · ${info.desc}`;
}

function formatChoiceLabel(label: string, desc: string, isCurrent: boolean): string {
  return isCurrent ? `${label}: ${desc} ✓` : `${label}: ${desc}`;
}

function getPiModeFromArgv(argv: string[] = process.argv): string | undefined {
  const eq = argv.find((a) => a.startsWith("--mode="));
  if (eq) return eq.slice("--mode=".length);

  const idx = argv.indexOf("--mode");
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];

  return undefined;
}

function hasInteractiveUI(ctx: any): boolean {
  if (!ctx?.hasUI) return false;

  const mode = getPiModeFromArgv()?.toLowerCase();
  if (mode && mode !== "interactive") return false;

  return true;
}

function isQuietMode(ctx: any): boolean {
  if (ctx?.quiet || ctx?.isQuiet) return true;
  if (ctx?.ui?.quiet || ctx?.ui?.isQuiet) return true;
  if (ctx?.settings?.quietStartup || ctx?.settings?.quiet) return true;

  const envQuiet = process.env.PI_QUIET?.toLowerCase();
  if (envQuiet && ["1", "true", "yes"].includes(envQuiet)) return true;

  if (process.argv.includes("--quiet") || process.argv.includes("-q")) return true;

  return isQuietStartupFromSettings();
}

function isQuietStartupFromSettings(): boolean {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { quietStartup?: boolean };
    return settings.quietStartup === true;
  } catch {
    return false;
  }
}

export interface PermissionState {
  currentLevel: PermissionLevel;
  isSessionOnly: boolean;
  permissionMode: PermissionMode;
  isModeSessionOnly: boolean;
}

export function createInitialState(): PermissionState {
  return {
    currentLevel: "minimal",
    isSessionOnly: false,
    permissionMode: "ask",
    isModeSessionOnly: false,
  };
}

function setLevel(
  state: PermissionState,
  level: PermissionLevel,
  saveGlobally: boolean,
  ctx: any,
): void {
  state.currentLevel = level;
  state.isSessionOnly = !saveGlobally;
  if (saveGlobally) {
    saveGlobalPermission(level);
  }
  if (ctx.ui?.setStatus) {
    ctx.ui.setStatus("authority", getStatusText(level));
  }
}

function setMode(
  state: PermissionState,
  mode: PermissionMode,
  saveGlobally: boolean,
  ctx: any,
): void {
  state.permissionMode = mode;
  state.isModeSessionOnly = !saveGlobally;
  if (saveGlobally) {
    saveGlobalPermissionMode(mode);
  }
}

async function handleConfigSubcommand(
  _state: PermissionState,
  args: string,
  ctx: any,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const action = parts[0];

  if (action === "show") {
    const config = loadPermissionConfig();
    const configStr = JSON.stringify(config, null, 2);
    ctx.ui.notify(`Permission Config:\n${configStr}`, "info");
    return;
  }

  if (action === "reset") {
    savePermissionConfig({});
    invalidateConfigCache();
    ctx.ui.notify("Permission config reset to defaults", "info");
    return;
  }

  const help = `Permission config

Usage:
  /permission config show
  /permission config reset

Edit ~/.pi/agent/settings.json directly for full control:

{
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "tmux show-*"],
      "medium": ["tmux *", "screen *"],
      "high": ["rm -rf *"],
      "dangerous": ["dd if=* of=/dev/*"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" }
    ]
  }
}`;

  ctx.ui.notify(help, "info");
}

export async function handlePermissionCommand(
  state: PermissionState,
  args: string,
  ctx: any,
): Promise<void> {
  const arg = args.trim().toLowerCase();

  if (arg === "config" || arg.startsWith("config ")) {
    const configArgs = arg.replace(/^config\s*/, "");
    await handleConfigSubcommand(state, configArgs, ctx);
    return;
  }

  if (arg && LEVELS.includes(arg as PermissionLevel)) {
    const newLevel = arg as PermissionLevel;

    if (hasInteractiveUI(ctx)) {
      const scope = await ctx.ui.select(UI_TEXT.saveLevelPrompt, [
        UI_TEXT.sessionOnly,
        UI_TEXT.global,
      ]);
      if (!scope) return;

      setLevel(state, newLevel, scope === UI_TEXT.global, ctx);
      const saveMsg = scope === UI_TEXT.global ? " (saved globally)" : " (session only)";
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
    } else {
      setLevel(state, newLevel, false, ctx);
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}`, "info");
    }
    return;
  }

  if (!hasInteractiveUI(ctx)) {
    ctx.ui.notify(`Current permission: ${formatLevelSummary(state.currentLevel)}`, "info");
    return;
  }

  const options = LEVELS.map((level) => {
    const info = LEVEL_INFO[level];
    return formatChoiceLabel(info.label, info.desc, level === state.currentLevel);
  });

  const choice = await ctx.ui.select(UI_TEXT.levelSelectPrompt, options);
  if (!choice) return;

  const selectedLabel = choice.split(":")[0].trim();
  const newLevel = LEVELS.find((l) => LEVEL_INFO[l].label === selectedLabel);
  if (!newLevel || newLevel === state.currentLevel) return;

  const scope = await ctx.ui.select(UI_TEXT.saveScopePrompt, [UI_TEXT.sessionOnly, UI_TEXT.global]);
  if (!scope) return;

  setLevel(state, newLevel, scope === UI_TEXT.global, ctx);
  const saveMsg = scope === UI_TEXT.global ? " (saved globally)" : " (session only)";
  ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
}

export async function handlePermissionModeCommand(
  state: PermissionState,
  args: string,
  ctx: any,
): Promise<void> {
  const arg = args.trim().toLowerCase();

  if (arg && PERMISSION_MODES.includes(arg as PermissionMode)) {
    const newMode = arg as PermissionMode;

    if (hasInteractiveUI(ctx)) {
      const scope = await ctx.ui.select(UI_TEXT.saveModePrompt, [
        UI_TEXT.sessionOnly,
        UI_TEXT.global,
      ]);
      if (!scope) return;

      setMode(state, newMode, scope === UI_TEXT.global, ctx);
      const saveMsg = scope === UI_TEXT.global ? " (saved globally)" : " (session only)";
      ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
    } else {
      setMode(state, newMode, false, ctx);
      ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}`, "info");
    }
    return;
  }

  if (!hasInteractiveUI(ctx)) {
    ctx.ui.notify(`Current permission mode: ${formatModeSummary(state.permissionMode)}`, "info");
    return;
  }

  const options = PERMISSION_MODES.map((mode) => {
    const info = PERMISSION_MODE_INFO[mode];
    return formatChoiceLabel(info.label, info.desc, mode === state.permissionMode);
  });

  const choice = await ctx.ui.select(UI_TEXT.modeSelectPrompt, options);
  if (!choice) return;

  const selectedLabel = choice.split(":")[0].trim();
  const newMode = PERMISSION_MODES.find((m) => PERMISSION_MODE_INFO[m].label === selectedLabel);
  if (!newMode || newMode === state.permissionMode) return;

  const scope = await ctx.ui.select(UI_TEXT.saveScopePrompt, [UI_TEXT.sessionOnly, UI_TEXT.global]);
  if (!scope) return;

  setMode(state, newMode, scope === UI_TEXT.global, ctx);
  const saveMsg = scope === UI_TEXT.global ? " (saved globally)" : " (session only)";
  ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
}

export function handleSessionStart(state: PermissionState, ctx: any): void {
  const envLevel = process.env.PI_PERMISSION_LEVEL?.toLowerCase();
  if (envLevel && LEVELS.includes(envLevel as PermissionLevel)) {
    state.currentLevel = envLevel as PermissionLevel;
  } else {
    const globalLevel = loadGlobalPermission();
    if (globalLevel) {
      state.currentLevel = globalLevel;
    }
  }

  if (ctx.hasUI) {
    const globalMode = loadGlobalPermissionMode();
    if (globalMode) {
      state.permissionMode = globalMode;
    }
  }

  if (ctx.hasUI) {
    if (ctx.ui?.setStatus) {
      ctx.ui.setStatus("authority", getStatusText(state.currentLevel));
    }
    if (state.currentLevel === "bypassed") {
      ctx.ui.notify("⚠️ Permission bypassed - all checks disabled!", "warning");
    } else if (!isQuietMode(ctx)) {
      ctx.ui.notify(`Permission: ${formatLevelSummary(state.currentLevel)} (use /permission to change)`, "info");
    }
    if (state.permissionMode === "block") {
      ctx.ui.notify("Permission mode: Block (use /permission-mode to change)", "info");
    }
  }
}

export async function handleBashToolCall(
  state: PermissionState,
  command: string,
  ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
  if (state.currentLevel === "bypassed") return undefined;

  const classification = classifyCommand(command);

  if (classification.dangerous) {
    if (!hasInteractiveUI(ctx)) {
      return {
        block: true,
        reason: `Dangerous command requires confirmation: ${command}
User can re-run with: PI_PERMISSION_LEVEL=bypassed pi -p "..."`,
      };
    }

    if (state.permissionMode === "block") {
      return {
        block: true,
        reason: `Blocked by permission mode (block). Dangerous command: ${command}
Use /permission-mode ask to enable confirmations.`,
      };
    }

    playPermissionSound();
    const choice = await ctx.ui.select(`${UI_TEXT.dangerousIcon} Dangerous command`, [UI_TEXT.allowOnce, UI_TEXT.cancel]);

    if (choice !== UI_TEXT.allowOnce) {
      return { block: true, reason: "Cancelled" };
    }
    return undefined;
  }

  const requiredIndex = LEVEL_INDEX[classification.level];
  const currentIndex = LEVEL_INDEX[state.currentLevel];

  if (requiredIndex <= currentIndex) return undefined;

  const requiredLevel = classification.level;
  const requiredInfo = LEVEL_INFO[requiredLevel];

  if (!hasInteractiveUI(ctx)) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). Command: ${command}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`,
    };
  }

  if (state.permissionMode === "block") {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}, mode: block). Command: ${command}
Requires ${requiredInfo.label}. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
Use /permission ${requiredLevel} or /permission-mode ask to enable prompts.`,
    };
  }

  playPermissionSound();
  const choice = await ctx.ui.select(`Requires ${requiredInfo.label}`, [
    UI_TEXT.allowOnce,
    `Allow all (${requiredInfo.label})`,
    UI_TEXT.cancel,
  ]);

  if (choice === UI_TEXT.allowOnce) return undefined;

  if (choice === `Allow all (${requiredInfo.label})`) {
    setLevel(state, requiredLevel, true, ctx);
    ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}

export interface WriteToolCallOptions {
  state: PermissionState;
  toolName: string;
  filePath: string;
  ctx: any;
}

export async function handleWriteToolCall(
  opts: WriteToolCallOptions,
): Promise<{ block: true; reason: string } | undefined> {
  const { state, toolName, filePath, ctx } = opts;

  if (state.currentLevel === "bypassed") return undefined;

  if (LEVEL_INDEX[state.currentLevel] >= LEVEL_INDEX.low) return undefined;

  const action = toolName === "write" ? "Write" : "Edit";
  const message = `Requires Low: ${action} ${filePath}`;

  if (!hasInteractiveUI(ctx)) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). ${action}: ${filePath}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=low pi -p "..."`,
    };
  }

  if (state.permissionMode === "block") {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}, mode: block). ${action}: ${filePath}
Requires Low. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
Use /permission low or /permission-mode ask to enable prompts.`,
    };
  }

  playPermissionSound();
  const choice = await ctx.ui.select(message, [UI_TEXT.allowOnce, "Allow all (Low)", UI_TEXT.cancel]);

  if (choice === UI_TEXT.allowOnce) return undefined;

  if (choice === "Allow all (Low)") {
    setLevel(state, "low", true, ctx);
    ctx.ui.notify("Permission → Low (saved globally)", "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  pi.registerCommand("permission", {
    description: "View or change permission level",
    handler: (args, ctx) => handlePermissionCommand(state, args, ctx),
  });

  pi.registerCommand("permission-mode", {
    description: "Set permission prompt mode (ask or block)",
    handler: (args, ctx) => handlePermissionModeCommand(state, args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    handleSessionStart(state, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return handleBashToolCall(state, event.input.command as string, ctx);
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      return handleWriteToolCall({
        state,
        toolName: event.toolName,
        filePath: event.input.path as string,
        ctx,
      });
    }

    return undefined;
  });
}
