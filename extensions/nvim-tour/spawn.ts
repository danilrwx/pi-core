import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nvimRequest, nvimSocket } from "./nvim.js";

const run = promisify(execFile);
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Return a responsive Neovim socket. If none is configured and Pi runs inside tmux,
 * open Neovim in a new tmux window. Never launches anything outside a session the
 * user can actually see.
 */
export async function ensureNvim(cwd: string): Promise<{ socket: string; opened: boolean }> {
  const existing = nvimSocket();
  if (existing) {
    try { await nvimRequest({ method: "status" }, 3_000); return { socket: existing, opened: false }; }
    catch { /* Configured socket is dead; fall through to auto-open. */ }
  }
  if (process.env.PI_NVIM_AUTO_OPEN === "0") throw new Error("Neovim is not connected and auto-open is disabled (PI_NVIM_AUTO_OPEN=0).");
  if (!process.env.TMUX) throw new Error("Neovim is not connected. Start it with `nvim --listen /tmp/nvim.sock` and set PI_NVIM_SOCKET, or run Pi inside tmux so the tour can open one.");
  const socket = join(tmpdir(), `pi-tour-${process.pid}-${Date.now()}.sock`);
  const token = randomBytes(16).toString("hex");
  const plugin = fileURLToPath(new URL("../../nvim/pi-ide.lua", import.meta.url));
  const tmux = process.env.PI_TOUR_TMUX_BIN ?? "tmux";
  const command = `PI_IDE_TOKEN=${shellQuote(token)} nvim --listen ${shellQuote(socket)} -c ${shellQuote(`lua dofile('${plugin}')`)}`;
  try {
    await run(tmux, ["new-window", "-d", "-n", "pi-review", "-c", cwd, command], { timeout: 10_000 });
  } catch (error) {
    throw new Error(`Could not open Neovim in tmux: ${(error as Error).message}`);
  }
  for (let i = 0; i < 100; i++) {
    if (existsSync(socket)) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!existsSync(socket)) throw new Error(`Neovim did not create its socket at ${socket}`);
  process.env.PI_NVIM_SOCKET = socket;
  process.env.PI_IDE_TOKEN = token;
  try { await nvimRequest({ method: "status" }, 5_000); }
  catch (error) { delete process.env.PI_NVIM_SOCKET; delete process.env.PI_IDE_TOKEN; throw error; }
  return { socket, opened: true };
}
