---
name: zellij
description: "Remote control zellij sessions for interactive CLIs (python, gdb, lldb, etc.) by sending keystrokes and scraping pane output."
license: Vibecoded
---

# zellij Skill

Use zellij as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock zellij. Drive sessions non-interactively with `zellij --session <name> action ...` so you never have to attach.

## Quickstart (named session)

```bash
SESSION=agentic-python                                              # slug-like names; avoid spaces
zellij delete-session "$SESSION" 2>/dev/null || true                # ensure a clean start
zellij --session "$SESSION" options --on-force-close detach >/dev/null 2>&1 &  # spawn detached server
sleep 1                                                             # give the server time to boot
./scripts/wait-for-session.sh -s "$SESSION" -T 15                   # confirm the session exists
zellij --session "$SESSION" action write-chars 'python3 -q'         # type a command
zellij --session "$SESSION" action write 10                         # press Enter (byte 10 = \n)
zellij --session "$SESSION" action dump-screen /dev/stdout          # watch output
zellij delete-session --force "$SESSION"                            # clean up
```

> NOTE: zellij has no private-socket concept like tmux. Isolation is achieved through unique **named sessions**. Always pass `--session "$SESSION"` so commands target the right server and never touch the user's interactive sessions.

After starting a session ALWAYS tell the user how to monitor it by giving them a command to copy paste:

```
To monitor this session yourself:
  zellij attach agentic-python

Or to capture the output once:
  zellij --session agentic-python action dump-screen /dev/stdout
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop. But the earlier you send it, the happier the user will be.

## Session convention

- Agents MUST use a prefix to keep sessions enumerable and avoid clashing with the user's own sessions. Default prefix: `agentic-` (e.g. `agentic-py`, `agentic-gdb`, `agentic-lldb`).
- Keep names short and slug-like (no spaces). One purpose per session.
- Sessions persist after detach. Always clean up with `zellij delete-session --force "$SESSION"` when done.

## Targeting panes and tabs

- A fresh session has one tab with one pane that is automatically focused, so `action write` / `write-chars` / `dump-screen` hit the right place without extra targeting.
- To open a new pane: `zellij --session "$SESSION" action new-pane` (add `-d down|right` to split a direction). A new pane becomes focused automatically.
- To open a new tab: `zellij --session "$SESSION" action new-tab --name shell`.
- Move focus before sending input if you have multiple panes: `zellij --session "$SESSION" action move-focus left|right|up|down` or `action focus-next-pane` / `action focus-previous-pane`.
- Inspect what's running: `zellij list-sessions` and `zellij --session "$SESSION" action query-tab-names`.

## Finding sessions

- List all sessions with metadata: `./scripts/find-sessions.sh`; add `-q partial-name` to filter by substring.
- Raw listing straight from zellij: `zellij list-sessions` (shows EXITED sessions too; resurrect with `zellij attach <name>` or purge with `zellij delete-session --force <name>`).

## Sending input safely

- Type literal text without a trailing newline: `zellij --session "$SESSION" action write-chars -- 'echo hello'`. Use `--` so leading dashes in the text aren't parsed as flags.
- Press Enter / send raw bytes with `action write <byte...>`:
  - Enter: `action write 10`
  - Ctrl-C: `action write 3`
  - Ctrl-D (EOF): `action write 4`
  - Ctrl-Z (suspend): `action write 26`
  - Escape: `action write 27`
  - Tab: `action write 9`
- Common pattern is `write-chars` then `write 10` to submit a command. To send a multi-line paste, repeat the pair per line.
- Avoid shell expansion surprises by single-quoting the argument to `write-chars`.

## Watching output

- Dump the visible screen: `zellij --session "$SESSION" action dump-screen /dev/stdout`.
- Capture to a file for diffing/inspection: `zellij --session "$SESSION" action dump-screen /tmp/out.txt` then read it.
- zellij's `dump-screen` captures the current viewport (scrollback is limited); poll repeatedly with the helper script below instead of relying on `wait-for`-style blocking.
- You can also temporarily attach to observe: `zellij attach "$SESSION"`; detach with `Ctrl+o d` (default keybinding).
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action; don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your keystrokes. Start it as `PYTHON_BASIC_REPL=1 python3 -q` via `write-chars`.

## Synchronizing / waiting for prompts

- Use timed polling to avoid races with interactive tools. Example: wait for a Python prompt before sending code:
  ```bash
  ./scripts/wait-for-text.sh -s "$SESSION" -p '^>>>' -T 15
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.

## Interactive tool recipes

- **Python REPL**: `write-chars 'PYTHON_BASIC_REPL=1 python3 -q'` then `write 10`; wait for `^>>>`; send code with `write-chars` + `write 10`; interrupt with `write 3`.
- **gdb**: `write-chars 'gdb --quiet ./a.out'` + `write 10`; disable paging `write-chars 'set pagination off'` + `write 10`; break with `write 3`; issue `bt`, `info locals`, etc.; exit via `write-chars 'quit'` + `write 10` then confirm `write-chars 'y'` + `write 10`.
- **dlv (Go debugger)**: `write-chars 'dlv debug ./main.go'` + `write 10`; set breakpoint `write-chars 'b main.main'` + `write 10`; continue `write-chars 'continue'` + `write 10`; step `write-chars 'step'` + `write 10`; next `write-chars 'next'` + `write 10`; print variables `write-chars 'print varName'` + `write 10`; stack trace `write-chars 'bt'` + `write 10`; exit via `write-chars 'quit'` + `write 10` then confirm `write-chars 'y'` + `write 10`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text with `write-chars` and submit with `write 10`.

## Cleanup

- Kill a session when done: `zellij delete-session --force "$SESSION"`.
- Kill all agent sessions (matching the `agentic-` prefix):
  ```bash
  zellij list-sessions -ns | awk '{print $1}' | grep '^agentic-' | xargs -r -n1 zellij delete-session --force
  ```
- Purge every EXITED session: `zellij delete-all-sessions --force`.

## Helper: wait-for-text.sh

`./scripts/wait-for-text.sh` polls a session's screen for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + zellij + grep.

```bash
./scripts/wait-for-text.sh -s session -p 'pattern' [-F] [-T 20] [-i 0.5]
```

- `-s`/`--session` session name (required)
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured screen to stderr to aid debugging.

## Helper: wait-for-session.sh

`./scripts/wait-for-session.sh` polls until a named session is registered with the zellij server.

```bash
./scripts/wait-for-session.sh -s session [-T 15] [-i 0.5]
```

- `-s`/`--session` session name (required)
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- Exits 0 once the session appears, 1 on timeout.
