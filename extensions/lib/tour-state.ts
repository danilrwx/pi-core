/**
 * The last change tour of this session, shared between the chat walkthrough and
 * the Neovim tour.
 *
 * A walkthrough already picked the stops and wrote why each exists; re-planning
 * the same change set for `/tour start` would produce a different list and lose
 * the explanations. The chat tour records itself here, and the editor tour
 * reuses it while the diff it described is still the diff on disk.
 *
 * Module-level, like the dictation registry: the extension modules share one
 * instance per session, so no file or session entry is involved.
 */

export interface SharedDeletedBlock {
  /** New-file line the block was removed before. */
  at: number;
  lines: { old: number; text: string }[];
}

export interface SharedStop {
  file: string;
  /** Line range of the hunk in the new file. */
  from: number;
  to: number;
  title: string;
  why: string;
  note?: string;
  added: number[];
  deleted: SharedDeletedBlock[];
}

export interface SharedTour {
  base: string;
  /** Files, insertions and deletions of the diff this tour describes. */
  signature: string;
  stops: SharedStop[];
}

/** Canonical `files:additions:deletions` signature, computed the same way on both sides. */
export function diffSignature(fileCount: number, additions: number, deletions: number): string {
  return `${fileCount}:${additions}:${deletions}`;
}

let last: SharedTour | undefined;

export function rememberTour(tour: SharedTour): void {
  last = tour.stops.length ? tour : undefined;
}

/** The last walkthrough of this session, if it still describes the working tree. */
export function lastTour(): SharedTour | undefined {
  return last;
}

export function forgetTour(): void {
  last = undefined;
}
