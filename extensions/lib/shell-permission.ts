import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyShellCommand } from "../permission/shell-ast.js";

/** Internal request/response protocol; the permission extension owns session-only policy. */
export const SHELL_PERMISSION_EVENT = "pi-core:authorize-shell";
export interface ShellPermissionRequest {
  command: string;
  ctx: ExtensionContext;
  result?: Promise<{ block: true; reason: string } | undefined>;
}

/**
 * Use the live permission extension when it is loaded. Without it, allow ordinary commands and
 * still reject intrinsically dangerous ones, so disabling permission does not break background jobs.
 */
export async function authorizeShell(pi: ExtensionAPI, command: string, ctx: ExtensionContext): Promise<void> {
  const request: ShellPermissionRequest = { command, ctx };
  pi.events.emit(SHELL_PERMISSION_EVENT, request);
  if (!request.result) {
    try {
      const assessment = await classifyShellCommand(command);
      if (assessment.dangerous) throw new Error("Dangerous background command is blocked while the permission extension is disabled.");
      return;
    } catch (error) {
      if (error instanceof Error && /Dangerous background command/.test(error.message)) throw error;
      throw new Error(`Background command could not be safety-checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const decision = await request.result;
  if (decision?.block) throw new Error(decision.reason);
}
