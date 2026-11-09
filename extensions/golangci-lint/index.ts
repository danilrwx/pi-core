/**
 * golangci-lint Hook Extension for pi-coding-agent
 *
 * Automatically runs golangci-lint --fix for changed Go modules.
 * Collects changed Go modules during agent turns and runs once at the end of the agent response.
 *
 * Usage:
 *   pi install ./path/to/golangci-lint
 *   Or use npm package if published
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const YELLOW = "\x1b[33m", RESET = "\x1b[0m";
const GOLANGCI_CONFIGS = [
  ".golangci.yml",
  ".golangci.yaml",
  ".golangci.toml",
  ".golangci.json",
] as const;

type GolangciLintConfig = {
  enabled?: boolean;
};

type GolangciLintScope = "project" | "global";

type GolangciLintAction = "status" | "enable" | "disable";

const COMMAND_ACTIONS: Array<{ value: GolangciLintAction; description: string }> = [
  { value: "status", description: "Show current project/global hook state" },
  { value: "enable", description: "Enable automatic golangci-lint --fix" },
  { value: "disable", description: "Disable automatic golangci-lint --fix" },
];

const COMMAND_SCOPES: Array<{ value: GolangciLintScope; description: string }> = [
  { value: "project", description: "Persist for current git repository" },
  { value: "global", description: "Persist for all projects" },
];

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR || process.env.TAU_CODING_AGENT_DIR;
  if (envDir) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function readJsonConfig(filePath: string): GolangciLintConfig {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as GolangciLintConfig;
  } catch {
    return {};
  }
}

function writeJsonConfig(filePath: string, config: GolangciLintConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function isEnabledConfig(filePath: string): boolean {
  return readJsonConfig(filePath).enabled !== false;
}

function setEnabledConfig(filePath: string, enabled: boolean): void {
  const config = readJsonConfig(filePath);
  config.enabled = enabled;
  writeJsonConfig(filePath, config);
}

function parseScope(raw: string | undefined): GolangciLintScope | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (["project", "local", "repo", "проект", "локально"].includes(value)) return "project";
  if (["global", "globally", "глобально"].includes(value)) return "global";
  return undefined;
}

function toAutocompleteItem(value: string, label: string, description: string): AutocompleteItem {
  return { value, label, description };
}

function filterCompletionItems(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.toLowerCase();
  const filtered = items.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
  return filtered.length > 0 ? filtered : null;
}

function getGolangciLintArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const hasTrailingSpace = /\s$/.test(prefix);
  const parts = prefix.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return COMMAND_ACTIONS.map((action) => toAutocompleteItem(action.value, action.value, action.description));
  }

  const actionPrefix = parts[0]?.toLowerCase() ?? "";
  const action = COMMAND_ACTIONS.find((item) => item.value === actionPrefix)?.value;

  if (!hasTrailingSpace && parts.length === 1) {
    return filterCompletionItems(
      COMMAND_ACTIONS.map((item) => toAutocompleteItem(item.value, item.value, item.description)),
      actionPrefix,
    );
  }

  if (action !== "enable" && action !== "disable") {
    return null;
  }

  if (parts.length > 2) {
    return null;
  }

  const scopePrefix = hasTrailingSpace ? "" : parts[1]?.toLowerCase() ?? "";
  return filterCompletionItems(
    COMMAND_SCOPES.map((scope) => toAutocompleteItem(`${action} ${scope.value}`, scope.value, scope.description)),
    `${action} ${scopePrefix}`,
  );
}

export default function (pi: ExtensionAPI) {
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;
  let isActive: boolean = false;
  let lintRunning: boolean = false;

  const touchedFiles: Set<string> = new Set();
  const pendingModules: Map<string, Set<string>> = new Map();
  const filesWithoutGoMod: Set<string> = new Set();

  function findGitRoot(cwd: string): string | undefined {
    try {
      return child_process.execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }

  function getProjectRoot(cwd: string): string {
    return findGitRoot(cwd) ?? cwd;
  }

  function getProjectConfigPath(cwd: string): string {
    return path.join(getProjectRoot(cwd), ".pi", "extensions", "golangci-lint", "golangci-lint.json");
  }

  function getGlobalConfigPath(): string {
    return path.join(getAgentDir(), "extensions", "golangci-lint", "golangci-lint.json");
  }

  function isLintEnabled(cwd: string): boolean {
    return isEnabledConfig(getGlobalConfigPath()) && isEnabledConfig(getProjectConfigPath(cwd));
  }

  function refreshActiveState(cwd: string): void {
    const moduleRoot = findLinterConfig(cwd);
    isActive = !!moduleRoot && isLintEnabled(cwd);
  }

  function hasGolangciConfig(dir: string): boolean {
    return GOLANGCI_CONFIGS.some((name) => fs.existsSync(path.join(dir, name)));
  }

  function findLinterConfig(cwd: string): string | undefined {
    let currentDir = cwd;
    const root = path.parse(currentDir).root;

    while (true) {
      if (hasGolangciConfig(currentDir)) {
        return currentDir;
      }

      if (currentDir === root) break;
      currentDir = path.dirname(currentDir);
    }

    try {
      const gitRoot = findGitRoot(cwd);
      if (!gitRoot) return undefined;

      const escapedPatterns = GOLANGCI_CONFIGS
        .map((name) => `'**/${name}'`)
        .join(" ");

      const result = child_process.execSync(`git ls-files --full-name ${escapedPatterns}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });

      const candidates = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((file) => path.join(gitRoot, path.dirname(file)));

      if (candidates.length > 0) {
        return candidates[0];
      }
    } catch {
    }

    return undefined;
  }

  function findNearestGoMod(filePath: string): string | undefined {
    let currentDir = path.dirname(filePath);
    const root = path.parse(currentDir).root;

    while (true) {
      if (fs.existsSync(path.join(currentDir, "go.mod"))) {
        return currentDir;
      }

      if (currentDir === root) break;
      currentDir = path.dirname(currentDir);
    }

    return undefined;
  }

  function updateStatus(text = `${YELLOW}golangci-lint${RESET}`): void {
    if (!statusUpdateFn) return;
    statusUpdateFn("golangci-lint", text);
  }

  function isGoFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".go";
  }

  function runGolangciLint(moduleRoot: string, files: Set<string>): { success: boolean; output: string; fixes: string[]; workingDir: string } {
    const fixes: string[] = [];

    try {
      child_process.execFileSync("golangci-lint", ["--version"], { stdio: "ignore", cwd: moduleRoot });
    } catch {
      return { success: false, output: "golangci-lint not found in PATH", fixes: [], workingDir: moduleRoot };
    }

    if (!fs.existsSync(path.join(moduleRoot, "go.mod"))) {
      return { success: false, output: "go.mod not found", fixes: [], workingDir: moduleRoot };
    }

    // --fix only the packages that contain files the agent actually touched,
    // never the whole module: an unrelated package may have pre-existing
    // findings and must not be rewritten behind the user's back.
    const dirs = [...new Set([...files].map((file) => path.relative(moduleRoot, path.dirname(file)) || "."))].sort();
    if (dirs.length === 0) return { success: true, output: "No fixes applied", fixes, workingDir: moduleRoot };
    try {
      const result = child_process.execFileSync(
        "golangci-lint",
        ["run", "--fix", "--timeout", "5m", ...dirs],
        { cwd: moduleRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      );

      return { success: true, output: result || "No fixes applied", fixes, workingDir: moduleRoot };
    } catch (error: any) {
      // A non-zero exit means lint findings or a tool error; surface it as
      // failure instead of pretending the run succeeded.
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      return { success: false, output: output || (error.message as string) || "Unknown error", fixes, workingDir: moduleRoot };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshActiveState(ctx.cwd);
    statusUpdateFn = ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;

    if (!isActive) {
      statusUpdateFn?.("golangci-lint", undefined);
      return;
    }

    updateStatus();
  });


  pi.on("session_tree", async (_event, ctx) => {
    refreshActiveState(ctx.cwd);

    if (!isActive) {
      statusUpdateFn?.("golangci-lint", undefined);
      return;
    }

    updateStatus();
  });


  pi.on("session_shutdown", async () => {
    touchedFiles.clear();
    pendingModules.clear();
    filesWithoutGoMod.clear();
    isActive = false;
    statusUpdateFn?.("golangci-lint", undefined);
  });

  pi.on("agent_start", async () => {
    touchedFiles.clear();
    pendingModules.clear();
    filesWithoutGoMod.clear();
  });

  function collectPendingModules(): void {
    if (touchedFiles.size === 0) return;

    const files = Array.from(touchedFiles);
    touchedFiles.clear();

    for (const filePath of files) {
      const moduleRoot = findNearestGoMod(filePath);
      if (moduleRoot) {
        const files = pendingModules.get(moduleRoot) ?? new Set<string>();
        files.add(filePath);
        pendingModules.set(moduleRoot, files);
      } else {
        filesWithoutGoMod.add(filePath);
      }
    }

    if (pendingModules.size > 0 || filesWithoutGoMod.size > 0) {
      updateStatus(`${YELLOW}golangci-lint pending${RESET}`);
    }
  }

  async function runPendingLint(ctx: ExtensionContext): Promise<void> {
    if (!isActive) return;
    if (lintRunning) return;

    collectPendingModules();

    if (pendingModules.size === 0 && filesWithoutGoMod.size === 0) return;

    lintRunning = true;
    const modules = [...pendingModules.entries()].sort(([a], [b]) => a.localeCompare(b));
    const missingGoModCount = filesWithoutGoMod.size;
    pendingModules.clear();
    filesWithoutGoMod.clear();
    updateStatus(`${YELLOW}golangci-lint running${RESET}`);

    try {
      if (modules.length === 0) {
        pi.sendMessage({
          customType: "golangci-lint-result",
          content: `golangci-lint skipped: no go.mod found for ${missingGoModCount} changed Go file(s)`,
          display: true,
        }, {
          deliverAs: "followUp",
        });
        return;
      }

      const outputs: string[] = [];
      const silentOutputs: string[] = [];

      for (const [moduleRoot, files] of modules) {
        const result = runGolangciLint(moduleRoot, files);
        const relModule = path.relative(ctx.cwd, moduleRoot) || ".";

        if (!result.success) {
          outputs.push(`Module: ${relModule}\n${result.output}`);
          continue;
        }

        if (result.output !== "No fixes applied") {
          outputs.push(`Module: ${relModule}\n${result.output}`);
          continue;
        }

        silentOutputs.push(`Module: ${relModule}\ngolangci-lint completed with no output`);
      }

      if (missingGoModCount > 0) {
        outputs.push(`golangci-lint skipped: no go.mod found for ${missingGoModCount} changed Go file(s)`);
      }

      if (outputs.length) {
        pi.sendMessage({
          customType: "golangci-lint-result",
          content: outputs.join("\n\n"),
          display: true,
        }, {
          triggerTurn: true,
          deliverAs: "followUp",
        });
        return;
      }

      if (silentOutputs.length) {
        pi.sendMessage({
          customType: "golangci-lint-result",
          content: silentOutputs.join("\n\n"),
          display: true,
        }, {
          deliverAs: "followUp",
        });
      }
    } finally {
      lintRunning = false;
      updateStatus();
    }
  }

  function formatStatus(cwd: string): string {
    const hasConfig = !!findLinterConfig(cwd);
    const globalEnabled = isEnabledConfig(getGlobalConfigPath());
    const projectEnabled = isEnabledConfig(getProjectConfigPath(cwd));
    const enabled = hasConfig && globalEnabled && projectEnabled;

    return [
      `golangci-lint: ${enabled ? "enabled" : "disabled"}`,
      `project: ${projectEnabled ? "enabled" : "disabled"} (${getProjectConfigPath(cwd)})`,
      `global: ${globalEnabled ? "enabled" : "disabled"} (${getGlobalConfigPath()})`,
      `config: ${hasConfig ? "found" : "not found"}`,
    ].join("\n");
  }

  function sendCommandResult(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.hasUI) {
      ctx.ui.notify(content, "info");
      return;
    }

    pi.sendMessage({
      customType: "golangci-lint-command",
      content,
      display: true,
    }, {
      deliverAs: "followUp",
    });
  }

  pi.registerCommand("golangci-lint", {
    description: "Manage golangci-lint hook: status | enable|disable [project|global]",
    getArgumentCompletions: getGolangciLintArgumentCompletions,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase();
      const scope = parseScope(parts[1]) ?? "project";

      if (!action || ["status", "state", "show"].includes(action)) {
        sendCommandResult(ctx, formatStatus(ctx.cwd));
        return;
      }

      const enabledAliases = ["enable", "enabled", "on", "включить"];
      const disabledAliases = ["disable", "disabled", "off", "выключить", "отключить"];
      const enabled = enabledAliases.includes(action) ? true : disabledAliases.includes(action) ? false : undefined;

      if (enabled === undefined || (parts[1] && !parseScope(parts[1]))) {
        sendCommandResult(ctx, "Usage: /golangci-lint status | /golangci-lint enable|disable [project|global]");
        return;
      }

      const configPath = scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(ctx.cwd);
      setEnabledConfig(configPath, enabled);
      refreshActiveState(ctx.cwd);

      if (!isActive) {
        touchedFiles.clear();
        pendingModules.clear();
        filesWithoutGoMod.clear();
        statusUpdateFn?.("golangci-lint", undefined);
      } else {
        updateStatus();
      }

      sendCommandResult(ctx, `golangci-lint ${enabled ? "enabled" : "disabled"} for ${scope}\n${formatStatus(ctx.cwd)}`);
    },
  });

  pi.on("turn_end", async () => {
    if (!isActive) return;
    collectPendingModules();
  });

  pi.on("agent_end", async (_event, ctx) => {
    await runPendingLint(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isActive) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = event.input.path as string;
    if (!filePath || !isGoFile(filePath)) return;

    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    touchedFiles.add(absPath);
    updateStatus(`${YELLOW}golangci-lint pending${RESET}`);
  });
}
