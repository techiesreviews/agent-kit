#!/usr/bin/env bash
# Usage: session-env.sh < hook.json; put the highest installed Node >=24 on PATH.
set -euo pipefail
trap 'exit 0' ERR
exec 2>/dev/null
jq -e 'select(.hook_event_name == "SessionStart")' >/dev/null 2>&1
version=$(node --version)
[[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || exit 0
(( BASH_REMATCH[1] < 24 )) || exit 0
root=${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}
[[ -n $root ]] || exit 0
best=""
major=0 minor=0 patch=0
shopt -s nullglob
for candidate in "$root"/.npm/_npx/*/node_modules/node/bin/node "$root"/.nvm/versions/node/*/bin/node; do
  [[ -x $candidate ]] || continue
  # One broken candidate must not hide another working installation.
  candidate_version=$("$candidate" --version 2>/dev/null) || continue
  [[ $candidate_version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || continue
  next_major=${BASH_REMATCH[1]} next_minor=${BASH_REMATCH[2]} next_patch=${BASH_REMATCH[3]}
  if (( next_major >= 24 && (next_major > major || (next_major == major && next_minor > minor) || (next_major == major && next_minor == minor && next_patch > patch)) )); then
    best=${candidate%/node}
    major=$next_major minor=$next_minor patch=$next_patch
  fi
done
[[ -n $best ]] || exit 0
# Double-quote escaping preserves spaces and literal shell metacharacters.
best=${best//\\/\\\\}
best=${best//\"/\\\"}
best=${best//\$/\\\$}
best=${best//\`/\\\`}
if [[ -n ${CLAUDE_ENV_FILE:-} ]]; then
  printf 'export PATH="%s:$PATH"\n' "$best" >> "$CLAUDE_ENV_FILE"
else
  context=$(printf 'Node >=24 is required. Prefix shell commands with: export PATH="%s:$PATH"' "$best")
  jq -n --arg context "$context" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $context}}'
fi
