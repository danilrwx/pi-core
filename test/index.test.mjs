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
