import assert from "node:assert/strict";
import test from "node:test";
import { jiti } from "./host.mjs";

const { skeleton, formatSkeleton } = await jiti.import("../extensions/index/index.ts");

test("index extracts TypeScript and Python symbols with approximate ranges", () => {
  const ts = `import { x } from "./x";
export class Foo {
  bar() {
    return x;
  }
}
export function baz() {
  return 1;
}
`;
  const result = skeleton(ts, "/repo/a.ts");
  assert.equal(result.language, "typescript");
  assert.match(result.imports[0], /import/);
  assert.deepEqual(result.symbols.map((symbol) => [symbol.kind, symbol.name, symbol.line, symbol.end]), [
    ["class", "Foo", 2, 6],
    ["method", "bar", 3, 5],
    ["function", "baz", 7, 9],
  ]);
  const formatted = formatSkeleton("/repo/a.ts", result, "/repo");
  assert.match(formatted, /class Foo/);
  assert.match(formatted, /function baz/);
});

test("index handles Python indentation, queries and caps", () => {
  const py = `import os
class Service:
    def run(self):
        return os.getcwd()

def helper():
    pass
`;
  const result = skeleton(py, "/repo/a.py");
  assert.equal(result.language, "python");
  assert.deepEqual(result.symbols.map((symbol) => [symbol.kind, symbol.name]), [["class", "Service"], ["function", "run"], ["function", "helper"]]);
  assert.equal(skeleton(py, "/repo/a.py", { maxSymbols: 1 }).symbols.length, 1);
  const found = skeleton(`def alpha():\n    pass\ndef beta():\n    pass\n`, "/repo/b.py").symbols.filter((symbol) => symbol.name.includes("beta"));
  assert.equal(found.length, 1);
});

test("index converts exact LSP DocumentSymbols and preserves nesting", async () => {
  const { fromLspSymbols, formatSkeleton } = await jiti.import("../extensions/index/index.ts");
  const text = `import x from "x";\nexport class Foo {\n  bar() {\n  }\n}\n`;
  const symbols = [{
    name: "Foo", kind: 5, range: { start: { line: 1, character: 0 }, end: { line: 4, character: 1 } },
    selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    children: [{
      name: "bar", kind: 6, range: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } },
      selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 5 } }, children: [],
    }],
  }];
  const result = fromLspSymbols(symbols, "/repo/a.ts", text);
  assert.equal(result.source, "lsp");
  assert.deepEqual(result.symbols.map((symbol) => [symbol.kind, symbol.name, symbol.line, symbol.end, symbol.indent]), [
    ["class", "Foo", 2, 5, 0],
    ["method", "bar", 3, 4, 2],
  ]);
  assert.match(formatSkeleton("/repo/a.ts", result, "/repo"), /· lsp/);
});

test("index uses tree-sitter for languages without a language server", async () => {
  const { treeSitterSkeleton } = await jiti.import("../extensions/index/index.ts");
  const c = await treeSitterSkeleton(`#include <stdio.h>
struct Point { int x; int y; };
static int add(int a, int b) { return a + b; }
`, "/repo/a.c");
  assert.equal(c.source, "tree-sitter");
  assert.ok(c.symbols.some((symbol) => symbol.kind === "struct" && symbol.name === "Point"));
  assert.ok(c.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "add"));
  assert.match(c.imports[0], /#include/);

  const cs = await treeSitterSkeleton(`using System;
namespace App { public class Foo { public int Bar(int x) { return x; } public string Name { get; set; } } }
`, "/repo/a.cs");
  assert.ok(cs.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "Foo"));
  assert.ok(cs.symbols.some((symbol) => symbol.kind === "method" && symbol.name === "Bar"));

  const zig = await treeSitterSkeleton(`pub fn add(a: i32, b: i32) i32 { return a + b; }
const Point = struct { x: i32, y: i32 };
`, "/repo/a.zig");
  assert.ok(zig.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "add"));
  assert.ok(zig.symbols.some((symbol) => symbol.kind === "variable" && symbol.name === "Point"));

  const elixir = await treeSitterSkeleton(`defmodule Foo do
  def bar(x), do: x + 1
end
`, "/repo/a.ex");
  assert.ok(elixir.symbols.some((symbol) => symbol.kind === "module" && symbol.name === "Foo"));
  assert.ok(elixir.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "bar"));
});
