import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Language, Parser, type Node } from "web-tree-sitter";

export interface SkeletonSymbol { line: number; end: number; indent: number; kind: string; name: string; signature: string }
export interface Skeleton { language: string; imports: string[]; symbols: SkeletonSymbol[]; lines: number; source?: "lsp" | "tree-sitter" | "regex" }

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 150;
const MAX_TS_NODES = 50_000;
const MAX_TS_DEPTH = 512;
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
  ".scala": "scala", ".sc": "scala", ".zig": "zig", ".dart": "dart",
  ".ex": "elixir", ".exs": "elixir", ".cxx": "cpp", ".hh": "cpp", ".hxx": "cpp",
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

const LSP_KINDS: Record<number, string> = {
  2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property",
  8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function",
  13: "variable", 14: "constant", 22: "enum member", 23: "struct", 24: "event",
  25: "operator", 26: "type parameter",
};


const TS_GRAMMARS: Record<string, string> = {
  c: "c", cpp: "cpp", csharp: "c_sharp", scala: "scala", zig: "zig", elixir: "elixir",
};

const DECLARATIONS: Record<string, Record<string, string>> = {
  c: {
    function_definition: "function", struct_specifier: "struct", union_specifier: "union",
    enum_specifier: "enum", type_definition: "type", preproc_def: "macro",
  },
  cpp: {
    function_definition: "function", class_specifier: "class", struct_specifier: "struct",
    union_specifier: "union", enum_specifier: "enum", namespace_definition: "namespace",
    type_definition: "type", alias_declaration: "type",
  },
  csharp: {
    method_declaration: "method", class_declaration: "class", interface_declaration: "interface",
    struct_declaration: "struct", enum_declaration: "enum", record_declaration: "record",
    property_declaration: "property", constructor_declaration: "constructor",
    namespace_declaration: "namespace", delegate_declaration: "delegate", event_declaration: "event",
  },
  scala: {
    function_definition: "function", function_declaration: "function", class_definition: "class",
    object_definition: "object", trait_definition: "trait", type_definition: "type",
    enum_definition: "enum",
  },
  zig: {
    function_declaration: "function", variable_declaration: "variable", test_declaration: "test",
    struct_declaration: "struct", enum_declaration: "enum", union_declaration: "union",
  },
  elixir: {},
};

let tsInit: Promise<void> | undefined;
const tsParsers = new Map<string, Parser>();
const tsLanguages = new Map<string, Promise<Language | undefined>>();

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function firstLine(value: string): string {
  return compact(value.split(/\r?\n/, 1)[0] ?? "");
}

function childName(node: Node | null | undefined, language: string): string | undefined {
  if (!node) return;
  if (language === "elixir" && node.type === "call") {
    const head = node.namedChildren[0];
    const args = node.namedChildren.find((child) => child?.type === "arguments");
    if (!head || head.type !== "identifier" || !["defmodule", "def", "defp", "defmacro", "defmacrop", "defguard", "defstruct"].includes(head.text)) return;
    if (!args) return head.text;
    if (head.text === "defmodule") return compact(args.text);
    const first = args.namedChildren.find((child) => child?.type === "call" || child?.type === "identifier");
    return first ? first.text.replace(/\(.*$/s, "").trim() : compact(args.text).split(/[,(]/)[0];
  }
  const named = node.childForFieldName("name");
  if (named?.text.trim()) return compact(named.text);
  if (node.type === "variable_declaration") {
    const identifier = node.namedChildren.find((child) => child?.type === "identifier");
    if (identifier) return compact(identifier.text);
  }
  if (language === "c" || language === "cpp") {
    let declarator = node.childForFieldName("declarator");
    while (declarator) {
      if (["identifier", "field_identifier", "operator_name", "type_identifier"].includes(declarator.type)) return compact(declarator.text);
      const name = declarator.childForFieldName("name");
      if (name?.text.trim()) return compact(name.text);
      const inner = declarator.childForFieldName("declarator");
      if (!inner) break;
      declarator = inner;
    }
    const identifier = node.namedChildren.find((child) => child?.type === "identifier" || child?.type === "field_identifier" || child?.type === "type_identifier");
    if (identifier) return compact(identifier.text);
  }
  return;
}

function elixirDeclaration(node: Node): string | undefined {
  if (node.type !== "call") return;
  const head = node.namedChildren[0];
  if (!head || head.type !== "identifier") return;
  if (head.text === "defmodule") return "module";
  if (["def", "defp", "defmacro", "defmacrop", "defguard"].includes(head.text)) return "function";
  if (head.text === "defstruct") return "struct";
  return;
}

async function loadTsLanguage(grammar: string): Promise<Language | undefined> {
  const cached = tsLanguages.get(grammar);
  if (cached) return cached;
  const pending = (async () => {
    try {
      await (tsInit ??= Parser.init());
      return await Language.load(fileURLToPath(new URL(`../../vendor/tree-sitter-languages/tree-sitter-${grammar}.wasm`, import.meta.url)));
    } catch { return; }
  })();
  tsLanguages.set(grammar, pending);
  return pending;
}

async function tsParser(grammar: string): Promise<Parser | undefined> {
  const cached = tsParsers.get(grammar);
  if (cached) return cached;
  const language = await loadTsLanguage(grammar);
  if (!language) return;
  const parser = new Parser();
  parser.setLanguage(language);
  tsParsers.set(grammar, parser);
  return parser;
}

/** Tree-sitter fallback for languages that have no language server in this setup. */
export async function treeSitterSkeleton(text: string, file: string): Promise<Skeleton | undefined> {
  const languageName = languageOf(file);
  const grammar = TS_GRAMMARS[languageName];
  if (!grammar) return;
  const parser = await tsParser(grammar);
  if (!parser) return;
  let tree;
  try { tree = parser.parse(text); } catch { return; }
  if (!tree) return;
  try {
    const lines = text.split(/\r?\n/);
    const declarations = DECLARATIONS[languageName] ?? {};
    const found: SkeletonSymbol[] = [];
    const seen = new Set<string>();
    let visited = 0;
    const walk = (node: Node, depth: number) => {
      if (++visited > MAX_TS_NODES || depth > MAX_TS_DEPTH) return;
      const kind = languageName === "elixir" ? elixirDeclaration(node) : declarations[node.type];
      let nextDepth = depth;
      if (kind) {
        const name = childName(node, languageName);
        if (name) {
          const start = node.startPosition;
          const end = node.endPosition;
          const line = start.row + 1;
          const endLine = Math.max(line, Math.min(lines.length, end.row + (end.column > 0 ? 1 : 0)));
          const key = `${line}:${endLine}:${kind}:${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            found.push({
              line, end: endLine, indent: nextDepth * 2, kind, name,
              signature: firstLine(node.text),
            });
          }
          nextDepth += 1;
        }
      }
      for (const child of node.namedChildren) if (child) walk(child, nextDepth);
    };
    walk(tree.rootNode, 0);
    if (!found.length) return;
    found.sort((a, b) => a.line - b.line || a.indent - b.indent);
    return {
      language: languageName,
      imports: importLines(lines, languageName),
      symbols: found.slice(0, MAX_SYMBOLS * 2),
      lines: lines.length,
      source: "tree-sitter",
    };
  } finally {
    tree.delete();
  }
}

/** Convert LSP DocumentSymbols (exact ranges) to the same compact shape as the regex fallback. */
export function fromLspSymbols(symbols: any[], file: string, text: string): Skeleton | undefined {
  if (!symbols.length) return;
  const lines = text.split(/\r?\n/);
  const result: SkeletonSymbol[] = [];
  const visit = (symbolsToVisit: any[], depth: number) => {
    for (const symbol of symbolsToVisit) {
      if (!symbol?.name || !symbol.range?.start || !symbol.range?.end) continue;
      const start = symbol.range.start.line;
      const end = symbol.range.end;
      const endLine = end.line + (end.character > 0 ? 1 : 0);
      const signature = (lines[start] ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
      result.push({
        line: start + 1, end: Math.max(start + 1, Math.min(endLine, lines.length)), indent: depth * 2,
        kind: LSP_KINDS[symbol.kind as number] ?? "symbol", name: String(symbol.name), signature,
      });
      if (Array.isArray(symbol.children)) visit(symbol.children, depth + 1);
      if (result.length >= MAX_SYMBOLS * 2) return;
    }
  };
  visit(symbols, 0);
  if (!result.length) return;
  result.sort((a, b) => a.line - b.line || a.indent - b.indent);
  return { language: languageOf(file), imports: importLines(lines, languageOf(file)), symbols: result.slice(0, MAX_SYMBOLS), lines: lines.length, source: "lsp" };
}

function importLines(lines: string[], language: string): string[] {
  const found: string[] = [];
  const patterns = language === "python"
    ? [/^\s*(?:from\s+\S+\s+)?import\s+/, /^\s*from\s+\S+\s+import\s+/]
    : language === "go"
      ? [/^\s*import\s+/, /^\s*"(?:[\w./-]+)"\s*$/]
      : language === "rust"
        ? [/^\s*(?:pub\s+)?use\s+/]
        : language === "c" || language === "cpp"
          ? [/^\s*#\s*include\b/]
          : language === "csharp"
            ? [/^\s*using\s+[\w.]+\s*;/]
            : language === "scala"
              ? [/^\s*import\s+/]
              : language === "zig"
                ? [/^\s*const\s+\w+\s*=\s*@import\(/]
                : language === "elixir"
                    ? [/^\s*(?:alias|import|require|use)\s+/]
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
  return { language, imports: importLines(lines, language), symbols: unique, lines: lines.length, source: "regex" };
}

export function formatSkeleton(file: string, sk: Skeleton, cwd: string): string {
  const out = [`${relative(cwd, file) || file} · ${sk.language} · ${sk.lines} lines · ${sk.source ?? "regex"}`];
  if (sk.imports.length) out.push("imports:", ...sk.imports.map((line) => `  ${line}`));
  if (sk.symbols.length) out.push("symbols:", ...sk.symbols.map((symbol) => {
    const depth = Math.min(4, Math.round(symbol.indent / 2));
    return `  ${symbol.line}-${symbol.end} ${"  ".repeat(depth)}${symbol.kind} ${symbol.name}`;
  }));
  else out.push("symbols: none detected (use read)");
  return out.join("\n");
}

async function lspSkeleton(cwd: string, file: string, text: string): Promise<Skeleton | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const { getOrCreateManager } = await import("../lsp-pi/lsp-core.js");
    const manager = getOrCreateManager(cwd);
    const symbols = await Promise.race([
      manager.getDocumentSymbols(file),
      new Promise<any[]>((resolve) => { timer = setTimeout(() => resolve([]), 8_000); timer.unref(); }),
    ]);
    return fromLspSymbols(symbols, file, text);
  } catch { return; }
  finally { if (timer) clearTimeout(timer); }
}

export default function skeletonExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "index",
    label: "Index file",
    description: "Return a compact skeleton of a source file: imports, declarations, methods and line ranges, without file bodies. Uses the language server for exact ranges when available, then falls back to a regex parser. Use it before read to find the ranges worth reading.",
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
        let sk = await lspSkeleton(context.cwd, file, text)
          ?? await treeSitterSkeleton(text, file)
          ?? skeleton(text, file, { maxSymbols: params.max_symbols });
        if (params.max_symbols) sk = { ...sk, symbols: sk.symbols.slice(0, params.max_symbols) };
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
