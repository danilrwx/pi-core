export interface Completion { value: string; label: string; description?: string }

/**
 * Complete a slash command's arguments token by token. `tree` holds the candidates for each
 * already-completed first word; returning null means "free text, no suggestions".
 */
export function completeArgs(prefix: string, empty: string[], tree: Record<string, string[]> = {},
  hints: Record<string, string> = {}): Completion[] | null {
  const parts = prefix.split(/\s+/);
  const trailing = /\s$/.test(prefix);
  const completed = prefix.trim() === "" ? [] : parts.slice(0, -1);
  const current = trailing ? "" : parts.at(-1) ?? "";
  let candidates: string[] | undefined;
  if (completed.length === 0) candidates = empty;
  else if (completed.length === 1) candidates = tree[completed[0]];
  if (!candidates) return null;
  const matches = candidates.filter((candidate) => candidate.toLowerCase().startsWith(current.toLowerCase()));
  if (!matches.length) return null;
  return matches.map((candidate) => ({
    value: [...completed, candidate].join(" "),
    label: candidate,
    ...(hints[candidate] ? { description: hints[candidate] } : {}),
  }));
}
export function completeFirstWords(prefix: string, values: string[], hints: Record<string, string> = {}): Completion[] | null {
  if (/\s/.test(prefix.trim())) return null;
  return completeArgs(prefix, values, {}, hints);
}
