#!/usr/bin/env bash
# Usage: run.sh <bash-guard|session-env|agent-cap> < hook.json.
set -euo pipefail
trap 'exit 0' ERR
[[ $# == 1 ]] || exit 0
case $1 in bash-guard|session-env|agent-cap) ;; *) exit 0 ;; esac
root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}
bash "$root/scripts/agents/hooks/$1.sh" || {
  status=$?
  [[ $status != 2 ]] || exit 2
}
