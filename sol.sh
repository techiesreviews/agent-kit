#!/usr/bin/env bash
# Usage: sol.sh <worktree> <brief-file> [effort=medium]; build with Sol, bounded by SOL_TIMEOUT (default 90m).
set -euo pipefail
[[ $# == 2 || $# == 3 ]] || { echo "Usage: sol.sh <worktree> <brief-file> [effort=medium]" >&2; exit 2; }
effort=${3:-medium}
limit=${SOL_TIMEOUT:-90m}
[[ $effort =~ ^(low|medium|high|xhigh)$ && $limit =~ ^[1-9][0-9]*[smhd]?$ && -d $1 && -f $2 ]] || {
  echo "problem: need a worktree, brief, valid effort and positive SOL_TIMEOUT (e.g. 90m)" >&2; exit 2;
}
wt=$(realpath "$1")
common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)
out=$wt/.scratch/sol
mkdir -p "$out"
brief=$out/brief-$$.md
cat "$2" > "$brief"
cat >> "$brief" <<'EOF'

## Build contract
Leave changes unstaged. Do not commit, push, deploy, spawn agents or use git stash.
Run npm run check, npm test and npm run lint, plus the ticket's touched specs.
Final report: at most 15 lines; changed files, behavior, validation and unresolved risks.
EOF
rm -f "$out/out.md"
status=0
# The supervisor owns codex's process group and waits for its exit event.
node "$(dirname "${BASH_SOURCE[0]}")/sol-run.mjs" "$limit" codex exec -m gpt-6.1-sol \
  -c "model_reasoning_effort=$effort" -s workspace-write \
  -c sandbox_workspace_write.network_access=true --add-dir "$common" \
  -C "$wt" -o "$out/out.md" - < "$brief" > "$out/run.log" 2>&1 || status=$?
if (( status == 124 )); then
  echo "problem: Sol exceeded SOL_TIMEOUT=$limit; process group killed; see $out/run.log" >&2
elif (( status )); then
  echo "problem: codex exec failed ($status); see $out/run.log" >&2
fi
if ! grep -Eq '^[[:space:]]*model:[[:space:]]*gpt-6\.1-sol[[:space:]]*$' "$out/run.log"; then
  echo "problem: run.log does not name model gpt-6.1-sol" >&2
  (( status )) || status=1
fi
if [[ -f $out/out.md ]]; then cat "$out/out.md"; else
  echo "problem: no final report; see $out/run.log" >&2
  (( status )) || status=1
fi
git -C "$wt" status --short
exit "$status"
