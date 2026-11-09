/**
 * The last change tour of this session, shared between the chat walkthrough and
 * the Neovim tour.
 *
 * A walkthrough already picked the stops and wrote why each exists; re-planning
 * the same change set for `/tour start` would produce a different list and lose
 * the explanations. The chat tour records itself here, and the editor tour
 * reuses it while the diff it described is still the diff on disk.
 *
 * Kept on `globalThis`, not in this module: Pi loads every extension with
 * `moduleCache: false`, so two extensions importing this file get two module
 * instances. A module-level variable would leave `/review start` blind to the
 * walkthrough that had just run.
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

interface Registry { last?: SharedTour }

const KEY = Symbol.for("pi-core.tour-state");

function registry(): Registry {
  const host = globalThis as typeof globalThis & { [KEY]?: Registry };
  host[KEY] ??= {};
  return host[KEY];
}

export function rememberTour(tour: SharedTour): void {
  registry().last = tour.stops.length ? tour : undefined;
}

/** The last walkthrough of this session, if it still describes the working tree. */
export function lastTour(): SharedTour | undefined {
  return registry().last;
}

export function forgetTour(): void {
  registry().last = undefined;
}
