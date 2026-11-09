/**
 * Removed lines grouped by where they were removed. `at` is the new-file line
 * the block sat before, so the editor can put the red lines back where they
 * belonged instead of stacking every deletion above the first line shown.
 */
export interface DeletedBlock { at: number; lines: { old: number; text: string }[] }
export interface Hunk { file: string; from: number; to: number; added: number[]; deleted: DeletedBlock[] }
export interface TourStop extends Hunk { expandedFrom: number; expandedTo: number; kind: "hunk" | "new-file" }

/** Pure parser for `git diff --unified=0`; one stop per hunk. */
export function parseDiffHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = "";
  let current: Hunk | undefined;
  let newLine = 0;
  let oldLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("+++ b/")) { file = line.slice(6); current = undefined; continue; }
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^"|"$/g, ""); current = undefined; continue; }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      const start = Number(match[2]);
      const length = match[3] === undefined ? 1 : Number(match[3]);
      const from = Math.max(1, start);
      const to = length === 0 ? from + 1 : Math.max(from, start + length - 1);
      current = { file, from, to, added: [], deleted: [] };
      newLine = start;
      oldLine = Number(match[1]);
      if (file && file !== "/dev/null" && to - from <= 200) hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) { current.added.push(newLine); newLine++; }
    else if (line.startsWith("-")) {
      // Group consecutive removals that happen at the same new-file position.
      const previous = current.deleted.at(-1);
      const entry = { old: oldLine, text: line.slice(1) };
      if (previous && previous.at === newLine) previous.lines.push(entry);
      else current.deleted.push({ at: newLine, lines: [entry] });
      oldLine += 1;
    } else if (line.startsWith(" ")) { newLine++; oldLine++; }
  }
  return hunks;
}

/** Expand hunks with context, merge overlaps in the same file, then cap each stop's size. */
export function buildStops(hunks: Hunk[], options: { context?: number; maxLines?: number; maxStops?: number } = {}): { stops: TourStop[]; truncated: number } {
  const context = Math.max(0, Math.min(20, options.context ?? 6));
  const maxLines = Math.max(10, Math.min(80, options.maxLines ?? 60));
  const maxStops = Math.max(1, Math.min(200, options.maxStops ?? 40));
  const stops: TourStop[] = [];
  for (const hunk of hunks) {
    const expandedFrom = Math.max(1, hunk.from - context);
    const expandedTo = Math.min(hunk.to + context, expandedFrom + maxLines - 1);
    const previous = stops.at(-1);
    if (previous && previous.file === hunk.file && expandedFrom <= previous.expandedTo + 1) {
      previous.expandedTo = Math.max(previous.expandedTo, expandedTo);
      previous.to = Math.max(previous.to, hunk.to);
      previous.added = [...new Set([...previous.added, ...(hunk.added ?? [])])].sort((a, b) => a - b);
      previous.deleted = [...previous.deleted, ...(hunk.deleted ?? [])].slice(0, 20);
      continue;
    }
    stops.push({ ...hunk, added: [...(hunk.added ?? [])], deleted: [...(hunk.deleted ?? [])], expandedFrom, expandedTo, kind: "hunk" });
  }
  const truncated = Math.max(0, stops.length - maxStops);
  return { stops: stops.slice(0, maxStops), truncated };
}
export function newFileStop(file: string, lines: number, maxLines = 40): TourStop {
  const to = Math.max(1, Math.min(lines, maxLines));
  return { file, from: 1, to, expandedFrom: 1, expandedTo: to, kind: "new-file", added: Array.from({ length: to }, (_, index) => index + 1), deleted: [] };
}

/** Number of removed lines, across every block of a stop. */
export function deletedLineCount(stop: { deleted: DeletedBlock[] }): number {
  return stop.deleted.reduce((sum, block) => sum + block.lines.length, 0);
}
