import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface IdeEndpoint { socket: string; token?: string; pid?: number; workspace?: string }

export function ideDirs(): string[] {
  const dirs = [process.env.PI_IDE_DIR, process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "pi-ide") : undefined,
    join(homedir(), ".pi", "ide"), join(tmpdir(), "pi-ide")];
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function contains(workspace: string, cwd: string): boolean {
  const base = resolve(workspace), target = resolve(cwd);
  return target === base || target.startsWith(`${base}/`);
}

/** Find the newest live Neovim endpoint whose workspace contains cwd. */
export function discoverIde(cwd: string): IdeEndpoint | undefined {
  let best: { endpoint: IdeEndpoint; mtime: number } | undefined;
  for (const dir of ideDirs()) {
    let names: string[];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".lock")); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      let data: any;
      try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      if (!data || typeof data.socket !== "string" || !data.socket) continue;
      if (!existsSync(data.socket)) continue;
      if (typeof data.pid === "number" && !alive(data.pid)) continue;
      const workspace = Array.isArray(data.workspaceFolders)
        ? data.workspaceFolders.find((entry: unknown) => typeof entry === "string" && contains(entry, cwd))
        : undefined;
      if (!workspace) continue;
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { /* keep zero */ }
      if (!best || mtime > best.mtime) best = { endpoint: { socket: data.socket, token: data.authToken, pid: data.pid, workspace }, mtime };
    }
  }
  return best?.endpoint;
}
