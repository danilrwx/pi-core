import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The tour diff is drawn by bridge.lua, so the placement of removed lines can
 * only be checked against a real Neovim. Everything here is headless and local.
 */
const hasNvim = (() => {
  try { execFileSync("nvim", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

const BRIDGE = new URL("../extensions/nvim/bridge.lua", import.meta.url).pathname;

function runTour(body) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bridge-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n") + "\n");
  const script = join(dir, "check.lua");
  const result = join(dir, "result.txt");
  writeFileSync(script, `
vim.opt.number = true
vim.opt.signcolumn = "yes"
local bridge = dofile(${JSON.stringify(BRIDGE)})
vim.cmd("edit ${file}")
local ok, shown = pcall(bridge.request, {
  method = "show", file = "${file}", root = "${dir}",
  ${body}
})
if not ok then vim.fn.writefile({ "ERR " .. tostring(shown) }, "${result}") vim.cmd("qa!") end
local out = {}
for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(0, -1, 0, -1, { details = true })) do
  local d = mark[4]
  if d.virt_lines then
    local lines = {}
    for _, vl in ipairs(d.virt_lines) do
      local parts = {}
      for _, chunk in ipairs(vl) do parts[#parts + 1] = chunk[1] end
      lines[#lines + 1] = table.concat(parts)
    end
    out[#out + 1] = string.format("virt %d %s %s", mark[2], tostring(d.virt_lines_above), table.concat(lines, "|"))
  elseif d.line_hl_group then
    out[#out + 1] = string.format("hl %d %s", mark[2], d.line_hl_group)
  end
end
vim.fn.writefile(out, "${result}")
vim.cmd("qa!")
`);
  try {
    execFileSync("nvim", ["--headless", "-u", "NONE", "-c", `luafile ${script}`], { stdio: "ignore" });
    // Neovim sends `print` to stderr in headless mode, so the Lua side writes the
    // expectations-relevant lines to a file instead.
    return readFileSync(result, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("removed lines render where they were removed, numbered and aligned", { skip: !hasNvim && "nvim is not installed" }, () => {
  const out = runTour(`
    from_line = 5, to_line = 15, mode = "diff",
    added = { 9 },
    deleted_blocks = {
      { at = 7, lines = { { old = 6, text = "removed six" }, { old = 7, text = "removed seven" } } },
      { at = 99, lines = { { old = 40, text = "removed at end" } } },
    },`);
  const lines = out.trim().split("\n");
  // Above line 7 (0-based row 6), one entry per removed line with its old number.
  assert.equal(lines[0], "virt 6 true   6 - removed six|  7 - removed seven");
  assert.equal(lines[1], "hl 8 DiffAdd");
  // A deletion past the end of the file hangs below the last line instead of being clamped onto a wrong row.
  assert.equal(lines[2], "virt 29 false  40 - removed at end");
});

test("a stop without removals only highlights the added lines", { skip: !hasNvim && "nvim is not installed" }, () => {
  const out = runTour(`from_line = 3, to_line = 6, mode = "diff", added = { 4, 5 }, deleted_blocks = {},`);
  assert.deepEqual(out.trim().split("\n"), ["hl 3 DiffAdd", "hl 4 DiffAdd"]);
});

test("the tour annotation carries the position and the agent's explanation", { skip: !hasNvim && "nvim is not installed" }, () => {
  const out = runTour(`
    from_line = 5, to_line = 12, mode = "diff",
    added = { 7 }, deleted_blocks = {}, note = "The dialog owns the recording while it is open.",
    index = 2, total = 7,`);
  assert.deepEqual(out.trim().split("\n"), [
    "virt 4 true ▸ 2/7 · +1|  The dialog owns the recording while it is open.",
    "hl 6 DiffAdd",
  ]);

});

test("annotate paints open buffers only and leaves the cursor alone", { skip: !hasNvim && "nvim is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-annot-"));
  try {
    const open = join(dir, "open.go");
    const closed = join(dir, "closed.go");
    const body = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    writeFileSync(open, body);
    writeFileSync(closed, body);
    const script = join(dir, "check.lua");
    const result = join(dir, "result.txt");
    writeFileSync(script, `
local bridge = dofile(${JSON.stringify(BRIDGE)})
vim.cmd("edit ${open}")
local painted = bridge.request({ method = "annotate", file = "${open}", root = "${dir}", items = {
  { from_line = 5, header = "Take the key in the form", text = "Alt+M is handled where the user is looking." },
} })
local skipped = bridge.request({ method = "annotate", file = "${closed}", root = "${dir}", items = {
  { from_line = 3, header = "Not open", text = "Skipped." },
} })
local lines = { "open=" .. painted.annotated .. " closed=" .. skipped.annotated .. " " .. tostring(skipped.skipped), "line=" .. vim.fn.line(".") }
for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(0, -1, 0, -1, { details = true })) do
  local d = mark[4]
  if d.virt_lines then
    local text = {}
    for _, vl in ipairs(d.virt_lines) do
      local parts = {}
      for _, chunk in ipairs(vl) do parts[#parts + 1] = chunk[1] end
      text[#text + 1] = table.concat(parts)
    end
    lines[#lines + 1] = string.format("row=%d %s", mark[2], table.concat(text, " / "))
  end
end
vim.fn.writefile(lines, "${result}")
vim.cmd("qa!")
`);
    execFileSync("nvim", ["--headless", "-u", "NONE", "-c", `luafile ${script}`], { stdio: "ignore" });
    const lines = readFileSync(result, "utf8").trim().split("\n");
    assert.equal(lines[0], "open=1 closed=0 buffer is not open");
    assert.equal(lines[1], "line=1");
    assert.equal(lines[2], "row=4 ▸ Take the key in the form /   Alt+M is handled where the user is looking.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
