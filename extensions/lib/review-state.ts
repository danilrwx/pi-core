/**
 * Whether a review is running, shared between extensions.
 *
 * Pi loads each extension with `moduleCache: false`, so this cannot live in a
 * module variable; `globalThis` is the one place every extension sees.
 */

const KEY = Symbol.for("pi-core.review-active");

export function setReviewActive(active: boolean): void {
  (globalThis as typeof globalThis & { [KEY]?: boolean })[KEY] = active;
}

export function reviewActive(): boolean {
  return Boolean((globalThis as typeof globalThis & { [KEY]?: boolean })[KEY]);
}
