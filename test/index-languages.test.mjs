import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { treeSitterSkeleton } = await jiti.import("../extensions/index/index.ts");

const cases = [
  ["a.go", `package main\nimport "fmt"\ntype Point struct { X, Y int }\ntype Stringer interface { String() string }\nfunc add(a, b int) int { return a + b }\nfunc (p Point) String() string { return "p" }\nconst Max = 10\nvar Global = 1\n`, ["type", "function", "method", "constant", "variable"]],
  ["a.ts", `import { x } from "./x";\nexport interface Foo { bar(): void }\nexport class Baz { bar() {} }\nexport function fn(a: number): string { return "" }\nexport const arrow = (b: number) => b;\nexport enum Color { Red, Blue }\nexport type Alias = string;\n`, ["interface", "class", "function", "variable", "enum", "type"]],
  ["a.tsx", `export const C = () => <div />;\nexport function Page() { return <C />; }\n`, ["variable", "function"]],
  ["a.js", `import { x } from "./x";\nclass Foo { bar() {} }\nfunction fn(a) { return a }\nconst arrow = (b) => b;\n`, ["class", "function", "variable"]],
  ["a.rs", `use std::collections::HashMap;\npub struct Point { pub x: i32 }\npub enum Color { Red, Blue }\npub trait Draw { fn draw(&self); }\npub fn add(a: i32) -> i32 { a }\nimpl Point { pub fn new() -> Self { Point { x: 0 } } }\npub const MAX: i32 = 10;\n`, ["struct", "enum", "trait", "function", "impl", "constant"]],
  ["a.py", `import os\nCONSTANT = 42\nclass Service:\n    def run(self):\n        pass\ndef helper(a):\n    return ""\n`, ["constant", "class", "function"]],
  ["a.java", `package com.example;\nimport java.util.List;\npublic class Foo {\n  public int bar(int x) { return x; }\n}\ninterface IBar { void x(); }\nenum Color { RED, BLUE }\nrecord Point(int x, int y) {}\n`, ["class", "method", "interface", "enum", "record"]],
  ["a.kt", `package com.example\nclass Foo(val x: Int) {\n  fun bar(y: Int): Int = y\n}\nobject Main { fun main() {} }\nfun topLevel(a: Int) = a\n`, ["class", "function", "object"]],
  ["a.rb", `module App\n  class Foo\n    def bar(x)\n      x\n    end\n  end\nend\nMAX = 10\n`, ["module", "class", "method", "constant"]],
  ["a.php", `<?php\nnamespace App;\nclass Foo {\n  public function bar(int $x): int { return $x; }\n}\ninterface IBar { public function x(); }\ntrait T { public function t() {} }\nfunction helper() {}\n`, ["namespace", "class", "method", "interface", "trait", "function"]],
  ["a.lua", `local M = {}\nfunction M.run(a)\n  return a\nend\nlocal function helper(b)\n  return b\nend\n`, ["function"]],
  ["a.dart", `import 'dart:io';\nclass Foo {\n  int bar(int x) { return x; }\n  int get baz => 1;\n}\nvoid main() { print('hi'); }\nenum Color { red, blue }\n`, ["class", "function", "getter", "enum"]],
  ["a.swift", `import Foundation\nclass Foo {\n  func bar(x: Int) -> Int { return x }\n}\nstruct Point { let x: Int }\nprotocol Draw { func draw() }\n`, ["class", "function", "struct", "interface"]],
];

test("tree-sitter extracts symbols for every major language", async () => {
  for (const [file, source, kinds] of cases) {
    const skeleton = await treeSitterSkeleton(source, `/repo/${file}`);
    assert.equal(skeleton?.source, "tree-sitter", `${file} should use tree-sitter`);
    const found = new Set((skeleton.symbols ?? []).map((symbol) => symbol.kind));
    for (const kind of kinds) {
      assert.ok(found.has(kind), `${file}: missing kind "${kind}" (got ${[...found].join(", ")})`);
    }
  }
});

test("tree-sitter outlines markup and config files", async () => {
  const json = await treeSitterSkeleton(`{\n  "name": "x",\n  "scripts": { "build": "tsc" },\n  "dependencies": ["a"]\n}`, "/repo/a.json");
  assert.deepEqual((json.symbols ?? []).map((s) => s.name), ["name", "scripts", "dependencies"]);

  const html = await treeSitterSkeleton(`<html><body><div id="app" class="main"><p>hi</p></div></body></html>`, "/repo/a.html");
  assert.ok(html.symbols.some((s) => s.kind === "element" && s.name === "div#app.main"));

  const css = await treeSitterSkeleton(`.card { color: red; }\n@media (max-width: 600px) { .a {} }`, "/repo/a.css");
  assert.ok(css.symbols.some((s) => s.kind === "rule" && s.name === ".card"));
  assert.ok(css.symbols.some((s) => s.kind === "media"));

  const toml = await treeSitterSkeleton(`[package]\nname = "x"\n[[bin]]\nname = "pi"`, "/repo/a.toml");
  assert.ok(toml.symbols.some((s) => s.kind === "section" && s.name === "package"));

  const vue = await treeSitterSkeleton(`<template><div class="app"></div></template>\n<script lang="ts">export default {}</script>`, "/repo/a.vue");
  assert.ok(vue.symbols.some((s) => s.kind === "element" && s.name === "div.app"));
  assert.ok(vue.symbols.some((s) => s.kind === "script"));
});

test("yaml always takes the template-aware extractor", async () => {
  const { markupSkeleton } = await jiti.import("../extensions/index/index.ts");

  // Plain YAML still gets an outline, and none of it goes through tree-sitter.
  assert.equal(await treeSitterSkeleton(`a: 1\n`, "/repo/a.yaml"), undefined);
  const plain = markupSkeleton(`apiVersion: v1\nmetadata:\n  name: x\nspec:\n  replicas: 3\n`, "/repo/a.yaml");
  assert.equal(plain.source, "regex");
  assert.deepEqual((plain.symbols ?? []).map((s) => s.name), ["apiVersion", "metadata", "name", "spec", "replicas"]);

  // Go templates are not structure: directives vanish, inline actions are stripped.
  const helm = markupSkeleton(
    `apiVersion: v1\nmetadata:\n  name: {{ .Release.Name }}-app\n{{- with .Values.image }}\n  image: {{ .name }}\n  tag: {{ .tag | default "latest" }}\n{{- end }}\n`,
    "/repo/a.yaml",
  );
  assert.deepEqual((helm.symbols ?? []).map((s) => s.name), ["apiVersion", "metadata", "name", "image", "tag"]);

  // Keys that live inside list items are kept, and repeats are not collapsed.
  const list = markupSkeleton(`containers:\n  - name: app\n    image: nginx\n  - name: sidecar\n    image: busybox\n`, "/repo/a.yaml");
  assert.deepEqual(
    (list.symbols ?? []).map((s) => s.name),
    ["containers", "name", "image", "name", "image"],
  );

  // Block scalar bodies are text, not keys.
  const block = markupSkeleton(`data:\n  run.sh: |\n    #!/bin/sh\n    echo "key: value"\n  other: plain\n`, "/repo/a.yaml");
  assert.deepEqual((block.symbols ?? []).map((s) => s.name), ["data", "run.sh", "other"]);

  // `.tpl` helpers are symbols of their own.
  const tpl = markupSkeleton(`{{- define "app.fullname" -}}\n{{- end }}\n{{- define "app.labels" -}}\n{{- end }}\n`, "/repo/helpers.tpl");
  assert.deepEqual((tpl.symbols ?? []).filter((s) => s.kind === "define").map((s) => s.name), ["app.fullname", "app.labels"]);
});
