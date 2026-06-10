#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -s session -p pattern [options]

Poll a zellij session's screen for text and exit when found.

Options:
  -s, --session   zellij session name, required
  -p, --pattern   regex pattern to look for, required
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -h, --help      show this help
USAGE
}

session=""
pattern=""
grep_flag="-E"
timeout=15
interval=0.5

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session)  session="${2-}"; shift 2 ;;
    -p|--pattern)  pattern="${2-}"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  timeout="${2-}"; shift 2 ;;
    -i|--interval) interval="${2-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$session" || -z "$pattern" ]]; then
  echo "session and pattern are required" >&2
  usage
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! command -v zellij >/dev/null 2>&1; then
  echo "zellij not found in PATH" >&2
  exit 1
fi

start_epoch=$(date +%s)
deadline=$((start_epoch + timeout))

while true; do
  screen_text="$(zellij --session "$session" action dump-screen /dev/stdout 2>/dev/null || true)"

  if printf '%s\n' "$screen_text" | grep $grep_flag -- "$pattern" >/dev/null 2>&1; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
    echo "Last screen from session '$session':" >&2
    printf '%s\n' "$screen_text" >&2
    exit 1
  fi

  sleep "$interval"
done
