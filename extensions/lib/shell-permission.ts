import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Internal request/response protocol; the permission extension owns session-only policy. */
export const SHELL_PERMISSION_EVENT = "pi-core:authorize-shell";
export interface ShellPermissionRequest {
  command: string;
  ctx: ExtensionContext;
  result?: Promise<{ block: true; reason: string } | undefined>;
}

/** Fail closed if the permission extension is disabled; never infer policy from stale settings. */
export async function authorizeShell(pi: ExtensionAPI, command: string, ctx: ExtensionContext): Promise<void> {
  const request: ShellPermissionRequest = { command, ctx };
  pi.events.emit(SHELL_PERMISSION_EVENT, request);
  if (!request.result) throw new Error("Background commands require pi-core's permission extension to be active.");
  const decision = await request.result;
  if (decision?.block) throw new Error(decision.reason);
}
