#!/usr/bin/env bash
# Usage: review.sh <worktree> <brief-file> <out-dir>; agent review, validate completion.
set -euo pipefail
[[ $# == 3 ]] || { echo "Usage: review.sh <worktree> <brief-file> <out-dir>" >&2; exit 2; }
mkdir -p "$3"
rm -f "$3/result.md"
status=0
"$(dirname "${BASH_SOURCE[0]}")/agent.sh" review "$1" "$2" || status=$?
out=$(realpath "$1")/.scratch/agent/review
if [[ $(realpath "$3") != "$out" && -f $out/run.log ]]; then cp "$out/run.log" "$3/run.log"; fi
[[ ! -f $out/out.md ]] || cp "$out/out.md" "$3/result.md"
(( status == 0 )) || exit "$status"
node --input-type=module - "$3/result.md" "$(dirname "${BASH_SOURCE[0]}")/review-brief.mjs" <<'EOF' || {
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { reviewComplete } = await import(pathToFileURL(resolve(process.argv[3])).href);
try { if (!reviewComplete(readFileSync(process.argv[2], "utf8"))) process.exit(1); }
catch { process.exit(1); }
EOF
  echo "problem: result lacks REVIEW_STATUS: complete" >&2; exit 1;
}
echo ok
