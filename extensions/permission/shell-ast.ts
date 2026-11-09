import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import { parse as words } from "shell-quote";
import { classifyLiteralCommand, isYoloDangerous, LEVEL_INDEX, type Classification, type PermissionConfig } from "./permission-core.js";
export { isYoloDangerous };

const grammar = fileURLToPath(new URL("../../vendor/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url));
let parser: Promise<Parser> | undefined;
export function loadShellParser(): Promise<Parser> {
  return parser ??= (async () => {
    await Parser.init();
    const p = new Parser();
    p.setLanguage(await Language.load(grammar));
    return p;
  })();
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "nice", "timeout", "stdbuf"]);
const EXPANSIONS = new Set(["expansion", "simple_expansion", "command_substitution", "process_substitution", "arithmetic_expansion"]);
const SAFE_REDIRECTS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"]);
export interface ShellAssessment extends Classification { commands: string[]; reasons: string[] }

/** Parse structure first, classify every executable segment, never whitelist an entire compound prefix. */
export async function classifyShellCommand(source: string, config?: PermissionConfig, depth = 0): Promise<ShellAssessment> {
  const answer: ShellAssessment = { level: "minimal", dangerous: false, commands: [], reasons: [] };
  const risky = (reason: string) => {
    answer.level = "high";
    answer.dangerous = true;
    if (!answer.reasons.includes(reason)) answer.reasons.push(reason);
  };
  const merge = (next: Classification) => {
    if (LEVEL_INDEX[next.level] > LEVEL_INDEX[answer.level]) answer.level = next.level;
    answer.dangerous ||= next.dangerous;
  };
  if (source.length > 65536 || depth > 4) { risky("Shell analysis limit reached"); return answer; }
  let tree;
  try { tree = (await loadShellParser()).parse(source); }
  catch { risky("Shell AST parser unavailable"); return answer; }
  if (!tree) { risky("Shell AST parser produced no tree"); return answer; }
  try {
    if (tree.rootNode.hasError) risky("Shell syntax is not fully understood");
    const stack: Node[] = [tree.rootNode];
    let count = 0;
    while (stack.length) {
      if (++count > 10000) { risky("Shell AST node limit reached"); break; }
      const node = stack.pop()!;
      stack.push(...node.namedChildren.filter((child): child is Node => child !== null));
      if (EXPANSIONS.has(node.type)) risky("Dynamic shell expansion needs explicit approval");
      if (node.type === "variable_assignment" && /^(PATH|ENV|BASH_ENV|SHELLOPTS|LD_[A-Z_]+)=/.test(node.text)) risky("Execution environment is modified");
      if (node.type === "file_redirect") {
        const target = node.childForFieldName("destination")?.text;
        if (/[>]/.test(node.text) && target && !SAFE_REDIRECTS.has(target) && !/^\d+$/.test(target)) {
          merge({ level: "low", dangerous: false });
          if (/^['"]?\/(etc|dev)\//.test(target)) risky("Writes to a system path");
        }
      }
      if (node.type !== "command") continue;
      const name = node.childForFieldName("name");
      if (!name) { risky("Command name is unresolved"); continue; }
      // Only literal argv is decoded. shell-quote never receives environment access.
      let argv: string[];
      try {
        const parsed = words(node.text, () => "__DYNAMIC__");
        if (parsed.some((part) => typeof part !== "string")) { risky("Non-literal command arguments"); continue; }
        argv = parsed as string[];
      } catch { risky("Cannot decode command arguments"); continue; }
      while (argv[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
      const commandName = argv[0]?.split("/").pop()?.replace(/^\\/, "") ?? "";
      answer.commands.push(node.text);
      // A user allow-pattern may change the level, but may not hide intrinsically dangerous commands.
      const intrinsic = classifyLiteralCommand(argv, node.text, {});
      merge(classifyLiteralCommand(argv, node.text, config));
      answer.dangerous ||= intrinsic.dangerous;
      if (commandName === "eval" || commandName === "source" || commandName === ".") risky("Runtime shell code needs explicit approval");
      if (SHELLS.has(commandName)) {
        const flag = argv.findIndex((arg, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
        if (flag >= 0 && argv[flag + 1] !== undefined) {
          const inner = await classifyShellCommand(argv[flag + 1], config, depth + 1);
          merge(inner); answer.commands.push(...inner.commands); answer.reasons.push(...inner.reasons);
        } else risky("Shell script body is not available for analysis");
      }
      if (WRAPPERS.has(commandName)) {
        let rest = argv.slice(1);
        if (commandName === "env") {
          while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || rest[0] === "--" || rest[0] === "-i")) rest.shift();
        } else if (["command", "builtin", "exec", "nohup"].includes(commandName)) {
          if (rest[0] === "--") rest.shift();
        } else { risky("Wrapper options require explicit approval"); rest = []; }
        if (rest.length && !rest[0].startsWith("-")) {
          const innerSource = rest.map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" ");
          const inner = await classifyShellCommand(innerSource, config, depth + 1);
          merge(inner); answer.commands.push(...inner.commands); answer.reasons.push(...inner.reasons);
        } else risky("Wrapped command is unresolved");
      }
      if (commandName === "find" && argv.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(arg))) risky("find can execute commands or delete files");
      if (commandName === "xargs") risky("xargs builds argv from external input");
      if (commandName === "patch") risky("patch modifies files");
      if (commandName === "sed") {
        const inPlace = argv.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place");
        const script = argv.slice(1).filter((arg) => !arg.startsWith("-")).join(" ");
        // `sed -n '1,20p'` is read-only; `w`, `e`, or `-i` can write/execute.
        if (inPlace || /(?:^|[;{}])\s*[we]\b/.test(script)) risky("sed can modify files or execute code");
      }
      if (commandName === "awk" || commandName === "gawk") {
        const script = argv.slice(1).filter((arg) => !arg.startsWith("-")).join(" ");
        if (/\bsystem\s*\(|\|\s*getline|(?:print|printf)\b[^;]*>/.test(script)) risky("awk can execute code or write files");
      }
    }
  } finally { tree.delete(); }
  if (answer.dangerous) answer.level = "high";
  return answer;
}
