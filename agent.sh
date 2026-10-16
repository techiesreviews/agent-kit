#!/usr/bin/env bash
# Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude] [--effort E] [--base REF] [--out DIR]; kit doctor gates kit worktrees.
set -euo pipefail
agent_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# ASE_SKIP_DOCTOR=1 bypasses the gate for tests only.
if [[ ${ASE_SKIP_DOCTOR:-} != 1 && -d ${2-} ]] &&
  [[ $(git -C "$2" rev-parse --is-inside-work-tree 2>/dev/null) == true ]] &&
  common=$(git -C "$2" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
  own_common=$(git -C "$agent_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
  [[ $(realpath -- "$common") == "$(realpath -- "$own_common")" ]]; then
  root=$(git -C "$2" rev-parse --show-toplevel)
  status=0
  output=$(cd -- "$root" && KIT_ROOT="$root" "$agent_dir/kit" doctor --quiet 2>&1) || status=$?
  if (( status != 0 )); then
    printf '%s\n' "$output" >&2
    printf 'agent.sh: kit doctor failed in %s; run scripts/agents/kit doctor there for details (ASE_SKIP_DOCTOR=1 is for tests only)\n' "$root" >&2
    exit 3
  fi
fi
exec node "$(dirname "${BASH_SOURCE[0]}")/agent-run.mjs" "$@"
