#!/usr/bin/env bash
# Usage: review.sh <worktree> <brief-file> <out-dir> [--base REF | --commit SHA]; run an agent review.
set -euo pipefail
[[ $# == 3 || ( $# == 5 && ( $4 == --base || $4 == --commit ) ) ]] || { echo "Usage: review.sh <worktree> <brief-file> <out-dir> [--base REF | --commit SHA]" >&2; exit 2; }
mkdir -p "$3"
rm -f "$3/result.md"
status=0
artifacts=$(realpath "$1")/.scratch/agent
mkdir -p "$artifacts"
out=$(mktemp -d "$artifacts/review-$(date +%s)-$$-XXXXXX")
"$(dirname "${BASH_SOURCE[0]}")/agent.sh" review "$1" "$2" --out "$out" "${@:4}" || status=$?
if [[ $(realpath "$3") != "$out" && -f $out/run.log ]]; then cp "$out/run.log" "$3/run.log"; fi
[[ ! -f $out/out.md ]] || cp "$out/out.md" "$3/result.md"
(( status == 0 )) || exit "$status"
echo ok
