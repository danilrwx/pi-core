import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { discoverIde, type IdeEndpoint } from "./discovery.js";
import { fileURLToPath } from "node:url";

const CLIENT = fileURLToPath(new URL("./client.lua", import.meta.url));
const BRIDGE = fileURLToPath(new URL("./bridge.lua", import.meta.url));

export function nvimSocket(): string | undefined {
  const value = process.env.PI_NVIM_SOCKET || process.env.DUET_NVIM_SOCKET || process.env.NVIM_LISTEN_ADDRESS;
  return value?.trim() || undefined;
}

/**
 * Endpoint priority: an explicit socket that still exists, then a live lock
 * published by nvim/pi-ide.lua, then a configured but missing socket (so the
 * request fails with a clear message instead of silently going elsewhere).
 *
 * Env first matters because `ensureNvim` spawns a window and records its socket
 * there: with discovery first, a second Neovim sitting in the same workspace
 * won the race and the tour was installed into the wrong one, leaving the
 * freshly opened window on an empty buffer.
 */
export function resolveEndpoint(cwd = process.cwd()): IdeEndpoint | undefined {
  const socket = nvimSocket();
  if (socket && existsSync(socket)) return { socket, token: process.env.PI_IDE_TOKEN };
  const lock = discoverIde(cwd);
  if (lock) return lock;
  return socket ? { socket, token: process.env.PI_IDE_TOKEN } : undefined;
}
export function hasNvim(cwd = process.cwd()): boolean {
  return Boolean(resolveEndpoint(cwd));
}

export interface NvimResult { file: string; from_line: number; to_line: number; text: string }
export async function nvimRequest<T = NvimResult>(request: Record<string, unknown>, timeoutMs = 8_000): Promise<T> {
  const cwd = typeof request.root === "string" ? request.root : process.cwd();
  const target = resolveEndpoint(cwd);
  if (!target) throw new Error("Neovim is not connected. Load nvim/pi-ide.lua in your init.lua (it publishes a lock file), or start it with `nvim --listen /tmp/nvim.sock` and set PI_NVIM_SOCKET.");
  const socket = target.socket;
  const payload = target.token ? { ...request, token: target.token } : request;
  const testBin = process.env.PI_TOUR_NVIM_BIN;
  const command = testBin || "nvim";
  const args = testBin ? [] : ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-l", CLIENT];
  const child = spawn(command, args, {
    env: { ...process.env, PI_TOUR_SOCKET: socket, PI_TOUR_REQUEST: JSON.stringify(payload), PI_TOUR_BRIDGE: BRIDGE, PI_TOUR_BRIDGE_VERSION: String(statSync(BRIDGE).mtimeMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 262_144) stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exit) => { clearTimeout(timer); resolve(exit); });
  });
  if (!stdout.trim()) throw new Error(`Neovim request failed without a response${stderr ? `: ${stderr.trim()}` : ""}`);
  let response: { ok?: boolean; result?: T; error?: string };
  try { response = JSON.parse(stdout.trim()); }
  catch { throw new Error("Neovim returned an invalid response"); }
  if (!response.ok) throw new Error(response.error || `Neovim exited with status ${code}`);
  return response.result as T;
}
