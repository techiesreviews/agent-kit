#!/usr/bin/env bash
# Usage: worktree.sh <branch> [base=origin/<land>]; create a sibling worktree with shared dependencies/fixture.
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "Usage: worktree.sh <branch> [base=origin/<land>]" >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
# Settings come from this checkout's scripts/agents/kit.json.
export KIT_ROOT=$root
# shellcheck source=kit-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/kit-lib.sh"
problems=$(kit_settings_problems) || { printf 'worktree.sh: %s\n' "${problems//$'\n'/; }" >&2; exit 1; }
branch=$1
base=${2:-origin/$(kit_setting .branches.land)}
git check-ref-format --branch "$branch" >/dev/null
# worktreePrefix names the sibling folder; without it the project name and a dash do.
prefix=$(kit_setting .worktreePrefix)
[[ -n $prefix ]] || prefix="$(kit_setting .project)-"
path="$(dirname "$root")/$prefix${branch//\//-}"
modules=''
dev_modules=$(kit_setting .sharedNodeModules)
if [[ -n $dev_modules ]]; then
  if [[ -L $dev_modules ]]; then modules=$(realpath "$dev_modules"); else modules=$dev_modules; fi
  [[ -d $modules ]] || { echo "Missing node_modules: $modules" >&2; exit 1; }
fi
# worktreeLinks names paths under the project's top that every worktree shares with the main checkout, linked even
# before the main checkout makes them (the editor's static preview); none without the key.
links=()
if raw=$(kit_setting .worktreeLinks) && [[ -n $raw ]]; then
  list=$(jq -r 'if type == "array" and all(.[]; type == "string" and . != "" and (startswith("/") | not) and (split("/") | index("..") == null))
    then .[] else error("bad") end' <<< "$raw" 2>/dev/null) \
    || { echo 'worktree.sh: worktreeLinks in scripts/agents/kit.json must be a list of relative paths inside the project' >&2; exit 1; }
  [[ -z $list ]] || mapfile -t links <<< "$list"
fi
git worktree add -b "$branch" "$path" "$base" >&2
mkdir -p "$path/.scratch"
owner=${ASE_OWNER:-unknown}
owner=${owner//$'\n'/ }
owner=${owner//$'\r'/ }
printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$owner" "$branch" "$base" > "$path/.scratch/owner"
if [[ -n $modules ]]; then
  ln -s "$modules" "$path/node_modules"
else
  echo "No sharedNodeModules in scripts/agents/kit.json; install dependencies in $path" >&2
fi
main=$(kit_main_root)
if [[ $main != "$path" ]]; then
  for link in "${links[@]}"; do
    mkdir -p "$(dirname -- "$path/$link")"
    ln -s "$main/$link" "$path/$link"
  done
fi
printf '%s\n' "$path"
