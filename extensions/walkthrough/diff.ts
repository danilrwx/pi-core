/**
 * Minimal unified-diff reader for the walkthrough tool.
 *
 * The tour never trusts diff text from the model: the extension runs `git diff`
 * itself and the model only names the file and hunk it wants to talk about.
 * That keeps what the reader sees identical to the working tree.
 */

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  /** Raw `@@ -1,2 +3,4 @@` header. */
  header: string;
  /** Text after the closing `@@`, usually the enclosing function. */
  context: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  /** Set for renames. */
  oldPath?: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** Parse `git diff` output. Unknown metadata lines are skipped, not fatal. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const startHunk = (match: RegExpExecArray) => {
    oldLine = Number(match[1]);
    newLine = Number(match[3]);
    hunk = {
      // Header without the trailing context text, which lives in `context`:
      // appending both would print the enclosing function twice.
      header: `@@ -${match[1]}${match[2] === undefined ? "" : `,${match[2]}`} +${match[3]}${match[4] === undefined ? "" : `,${match[4]}`} @@`,
      context: match[5] ?? "",
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    };
    file?.hunks.push(hunk);
  };

  for (const raw of text.split("\n")) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      file = { path: header[2], binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("rename from ")) { file.oldPath = raw.slice(12); continue; }
    if (raw.startsWith("rename to ")) { file.path = raw.slice(10); continue; }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) { file.binary = true; continue; }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ")
      || raw.startsWith("new file mode") || raw.startsWith("deleted file mode")
      || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("similarity index")
      || raw.startsWith("dissimilarity index")) continue;

    const hunkHeader = HUNK_HEADER.exec(raw);
    if (hunkHeader) { startHunk(hunkHeader); continue; }
    if (!hunk) continue;
    if (raw.startsWith("\\ No newline")) continue;

    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: body, newLine: newLine++ });
      file.additions += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: body, oldLine: oldLine++ });
      file.deletions += 1;
    } else if (marker === " ") {
      hunk.lines.push({ kind: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return files;
}

/** New-file span of a hunk, used to resolve a stop that names line numbers. */
export function hunkSpan(hunk: Hunk): [number, number] {
  const start = hunk.newStart;
  return [start, start + Math.max(0, hunk.newCount - 1)];
}

/**
 * Pick the hunks a stop talks about. A stop may name a hunk index, a line range
 * in the new file, or nothing (then the first hunks are used).
 */
export function selectHunks(
  file: FileDiff, stop: { hunk?: number; lines?: readonly number[] }, maxHunks = 2,
): { hunks: Hunk[]; reason?: string } {
  if (!file.hunks.length) return { hunks: [], reason: file.binary ? "binary file" : "no hunks" };

  if (stop.hunk !== undefined) {
    const index = Math.trunc(stop.hunk) - 1;
    const hunk = file.hunks[index];
    if (hunk) return { hunks: [hunk] };
    return { hunks: [file.hunks[0]], reason: `hunk ${stop.hunk} does not exist (file has ${file.hunks.length})` };
  }

  if (stop.lines && stop.lines.length >= 2) {
    const from = Math.min(stop.lines[0], stop.lines[1]);
    const to = Math.max(stop.lines[0], stop.lines[1]);
    const matching = file.hunks.filter((hunk) => {
      const [start, end] = hunkSpan(hunk);
      return start <= to && end >= from;
    });
    if (matching.length) return { hunks: matching.slice(0, maxHunks) };
    return { hunks: file.hunks.slice(0, maxHunks), reason: `no hunk covers lines ${from}-${to}` };
  }

  return { hunks: file.hunks.slice(0, maxHunks) };
}

/** Match a path the model wrote against the paths in the diff. */
export function findFile(files: readonly FileDiff[], wanted: string): FileDiff | undefined {
  const normalized = wanted.replace(/^\.\//, "");
  return files.find((file) => file.path === normalized)
    ?? files.find((file) => file.oldPath === normalized)
    ?? files.find((file) => file.path.endsWith(`/${normalized}`))
    ?? files.find((file) => normalized.endsWith(`/${file.path}`));
}
