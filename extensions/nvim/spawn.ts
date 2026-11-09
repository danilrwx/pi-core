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

/** How long a freshly opened Neovim may take to answer, plugins included. */
function openBudgetMs(): number {
  const value = Number(process.env.PI_NVIM_OPEN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
  let pane: string | undefined;
  try {
    // -P -F prints the pane id, so a failed handshake can close the window it
    // opened instead of leaving an empty Neovim behind.
    const { stdout } = await run(tmux, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "pi-review", "-c", cwd, command], { timeout: 10_000 });
    pane = stdout.trim() || undefined;
  } catch (error) {
    throw new Error(`Could not open Neovim in tmux: ${(error as Error).message}`);
  }

  const budget = openBudgetMs();
  const deadline = Date.now() + budget;
  // Start-up is not instant on a heavy config: wait for the socket, then keep
  // retrying the handshake instead of giving up after one attempt, which used to
  // leave the freshly opened window sitting on an empty buffer.
  while (!existsSync(socket) && Date.now() < deadline) await delay(50);
  if (!existsSync(socket)) {
    await closePane(tmux, pane);
    throw new Error(`Neovim did not create its socket at ${socket} within ${Math.round(budget / 1000)}s.`);
  }

  process.env.PI_NVIM_SOCKET = socket;
  process.env.PI_IDE_TOKEN = token;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await nvimRequest({ method: "status" }, Math.min(5_000, Math.max(1_000, deadline - Date.now())));
      return { socket, opened: true };
    } catch (error) {
      lastError = error;
      // A missing plugin or a rejected token will not fix itself by waiting.
      const message = error instanceof Error ? error.message : String(error);
      if (/Invalid Pi IDE token|dofile|Unknown tour|E\d+:/i.test(message)) break;
      await delay(200);
    }
  }

  delete process.env.PI_NVIM_SOCKET;
  delete process.env.PI_IDE_TOKEN;
  await closePane(tmux, pane);
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "no response");
  throw new Error(`Neovim opened but did not answer within ${Math.round(budget / 1000)}s: ${reason}`);
}

async function closePane(tmux: string, pane: string | undefined): Promise<void> {
  if (!pane) return;
  await run(tmux, ["kill-pane", "-t", pane], { timeout: 5_000 }).catch(() => {});
}
