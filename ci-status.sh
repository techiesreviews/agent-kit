#!/usr/bin/env bash
# Usage: ci-status.sh [branch=dev] [--wait]; latest workflow results, optionally wait for origin head.
set -euo pipefail
branch=dev
wait_for_head=0
has_branch=0
usage() { echo 'Usage: ci-status.sh [branch=dev] [--wait]' >&2; exit 2; }
for arg in "$@"; do
  case $arg in
    --wait) wait_for_head=1 ;;
    -*) usage ;;
    *) (( !has_branch )) || usage; branch=$arg; has_branch=1 ;;
  esac
done
git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 || usage
root=$(git rev-parse --show-toplevel)
cd "$root"
args=("$branch")
if (( wait_for_head )); then
  head=$(git rev-parse --verify "refs/remotes/origin/$branch^{commit}") || { echo 'problem: origin head'; exit 1; }
  args+=("$head")
fi
exec node scripts/agents/ci-summary.mjs "${args[@]}"
