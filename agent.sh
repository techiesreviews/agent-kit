#!/usr/bin/env bash
# Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude|grok|opencode] [--effort E] [--base REF] [--out DIR]; agent.sh --resume <out-dir> [--brief FILE]; kit doctor gates kit worktrees.
set -euo pipefail
agent_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# ASE_SKIP_DOCTOR=1 bypasses the gate for tests only.
gate=false
kind=${1-}
gate_dir=${2-}
if [[ $kind == --resume && ${ASE_SKIP_DOCTOR:-} != 1 && -f $gate_dir/status.json ]]; then
  { read -r gate_dir; read -r kind; } < <(node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(`${s.worktree}\n${s.kind}`)' "$gate_dir/status.json")
fi
if [[ ${ASE_SKIP_DOCTOR:-} != 1 && -d $gate_dir ]] && root=$(git -C "$gate_dir" rev-parse --show-toplevel 2>/dev/null); then
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=''
  own_common=$(git -C "$agent_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || own_common=''
  # Gate this repo's worktrees and any other checkout of the kit; unrelated repos (the starter, test repos) pass through.
  if [[ -n $common && -n $own_common && $(realpath -- "$common") == "$(realpath -- "$own_common")" ]] || [[ -f $root/scripts/agents/kit ]]; then
    gate=true
  fi
fi
if [[ $gate == true ]]; then
  # A builder starts despite a broken --help, so a fix round can repair it; reviews still need every help.
  skip=''
  if [[ $kind == build ]]; then skip=help; fi
  status=0
  output=$(cd -- "$root" && KIT_ROOT="$root" KIT_DOCTOR_SKIP="$skip" "$agent_dir/kit" doctor --quiet 2>&1) || status=$?
  if (( status != 0 )); then
    printf '%s\n' "$output" >&2
    printf 'agent.sh: kit doctor failed in %s; run scripts/agents/kit doctor there for details (ASE_SKIP_DOCTOR=1 is for tests only)\n' "$root" >&2
    exit 3
  fi
  if problems=$(grep '^problem: ' <<< "$output"); then
    printf '%s\n' "$problems" >&2
    printf 'agent.sh: building in %s despite the problem above; the builder should repair it\n' "$root" >&2
  fi
fi
# The skip is the gate's alone: the builder's or reviewer's own kit doctor sees every broken help.
unset KIT_DOCTOR_SKIP
exec node "$(dirname "${BASH_SOURCE[0]}")/agent-run.mjs" "$@"
