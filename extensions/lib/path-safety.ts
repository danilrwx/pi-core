import { isAbsolute, relative, resolve, sep } from "node:path";

/** True when `path` resolves to cwd itself or a descendant, without prefix tricks. */
export function isInside(cwd: string, path: string): boolean {
  const rel = relative(resolve(cwd), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
