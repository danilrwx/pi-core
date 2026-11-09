/**
 * Local RTK command rewriting for pi.
 *
 * RTK rewrites shell commands to compact equivalents before they execute.
 * This is intentionally a small, fail-open shim: every error path runs the
 * original command. See THIRD_PARTY.md for the reviewed upstream plugins.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { forgetOriginalCommand, rememberOriginalCommand } from "../lib/original-command.js";
import {
  MIN_RTK_VERSION,
  acceptableRewrite,
  atLeastVersion,
  envDisabled,
  parseVersion,
  shouldSkipRewrite,
} from "./rewrite.js";

const REWRITE_TIMEOUT_MS = 2_000;
const VERSION_TIMEOUT_MS = 2_000;
const RETRY_UNAVAILABLE_MS = 30_000;
const STATUS_KEY = "rtk";

type ExecResult = { code: number; stdout: string; stderr?: string; killed?: boolean };
type Exec = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;

interface Stats {
  calls: number;
  rewritten: number;
  passed: number;
  errors: number;
}

const stats: Stats = { calls: 0, rewritten: 0, passed: 0, errors: 0 };
let enabled = true;
let available: boolean | undefined;
let version: string | null = null;
let lastCheck = 0;
let warningShown = false;
let checking: Promise<boolean> | undefined;

function hasUI(ctx: ExtensionContext | undefined): boolean {
  return Boolean(ctx?.hasUI);
}

function notify(ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" = "info"): void {
  if (!hasUI(ctx)) return;
  try { ctx!.ui.notify(text, level); } catch { /* UI must never break rewriting. */ }
}

function setStatus(ctx: ExtensionContext | undefined): void {
  if (!ctx?.hasUI) return;
  const text = !enabled ? "rtk off" : available === false ? "rtk ⚠" : undefined;
  try { ctx.ui.setStatus(STATUS_KEY, text); } catch { /* Footer is best effort. */ }
}

async function probe(pi: ExtensionAPI, ctx: ExtensionContext | undefined, force = false): Promise<boolean> {
  if (!force && available !== undefined) {
    if (available || Date.now() - lastCheck < RETRY_UNAVAILABLE_MS) return available;
  }
  if (checking) return checking;
  checking = (async () => {
    let result: ExecResult | undefined;
    try {
      result = await (pi.exec as Exec)("rtk", ["--version"], { timeout: VERSION_TIMEOUT_MS });
    } catch { /* Missing/unexecutable binary. */ }
    lastCheck = Date.now();
    const raw = result?.code === 0 ? result.stdout.trim() : "";
    const parsed = parseVersion(raw);
    if (!raw || !parsed || !atLeastVersion(parsed, MIN_RTK_VERSION)) {
      available = false;
      version = raw || null;
      if (!warningShown) {
        warningShown = true;
        notify(ctx, raw
          ? `RTK ${raw} is too old; need >= ${MIN_RTK_VERSION.join(".")}. Commands run unchanged.`
          : "RTK is not available on PATH. Shell commands run unchanged.", "warning");
      }
      setStatus(ctx);
      return false;
    }
    available = true;
    version = raw;
    warningShown = false;
    setStatus(ctx);
    return true;
  })().finally(() => { checking = undefined; });
  return checking;
}

async function rewrite(pi: ExtensionAPI, command: string, signal: AbortSignal | undefined, ctx: ExtensionContext | undefined): Promise<string | undefined> {
  if (!enabled || envDisabled() || shouldSkipRewrite(command)) return;
  if (!(await probe(pi, ctx))) return;
  let result: ExecResult | undefined;
  try {
    result = await (pi.exec as Exec)("rtk", ["rewrite", command], {
      timeout: REWRITE_TIMEOUT_MS,
      signal,
    });
  } catch {
    available = false;
    lastCheck = Date.now();
    setStatus(ctx);
    return;
  }
  if (!result || result.killed) return;
  // Exit 3 means "rewritten, but the original has an ask rule". We do not
  // enforce RTK's permission verdict here; our own permission layer still sees
  // the rewritten command.
  if (result.code !== 0 && result.code !== 3) return;
  return acceptableRewrite(command, result.stdout);
}

function statusText(): string {
  const state = !enabled ? "off" : available === false ? "unavailable" : "on";
  const versionText = version ? ` · ${version}` : "";
  return [
    `RTK: ${state}${versionText}`,
    `${stats.calls} calls · ${stats.rewritten} rewritten · ${stats.passed} passed${stats.errors ? ` · ${stats.errors} errors` : ""}`,
    "Bypass one command with RTK_DISABLED=1; toggle with /rtk on|off.",
  ].join("\n");
}

export default function rtkExtension(pi: ExtensionAPI): void {
  const localBash = createLocalBashOperations();

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    stats.calls = stats.rewritten = stats.passed = stats.errors = 0;
    warningShown = false;
    available = undefined;
    version = null;
    checking = undefined;
    await probe(pi, ctx, true);
    setStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch { /* no UI */ }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    // A tool called from codemode expects the exact output it asked for.
    if (event.parentToolCallId) return;
    const original = event.input.command;
    if (typeof original !== "string") return;
    rememberOriginalCommand(event.toolCallId, original);
    stats.calls++;
    try {
      const next = await rewrite(pi, original, ctx.signal, ctx);
      if (next) {
        event.input.command = next;
        stats.rewritten++;
      } else {
        stats.passed++;
      }
    } catch {
      stats.errors++;
      // Fail open: the original command is already in the input.
    }
  });

  pi.on("tool_result", (event) => {
    forgetOriginalCommand(event.toolCallId);
  });

  pi.on("user_bash", async (event, ctx) => {
    if (event.excludeFromContext) return;
    stats.calls++;
    try {
      const next = await rewrite(pi, event.command, ctx.signal, ctx);
      if (!next) { stats.passed++; return; }
      stats.rewritten++;
      return {
        operations: {
          exec: (_command, cwd, options) => localBash.exec(next, cwd, options),
        },
      };
    } catch {
      stats.errors++;
      return;
    }
  });

  pi.registerCommand("rtk", {
    description: "Control local RTK command rewriting: /rtk on|off|status",
    getArgumentCompletions: (prefix) => {
      const choices = [
        { value: "on", label: "on", description: "enable command rewriting" },
        { value: "off", label: "off", description: "disable command rewriting" },
        { value: "status", label: "status", description: "show RTK state and session stats" },
      ];
      const lower = prefix.toLowerCase();
      const items = choices.filter((choice) => choice.value.startsWith(lower));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === "status") {
        await probe(pi, ctx);
        notify(ctx, statusText());
        return;
      }
      if (arg === "on" || arg === "enable") {
        enabled = true;
        await probe(pi, ctx);
        setStatus(ctx);
        notify(ctx, "RTK rewriting enabled");
        return;
      }
      if (arg === "off" || arg === "disable") {
        enabled = false;
        setStatus(ctx);
        notify(ctx, "RTK rewriting disabled");
        return;
      }
      notify(ctx, `Unknown argument "${arg}". Use on, off, or status.`, "warning");
    },
  });
}
