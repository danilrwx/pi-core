/**
 * Tree-sitter skeletons for `index`.
 *
 * Tree-sitter runs before the language server: it is fast, deterministic, and
 * needs no per-language server binary. Grammars are prebuilt WASM files in
 * `vendor/tree-sitter-languages/`; see THIRD_PARTY.md for provenance.
 */

import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";

export interface SkeletonSymbol { line: number; end: number; indent: number; kind: string; name: string; signature: string }
export interface Skeleton { language: string; imports: string[]; symbols: SkeletonSymbol[]; lines: number; source?: "lsp" | "tree-sitter" | "regex" }

export const MAX_SYMBOLS = 150;
const MAX_TS_NODES = 50_000;
const MAX_TS_DEPTH = 512;
const MAX_IMPORT_LINES = 25;

/** Extension → language name. `.tsx` needs its own grammar, so it is a language. */
const EXT_LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".lua": "lua",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".scala": "scala", ".sc": "scala", ".zig": "zig", ".dart": "dart",
  ".ex": "elixir", ".exs": "elixir",
  ".vue": "vue", ".svelte": "svelte",
  ".json": "json", ".html": "html", ".htm": "html",
  ".css": "css", ".toml": "toml",
  ".yaml": "yaml", ".yml": "yaml", ".tpl": "helm",
  ".md": "markdown", ".markdown": "markdown",
};

export function languageOf(file: string): string {
  return EXT_LANGUAGES[extname(file).toLowerCase()] ?? "text";
}

/** Language name → grammar file (without `.wasm`). */
const TS_GRAMMARS: Record<string, string> = {
  c: "c", cpp: "cpp", csharp: "c_sharp", scala: "scala", zig: "zig", elixir: "elixir",
  go: "go", typescript: "typescript", tsx: "tsx", javascript: "javascript",
  rust: "rust", python: "python", java: "java", kotlin: "kotlin", ruby: "ruby",
  php: "php", lua: "lua", dart: "dart", swift: "swift",
  json: "json", html: "html", css: "css", toml: "toml", vue: "vue", yaml: "yaml",
};

/** tree-sitter node type → symbol kind, for declarations whose name is the `name` field. */
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
  go: {
    function_declaration: "function", method_declaration: "method",
    type_spec: "type", type_alias: "type", const_spec: "constant", var_spec: "variable",
  },
  typescript: {
    class_declaration: "class", function_declaration: "function", method_definition: "method",
    method_signature: "method", interface_declaration: "interface", type_alias_declaration: "type",
    enum_declaration: "enum", public_field_definition: "property", property_signature: "property",
    lexical_declaration: "variable", variable_declaration: "variable",
  },
  tsx: {
    class_declaration: "class", function_declaration: "function", method_definition: "method",
    method_signature: "method", interface_declaration: "interface", type_alias_declaration: "type",
    enum_declaration: "enum", public_field_definition: "property", property_signature: "property",
    lexical_declaration: "variable", variable_declaration: "variable",
  },
  javascript: {
    class_declaration: "class", function_declaration: "function", method_definition: "method",
    lexical_declaration: "variable", variable_declaration: "variable",
  },
  rust: {
    struct_item: "struct", enum_item: "enum", union_item: "union", trait_item: "trait",
    function_item: "function", const_item: "constant", static_item: "constant", mod_item: "module",
    type_item: "type", macro_definition: "macro", impl_item: "impl",
  },
  python: {
    class_definition: "class", function_definition: "function",
  },
  java: {
    class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum",
    record_declaration: "record", method_declaration: "method", constructor_declaration: "constructor",
    annotation_type_declaration: "interface", field_declaration: "field",
  },
  kotlin: {
    class_declaration: "class", object_declaration: "object", function_declaration: "function",
    property_declaration: "property", type_alias: "type",
  },
  ruby: {
    module: "module", class: "class", method: "method", singleton_method: "method",
  },
  php: {
    class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait",
    enum_declaration: "enum", function_definition: "function", method_declaration: "method",
    namespace_definition: "namespace",
  },
  lua: {
    function_definition_statement: "function", local_function_definition_statement: "function",
  },
  dart: {
    class_definition: "class", mixin_declaration: "mixin", enum_declaration: "enum",
    extension_declaration: "extension", function_signature: "function",
    getter_signature: "getter", setter_signature: "setter",
  },
  swift: {
    class_declaration: "class", function_declaration: "function", property_declaration: "property",
    protocol_declaration: "interface", typealias_declaration: "type", enum_declaration: "enum",
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

function findChild(node: Node, type: string): Node | null {
  return node.namedChildren.find((child) => child?.type === type) ?? null;
}

/** Name from the `name` field, the common case across grammars. */
function fieldName(node: Node): string | undefined {
  const named = node.childForFieldName("name");
  return named?.text.trim() ? compact(named.text) : undefined;
}

function declarationName(node: Node, language: string, type: string): string | undefined {
  const named = fieldName(node);
  if (named) return named;

  switch (language) {
    case "c":
    case "cpp": {
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
      return identifier?.text.trim() ? compact(identifier.text) : undefined;
    }
    case "typescript":
    case "tsx":
    case "javascript":
      if (type === "lexical_declaration" || type === "variable_declaration") {
        const declarator = findChild(node, "variable_declarator");
        const name = declarator?.childForFieldName("name");
        return name?.text.trim() ? compact(name.text) : undefined;
      }
      break;
    case "rust":
      if (type === "impl_item") {
        const ty = findChild(node, "type_identifier") ?? findChild(node, "scoped_type_identifier");
        return ty?.text.trim() ? compact(ty.text) : undefined;
      }
      break;
    case "java":
      if (type === "field_declaration") {
        const declarator = findChild(node, "variable_declarator");
        const name = declarator?.childForFieldName("name");
        return name?.text.trim() ? compact(name.text) : undefined;
      }
      break;
    case "kotlin": {
      const nameNode = findChild(node, "type_identifier") ?? findChild(node, "simple_identifier");
      return nameNode?.text.trim() ? compact(nameNode.text) : undefined;
    }
    case "lua": {
      if (type === "local_variable_declaration" || type === "variable_declaration") {
        const list = findChild(node, "variable_list");
        const first = list?.namedChildren[0];
        return first?.text.trim() ? compact(first.text) : undefined;
      }
      break;
    }
    case "zig":
      if (type === "variable_declaration") {
        const identifier = node.namedChildren.find((child) => child?.type === "identifier");
        return identifier?.text.trim() ? compact(identifier.text) : undefined;
      }
      break;
    case "dart":
      if (type === "method_signature") {
        const signature = findChild(node, "function_signature");
        const name = signature?.childForFieldName("name");
        return name?.text.trim() ? compact(name.text) : undefined;
      }
      break;
  }
  return;
}

function swiftKind(node: Node): string {
  const keyword = /^\s*(struct|class|enum|protocol|extension)\b/.exec(node.text)?.[1];
  if (keyword === "struct") return "struct";
  if (keyword === "enum") return "enum";
  if (keyword === "protocol") return "interface";
  if (keyword === "extension") return "extension";
  return "class";
}

interface Declaration { kind: string; name: string }

function attributeValue(startTag: Node, name: string): string | undefined {
  for (const attr of startTag.namedChildren) {
    if (!attr || attr.type !== "attribute") continue;
    if (findChild(attr, "attribute_name")?.text !== name) continue;
    const quoted = findChild(attr, "quoted_attribute_value");
    return quoted?.namedChildren[0]?.text ?? quoted?.text.replace(/^["']|["']$/g, "");
  }
  return;
}

function markupElementName(node: Node): string | undefined {
  const start = findChild(node, "start_tag");
  const tagName = start ? findChild(start, "tag_name")?.text : undefined;
  if (!tagName) return;
  const id = start ? attributeValue(start, "id") : undefined;
  const cls = start ? attributeValue(start, "class") : undefined;
  return `${tagName}${id ? `#${id}` : ""}${cls ? `.${cls.split(/\s+/)[0]}` : ""}`;
}

function elixirDeclaration(node: Node): Declaration | undefined {
  if (node.type !== "call") return;
  const head = node.namedChildren[0];
  if (!head || head.type !== "identifier") return;
  const headText = head.text;
  if (["defmodule", "def", "defp", "defmacro", "defmacrop", "defguard", "defstruct"].includes(headText)) {
    const args = node.namedChildren.find((child) => child?.type === "arguments");
    const name = fieldName(node) ?? (args ? compact(args.text).split(/[,(]/)[0].replace(/\(.*$/s, "") : headText);
    if (!name) return;
    if (headText === "defmodule") return { kind: "module", name };
    if (headText === "defstruct") return { kind: "struct", name };
    return { kind: "function", name };
  }
  return;
}

function describe(node: Node, language: string): Declaration | undefined {
  if (language === "elixir") return elixirDeclaration(node);
  const type = node.type;

  // Declarations whose kind does not come from a node-type table.
  if (language === "python") {
    if (type === "expression_statement") {
      const assignment = findChild(node, "assignment");
      const left = assignment?.namedChildren[0];
      if (left && /^[A-Z_][A-Z0-9_]*$/.test(left.text)) return { kind: "constant", name: left.text };
    }
    if (type === "decorated_definition") {
      const inner = findChild(node, "class_definition") ?? findChild(node, "function_definition");
      return inner ? describe(inner, language) : undefined;
    }
  }
  if (language === "ruby" && type === "assignment") {
    const left = node.namedChildren[0];
    if (left?.type === "constant") return { kind: "constant", name: compact(left.text) };
  }

  // Markup and config formats: the structure, not the bodies, is what matters.
  if (language === "json" && type === "pair") {
    const parent = node.parent;
    if (parent?.type !== "object" || parent.parent?.type !== "document") return;
    const content = node.namedChildren[0]?.namedChildren[0];
    if (!content?.text.trim()) return;
    return { kind: "key", name: content.text.trim() };
  }
  if (language === "html" || language === "vue") {
    if (type === "element") {
      const name = markupElementName(node);
      if (name) return { kind: "element", name };
    }
    if (language === "vue" && (type === "script_element" || type === "style_element")) {
      const tag = type === "script_element" ? "script" : "style";
      const start = findChild(node, "start_tag");
      const lang = start ? attributeValue(start, "lang") : undefined;
      return { kind: tag, name: lang ? `${tag} (${lang})` : tag };
    }
    return;
  }
  if (language === "css") {
    if (type === "rule_set") {
      const selectors = findChild(node, "selectors");
      return selectors?.text.trim() ? { kind: "rule", name: compact(selectors.text) } : undefined;
    }
    if (type === "media_statement") {
      const query = findChild(node, "feature_query") ?? findChild(node, "media_query");
      return { kind: "media", name: query ? compact(query.text) : "media" };
    }
  }
  if (language === "yaml") {
    if (type === "block_mapping_pair" || type === "flow_pair") {
      const key = node.childForFieldName("key")?.text;
      if (key?.trim()) return { kind: "key", name: compact(key) };
    }
  }
  if (language === "toml") {
    if (type === "table" || type === "table_array_element") {
      const key = findChild(node, "bare_key") ?? findChild(node, "dotted_key");
      return key?.text.trim() ? { kind: "section", name: compact(key.text) } : undefined;
    }
    if (type === "pair") {
      const key = node.namedChildren[0];
      return key?.text.trim() ? { kind: "key", name: compact(key.text) } : undefined;
    }
  }

  let kind = DECLARATIONS[language]?.[type];
  if (!kind) return;
  const name = declarationName(node, language, type);
  if (!name) return;
  if (language === "swift" && type === "class_declaration") kind = swiftKind(node);
  return { kind, name };
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

function importLines(lines: string[], language: string): string[] {
  const patterns: Record<string, RegExp[]> = {
    python: [/^\s*(?:from\s+\S+\s+)?import\s+/, /^\s*from\s+\S+\s+import\s+/],
    go: [/^\s*import\s+/, /^\s*"(?:[\w./-]+)"\s*$/],
    rust: [/^\s*(?:pub\s+)?use\s+/],
    c: [/^\s*#\s*include\b/],
    cpp: [/^\s*#\s*include\b/],
    csharp: [/^\s*using\s+[\w.]+\s*;/],
    scala: [/^\s*import\s+/],
    zig: [/^\s*const\s+\w+\s*=\s*@import\(/],
    elixir: [/^\s*(?:alias|import|require|use)\s+/],
    typescript: [/^\s*import\s+/, /^\s*export\s+[^;]*\bfrom\s+/],
    tsx: [/^\s*import\s+/, /^\s*export\s+[^;]*\bfrom\s+/],
    javascript: [/^\s*import\s+/, /^\s*(?:const|let|var)\s+[\w${}\s,]+\s*=\s*require\(/],
    java: [/^\s*import\s+/, /^\s*package\s+/],
    kotlin: [/^\s*import\s+/, /^\s*package\s+/],
    ruby: [/^\s*(?:require|require_relative|autoload)\s+/],
    php: [/^\s*(?:use|require|require_once|include|include_once)\s+/],
    lua: [/^\s*(?:local\s+)?[\w.]+\s*=\s*require\(/],
    dart: [/^\s*(?:import|export|part)\s+['"]/],
    swift: [/^\s*import\s+/],
  };
  const rules = patterns[language] ?? [/^\s*import\s+/, /^\s*(?:const|let|var)\s+[\w${}\s,]+\s*=\s*require\(/];
  const found: string[] = [];
  const sig = (line: string) => line.trim().replace(/\s+/g, " ").slice(0, 160);
  for (let i = 0; i < lines.length && found.length < MAX_IMPORT_LINES; i++) {
    const line = lines[i];
    if (rules.some((re) => re.test(line))) found.push(`${i + 1}: ${sig(line)}`);
    else if (found.length && line.trim() && !/^\s*(?:\/\/|#|\/\*|\*)/.test(line) && i > 10) break;
  }
  return found;
}

export async function treeSitterSkeleton(text: string, file: string): Promise<Skeleton | undefined> {
  const languageName = languageOf(file);
  if (languageName === "yaml" && /{{/.test(text)) return; // Helm templates are Go-flavoured; use the regex extractor.
  const grammar = TS_GRAMMARS[languageName];
  if (!grammar) return;
  const parser = await tsParser(grammar);
  if (!parser) return;
  let tree;
  try { tree = parser.parse(text); } catch { return; }
  if (!tree) return;
  try {
    const lines = text.split(/\r?\n/);
    const found: SkeletonSymbol[] = [];
    const seen = new Set<string>();
    let visited = 0;
    const walk = (node: Node, indentDepth: number, treeDepth: number) => {
      if (++visited > MAX_TS_NODES || treeDepth > MAX_TS_DEPTH) return;
      const declaration = describe(node, languageName);
      let nextDepth = indentDepth;
      if (declaration) {
        const start = node.startPosition;
        const end = node.endPosition;
        const line = start.row + 1;
        const endLine = Math.max(line, Math.min(lines.length, end.row + (end.column > 0 ? 1 : 0)));
        const key = `${line}:${endLine}:${declaration.kind}:${declaration.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({
            line, end: endLine, indent: nextDepth * 2, kind: declaration.kind, name: declaration.name,
            signature: firstLine(node.text),
          });
        }
        nextDepth += 1;
      }
      for (const child of node.namedChildren) if (child) walk(child, nextDepth, treeDepth + 1);
    };
    walk(tree.rootNode, 0, 0);
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

export { importLines };

/**
 * Regex outline for YAML and Helm, used when tree-sitter is unavailable or the
 * file carries Go templates (`{{ ... }}`) that the YAML grammar cannot parse.
 * YAML keys are extracted by indentation; template directive lines are skipped
 * and inline actions are stripped so a key like `name: {{ .Release.Name }}`
 * still yields `name`. Helm `.tpl` files additionally report `define` names.
 */
export function markupSkeleton(text: string, file: string): Skeleton | undefined {
  const language = languageOf(file);
  if (language !== "yaml" && language !== "helm") return;
  const lines = text.split(/\r?\n/);
  const symbols: SkeletonSymbol[] = [];
  const seen = new Set<string>();

  const isDirective = (line: string) => /^\s*{{[-]?/.test(line);
  const strip = (line: string) => line.replace(/{{[-]?[^}]*[-]?}}/g, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    if (language === "helm") {
      const define = /{{-?\s*(?:define|template)\s+"([^"]+)"/.exec(raw);
      if (define) {
        const key = `define:${i}:${define[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({ line: i + 1, end: i + 1, indent: 0, kind: "define", name: define[1], signature: compact(raw) });
        }
      }
    }

    if (isDirective(raw)) continue; // {{- with ... }}, {{ end }}, {{- end }}
    const clean = strip(raw);
    if (!clean) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:(?:\s+.*)?$/.exec(clean);
    if (!match) continue;
    const indent = (match[1] ?? "").length;
    const name = match[2];
    const key = `${indent}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({ line: i + 1, end: yamlEnd(lines, i, indent), indent, kind: "key", name, signature: compact(raw) });
  }

  if (!symbols.length) return;
  symbols.sort((a, b) => a.line - b.line);
  return { language, imports: [], symbols: symbols.slice(0, MAX_SYMBOLS * 2), lines: lines.length, source: "regex" };
}

function yamlEnd(lines: string[], start: number, indent: number): number {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line) || /^\s*{{[-]?/.test(line)) continue;
    const current = (line.match(/^\s*/) ?? [""])[0].length;
    if (current <= indent) break;
    end = i + 1;
  }
  return end;
}

