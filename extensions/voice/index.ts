import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { completeArgs } from "../lib/complete.js";
import { ApiDictation, type DictationSession } from "./api.js";
import { DEFAULT_VOICE, LocalDictation, type VoiceBackend, type VoiceConfig } from "./recorder.js";
import { formatElapsed, VoicePanel } from "./ui.js";

const STRING_FIELDS = ["model", "language", "whisperBin", "recorderBin", "vocabulary", "apiUrl", "apiModel", "apiKeyEnv"] as const;
export function validateVoice(value: unknown): VoiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("voice.json must contain an object");
  const config = { ...DEFAULT_VOICE, ...value } as VoiceConfig;
  if (config.backend !== "local" && config.backend !== "nari") throw new Error("Voice backend must be local or nari");
  for (const key of STRING_FIELDS) {
    if (typeof config[key] !== "string" || config[key].length > 4096) throw new Error(`Invalid voice.${key}`);
  }
  if (!/^(auto|[a-z]{2,3})$/.test(config.language)) throw new Error("Voice language must be auto or a short language code");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv)) throw new Error("apiKeyEnv must be an environment variable name");
  if (!config.apiModel.trim()) throw new Error("apiModel must not be empty");
  return config;
}
async function config(): Promise<VoiceConfig> {
  try { return validateVoice(JSON.parse(await readFile(join(getAgentDir(), "voice.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_VOICE }; throw error; }
}
async function save(config: VoiceConfig): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const path = join(getAgentDir(), "voice.json"), temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

export default function voice(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let recording: DictationSession | undefined;
  let panel: VoicePanel | undefined;
  let activeBackend: VoiceBackend = "local";
  let phase: "idle" | "starting" | "recording" | "transcribing" = "idle";
  let muted = false;
  let epoch = 0;
  let unsubscribe: (() => void) | undefined;
  let levelAt = 0;
  let lastLevel = 0;
  let liveText = "";
  let startedAt = 0;
  let elapsed = 0;
  let ticker: NodeJS.Timeout | undefined;
  let cancellation: Promise<void> | undefined;

  const status = (text?: string) => ctx?.ui.setStatus("voice", text);
  function updatePanel() {
    panel?.set({ backend: activeBackend, muted, level: lastLevel, text: liveText, elapsed });
    status(phase === "idle" ? undefined : muted ? "🔇 muted" : `🎙 ${formatElapsed(elapsed)}`);
  }
  function openPanel() {
    if (!ctx || ctx.mode !== "tui") return;
    panel = undefined;
    ctx.ui.setWidget("voice", (tui, theme) => {
      panel = new VoicePanel(tui, theme);
      updatePanel();
      return panel;
    }, { placement: "aboveEditor" });
  }
  function closePanel() {
    clearInterval(ticker); ticker = undefined;
    panel = undefined;
    ctx?.ui.setWidget("voice", undefined);
  }
  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      if (phase !== "recording") return;
      elapsed = Math.floor((Date.now() - startedAt) / 1000);
      updatePanel();
    }, 500);
    ticker.unref();
  }
  function cancel(): Promise<void> {
    if (cancellation) return cancellation;
    const generation = ++epoch;
    const old = recording; recording = undefined; phase = "starting"; liveText = "";
    return cancellation = (async () => {
      try { await old?.cancel(); }
      finally {
        if (generation === epoch) { phase = "idle"; muted = false; closePanel(); status(); }
        cancellation = undefined;
      }
    })();
  }
  async function finish() {
    if (!recording || phase !== "recording") return;
    const current = recording, generation = epoch, backend = activeBackend;
    phase = "transcribing";
    liveText = "finalizing…"; lastLevel = 0; updatePanel();
    try {
      const text = await current.transcribe();
      if (generation !== epoch || !ctx) return;
      ctx.ui.pasteToEditor(text); // Preserve the existing draft; the user presses Enter.
      const cost = current instanceof ApiDictation ? ` · ~$${current.estimatedCostUsd().toFixed(4)} estimated` : "";
      ctx.ui.notify(`Dictation inserted into the draft${cost}. Review before sending.`, "info");
    } catch (error) {
      if (generation === epoch) ctx?.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      await current.cleanup();
      if (generation === epoch) { recording = undefined; phase = "idle"; muted = false; liveText = ""; closePanel(); status(); }
    }
  }
  async function toggle() {
    if (phase === "recording") return finish();
    if (phase !== "idle") { ctx?.ui.notify("Voice is busy; /voice cancel stops it.", "info"); return; }
    const generation = ++epoch;
    phase = "starting"; liveText = ""; muted = false; elapsed = 0;
    status("🎙 opening microphone…");
    try {
      const settings = await config();
      if (generation !== epoch) return;
      activeBackend = settings.backend;
      const level = (value: number) => {
        lastLevel = value;
        if (generation !== epoch || Date.now() - levelAt < 80) return;
        levelAt = Date.now(); updatePanel();
      };
      const partial = (text: string) => {
        if (generation !== epoch) return;
        liveText = text; updatePanel();
      };
      const expired = () => { if (generation === epoch) void finish(); };
      const current: DictationSession = activeBackend === "nari"
        ? new ApiDictation(settings, process.env[settings.apiKeyEnv] ?? "", level, partial, expired)
        : new LocalDictation(settings, level, expired);
      recording = current;
      await current.start();
      if (generation !== epoch) { await current.cancel(); return; }
      phase = "recording"; startedAt = Date.now();
      openPanel(); startTicker(); updatePanel();
    } catch (error) {
      if (generation === epoch) {
        await recording?.cancel(); recording = undefined; phase = "idle"; closePanel(); status();
        ctx?.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }
  function toggleMute() {
    if (phase !== "recording" || !recording) { ctx?.ui.notify("Not recording; nothing to mute.", "info"); return; }
    muted = !muted;
    recording.setMuted(muted);
    if (muted) lastLevel = 0;
    updatePanel();
    ctx?.ui.notify(muted ? "Microphone muted: audio is discarded and not sent." : "Microphone unmuted.", "info");
  }
  pi.on("session_start", (_event, context) => {
    ctx = context;
    if (context.mode !== "tui") return;
    unsubscribe = context.ui.onTerminalInput((data) => {
      if (phase !== "idle" && matchesKey(data, "escape")) { void cancel(); return { consume: true }; }
    });
  });
  pi.on("session_shutdown", async () => { unsubscribe?.(); unsubscribe = undefined; await cancel(); ctx = undefined; });
  pi.registerShortcut("alt+m", { description: "Start/stop dictation (review draft before Enter)", handler: async () => { if (ctx?.mode === "tui") await toggle(); } });
  pi.registerShortcut("alt+u", { description: "Mute/unmute the active dictation stream", handler: async () => { if (ctx?.mode === "tui") toggleMute(); } });
  pi.registerCommand("voice", {
    description: "Dictation: /voice, mute, cancel, status, api nari|local, model <file>, language <ru|en|auto>",
    getArgumentCompletions: (prefix) => completeArgs(prefix,
      ["mute", "cancel", "status", "api", "model", "language"],
      { api: ["nari", "local"], language: ["auto", "ru", "en", "de", "es", "fr", "it", "pt", "uk", "pl", "tr", "zh", "ja"] },
      { mute: "pause sending audio (Alt+U)", cancel: "stop recording or transcription", status: "show backend, key and model",
        api: "switch STT backend", model: "local Whisper model file", language: "spoken language (auto = detect)",
        nari: "streaming Nari API (audio leaves the machine)", local: "offline whisper.cpp" }),
    handler: async (args, context) => {
      if (context.mode !== "tui") { context.ui.notify("Voice needs the interactive terminal on the microphone's machine.", "warning"); return; }
      ctx = context;
      const arg = args.trim();
      if (!arg) return toggle();
      if (arg === "mute") return toggleMute();
      if (arg === "cancel") return cancel();
      if (arg === "status") {
        const current = await config();
        const key = process.env[current.apiKeyEnv] ? "set" : "missing";
        context.ui.notify([
          `Voice: ${phase}${muted ? " (muted)" : ""}; backend ${current.backend}; nothing is auto-submitted`,
          `API: ${current.apiUrl} · model ${current.apiModel} · ${current.apiKeyEnv}: ${key}`,
          `Local: ${current.model || "model not configured"} · ${current.whisperBin} · recorder ${current.recorderBin}`,
          `Language: ${current.language}; config ${join(getAgentDir(), "voice.json")}`,
        ].join("\n"), "info");
        return;
      }
      if (phase !== "idle") throw new Error("Stop or cancel dictation before changing its configuration");
      const current = await config();
      if (arg === "api" || arg.startsWith("api ")) {
        const value = arg.slice(3).trim();
        if (!value) { context.ui.notify(`API backend: ${current.backend}. Use /voice api nari or /voice api local.`, "info"); return; }
        if (value !== "nari" && value !== "local") { context.ui.notify("Usage: /voice api nari|local", "info"); return; }
        current.backend = value;
        await save(validateVoice(current));
        if (value === "nari") {
          const missing = !process.env[current.apiKeyEnv];
          context.ui.notify(`API dictation enabled: audio streams to ${new URL(current.apiUrl).host} and is not stored locally.${missing ? ` Set ${current.apiKeyEnv} first.` : ""} Use /voice language ru/en if auto detection is inaccurate.`, missing ? "warning" : "info");
        } else context.ui.notify("Local dictation enabled; a local multilingual Whisper model is required.", "info");
        return;
      }
      if (arg.startsWith("model ")) {
        const path = arg.slice(6).trim().replace(/^['"]|['"]$/g, "");
        current.model = resolve(context.cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
      } else if (arg.startsWith("language ")) current.language = arg.slice(9).trim();
      else { context.ui.notify("Usage: /voice [mute|cancel|status|api nari|local|model <file>|language <auto|ru|en>]", "info"); return; }
      await save(validateVoice(current));
      context.ui.notify("Dictation configuration saved.", "info");
    },
  });
}
