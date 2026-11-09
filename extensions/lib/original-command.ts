/**
 * Preserve the command a model actually asked for when another extension
 * rewrites it before the permission gate sees the tool call.
 *
 * `tool_call` handlers run in load order, so a rewrite (RTK) and a policy
 * (permission) can see different versions of the same call. The rewrite records
 * the original here; policy handlers read it by tool-call id instead of relying
 * on extension order. Bounded so a missing tool_result cannot grow it forever.
 */
const originals = new Map<string, string>();
const MAX_ORIGINALS = 256;

export function rememberOriginalCommand(toolCallId: string | undefined, command: string): void {
  if (!toolCallId || typeof command !== "string") return;
  originals.delete(toolCallId);
  originals.set(toolCallId, command);
  while (originals.size > MAX_ORIGINALS) originals.delete(originals.keys().next().value!);
}

export function originalCommand(toolCallId: string | undefined, fallback: string): string {
  return (toolCallId && originals.get(toolCallId)) || fallback;
}

export function forgetOriginalCommand(toolCallId: string | undefined): void {
  if (toolCallId) originals.delete(toolCallId);
}
