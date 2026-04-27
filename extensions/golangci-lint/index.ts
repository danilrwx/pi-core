/**
 * golangci-lint Hook Extension for pi-coding-agent
 *
 * Automatically runs golangci-lint --fix for changed Go modules.
 * Runs after agent turns and at the end of the agent response.
 *
 * Usage:
 *   pi install ./path/to/golangci-lint
 *   Or use npm package if published
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const YELLOW = "\x1b[33m", RESET = "\x1b[0m";
const GOLANGCI_CONFIGS = [
  ".golangci.yml",
  ".golangci.yaml",
  ".golangci.toml",
  ".golangci.json",
] as const;

export default function (pi: ExtensionAPI) {
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;
  let isActive: boolean = false;
  let lintRunning: boolean = false;

  const touchedFiles: Set<string> = new Set();

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

  function runGolangciLint(moduleRoot: string): { success: boolean; output: string; fixes: string[]; workingDir: string } {
    const fixes: string[] = [];

    try {
      child_process.execSync("which golangci-lint", { stdio: "ignore", cwd: moduleRoot });
    } catch {
      return { success: false, output: "golangci-lint not found in PATH", fixes: [], workingDir: moduleRoot };
    }

    if (!fs.existsSync(path.join(moduleRoot, "go.mod"))) {
      return { success: false, output: "go.mod not found", fixes: [], workingDir: moduleRoot };
    }

    try {
      const result = child_process.execSync(
        "golangci-lint run --fix --timeout 5m ./... 2>&1",
        {
          cwd: moduleRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      return { success: true, output: result || "No fixes applied", fixes, workingDir: moduleRoot };
    } catch (error: any) {
      if (error.stdout) {
        return { success: true, output: error.stdout as string, fixes, workingDir: moduleRoot };
      }
      return { success: false, output: (error.message as string) || "Unknown error", fixes, workingDir: moduleRoot };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const moduleRoot = findLinterConfig(ctx.cwd);
    isActive = !!moduleRoot;

    if (!isActive) {
      return;
    }

    statusUpdateFn = ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;
    updateStatus();
  });


  pi.on("session_tree", async (_event, ctx) => {
    const moduleRoot = findLinterConfig(ctx.cwd);
    isActive = !!moduleRoot;

    if (!isActive) {
      statusUpdateFn?.("golangci-lint", undefined);
      return;
    }

    updateStatus();
  });


  pi.on("session_shutdown", async () => {
    touchedFiles.clear();
    isActive = false;
    statusUpdateFn?.("golangci-lint", undefined);
  });

  pi.on("agent_start", async () => {
    touchedFiles.clear();
  });

  async function runPendingLint(ctx: ExtensionContext): Promise<void> {
    if (!isActive) return;
    if (lintRunning) return;
    if (touchedFiles.size === 0) return;

    lintRunning = true;
    const files = Array.from(touchedFiles);
    touchedFiles.clear();
    updateStatus(`${YELLOW}golangci-lint running${RESET}`);

    try {
      const modules = new Set<string>();
      for (const filePath of files) {
        const moduleRoot = findNearestGoMod(filePath);
        if (moduleRoot) {
          modules.add(moduleRoot);
        }
      }

      if (modules.size === 0) {
        pi.sendMessage({
          customType: "golangci-lint-result",
          content: "golangci-lint skipped: no go.mod found for changed Go files",
          display: true,
        }, {
          deliverAs: "followUp",
        });
        return;
      }

      const outputs: string[] = [];
      const silentOutputs: string[] = [];

      for (const moduleRoot of Array.from(modules).sort()) {
        const result = runGolangciLint(moduleRoot);
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

  pi.on("turn_end", async (_event, ctx) => {
    await runPendingLint(ctx);
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
