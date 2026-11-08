import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { jiti } from "./host.mjs";
const { betaEndpoint, isPrefixCapable, streamPrefixCompletion, toOpenAIMessages } = await jiti.import("../extensions/prefix/client.ts");
const prefixPlugin = await jiti.import("../extensions/prefix/index.ts");

async function wire(handler) {
  const bodies = [], headers = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString();
    bodies.push({ url: req.url, body: JSON.parse(body) });
    headers.push(req.headers);
    await handler(req, res, bodies.at(-1).body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, bodies, headers, endpoint: `http://127.0.0.1:${server.address().port}/beta/chat/completions`,
    close: () => new Promise((done) => server.close(done)) };
}
const delta = (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47, prompt_cache_hit_tokens: 8 } })}\n\n`;

test("prefix request appends the prefix as the final assistant message and streams the continuation", async () => {
  const stream = await wire(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(delta(" def")); res.write(delta(" add(a, b):"));
    setTimeout(() => { res.write(usage); res.end("data: [DONE]\n\n"); }, 10);
  });
  const deltas = [];
  try {
    const result = await streamPrefixCompletion({
      endpoint: stream.endpoint, apiKey: "secret-test-key", model: "deepseek-flash",
      messages: [{ role: "user", content: "Write add()" }], prefix: "def", maxTokens: 64,
      onDelta: (text) => deltas.push(text),
    });
    assert.equal(result.text, " def add(a, b):");
    assert.deepEqual(result.usage, { input: 40, output: 7, total: 47, cacheHit: 8 });
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(deltas, [" def", " add(a, b):"]);
    const body = stream.bodies[0].body;
    assert.equal(stream.bodies[0].url, "/beta/chat/completions");
    assert.equal(stream.headers[0].authorization, "Bearer secret-test-key");
    assert.deepEqual(body.messages, [{ role: "user", content: "Write add()" }, { role: "assistant", content: "def", prefix: true }]);
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.max_tokens, 64);
    assert.equal(body.stream, true);
    assert.equal(body.tools, undefined);
  } finally { await stream.close(); }
});

test("HTTP and in-stream errors are surfaced without leaking the key", async () => {
  const unauthorized = await wire(async (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }));
  });
  try {
    await assert.rejects(streamPrefixCompletion({ endpoint: unauthorized.endpoint, apiKey: "never-print-me", model: "m",
      messages: [], prefix: "x" }), (error) => {
      assert.match(error.message, /HTTP 401/); assert.doesNotMatch(error.message, /never-print-me/);
      return true;
    });
  } finally { await unauthorized.close(); }
  const inStream = await wire(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ error: { message: "prefix unsupported" } })}\n\n`);
  });
  try {
    await assert.rejects(streamPrefixCompletion({ endpoint: inStream.endpoint, apiKey: "k", model: "m", messages: [], prefix: "x" }), /prefix unsupported/);
  } finally { await inStream.close(); }
});

test("prefix completion can be cancelled and times out", async () => {
  const stalled = await wire(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(delta("partial"));
  });
  try {
    const controller = new AbortController();
    await assert.rejects(streamPrefixCompletion({ endpoint: stalled.endpoint, apiKey: "k", model: "m", messages: [], prefix: "x",
      signal: controller.signal, onDelta: () => controller.abort() }), /cancelled/);
  } finally { await stalled.close(); }
  const silent = await wire(async () => {});
  try {
    await assert.rejects(streamPrefixCompletion({ endpoint: silent.endpoint, apiKey: "k", model: "m", messages: [], prefix: "x", timeoutMs: 150 }), /timed out/);
  } finally { await silent.close(); }
});

test("prefix completion is limited to DeepSeek's OpenAI-compatible endpoint", () => {
  assert.equal(isPrefixCapable({ provider: "deepseek", baseUrl: "https://api.deepseek.com", api: "openai-completions" }), true);
  assert.equal(isPrefixCapable({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" }), false);
  assert.equal(isPrefixCapable({ provider: "deepseek", baseUrl: "https://api.deepseek.com", api: "anthropic-messages" }), false);
  assert.equal(betaEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/beta/chat/completions");
  assert.equal(betaEndpoint("https://api.deepseek.com/"), "https://api.deepseek.com/beta/chat/completions");
  assert.equal(betaEndpoint("https://api.deepseek.com/beta"), "https://api.deepseek.com/beta/chat/completions");
  assert.throws(() => betaEndpoint("http://example.com"), /HTTPS/);
});

test("history conversion keeps tool calls and text but never images", () => {
  const converted = toOpenAIMessages([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 2 },
  ]);
  assert.deepEqual(converted, [
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "body" },
  ]);
});

test("continuing the last assistant reply drops it from history to avoid duplication", () => {
  const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "first" }, { role: "assistant", content: "second" }];
  const found = prefixPlugin.lastAssistantText(messages);
  assert.deepEqual(found, { index: 2, text: "second" });
  messages.splice(found.index, 1);
  assert.equal(messages.filter((message) => message.content === "second").length, 0);
  assert.equal(prefixPlugin.lastAssistantText([{ role: "user", content: "hi" }]), undefined);
});
