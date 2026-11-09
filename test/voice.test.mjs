import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { jiti } from "./host.mjs";
const { DEFAULT_VOICE, LocalDictation, wavHeader, audioLevel } = await jiti.import("../extensions/voice/recorder.ts");
const voice = await jiti.import("../extensions/voice/index.ts");

async function fixture(silent = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-voice-fixture-"));
  const model = join(dir, "model.bin"); await writeFile(model, "fixture model; never sent to real Whisper");
  const recorderBin = join(dir, "recorder");
  await writeFile(recorderBin, `#!${process.execPath}\nprocess.on('SIGINT',()=>process.exit(0));const pcm=Buffer.alloc(12000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(${silent ? 0 : 5000},i);process.stdout.write(pcm);setInterval(()=>{},1000);\n`);
  const whisperBin = join(dir, "transcriber");
  await writeFile(whisperBin, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const wav=fs.readFileSync(args[args.indexOf('-f')+1]);if(wav.toString('ascii',0,4)!=='RIFF'||wav.readUInt32LE(40)!==12000)process.exit(2);fs.writeFileSync(args[args.indexOf('-of')+1]+'.txt','Проверь KubeVirt controller.');\n`);
  await chmod(recorderBin, 0o755); await chmod(whisperBin, 0o755);
  return { ...DEFAULT_VOICE, model, recorderBin, whisperBin };
}
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(20); } assert.fail("Timed out"); }

test("voice WAV header and level are deterministic", () => {
  const header = wavHeader(32000);
  assert.equal(header.readUInt32LE(24), 16000); assert.equal(header.readUInt32LE(40), 32000);
  assert.equal(audioLevel(Buffer.alloc(20)), 0);
});

test("local dictation records privately, produces text and removes temporary audio", async () => {
  const config = await fixture(); let heard = false;
  const recording = new LocalDictation(config, () => { heard = true; }, () => {});
  try {
    await recording.start(); await until(() => heard);
    const path = recording.directory;
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(path, 'audio.wav'))).mode & 0o777, 0o600);
    assert.equal(await recording.transcribe(), "Проверь KubeVirt controller.");
    await recording.cleanup(); await assert.rejects(stat(path), /ENOENT/);
  } finally { await recording.cancel(); }
});

test("silence is not turned into hallucinated text", async () => {
  let heard = false; const recording = new LocalDictation(await fixture(true), () => { heard = true; }, () => {});
  try { await recording.start(); await until(() => heard); await assert.rejects(recording.transcribe(), /silent/); }
  finally { await recording.cancel(); }
});

test("cancel stops capture and discards audio without transcription", async () => {
  let heard = false; const recording = new LocalDictation(await fixture(), () => { heard = true; }, () => {});
  await recording.start(); await until(() => heard); const path = recording.directory;
  await recording.cancel(); await assert.rejects(stat(path), /ENOENT/);
  await assert.rejects(recording.transcribe(), /cancelled/);
});

test("missing model never opens the microphone", async () => {
  let touched = false;
  const recording = new LocalDictation({ ...DEFAULT_VOICE }, () => { touched = true; }, () => {});
  await assert.rejects(recording.start(), /Set a local/); assert.equal(touched, false);
});

test("voice inserts into the current draft, never submits, and does not auto-start", async () => {
  const cfg = await fixture(), dir = await mkdtemp(join(tmpdir(), "pi-core-voice-ui-"));
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  await writeFile(join(dir, "voice.json"), JSON.stringify(cfg), { mode: 0o600 });
  const hooks = new Map(), commands = new Map(), levels = [];
  let text = "existing draft ", submitted = 0;
  voice.default({ on(name, fn) { hooks.set(name, fn); }, registerCommand(name, cmd) { commands.set(name, cmd); }, registerShortcut() {}, sendUserMessage() { submitted++; } });
  const ctx = { mode: "tui", cwd: dir, ui: { setStatus(_key, text) { levels.push(text); }, notify() {},
    setWidget() {}, onTerminalInput() { return () => {}; }, pasteToEditor(value) { text += value; } } };
  try {
    await hooks.get("session_start")({}, ctx); assert.equal(levels.length, 0);
    await commands.get("voice").handler("", ctx);
    // The recorder writes asynchronously; let a chunk arrive before stopping.
    await delay(250);
    text += "typed while recording ";
    await commands.get("voice").handler("", ctx);
    assert.equal(text, "existing draft typed while recording Проверь KubeVirt controller.");
    assert.equal(submitted, 0);
  } finally {
    await hooks.get("session_shutdown")({}, ctx);
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
  }
});

test("voice config rejects invalid input", () => {
  assert.throws(() => voice.validateVoice({ language: "--shell" }), /language/);
  assert.throws(() => voice.validateVoice({ model: 123 }), /model/);
});

test("voice registers the shared dictation service and drops it on shutdown", async () => {
  const { getDictationService } = await jiti.import("../extensions/lib/dictation.ts");
  const handlers = new Map();
  const pi = {
    on: (name, handler) => { handlers.set(name, handler); },
    registerShortcut() {},
    registerCommand() {},
  };
  voice.default(pi);
  const service = getDictationService();
  assert.ok(service, "voice must publish itself for other UIs");
  assert.equal(service.phase(), "idle");
  assert.deepEqual(service.snapshot(), { phase: "idle", muted: false, elapsed: 0, level: 0, text: "" });

  await handlers.get("session_shutdown")();
  assert.equal(getDictationService(), undefined, "shutdown must not leave a stale service behind");
});
