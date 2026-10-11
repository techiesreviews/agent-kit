#!/usr/bin/env bash
# Usage: review.sh <worktree> <brief-file> <out-dir>; read-only Sol review, validate completion and model.
set -euo pipefail
[[ $# == 3 ]] || { echo "Usage: review.sh <worktree> <brief-file> <out-dir>" >&2; exit 2; }
mkdir -p "$3"
rm -f "$3/result.md"
if codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -C "$1" -o "$3/result.md" - < "$2" > "$3/run.log" 2>&1; then :; else
  echo "problem: codex exec failed; see $3/run.log" >&2; exit 1
fi
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
grep -Eq '^[[:space:]]*model:[[:space:]]*gpt-6\.1-sol[[:space:]]*$' "$3/run.log" || { echo "problem: run.log does not name model gpt-6.1-sol" >&2; exit 1; }
echo ok
