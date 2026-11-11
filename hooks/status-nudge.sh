#!/usr/bin/env bash
# Usage: status-nudge.sh < hook.json; for a prompt that is a finished helper's result ("Delegated task <id> (<title>)
# [completed|failed|interrupted]:"), add context asking the lead to end its reply with the two-line status. It only
# adds context: never a block, never a Stop hook, and silent for every other prompt. Opt-in: kit init does not write
# it; a project turns it on by adding `run.sh status-nudge` under UserPromptSubmit in its own .claude/settings.json.
set -euo pipefail
trap 'exit 0' ERR
context='A helper finished. End your reply to Lex with a two-line status in plain words. Line 1 - Done: <what finished>; Running: <what still runs, or none>. Line 2 - Next: <what happens next, or what Lex must do>.'
jq -er --arg context "$context" '
  if .hook_event_name == "UserPromptSubmit" and ((.prompt | type) == "string")
    and (.prompt | split("\n")[0] | test("^Delegated task \\S+ .*\\[(completed|failed|interrupted)\\]"))
  then {hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $context}}
  else empty end' 2>/dev/null || true
exit 0
