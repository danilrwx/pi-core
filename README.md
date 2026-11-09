<div align="center">

# pi-core

**A personal extension suite for [pi](https://github.com/earendil-works/pi) — built for long sessions, small context, and a terminal that stays out of the way.**

![pi](https://img.shields.io/badge/pi-%E2%89%A5%201.3.0-6f42c1)
![tests](https://img.shields.io/badge/tests-226%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)
![platform](https://img.shields.io/badge/platform-Unix-lightgrey)

</div>

---

## Why this exists

Coding agents are most useful when three things are true:

1. the model sees **less noise**, not more;
2. long-running work survives the turn that started it;
3. the human can see, steer, and undo what happened.

`pi-core` is a set of small, focused extensions that push pi in that direction. It is not a framework, not a sandbox, and not a replacement for git. It is a workshop: the tools are sharp, the state is explicit, and the edit history is visible.

The code here is maintained as **our own source copies**. Third-party work is vendored with its license and the exact upstream commit recorded in [`THIRD_PARTY.md`](THIRD_PARTY.md); there is no automatic updater.

---

## Quick start

Install straight from git:

```sh
pi install git:github.com/danilrwx/pi-core.git
```

Then reload with `/reload`. That is the whole install: the package manifest
declares the recommended extensions, and pi installs the git checkout and its
npm dependencies together.

To pin an exact revision, append a commit or tag:

```sh
pi install git:github.com/danilrwx/pi-core.git@<commit>
```

### Local checkout

For development, use a local path so edits are picked up by `/reload`:

```sh
git clone https://github.com/danilrwx/pi-core.git
cd pi-core
npm ci --ignore-scripts
pi install ./pi-core
```

To expose only the local `session-query` skill (instead of every skill under
`skills/`), set the resulting package entry to:

```json
{
  "packages": [
    { "source": "/absolute/path/to/pi-core", "skills": ["skills/session-query"] }
  ]
}
```

Optional extensions such as `permission`, `context`, and `interactive-shell` are
intentionally not in the default manifest; add them as explicit extension paths
when needed.

> **Requirements:** pi `>= 1.3.0`, Node `>= 22.19.0`, and a Unix host for background jobs. `rtk`, `golangci-lint`, LSP servers, Neovim, Kitty/tmux, `pw-record`, and `whisper-cli` are optional — each only matters when its extension is used.

---

## The design rules

| Rule | What it means in practice |
|---|---|
| **Context is expensive** | `index`, `batch`, `bash-head-tail`, partial output, and RTK all exist to keep raw bytes out of the next request. |
| **State is explicit** | Todos, checkpoints, read fingerprints, cache warming, and memory live in custom session entries or bounded files — not in hidden process state. |
| **Safety is layered** | The permission extension and the AST shell parser are a policy layer, not an OS sandbox. Checkpoints are not a git replacement. |
| **The terminal is the UI** | No browser dashboard, no background daemon, no auto-downloaded binaries. If it needs a server, it is a service you start yourself. |
| **Own the source** | Upstream snippets are copied with a license and a pinned commit. Updates are deliberate. |

---

## What is inside

### Workflow

| Extension | What it does |
|---|---|
| [`background-jobs`](extensions/background-jobs) | `background_job`, `monitor`, and `watch_path`. Slow builds and tests move off the current turn; completion arrives as a message, without polling. Unix process groups, private 8 MiB logs, 30-day retention. |
| [`btw`](extensions/btw) | `/btw <question>` sends the latest main-session request plus a side question. No tools, no history mutation, 90-second deadline, separate cost status. |
| [`todo`](extensions/todo) | `todo_write` plus a persistent panel above the editor. Replace-all semantics, session-scoped snapshots, auto-clear only after a user message. |
| [`question`](extensions/question) | A 1–4 question terminal dialog with tabs, multi-select, free-text answers, and a single blocking tool call. Inside the answer editor `Alt+M` dictates straight into the field, so a spoken answer can be mixed with typed text before submitting. |
| [`walkthrough`](extensions/walkthrough) | `walkthrough` presents a change set as a narrated tour **in the chat**, rendered as its own block type (`pi-core:walkthrough`) rather than a tool shell. The transcript keeps one slide (the first stop); the rest are flipped in the review slider: the model picks the hunks that carry the story and explains why each one exists, the diff itself is read from git. Paired `-`/`+` lines mark only the changed words, whole-file additions get syntax highlighting, and each stop carries old/new line numbers plus `why`/`note`. The chat-side counterpart of `review_tour`. |
| [`review`](extensions/review) | Review mode inside Pi: `/story` opens a full-size panel over the conversation with the stop's real diff (colours plus word-level marking), its `why`, the discussion thread and an input field — `]t`/`[t` move between stops inside it, typing talks to the current stop, one discussion thread per stop on top of the cached main prefix, and `/review submit` writes a single digest into the conversation. The threads themselves never touch the history, so walking ten stops does not rewrite the context or drop the prompt cache. |
| [`batch`](extensions/batch) | Up to 8 independent **read-only** calls in one turn: `read`, `grep`, `find`, `ls`, `index`, `lsp`. Per-call and total output caps, partial failures, image passthrough. |
| [`usage`](extensions/usage) | A compact, local `/usage` panel in a Claude-Code-like style: current session, today, current week, all time, cache reuse, context bar, and per-model cost. |
| [`notify`](extensions/notify) | OSC 99 in Kitty, OSC 777 elsewhere. Fires when the agent is ready or needs input, not after every low-level retry. |

### Context economy

| Extension | What it does |
|---|---|
| [`index`](extensions/index) | File skeleton with imports, declarations, methods, and line ranges. Tree-sitter first for C, C++, C#, Go, Rust, TS/JS/TSX, Python, Java, Kotlin, Ruby, PHP, Lua, Scala, Swift, Dart, Zig, Elixir, plus JSON/TOML keys, HTML/Vue elements, and CSS rules; then a template-aware indentation extractor for every `.yaml`/`.yml`/`.tpl` (Helm actions, list-item keys and block scalars all handled) and Markdown headings; then LSP `documentSymbols`. |
| [`bash-head-tail`](extensions/bash-head-tail) | When bash output is truncated to a tail, reads the beginning of the full log (80 lines / 12 KiB) and puts it before the tail. |
| [`partial-output`](extensions/partial-output) | Labels aborted/timed-out bash and codemode output as partial, preserving the streamed text and exit code 130/124. |
| [`rtk`](extensions/rtk) | Rewrites safe `bash` commands through `rtk rewrite`: `git`, `cargo`, `rg`, `find`, `kubectl`, `docker`, and friends. Fail-open; skips compound commands, inline scripts, and unsafe `find` predicates. |
| [`cache-guard`](extensions/cache-guard) | `/cache` shows the last 10 turns: prompt size, cache hit, cost, output. Flags a cold turn when prompt ≥ 4k, hit < 50%, and hit dropped ≥ 35%. |
| [`cache-warming`](extensions/cache-warming) | Bounded idle cache warming: ≤ 30 minutes idle, ≤ $0.05 per idle window, only when expected savings ≥ $0.005. |
| [`memory`](extensions/memory) | Claude-compatible Markdown memory with `MEMORY.md` index, project/global scopes, Claude import, secret-aware auto-memory, and optional Jev classifier recall. |

### Safety, recovery, and observation

| Extension | What it does |
|---|---|
| [`permission`](extensions/permission) | Optional layered policy: `minimal`, `low`, `medium`, `high`, `yolo`, `bypassed`. Bash is parsed with tree-sitter; allow rules apply per command, not per unsafe prefix. |
| [`checkpoint`](extensions/checkpoint) | File-level snapshots before `edit`/`write`/`propose_change`; gzip blobs, safety checkpoint before restore, `/checkpoint`, `/rewind`, and a confirmation-gated `checkpoint` tool. |
| [`read-watch`](extensions/read-watch) | Fingerprints every successful read, watches its parent directory, and blocks edits to stale files until they are read again. Project-local paths only. |
| [`image-preview`](extensions/image-preview) | Inline images in the draft, `Alt+I` gallery, short `🖼1` paste tokens, and Kitty Unicode placeholders inside tmux. |
| [`voice`](extensions/voice) | `Alt+M` dictation, `Alt+U` mute, insertion into the draft or another UI's field (the `question` dialog borrows it through `lib/dictation`). Local `pw-record` + `whisper-cli`, or explicit Nari streaming via `/voice api nari`. |

### Editor and code intelligence

| Extension | What it does |
|---|---|
| [`nvim`](extensions/nvim) | The Neovim bridge: `/story` mirrors its stops here automatically, live-follow, bidirectional comments, `show`, `selection`, `nvim_context`, and `propose_change` with an accept/reject diff. The tour draws diffs with extmarks only (no `:diffthis`): added lines are highlighted in place, removed lines are put back where they were removed with their old line numbers in the gutter and the code aligned to the buffer text. A chat card for the same step stays three lines — the hunk lives in the editor. Every stop carries an **annotation** above its first changed line: the position and counts on the header line, then the agent's explanation (`review_tour … note=…`), kept on the stop so `]t`/`[t` brings it back. A stop without an explanation says `no explanation yet — ask pi` instead of looking empty, and a whole new file is annotated but not painted green line by line. |
| [`lsp-pi`](extensions/lsp-pi) | LSP diagnostics hook and on-demand `lsp` tool. One server per project root, idle shutdown, LRU-bounded document cache. |
| [`golangci-lint`](extensions/golangci-lint) | Runs `golangci-lint run --fix` only for packages containing files the agent actually changed — never the whole module. |
| [`handoff`](extensions/handoff) | `/handoff` distills the current conversation into a focused prompt for a fresh session, optionally with a mode or model. |
| [`session-query`](extensions/session-query) | `session_query` asks a model about a previous pi session file. Pairs with `handoff`’s parent-session prompt. |

### Optional / legacy

| Extension | Status |
|---|---|
| [`context`](extensions/context) | `/context` overview: loaded context, tools, skills, session usage. Optional; not in the recommended settings list. |
| [`interactive-shell`](extensions/interactive-shell) | Runs `!vim`, `!git rebase -i`, and similar commands with full terminal access. Optional; load explicitly when needed. |
| [`model-price`](extensions/model-price) | Price-per-1M status. Legacy; intentionally not loaded by default. |

---

## Commands and shortcuts

### Commands

| Command | Extension | Purpose |
|---|---|---|
| `/jobs` | background-jobs | List jobs and file watches; choose one to stop. |
| `/btw [cancel]` | btw | Ask a side question, or cancel the active one. |
| `/todos [clear \| collapse \| expand]` | todo | Show or manage the task list. |
| `/images` | image-preview | Open the image gallery. |
| `/voice [mute \| cancel \| status \| api \| model \| language]` | voice | Configure and control dictation. |
| `/story [--base <ref>] [paths] \| submit \| stop \| status]` | walkthrough | The only entry point you need: narrates the change set (3-6 stops with `why`), opens the review panel on the same stops when that turn ends and mirrors them into a connected Neovim as annotations. `/story` again re-opens the panel, `submit` writes one digest, `stop` cancels. No questions from the agent, no second command. Without `--base` the base is resolved like this: uncommitted or untracked work, else the branch point with the default branch, else the last commit (`HEAD~1`). |
| `/nvim [status \| save [file] \| live on\|off]` | nvim | Inspect the bridge, save a dirty buffer, or toggle live-follow. |
| `/memory [add \| search \| forget \| clear \| list \| import \| auto \| jev]` | memory | Manage long-term memory. |
| `/checkpoint [list \| restore \| on \| off]` | checkpoint | Manage code snapshots. |
| `/rewind` | checkpoint | Restore code and optionally rewind the conversation tree. |
| `/cache [clear]` | cache-guard | Prompt-cache history for this session. |
| `/warming [status \| on \| off]` | cache-warming | Cache-warming policy and budget. |
| `/usage` | usage | Local usage panel. |
| `/read-watch [on \| off]` | read-watch | Enable or disable stale-read protection. |
| `/notify [on \| off \| status]` | notify | Terminal notifications. |
| `/rtk [on \| off \| status]` | rtk | RTK rewriting for this session. |
| `/golangci-lint [status \| enable \| disable] [project \| global]` | golangci-lint | Manage the lint hook. |
| `/permission [level \| config]` | permission | Optional policy level. |
| `/permission-mode [ask \| block]` | permission | Prompt or block when policy requires approval. |
| `/handoff [-mode <name>] [-model <provider/id>] <goal>` | handoff | Start a focused follow-up session. |
| `/lsp` | lsp-pi | LSP status and hook mode. |
| `/context` | context | Optional context overview. |

### Shortcuts

| Key | Action |
|---|---|
| `Alt+M` | Start/stop dictation: into the draft, or into the answer field of an open `question` dialog. |
| `Alt+U` | Mute/unmute the active dictation stream. |
| `Alt+I` | Open the image gallery; remove draft attachments. |
| `Ctrl+Shift+T` | Collapse/expand the todo panel. |
| `]t` / `[t` | Next/previous Neovim tour stop. |
| `<leader>pc` | Comment on the current Neovim line or selection. |
| `<leader>pl` | List Neovim comment threads. |
| `<leader>pr` | Resolve the comment under the cursor. |

> `]t` and `[t` override Neovim’s default tag jumps. The tour restores nothing else; `propose_change` uses extmarks, not `:diffthis`.

---

## Neovim setup

Add the bridge to your Neovim config:

```lua
pcall(dofile, "/absolute/path/to/pi-core/nvim/pi-ide.lua")
```

The bridge publishes a socket lock under `$XDG_RUNTIME_DIR/pi-ide`, `~/.pi/ide`, or `/tmp/pi-ide`. Pi picks the newest live endpoint whose workspace contains the current directory. You can also connect manually:

```sh
nvim --listen /tmp/nvim.sock
export PI_NVIM_SOCKET=/tmp/nvim.sock
```

Inside tmux with Kitty, inline images need:

```tmux
set -g allow-passthrough on
```

`/story` mirrors its stops into a **connected** Neovim, so `]t`/`[t` and `<leader>pc` work there too; it never opens a window on its own. `PI_NVIM_AUTO_OPEN=0` disables the explicit auto-open requests.

---

## Configuration

Most extensions work without configuration. The useful knobs:

| Variable | Used by | Meaning |
|---|---|---|
| `PI_CACHE_WARM_POLICY=0` | cache-warming | Disable idle warming entirely. |
| `PI_CACHE_WARM_IDLE_MINUTES` | cache-warming | Idle window in minutes (default `30`, floor `1`). |
| `PI_CACHE_WARM_IDLE_BUDGET` | cache-warming | Maximum spend per idle window (default `0.05`). |
| `PI_CACHE_WARM_MIN_SAVINGS` | cache-warming | Minimum expected saving (default `0.005`). |
| `PI_CHECKPOINT=0` | checkpoint | Disable checkpoint capture. |
| `PI_CHECKPOINT_DIR` | checkpoint | Override the blob directory. |
| `PI_MEMORY_DIR` | memory | Override the memory root. |
| `PI_MEMORY_AUTO=0` | memory | Disable auto-memory. |
| `PI_MEMORY_JEV=0` | memory | Disable Jev recall. |
| `PI_MEMORY_JEV_THRESHOLD` | memory | Relevance threshold (default `0.8`). |
| `PI_MEMORY_JEV_TIMEOUT_MS` | memory | Classifier timeout (default `2500`). |
| `PI_NOTIFY=0` | notify | Disable notifications. |
| `PI_NVIM_SOCKET` | nvim | Explicit Neovim socket. |
| `PI_NVIM_AUTO_OPEN=0` | nvim | Disable tmux auto-open. |
| `PI_NVIM_LIVE=0` | nvim | Disable live-follow after edits. |
| `PI_IDE_DIR` / `PI_IDE_TOKEN` | nvim | Override lock directory / token. |
| `PI_PERMISSION_LEVEL` | permission | Headless policy level. |
| `RTK_DISABLED=1` | rtk | Disable RTK for one command or the process. |
| `RTK_DISABLE_REWRITE=1` | rtk | Skip rewriting for one command. |
| `NARI_API_KEY` | voice | Nari API key when using `/voice api nari`. |

### Cache warming model override

`cacheWarming: "idle"` and a model with a declared prompt cache are required. A typical DeepSeek override in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "deepseek": {
      "modelOverrides": {
        "deepseek-flash": {
          "promptCache": { "short": 300 }
        }
      }
    }
  }
}
```

---

## Repository layout

```text
pi-core/
├── extensions/
│   ├── background-jobs/     jobs, monitors, path watches
│   ├── batch/               parallel read-only calls
│   ├── checkpoint/          file snapshots and rewind
│   ├── image-preview/       draft gallery, Kitty placeholders
│   ├── index/               LSP + tree-sitter + regex skeletons
│   ├── memory/              Claude-format memory and Jev recall
│   ├── nvim/                Neovim bridge, tour, comments, diff
│   ├── permission/          optional AST-backed policy
│   ├── usage/               local /usage panel
│   └── ...                  one directory per feature
├── licenses/                third-party license texts
├── nvim/pi-ide.lua          Neovim discovery and bridge server
├── scripts/third-party.mjs  offline lock verification
├── skills/                  local skill definitions
├── test/                    Node test runner suites
├── third-party.lock.json    SHA-256 inventory of vendored files
├── vendor/                  pinned WASM grammars
├── THIRD_PARTY.md           provenance and upstream commits
└── package.json
```

---

## Testing

Run the full suite against an installed pi SDK, without installing a second copy:

```sh
PI_OFFLINE=1 \
PI_TEST_NODE_MODULES="$HOME/.pi/agent/install/releases/1.3.0/node_modules" \
npm run test:agent-features
```

Typecheck the extension set:

```sh
npm run typecheck:agent-features
```

The tests use temporary directories, separate process groups, and local HTTP/WebSocket fakes. They do not call real models, microphones, or paid APIs. The suite covers permission and session state, job cleanup, bounded logs, atomic saves, `/btw` cancellation, codemode, cache warming, AST shell parsing, partial output, read-watch, images, voice, todo, question, Neovim tour/discovery, `index`, memory, notify, checkpoints, batch, RTK, walkthrough diff parsing and rendering, the local usage collector, and the vendored-file lock.

---

## Limits and non-goals

- These extensions run with **your user privileges**. They are not an OS sandbox.
- Background jobs belong to the pi process. They survive `/reload`, but not quitting pi. Use systemd or tmux for daemons.
- Checkpoints cover `edit`, `write`, and `propose_change`. Changes made through `bash`, MCP, or another editor are not automatically reversible.
- `read-watch` detects that a file changed, not who changed it. It is not a lock and not a full multi-agent coordination layer.
- RTK rewriting is best-effort and fail-open. It does not replace the permission layer.
- `/usage` reports persisted usage only. It does not invent subscription limits, and it does not include unrecorded tool costs.
- Memory recall with Jev sends memory summaries and the current query to the selected provider. Do not store secrets in memory.
- Voice never starts the microphone automatically. Nari mode is opt-in and sends audio off the machine.

---

## Roadmap

- Isolated-context subagents and a `task` tool.
- Plan mode with a read-only exploration phase.
- Checkpoints for changes made through `bash` and MCP.
- Multi-agent coordination and file-conflict notifications.
- Hold-to-talk dictation and richer push-to-talk workflows.

---

## Third-party code

Vendored code and WASM grammars are listed in [`THIRD_PARTY.md`](THIRD_PARTY.md), with exact upstream commits and license files in [`licenses/`](licenses). [`third-party.lock.json`](third-party.lock.json) records the SHA-256 of every vendored file and license.

Verify the inventory offline:

```sh
npm run third-party:check
```

The check rejects a changed vendored file, a missing license, and any unlisted file under `vendor/` or `licenses/`. After an intentional upstream refresh, update the copied files and run:

```sh
npm run third-party:lock
```

`lock` only refreshes hashes for files already declared in the lock; it does not fetch upstream and does not silently add new files. This repository does not include an automatic upstream updater.
