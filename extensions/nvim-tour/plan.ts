export interface Hunk { file: string; from: number; to: number; added: number[]; deleted: string[] }
export interface TourStop extends Hunk { expandedFrom: number; expandedTo: number; kind: "hunk" | "new-file" }

/** Pure parser for `git diff --unified=0`; one stop per hunk. */
export function parseDiffHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = "";
  let current: Hunk | undefined;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; continue; }
    if (line.startsWith("+++ b/")) { file = line.slice(6); current = undefined; continue; }
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^"|"$/g, ""); current = undefined; continue; }
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      const start = Number(match[1]);
      const length = match[2] === undefined ? 1 : Number(match[2]);
      const from = Math.max(1, start);
      const to = length === 0 ? from + 1 : Math.max(from, start + length - 1);
      current = { file, from, to, added: [], deleted: [] };
      newLine = start;
      if (file && file !== "/dev/null" && to - from <= 200) hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) { current.added.push(newLine); newLine++; }
    else if (line.startsWith("-")) current.deleted.push(line.slice(1));
    else if (line.startsWith(" ")) newLine++;
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
      previous.deleted = [...previous.deleted, ...(hunk.deleted ?? [])].slice(0, 50);
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
