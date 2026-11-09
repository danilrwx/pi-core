/**
 * Pure helpers for the local RTK integration.
 *
 * The unsafe-rewrite and find-predicate checks are adapted from
 * @bacnh85/pi-rtk (MIT) and pi-rtk-rewrite (MIT). See THIRD_PARTY.md.
 */

export const MIN_RTK_VERSION: readonly [number, number, number] = [0, 23, 0];
export const FIND_PASSTHROUGH_VERSION: readonly [number, number, number] = [0, 46, 0];

export function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.trim().replace(/^rtk\s+/i, "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeastVersion(current: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}

const TRUTHY = /^(?:1|true|yes|on)$/i;

export function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.test((env.RTK_DISABLED ?? "").trim());
}

export function commandDisabled(command: string): boolean {
  return /(?:^|\s)RTK_(?:DISABLED|DISABLE_REWRITE)\s*=\s*(?:1|true|yes|on)(?:\s|$)/i.test(command);
}

export function shouldSkipRewrite(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (/^rtk(?:\s|$)/.test(trimmed)) return true;
  if (commandDisabled(trimmed)) return true;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return true;
  return false;
}

/**
 * RTK cannot safely rewrite inline programs: the command text is data for an
 * interpreter, not a shell command line.
 */
const SCRIPT_COMMAND = /^(?:env\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*)?(?:(?:\/[\w/.-]+)?\b(?:node|python|python3|ruby|perl|php|deno|bun|lua|perl6|raku|tclsh|groovy|julia|Rscript|ghci|dart|swift|bash|sh|zsh|ksh|fish|dash|ash|csh|tcsh)\s+)(?:-\S+\s+)*(?:-[pecrE]{1,3}|--eval|--print|eval(?=\s|$)|-c(?=\s|$))\b/;

export function isEvalCommand(command: string): boolean {
  return SCRIPT_COMMAND.test(command.trim());
}

type CharKind = "live" | "single" | "double" | "escaped";

/** Classify shell characters so quoted parentheses and `$` are not treated as live syntax. */
export function shellCharKinds(text: string): CharKind[] {
  const kinds: CharKind[] = Array.from({ length: text.length }, () => "live");
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      kinds[i] = kinds[i + 1] = "escaped";
      i += 2;
      continue;
    }
    if (char === "'") {
      kinds[i] = "single";
      const end = text.indexOf("'", i + 1);
      if (end === -1) break;
      for (let j = i + 1; j < end; j++) kinds[j] = "single";
      i = end + 1;
      continue;
    }
    if (char === '"') {
      kinds[i] = "double";
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          kinds[j] = kinds[j + 1] = "double";
          j += 2;
          continue;
        }
        kinds[j] = "double";
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return kinds;
}

/**
 * Accept RTK's usual `rtk <same-command>` form, plus its read shorthands.
 * Reject shell operators, command substitutions and inline scripts.
 */
export function isSafeRewrite(original: string, rewritten: string): boolean {
  if (isEvalCommand(original) || isEvalCommand(rewritten)) return false;
  const originalFirst = original.trim().split(/\s+/)[0] ?? "";
  const match = /^rtk\s+(\S+)/.exec(rewritten.trim());
  if (!match) return false;
  const rtkSubcommand = match[1];
  const sameCommand = rtkSubcommand === originalFirst;
  const readShortcut = rtkSubcommand === "read" && ["cat", "head", "tail"].includes(originalFirst);
  if (!sameCommand && !readShortcut) return false;

  // A compound command may contain independent commands; RTK's rewrite of
  // one part must not change the meaning of the whole line.
  if (/[|><;&`]/.test(rewritten)) return false;
  const kinds = shellCharKinds(rewritten);
  for (let i = 0; i < rewritten.length; i++) {
    const char = rewritten[i];
    if (kinds[i] === "single" || kinds[i] === "escaped") continue;
    if (char === "$" && rewritten[i + 1] === "(") return false;
    if ((char === "(" || char === ")") && kinds[i] === "live") return false;
  }
  return true;
}

const UNSAFE_FIND_TOKENS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete",
  "-print0", "-fprint", "-fprint0", "-fprintf",
  "-regex", "-iregex", "-regextype",
]);

const SHELL_SEPARATORS = new Set(["|", "&&", "||", ";"]);

function tokens(command: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: string | undefined;
  const flush = () => { if (token) { result.push(token); token = ""; } };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (char === "&" && command[i + 1] === "&") { flush(); result.push("&&"); i += 1; continue; }
    if (char === "|" && command[i + 1] === "|") { flush(); result.push("||"); i += 1; continue; }
    if (char === "|" || char === ";" || char === "(" || char === ")") { flush(); result.push(char); continue; }
    if (char === "\\" && i + 1 < command.length) token += command[++i];
    else token += char;
  }
  flush();
  return result;
}

/** Reject `rtk find` invocations whose output contract RTK cannot preserve. */
export function hasUnsupportedFind(rewritten: string): boolean {
  const words = tokens(rewritten);
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] !== "rtk" || words[i + 1] !== "find") continue;
    for (let j = i + 2; j < words.length && !SHELL_SEPARATORS.has(words[j]); j++) {
      if (UNSAFE_FIND_TOKENS.has(words[j])) return true;
    }
  }
  return false;
}

export function acceptableRewrite(original: string, rewritten: string | null): string | undefined {
  if (!rewritten) return;
  const next = rewritten.trim();
  if (!next || next === original.trim()) return;
  if (!isSafeRewrite(original, next)) return;
  if (hasUnsupportedFind(next)) return;
  return next;
}
