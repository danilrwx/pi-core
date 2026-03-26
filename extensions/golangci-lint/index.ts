/**
 * golangci-lint Hook Extension for pi-coding-agent
 *
 * Automatically runs golangci-lint --fix for changed Go modules.
 * Executes once at the end of the agent response.
 *
 * Usage:
 *   pi install ./path/to/golangci-lint
 *   Or use npm package if published
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const YELLOW = "\x1b[33m", RESET = "\x1b[0m";

export default function (pi: ExtensionAPI) {
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;
  let isActive: boolean = false;

  const touchedFiles: Set<string> = new Set();

  function findLinterConfig(cwd: string): string | undefined {
    let currentDir = cwd;
    const root = path.parse(currentDir).root;

    while (true) {
      if (fs.existsSync(path.join(currentDir, ".golangci.yaml"))) {
        return currentDir;
      }

      if (currentDir === root) break;
      currentDir = path.dirname(currentDir);
    }

    try {
      const gitRoot = child_process.execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();

      const result = child_process.execSync("git ls-files --full-name '**/.golangci.yaml'", {
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

  function updateStatus(): void {
    if (!statusUpdateFn) return;
    statusUpdateFn("golangci-lint", `${YELLOW}golangci-lint${RESET}`);
  }

  function isGoFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".go";
  }

  /**
   * Find the nearest go.mod file by traversing up from the given file path.
   * Returns the directory containing go.mod, or undefined if not found.
   */
  function findNearestGoMod(filePath: string): string | undefined {
    let currentDir = path.dirname(filePath);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      if (fs.existsSync(path.join(currentDir, "go.mod"))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }

    // Check root as well
    if (fs.existsSync(path.join(root, "go.mod"))) {
      return root;
    }

    return undefined;
  }

  function runGolangciLint(filePath: string, cwd: string): { success: boolean; output: string; fixes: string[]; workingDir: string } {
    const fixes: string[] = [];
    
    // Check if golangci-lint is available
    try {
      child_process.execSync("which golangci-lint", { stdio: "ignore", cwd });
    } catch {
      return { success: false, output: "golangci-lint not found in PATH", fixes: [], workingDir: cwd };
    }

    // Find nearest go.mod from the file, fallback to cwd
    const moduleRoot = findNearestGoMod(filePath) || cwd;

    // Check if go.mod exists in the found directory
    if (!fs.existsSync(path.join(moduleRoot, "go.mod"))) {
      return { success: false, output: "go.mod not found", fixes: [], workingDir: moduleRoot };
    }

    try {
      const result = child_process.execSync(
        "golangci-lint run --fix --timeout 5m ./... 2>&1",
        {
          cwd: moduleRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }
      );

      return { success: true, output: result || "No fixes applied", fixes, workingDir: moduleRoot };
    } catch (error: any) {
      // golangci-lint returns non-zero if there are errors, but --fix might still work
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

  pi.on("session_switch", async (_event, ctx) => {
    const moduleRoot = findLinterConfig(ctx.cwd);
    isActive = !!moduleRoot;

    if (!isActive) {
      statusUpdateFn?.("golangci-lint", undefined);
      return;
    }

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

  pi.on("session_fork", async (_event, ctx) => {
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

  pi.on("agent_end", async (_event, ctx) => {
    if (!isActive) return;
    if (touchedFiles.size === 0) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const files = Array.from(touchedFiles);
    touchedFiles.clear();

    const modules = new Map<string, string>();
    for (const filePath of files) {
      const moduleRoot = findNearestGoMod(filePath) || ctx.cwd;
      if (!modules.has(moduleRoot)) {
        modules.set(moduleRoot, filePath);
      }
    }

    const outputs: string[] = [];
    modules.forEach((filePath, moduleRoot) => {
      const result = runGolangciLint(filePath, ctx.cwd);

      if (result.success && result.output !== "No fixes applied") {
        const relModule = path.relative(ctx.cwd, moduleRoot) || ".";
        outputs.push(`Module: ${relModule}\n${result.output}`);
      }
    });

    if (outputs.length) {
      pi.sendMessage({
        customType: "golangci-lint-result",
        content: outputs.join("\n\n"),
        display: true,
      }, {
        triggerTurn: true,
        deliverAs: "followUp",
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isActive) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = event.input.path as string;
    if (!filePath || !isGoFile(filePath)) return;

    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    touchedFiles.add(absPath);
  });
}
