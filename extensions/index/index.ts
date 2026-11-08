import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export interface SkeletonSymbol { line: number; end: number; indent: number; kind: string; name: string; signature: string }
export interface Skeleton { language: string; imports: string[]; symbols: SkeletonSymbol[]; lines: number }

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 150;
const NOISE = new Set(["if", "for", "while", "switch", "catch", "return", "else", "new", "typeof", "await"]);

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift",
  ".c": "c", ".h": "c", ".cc": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".lua": "lua", ".sh": "shell", ".bash": "shell",
  ".vue": "vue", ".svelte": "svelte",
};

export function languageOf(file: string): string {
  return LANGUAGES[extname(file).toLowerCase()] ?? "text";
}

function sig(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 160);
}
function countBraces(line: string): number {
  let balance = 0, quote = "", escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "{") balance++;
    else if (ch === "}") balance--;
  }
  return balance;
}
function nextEnd(lines: string[], start: number, indent: number, language: string): number {
  const braces = ["typescript", "javascript", "go", "rust", "java", "kotlin", "swift", "c", "cpp", "csharp", "php", "vue", "svelte"].includes(language);
  if (braces) {
    let balance = 0, opened = false;
    for (let i = start; i < lines.length; i++) {
      const delta = countBraces(lines[i]);
      if (delta > 0) opened = true;
      balance += delta;
      if (opened && balance <= 0) return i + 1;
      if (!opened && i > start + 2) break;
    }
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const nextIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
    if (nextIndent <= indent) return i;
  }
  return lines.length;
}

type Rule = { kind: string; re: RegExp; name: number; indent?: number };
const RULES: Record<string, Rule[]> = {
  typescript: [
    { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, name: 1 },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([\w$]+)/, name: 1 },
    { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([\w$]+)/, name: 1 },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([\w$]+)/, name: 1 },
    { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/, name: 1 },
    { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/, name: 1 },
    { kind: "method", re: /^\s{2,}(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::[^{]+)?\{/, name: 1 },
  ],
  python: [
    { kind: "class", re: /^(\s*)class\s+([\w]+)/, name: 2, indent: 1 },
    { kind: "function", re: /^(\s*)(?:async\s+)?def\s+([\w]+)/, name: 2, indent: 1 },
  ],
  go: [
    { kind: "type", re: /^\s*type\s+([\w]+)/, name: 1 },
    { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([\w]+)/, name: 1 },
    { kind: "variable", re: /^\s*(?:var|const)\s+([\w]+)/, name: 1 },
  ],
  rust: [
    { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([\w]+)/, name: 1 },
    { kind: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([\w]+)/, name: 1 },
    { kind: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([\w]+)/, name: 1 },
    { kind: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([\w]+)/, name: 1 },
    { kind: "impl", re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w]+)/, name: 1 },
    { kind: "module", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([\w]+)/, name: 1 },
  ],
  java: [
    { kind: "class", re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*(?:class|interface|enum|record)\s+([\w]+)/, name: 1 },
    { kind: "method", re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>[\],.?]+\s+([\w]+)\s*\([^;]*\)\s*(?:throws [^{]+)?\{/, name: 1 },
  ],
  kotlin: [
    { kind: "class", re: /^\s*(?:private\s+|internal\s+|public\s+|abstract\s+|sealed\s+|data\s+|open\s+)*(?:class|interface|object)\s+([\w]+)/, name: 1 },
    { kind: "function", re: /^\s*(?:(?:private|internal|public|protected|suspend|override|open|inline)\s+)*fun\s+(?:<[^>]*>\s*)?([\w]+)/, name: 1 },
  ],
  ruby: [
    { kind: "class", re: /^\s*(?:class|module)\s+([\w:]+)/, name: 1 },
    { kind: "function", re: /^\s*def\s+([\w!?=]+)/, name: 1 },
  ],
  php: [
    { kind: "class", re: /^\s*(?:abstract\s+|final\s+)*(?:class|interface|trait|enum)\s+([\w]+)/, name: 1 },
    { kind: "function", re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([\w]+)/, name: 1 },
  ],
  lua: [
    { kind: "function", re: /^\s*(?:local\s+)?function\s+([\w.:]+)/, name: 1 },
  ],
  shell: [
    { kind: "function", re: /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{?/, name: 1 },
  ],
};

function importLines(lines: string[], language: string): string[] {
  const found: string[] = [];
  const patterns = language === "python"
    ? [/^\s*(?:from\s+\S+\s+)?import\s+/, /^\s*from\s+\S+\s+import\s+/]
    : language === "go"
      ? [/^\s*import\s+/, /^\s*"(?:[\w./-]+)"\s*$/]
      : language === "rust"
        ? [/^\s*(?:pub\s+)?use\s+/]
        : [/^\s*import\s+/, /^\s*(?:const|let|var)\s+[\w${}\s,]+\s*=\s*require\(/];
  for (let i = 0; i < lines.length && found.length < 25; i++) {
    const line = lines[i];
    if (patterns.some((re) => re.test(line))) found.push(`${i + 1}: ${sig(line)}`);
    else if (found.length && line.trim() && !/^\s*(?:\/\/|#|\/\*|\*)/.test(line) && i > 10) break;
  }
  return found;
}

export function skeleton(text: string, file: string, options: { maxSymbols?: number } = {}): Skeleton {
  const language = languageOf(file);
  const lines = text.split(/\r?\n/);
  const symbols: SkeletonSymbol[] = [];
  const rules = RULES[language] ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    for (const rule of rules) {
      const match = rule.re.exec(line);
      if (!match) continue;
      const indent = (line.match(/^\s*/)?.[0].length ?? 0);
      const name = match[rule.name] ?? "";
      if (!name || NOISE.has(name)) continue;
      symbols.push({ line: i + 1, end: nextEnd(lines, i, indent, language), indent, kind: rule.kind, name, signature: sig(line) });
      break;
    }
  }
  const seen = new Set<string>();
  const unique = symbols.filter((symbol) => {
    const key = `${symbol.line}:${symbol.name}:${symbol.kind}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => a.line - b.line).slice(0, options.maxSymbols ?? MAX_SYMBOLS);
  return { language, imports: importLines(lines, language), symbols: unique, lines: lines.length };
}

export function formatSkeleton(file: string, sk: Skeleton, cwd: string): string {
  const out = [`${relative(cwd, file) || file} · ${sk.language} · ${sk.lines} lines`];
  if (sk.imports.length) out.push("imports:", ...sk.imports.map((line) => `  ${line}`));
  if (sk.symbols.length) out.push("symbols:", ...sk.symbols.map((symbol) => {
    const depth = Math.min(4, Math.round(symbol.indent / 2));
    return `  ${symbol.line}-${symbol.end} ${"  ".repeat(depth)}${symbol.kind} ${symbol.name}`;
  }));
  else out.push("symbols: none detected (use read)");
  return out.join("\n");
}

export default function skeletonExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "index",
    label: "Index file",
    readOnly: true,
    description: "Return a compact skeleton of a source file: imports, declarations, methods and exact line ranges, without file bodies. Use it before read to find the ranges worth reading. Ranges are best-effort for brace/indent languages.",
    promptSnippet: "Index a file before reading it to save context",
    promptGuidelines: [
      "For an unfamiliar or large source file, call index before read; then read only the relevant line ranges.",
      "If index does not recognize a language, fall back to grep/read and say so.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "File inside the project; relative to the Pi working directory" }),
      query: Type.Optional(Type.String({ description: "Only show symbols whose name or signature contains this text" })),
      max_symbols: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, context) {
      const file = resolve(context.cwd, params.file);
      try {
        const data = await readFile(file);
        if (data.length > MAX_BYTES) throw new Error(`File is larger than ${MAX_BYTES / 1024 / 1024} MiB; use read with ranges`);
        const text = data.toString("utf8");
        if (text.includes("\0")) throw new Error("Binary file; use read for supported images or a hex tool");
        let sk = skeleton(text, file, { maxSymbols: params.max_symbols });
        if (params.query?.trim()) {
          const needle = params.query.trim().toLowerCase();
          sk = { ...sk, symbols: sk.symbols.filter((symbol) => `${symbol.name} ${symbol.signature}`.toLowerCase().includes(needle)) };
        }
        return { content: [{ type: "text" as const, text: formatSkeleton(file, sk, context.cwd) }], details: sk };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true };
      }
    },
  });
}
