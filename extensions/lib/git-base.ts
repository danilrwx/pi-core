/**
 * Which revision a change tour should compare against when the user did not say.
 *
 * The default `HEAD` only covers uncommitted work, so a finished branch or a
 * fresh commit produced an empty tour that looked like a broken command. The
 * order below answers "what did we just do" in the common cases:
 *
 * 1. uncommitted or untracked work — that is the change set;
 * 2. commits ahead of the default branch — the branch (merge base);
 * 3. a clean tree on the default branch — the last commit, `HEAD~1`;
 * 4. nothing to compare — `HEAD`, and the caller reports an empty change set.
 */

export type GitRunner = (args: string[]) => Promise<string>;

const DEFAULT_BRANCHES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

export async function resolveDiffBase(run: GitRunner): Promise<string> {
  const diff = async (ref: string) => (await run(["diff", "--name-only", ref]).catch(() => "")).trim();

  if (await diff("HEAD")) return "HEAD";
  const untracked = (await run(["ls-files", "--others", "--exclude-standard"]).catch(() => "")).trim();
  if (untracked) return "HEAD";

  for (const candidate of DEFAULT_BRANCHES) {
    try { await run(["rev-parse", "--verify", "--quiet", candidate]); } catch { continue; }
    const mergeBase = (await run(["merge-base", candidate, "HEAD"]).catch(() => "")).trim();
    if (!mergeBase) continue;
    if (await diff(mergeBase)) return mergeBase;
  }

  // Clean, nothing ahead of the default branch: review the commit that just landed.
  const parent = await run(["rev-parse", "--verify", "--quiet", "HEAD~1"]).catch(() => "");
  if (parent.trim() && await diff("HEAD~1")) return "HEAD~1";

  return "HEAD";
}
