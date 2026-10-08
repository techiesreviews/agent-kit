#!/usr/bin/env bash
# Usage: worktree.sh <branch> [base=origin/dev]; create a sibling worktree with shared dependencies/fixture.
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "Usage: worktree.sh <branch> [base=origin/dev]" >&2; exit 2; }
root=$(git rev-parse --show-toplevel)
branch=$1
base=${2:-origin/dev}
git check-ref-format --branch "$branch" >/dev/null
path="$(dirname "$root")/native-site-editor-${branch//\//-}"
dev_modules=/home/ubulex/Projects/native-site-editor-dev/node_modules
if [[ -L $dev_modules ]]; then modules=$(realpath "$dev_modules"); else modules=$dev_modules; fi
[[ -d $modules ]] || { echo "Missing node_modules: $modules" >&2; exit 1; }
git worktree add -b "$branch" "$path" "$base" >&2
ln -s "$modules" "$path/node_modules"
mkdir -p "$path/.scratch"
ln -s /home/ubulex/Projects/native-site-editor/.scratch/native-static-preview "$path/.scratch/native-static-preview"
printf '%s\n' "$path"
