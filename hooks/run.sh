#!/usr/bin/env bash
# Usage: run.sh <bash-guard|session-env|agent-cap|context-card> < hook.json.
set -euo pipefail
trap 'exit 0' ERR
[[ $# == 1 ]] || exit 0
case $1 in bash-guard|session-env|agent-cap|context-card) ;; *) exit 0 ;; esac
root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}
if [[ $1 == context-card ]]; then
  # The card never blocks a session: it prints SessionStart context or nothing.
  timeout 5 node "$root/scripts/agents/context-card.mjs" --hook 2>/dev/null || true
  exit 0
fi
bash "$root/scripts/agents/hooks/$1.sh" || {
  status=$?
  [[ $status != 2 ]] || exit 2
}
