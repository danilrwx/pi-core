#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-session.sh -s session [options]

Poll until a named zellij session is registered with the server.

Options:
  -s, --session   zellij session name, required
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -h, --help      show this help
USAGE
}

session=""
timeout=15
interval=0.5

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session)  session="${2-}"; shift 2 ;;
    -T|--timeout)  timeout="${2-}"; shift 2 ;;
    -i|--interval) interval="${2-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$session" ]]; then
  echo "session is required" >&2
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
  # -ns: no-formatting + short, one session name per line
  if zellij list-sessions -ns 2>/dev/null | awk '{print $1}' | grep -Fxq -- "$session"; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    echo "Timed out after ${timeout}s waiting for session: $session" >&2
    echo "Current sessions:" >&2
    zellij list-sessions 2>/dev/null >&2 || echo "  (no zellij server running)" >&2
    exit 1
  fi

  sleep "$interval"
done
