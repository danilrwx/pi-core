#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: find-sessions.sh [-q pattern] [-a]

List zellij sessions with metadata.

Options:
  -q, --query   case-insensitive substring to filter session names
  -a, --all     include EXITED sessions (default: active only)
  -h, --help    show this help
USAGE
}

query=""
include_exited=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--query) query="${2-}"; shift 2 ;;
    -a|--all)   include_exited=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v zellij >/dev/null 2>&1; then
  echo "zellij not found in PATH" >&2
  exit 1
fi

# zellij list-sessions prints "<name> [Created ...] (current|EXITED ...)" with colors.
# -n disables formatting so we can parse it reliably.
sessions="$(zellij list-sessions -n 2>/dev/null || true)"

if [[ -z "$sessions" ]]; then
  echo "No zellij sessions found"
  exit 0
fi

if [[ "$include_exited" != true ]]; then
  sessions="$(printf '%s\n' "$sessions" | grep -v 'EXITED' || true)"
fi

if [[ -n "$query" ]]; then
  sessions="$(printf '%s\n' "$sessions" | grep -i -- "$query" || true)"
fi

if [[ -z "$sessions" ]]; then
  echo "No matching sessions found"
  exit 0
fi

echo "Sessions:"
printf '%s\n' "$sessions" | while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  printf '  - %s\n' "$line"
done
