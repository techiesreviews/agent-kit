#!/usr/bin/env bash
# Usage: agent-cap.sh < hook.json; track and cap Claude subagents per session.
set -euo pipefail
trap 'exit 0' ERR
fields=$(jq -er '[.hook_event_name, .session_id, (.agent_id // "-"), (.tool_name // "-")] | map(select(type == "string")) | select(length == 4) | @tsv' 2>/dev/null)
IFS=$'\t' read -r event session agent tool <<< "$fields"
[[ $session =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
state="${CLAUDE_AGENT_CAP_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/claude-agent-cap}/$session"
case $event in
  SubagentStart)
    [[ $agent =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
    mkdir -p -- "$state"
    touch -- "$state/$agent"
    ;;
  SubagentStop)
    [[ $agent =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
    rm -f -- "$state/$agent"
    ;;
  PreToolUse)
    [[ $tool == Agent || $tool == Task ]] || exit 0
    cap=${CLAUDE_AGENT_CAP:-5}
    [[ $cap =~ ^[1-9][0-9]{0,8}$ && -d $state ]] || exit 0
    now=$(date +%s)
    count=0
    for entry in "$state"/*; do
      [[ -f $entry ]] || continue
      modified=$(stat -c %Y -- "$entry")
      if (( now - modified < 21600 )); then count=$((count + 1)); fi
    done
    if (( count >= cap )); then
      printf '%s subagents running (cap %s): wait for one to finish\n' "$count" "$cap" >&2
      exit 2
    fi
    ;;
esac
