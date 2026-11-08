import { open } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HEAD_LINES = 80;
const HEAD_BYTES = 12 * 1024;

/** Read only the beginning of a (possibly huge) log without loading it all. */
export async function readHead(path: string, maxLines = HEAD_LINES, maxBytes = HEAD_BYTES): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    return lines.slice(0, maxLines).join("\n");
  } finally { await handle.close(); }
}

interface Truncation { truncated?: boolean; totalLines?: number; outputLines?: number }

export default function bashHeadTail(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const details = event.details as { fullOutputPath?: string; truncation?: Truncation } | undefined;
    const path = details?.fullOutputPath;
    const truncation = details?.truncation;
    if (!path || !truncation?.truncated) return;
    const total = truncation.totalLines ?? 0;
    const shown = truncation.outputLines ?? 0;
    if (total && total <= shown + HEAD_LINES) return;
    const part = event.content.find((entry) => entry.type === "text");
    if (!part || part.type !== "text" || part.text.includes("[first lines of output]")) return;
    try {
      const head = await readHead(path);
      if (!head.trim()) return;
      const prefix = `[first lines of output]\n${head}\n[... middle omitted; full output: ${path}]\n\n[last lines]\n`;
      part.text = prefix + part.text;
    } catch { /* Keep the original tail if the full log disappeared. */ }
  });
}
