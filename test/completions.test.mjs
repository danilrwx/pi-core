import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";
const { completeArgs, completeFirstWords } = await jiti.import("../extensions/lib/complete.ts");

test("top-level completions list every voice subcommand", () => {
  const values = completeArgs("", ["cancel", "status", "api", "model", "language"]);
  assert.deepEqual(values.map((item) => item.value), ["cancel", "status", "api", "model", "language"]);
  assert.equal(completeArgs("s", ["cancel", "status"])[0].value, "status");
  assert.deepEqual(completeArgs("api", ["cancel", "status", "api"]).map((item) => item.value), ["api"]);
});

test("nested completions keep the completed words and support trailing spaces", () => {
  const tree = { api: ["nari", "local"], language: ["auto", "ru", "en"] };
  assert.deepEqual(completeArgs("api ", ["api"], tree).map((item) => item.value), ["api nari", "api local"]);
  assert.deepEqual(completeArgs("api n", ["api"], tree).map((item) => item.value), ["api nari"]);
  assert.deepEqual(completeArgs("language r", ["language"], tree).map((item) => item.value), ["language ru"]);
  assert.equal(completeArgs("language zz", ["language"], tree), null);
  assert.equal(completeArgs("api nari extra", ["api"], tree), null);
});

test("completions carry labels, descriptions and never leak unmatched values", () => {
  const [item] = completeArgs("api ", [], { api: ["nari"] }, { nari: "streaming API" });
  assert.deepEqual(item, { value: "api nari", label: "nari", description: "streaming API" });
  assert.equal(completeArgs("", ["x"], {}, { x: "" }) [0].description, undefined);
});

test("single-word commands suggest only their actions and stay out of free text", () => {
  assert.deepEqual(completeFirstWords("c", ["cancel", "insert"]).map((item) => item.value), ["cancel"]);
  assert.equal(completeFirstWords("def foo(", ["cancel", "insert"]), null);
  assert.deepEqual(completeFirstWords("", ["on", "off"]).map((item) => item.value), ["on", "off"]);
});
