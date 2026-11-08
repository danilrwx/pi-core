import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function interruption(text: string): "aborted" | "timeout" | undefined {
  if (/(?:^|\n)(?:Command|Operation) aborted\s*$/i.test(text)) return "aborted";
  if (/(?:^|\n)Command timed out after [\d.]+ seconds\s*$/i.test(text)) return "timeout";
}

/** Pi already retains bash's streamed tail on interruption. Preserve and explicitly label it. */
export default function partialOutput(pi: ExtensionAPI) {
  const started = new Map<string, number>();
  pi.on("tool_call", (event) => { started.set(event.toolCallId, Date.now()); });
  pi.on("tool_result", (event, ctx) => {
    const since = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    if (!event.isError) return;
    const text = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const why = interruption(text) ?? (ctx.signal?.aborted ? "aborted" : undefined);
    if (!why || !["bash", "powershell", "codemode"].includes(event.toolName)) return;
    const header = `[Partial result: ${why}. Work may be incomplete; output below is not evidence of success. Do not blindly rerun completed steps.]`;
    const metadata = event.details as { fullOutputPath?: unknown } | undefined;
    const path = typeof metadata?.fullOutputPath === "string" ? metadata.fullOutputPath : undefined;
    const details = { ...(event.details ?? {}), partial: true, interruption: why, ...(path ? { fullOutputPath: path } : {}) };
    const structuredContent = event.structuredContent ?? (event.toolName === "bash" || event.toolName === "powershell" ? {
      output: `${header}\n${text}`, truncated: Boolean(path), ...(path ? { full_output_path: path } : {}),
      exit_code: why === "aborted" ? 130 : 124,
      wall_time_seconds: since === undefined ? 0 : (Date.now() - since) / 1000,
    } : undefined);
    return { content: [{ type: "text" as const, text: `${header}\n${text}` }], details, isError: true, ...(structuredContent ? { structuredContent } : {}) };
  });
  pi.on("agent_end", () => started.clear());
  pi.on("session_shutdown", () => started.clear());
}
