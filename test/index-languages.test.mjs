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
