#!/usr/bin/env bash
# Usage: agent-cap.sh < hook.json; track and cap Claude subagents per session.
set -euo pipefail
trap 'exit 0' ERR
fields=$(jq -er '[.hook_event_name, .session_id, (.agent_id // "-"), (.tool_name // "-"), (.tool_use_id // "-")] | map(select(type == "string")) | select(length == 5) | @tsv' 2>/dev/null)
IFS=$'\t' read -r event session agent tool launch <<< "$fields"
[[ $session =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
state="${CLAUDE_AGENT_CAP_STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}/claude-agent-cap}/$session"
# Validate before creating state; every state change uses the same lock.
case $event in
  SubagentStart|SubagentStop) [[ $agent =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0 ;;
  PreToolUse|PostToolUse|PostToolUseFailure)
    [[ $tool == Agent || $tool == Task ]] || exit 0
    [[ $launch =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
    ;;
  *) exit 0 ;;
esac
cap=${CLAUDE_AGENT_CAP:-5}
[[ $cap =~ ^[1-9][0-9]{0,8}$ ]] || exit 0
pending="$state/.pending"
mkdir -p -- "$pending"
exec 9>"$state/.lock"
flock -x 9
now=$(date +%s)
count=0
for entry in "$state"/* "$pending"/*; do
  [[ -f $entry ]] || continue
  age=21600
  [[ $entry == "$pending/"* ]] && age=180
  modified=$(stat -c %Y -- "$entry")
  if (( now - modified >= age )); then
    rm -f -- "$entry"
  else
    count=$((count + 1))
  fi
done
case $event in
  SubagentStart)
    # Duplicate starts refresh the live entry without consuming another slot.
    if [[ ! -f $state/$agent ]]; then
      # Timestamped names sort in reservation order, even within one second.
      for entry in "$pending"/*; do
        [[ -f $entry ]] || continue
        rm -f -- "$entry"
        break
      done
    fi
    touch -- "$state/$agent"
    ;;
  SubagentStop)
    rm -f -- "$state/$agent"
    ;;
  PostToolUse|PostToolUseFailure)
    # Reconcile the tool ID even when FIFO assigned another reservation at start.
    [[ $launch != "-" ]] || exit 0
    for entry in "$pending"/*; do
      [[ -f $entry ]] || continue
      read -r reserved < "$entry"
      if [[ $reserved == "$launch" ]]; then rm -f -- "$entry"; fi
    done
    ;;
  PreToolUse)
    for entry in "$pending"/*; do
      [[ -f $entry ]] || continue
      read -r reserved < "$entry"
      # Repeated delivery of an identified tool call reserves only once.
      if [[ $launch != "-" && $reserved == "$launch" ]]; then exit 0; fi
    done
    if (( count >= cap )); then
      printf '%s subagents running or pending (cap %s): wait for one to finish\n' "$count" "$cap" >&2
      exit 2
    fi
    entry=$(mktemp "$pending/$(date +%s%N).XXXXXX")
    printf '%s\n' "$launch" > "$entry"
    ;;
esac
