# Third-party source provenance

These are maintained source copies, not automatically updated dependencies.
Original copyrights and license terms remain applicable. Modified source files
carry notices. Keep this record, license files and regression tests when editing.

| Source | Exact upstream commit | Copied files | License |
|---|---|---|---|
| [GhabiX/pi-background-job](https://github.com/GhabiX/pi-background-job) | `08389a029beb721429db80bf2f58b44396aebc11` | `extensions/background-jobs/{core,events,index}.ts`, `test/background-job*.test.mjs` | Copyright 2026 GhabiX, [Apache-2.0](licenses/Apache-2.0-GhabiX.txt) |
| [GhabiX/pi-btw-cached](https://github.com/GhabiX/pi-btw-cached) | `c7d9867b6d2f5efe69de69264f04b9cdfae0b55a` | `extensions/btw/index.ts`, `test/btw-host.test.mjs` | Copyright 2026 GhabiX, [Apache-2.0](licenses/Apache-2.0-GhabiX.txt) |
| [1jehuang/jcode](https://github.com/1jehuang/jcode) | `2df610a7d821515a843996621cb890673b139e30` | `extensions/image-preview/kitty.ts` (diacritic table and tmux/Kitty envelope adapted) | Copyright 2025 Jeremy Huang, [MIT](licenses/MIT-jcode.txt) |
| [@bacnh85/pi-rtk](https://github.com/bacnh85/pi-extensions/tree/main/pi-rtk) | `90930b50f5fc0a4491a748ee1692db40f7ec358a` | `extensions/rtk/rewrite.ts` (safe-rewrite and find-predicate checks adapted) | MIT, copyright bacnh85 |
| [pi-rtk-rewrite](https://github.com/viartemev/pi-rtk-rewrite) | `59c891163b6ea70c97da8b21024c79a6df690f89` | `extensions/rtk/index.ts` (tool_call rewrite flow informed) | MIT, copyright viartemev |
| [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) | `3e88dc9e36b4e8bf752ce53bea61e4b67282a2bb` | `vendor/tree-sitter-languages/*.wasm` (prebuilt language grammars) | Package Unlicense; grammar licenses in `vendor/tree-sitter-languages/LICENSE-*.txt` |

Local changes:

- Shell authorization through the live pi-core permission extension (fail closed).
- Private log/record modes; a shared 8 MiB hard log cap and continued output draining.
- Quoted, explicitly untrusted model-facing event output.
- Own filesystem watcher with atomic-save handling, flood limits and lifecycle cleanup.
- Side-request abort, deadline and separate usage status, preserving request-prefix design.
- Portable test loading with the installed Pi SDK and additional regression tests.

## Bash grammar

`vendor/tree-sitter-bash/tree-sitter-bash.wasm` and its LICENSE are copied from the
official `tree-sitter-bash@0.25.1` npm tarball (git head
`801326684a26ffc4e749bb016c50c6c30bdfa345`), MIT. No native build scripts were run.
The `web-tree-sitter` runtime is pinned to 0.25.10 in package.json/package-lock.json.

- Source: https://registry.npmjs.org/tree-sitter-bash/-/tree-sitter-bash-0.25.1.tgz
- Tarball SHA-512 (verified against npm metadata before extraction):
  `7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw==`
- WASM SHA-256:
  `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a`

Tree-sitter grammars were copied from the `tree-sitter-wasms@0.1.13` tarball:
`tree-sitter-c@0.20.7` (`df6ac34d5eb1dccfac8f2a9011a8491300818d7c`),
`tree-sitter-cpp@0.20.4` (`51da29228ea1d137d196edd1b41149f325cc6ecb`),
`tree-sitter-c-sharp@0.20.0` (`7a47daeaf0d410dd1a91c97b274bb7276dd96605`),
`tree-sitter-scala@0.19.0` (`262797b1dfe0303818c2418c0a88f6be65f37245`),
`@tree-sitter-grammars/tree-sitter-zig@1.0.0` (`21e2218e0ec7f4e3c0640d16bf8c67e6f0a61e18`),
and `tree-sitter-elixir@0.1.1` (`11426c5fd20eef360d5ecaf10729191f6bc5d715`).
The licenses are kept next to the WASM files. No grammar build scripts were run.

The `todo` tool and panel are written locally; Maki `todo_write` (MIT) and
`@juicesharp/rpiv-todo` (MIT) informed the behaviour, but no code is copied.
The Neovim tour client/bridge, discovery lock files and diff/dirty/context
features were informed by coder/claudecode.nvim (MIT) and its published PROTOCOL.md;
no Lua or TypeScript code was copied. The Unix-socket transport is our own.

The Neovim tour client/bridge (`extensions/nvim/*.lua`) is written locally
as a minimal RPC shim; the duet bridge protocol informed it, but no Lua code was
copied.

The `question` tool is adapted from Pi's official `questionnaire.ts` example
(Pi is MIT); it was rewritten for Maki-style multi-select, free-text answers and
dismissal, with no rpiv/third-party code copied.

Partial-output labeling, read tracking, image preview UI and local voice integration
are written locally. Kitty Unicode placeholders in `extensions/image-preview/kitty.ts`
adapt jcode's table and DCS passthrough envelope (MIT); the surrounding pi-tui
component and image selection are ours. No audio models or STT executables are included/downloaded.
The Nari realtime WebSocket protocol was implemented from jcode's `nari.rs` as a
protocol reference (jcode is MIT); no jcode code is copied. `ws` is a runtime
dependency (MIT), not a vendored source copy.

No code from pi-event-monitor or whisper-dictation is vendored here. Their APIs
and implementation limitations informed the review, but the path watcher was
written locally. No automatic upstream updater is included.
