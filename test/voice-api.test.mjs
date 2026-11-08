import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { importHost, jiti } from "./host.mjs";
const { WebSocketServer } = await importHost("ws");
const { DEFAULT_VOICE } = await jiti.import("../extensions/voice/recorder.ts");
const { ApiDictation } = await jiti.import("../extensions/voice/api.ts");
const voice = await jiti.import("../extensions/voice/index.ts");

async function recorder(silent = false, paced = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-api-rec-")), bin = join(dir, "recorder");
  const pcm = Buffer.alloc(16000); if (!silent) for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
  const body = paced
    ? `process.on('SIGINT',()=>process.exit(0));const chunk=Buffer.from('${pcm.subarray(0, 3200).toString("base64")}','base64');setInterval(()=>process.stdout.write(chunk),30);`
    : `process.on('SIGINT',()=>process.exit(0));const pcm=Buffer.from('${pcm.toString("base64")}','base64');process.stdout.write(pcm);process.stdout.write(pcm);setInterval(()=>{},1000);`;
  await writeFile(bin, `#!${process.execPath}\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}
async function until(fn, label = "condition") { for (let i = 0; i < 150; i++) { if (fn()) return; await delay(20); } assert.fail(`Timed out waiting for ${label}`); }

async function nariServer(onEvent) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => server.once("listening", done));
  const state = { events: [], headers: {}, audioBytes: 0, socket: undefined, authKey: undefined, committed: 0 };
  server.on("connection", (socket, request) => {
    state.socket = socket; state.headers = request.headers; state.authKey = request.headers.authorization;
    socket.on("message", async (data) => {
      const message = JSON.parse(data.toString());
      state.events.push(message);
      if (message.type === "input_audio_buffer.append") state.audioBytes += Buffer.from(message.audio, "base64").length;
      if (message.type === "input_audio_buffer.commit") state.committed++;
      await onEvent(message, socket, state);
    });
  });
  return { server, state, url: `ws://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { for (const client of server.clients) client.terminate(); server.close(done); }) };
}
const base = (url, recorderBin, extra = {}) => ({ ...DEFAULT_VOICE, backend: "nari", recorderBin, apiUrl: url,
  apiModel: "qwen3-asr-fast", language: "ru", vocabulary: "KubeVirt", ...extra });

test("Nari streaming: configure, append audio, live partials, commit and aggregated transcript", async () => {
  const seen = [];
  const wire = await nariServer(async (message, socket) => {
    if (message.type === "session.configure") {
      socket.send(JSON.stringify({ type: "session.configured" }));
      socket.send(JSON.stringify({ type: "transcript.partial", item_id: "a", transcript: "Проверь" }));
    }
    if (message.type === "input_audio_buffer.commit") {
      socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a", client_event_id: message.event_id }));
      socket.send(JSON.stringify({ type: "transcript.completed", item_id: "a", transcript: "Проверь KubeVirt" }));
    }
  });
  const dictation = new ApiDictation(base(wire.url, await recorder()), "secret-nari-key", () => {}, (text) => seen.push(text), () => {});
  try {
    await dictation.start();
    await until(() => wire.state.audioBytes >= 32_000, "audio chunks");
    await until(() => seen.some((text) => text.includes("Проверь")), "partial transcript");
    const text = await dictation.transcribe();
    assert.equal(text, "Проверь KubeVirt");
    assert.equal(wire.state.authKey, "Bearer secret-nari-key");
    const configure = wire.state.events.find((event) => event.type === "session.configure");
    assert.deepEqual(configure.session, { model: "qwen3-asr-fast", turn_detection: null, prompt: "KubeVirt", language: "ru" });
    assert.equal(wire.state.committed, 1);
    assert.ok(wire.state.events.filter((event) => event.type === "input_audio_buffer.append").length > 0);
    assert.ok(dictation.estimatedCostUsd() > 0);
    await until(() => wire.state.socket?.readyState === 3, "socket closed");
  } finally { await dictation.cancel(); await wire.close(); }
});

test("auto language omits the language field and cancel closes the session", async () => {
  const wire = await nariServer(async (message, socket) => {
    if (message.type === "session.configure") socket.send(JSON.stringify({ type: "session.configured" }));
  });
  const dictation = new ApiDictation(base(wire.url, await recorder(), { language: "auto" }), "k", () => {}, () => {}, () => {});
  try {
    await dictation.start();
    await until(() => wire.state.events.some((event) => event.type === "session.configure"));
    const configure = wire.state.events.find((event) => event.type === "session.configure");
    assert.equal("language" in configure.session, false);
    await dictation.cancel();
    await until(() => wire.state.socket?.readyState === 3, "socket closed after cancel");
    assert.equal(wire.state.committed, 0);
  } finally { await dictation.cancel(); await wire.close(); }
});

test("missing key and silent audio never transcribe; silent audio is not committed", async () => {
  await assert.rejects(new ApiDictation(base("ws://127.0.0.1:1", "/does/not/exist"), "", () => {}, () => {}, () => {}).start(),
    /Set NARI_API_KEY/);
  const wire = await nariServer(async (message, socket) => {
    if (message.type === "session.configure") socket.send(JSON.stringify({ type: "session.configured" }));
  });
  const dictation = new ApiDictation(base(wire.url, await recorder(true)), "k", () => {}, () => {}, () => {});
  try {
    await dictation.start();
    await until(() => wire.state.events.some((event) => event.type === "input_audio_buffer.append"), "silent audio");
    await assert.rejects(dictation.transcribe(), /silent/);
    assert.equal(wire.state.committed, 0);
  } finally { await dictation.cancel(); await wire.close(); }
});

test("provider errors are reported without revealing the key and plain http is rejected", async () => {
  const wire = await nariServer(async (message, socket) => {
    if (message.type === "session.configure") socket.send(JSON.stringify({ type: "error", error: { code: "UNAUTHORIZED" } }));
  });
  const dictation = new ApiDictation(base(wire.url, await recorder()), "super-secret-value", () => {}, () => {}, () => {});
  try {
    await assert.rejects(dictation.start(), (error) => {
      assert.match(error.message, /rejected the key/); assert.doesNotMatch(error.message, /super-secret-value/);
      return true;
    });
  } finally { await dictation.cancel(); await wire.close(); }
  await assert.rejects(new ApiDictation(base("ws://example.com/x", await recorder()), "k", () => {}, () => {}, () => {}).start(), /wss/);
});

test("mute discards audio instead of buffering it and resumes after unmute", async () => {
  const wire = await nariServer(async (message, socket) => {
    if (message.type === "session.configure") socket.send(JSON.stringify({ type: "session.configured" }));
    if (message.type === "input_audio_buffer.commit") socket.send(JSON.stringify({ type: "input_audio_buffer.commit_empty", client_event_id: message.event_id }));
  });
  const dictation = new ApiDictation(base(wire.url, await recorder(false, true)), "k", () => {}, () => {}, () => {});
  try {
    await dictation.start();
    await until(() => wire.state.audioBytes >= 6400, "initial audio");
    dictation.setMuted(true);
    await delay(120);
    const during = wire.state.audioBytes;
    await delay(300);
    assert.equal(wire.state.audioBytes, during, "muted audio must not be sent");
    dictation.setMuted(false);
    await until(() => wire.state.audioBytes > during, "audio after unmute");
    await assert.rejects(dictation.transcribe(), /empty transcript/);
  } finally { await dictation.cancel(); await wire.close(); }
});

test("voice command advertises mute in its argument completions", () => {
  const commands = new Map();
  voice.default({ on() {}, registerCommand(name, cmd) { commands.set(name, cmd); }, registerShortcut() {} });
  const command = commands.get("voice");
  assert.ok(command.getArgumentCompletions("").some((item) => item.value === "mute"));
  assert.deepEqual(command.getArgumentCompletions("api ").map((item) => item.value), ["api nari", "api local"]);
});

test("voice config validates the API backend and key variable", () => {
  assert.equal(voice.validateVoice({ backend: "nari", apiKeyEnv: "NARI_API_KEY" }).backend, "nari");
  assert.throws(() => voice.validateVoice({ backend: "cloud" }), /backend/);
  assert.throws(() => voice.validateVoice({ apiKeyEnv: "bad-name" }), /environment variable/);
  assert.throws(() => voice.validateVoice({ apiModel: " " }), /apiModel/);
});

test("/voice api nari persists the backend and warns about audio leaving the machine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-core-voice-config-"));
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  const priorKey = process.env.NARI_API_KEY; delete process.env.NARI_API_KEY;
  const commands = new Map(), notices = [];
  voice.default({ on() {}, registerCommand(name, cmd) { commands.set(name, cmd); }, registerShortcut() {} });
  const ctx = { mode: "tui", cwd: dir, ui: { notify(message, type) { notices.push({ message, type }); }, setStatus() {}, onTerminalInput() { return () => {}; } } };
  try {
    await commands.get("voice").handler("api nari", ctx);
    const saved = JSON.parse(await readFile(join(dir, "voice.json"), "utf8"));
    assert.equal(saved.backend, "nari");
    assert.match(notices.at(-1).message, /api\.narilabs\.com/);
    assert.equal(notices.at(-1).type, "warning");
    assert.match(notices.at(-1).message, /NARI_API_KEY/);
    await commands.get("voice").handler("api local", ctx);
    assert.equal(JSON.parse(await readFile(join(dir, "voice.json"), "utf8")).backend, "local");
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (priorKey !== undefined) process.env.NARI_API_KEY = priorKey;
  }
});
