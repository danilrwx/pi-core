/**
 * Parallel read-only tool calls.
 *
 * Pi already parallelizes tool calls from one assistant message. This tool is
 * for models/providers that emit one call at a time and for cases where several
 * independent reads/searches should be grouped into one round-trip. Mutating
 * tools are deliberately excluded: parallel edits and shell commands are a
 * race, not a batch.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_CALLS = 8;
const MAX_CHARS_PER_CALL = 8_000;
const MAX_TOTAL_CHARS = 32_000;
const MAX_IMAGES = 4;

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "index",
  "lsp",
]);

interface BatchCall {
  tool: string;
  parameters?: Record<string, unknown>;
}

interface CallResult {
  tool: string;
  isError: boolean;
  durationMs?: number;
  text: string;
  truncated: boolean;
}

function textOf(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n… [truncated; use the tool directly for the rest]`, truncated: true };
}

function normalize(call: BatchCall): Record<string, unknown> {
  return call.parameters && typeof call.parameters === "object" && !Array.isArray(call.parameters)
    ? call.parameters
    : {};
}

async function runCall(call: BatchCall, context: ExtensionToolContext): Promise<CallResult> {
  try {
    const outcome = await context.executeTool(call.tool, normalize(call), { signal: context.signal });
    return {
      tool: call.tool,
      isError: Boolean(outcome.isError),
      durationMs: outcome.durationMs,
      text: textOf(outcome.result),
      truncated: false,
    };
  } catch (error) {
    return {
      tool: call.tool,
      isError: true,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      truncated: false,
    };
  }
}

function formatResults(calls: BatchCall[], results: CallResult[]): { content: any[]; details: any; isError: boolean } {
  const content: any[] = [];
  const summary = [`Batch: ${results.filter((result) => !result.isError).length}/${results.length} succeeded`];
  let total = 0;
  const details: any[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const label = `${i + 1}. ${result.tool}${result.isError ? " (failed)" : ""}`;
    const remaining = Math.max(0, MAX_TOTAL_CHARS - total);
    const limited = truncate(result.text || "(no output)", Math.min(MAX_CHARS_PER_CALL, remaining));
    total += limited.text.length;
    summary.push(`## ${label}`, limited.text);
    if (!limited.text) summary.push("(no output)");
    details.push({
      index: i + 1,
      tool: calls[i].tool,
      isError: result.isError,
      durationMs: result.durationMs,
      truncated: result.truncated || limited.truncated,
      bytes: result.text.length,
    });
  }
  content.push({ type: "text" as const, text: summary.join("\n") });
  return { content, details: { calls: details, totalChars: total }, isError: results.length > 0 && results.every((result) => result.isError) };
}

export default function batchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "batch",
    label: "Batch",
    executionMode: "sequential",
    annotations: { readOnlyHint: true },
    description: `Run up to ${MAX_CALLS} independent read-only tool calls in parallel and return their combined results in one turn. Use it when a task needs several files or searches and none of the calls depend on another. Allowed tools: read, grep, find, ls, index, lsp. Do not use batch for edits, writes, bash, or dependent calls. Prefer read with offset/limit so each result stays small.`,
    promptSnippet: "Run independent read-only tools in one parallel batch",
    promptGuidelines: [
      "Use batch only for 2 or more independent read-only calls (read, grep, find, ls, index, lsp); not for edits, bash, or calls that depend on an earlier result.",
      "Keep each batch small: use read offset/limit or grep glob filters; the batch truncates large children.",
    ],
    parameters: Type.Object({
      tool_calls: Type.Array(Type.Object({
        tool: Type.String({ description: "Read-only tool name" }),
        parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the tool" })),
      }), { minItems: 1, maxItems: MAX_CALLS, description: "Independent calls to run in parallel" }),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, context) {
      const calls = Array.isArray(params.tool_calls) ? params.tool_calls as BatchCall[] : [];
      if (!calls.length) {
        return { content: [{ type: "text" as const, text: "Error: provide at least one tool call" }], details: {}, isError: true };
      }
      const unsupported = calls.map((call) => call.tool).filter((tool) => !READ_ONLY_TOOLS.has(tool));
      if (unsupported.length) {
        return {
          content: [{ type: "text" as const, text: `Error: batch allows only read-only tools (${[...READ_ONLY_TOOLS].join(", ")}); rejected: ${[...new Set(unsupported)].join(", ")}` }],
          details: { rejected: unsupported },
          isError: true,
        };
      }
      const results = await Promise.all(calls.map((call) => runCall(call, context)));
      // Promise.all preserves input order; runCall never rejects.
      const formatted = formatResults(calls, results);
      return {
        content: formatted.content,
        details: formatted.details,
        isError: formatted.isError,
      };
    },
  });
}
