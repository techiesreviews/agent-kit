#!/usr/bin/env bash
# Usage: run.sh <bash-guard|session-env|agent-cap|context-card> < hook.json.
# The guard hooks sit beside this file, in the kit, so a project's hook launcher can run it from the machine copy.
set -euo pipefail
trap 'exit 0' ERR
[[ $# == 1 ]] || exit 0
case $1 in bash-guard|session-env|agent-cap|context-card) ;; *) exit 0 ;; esac
if [[ $1 == context-card ]]; then
  # The card never blocks a session: it prints SessionStart context or nothing. It is the kit's own script,
  # beside these hooks, for every project.
  timeout 1 node "$(dirname -- "${BASH_SOURCE[0]}")/../context-card.mjs" --hook 2>/dev/null || true
  exit 0
fi
bash "$(dirname -- "${BASH_SOURCE[0]}")/$1.sh" || {
  status=$?
  [[ $status != 2 ]] || exit 2
}
