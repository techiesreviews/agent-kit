#!/usr/bin/env bash
# Usage: brief-guard.sh < hook.json; refuse a child's brief that kit brief did not write (PreToolUse on
# mcp__t3-code__delegate_task and Agent|Task). A brief passes with kit brief's marker line ("kit-brief: <version>
# <ticket> <stage>"), or with a first line "kit-brief: none (<reason>)" for research, review-only and question
# tasks. The read-only agent types (Explore, Plan) never build, so they pass as they are.
set -euo pipefail
trap 'exit 0' ERR
verdict=$(jq -r '
  if .hook_event_name != "PreToolUse" or ((.tool_name // "") | IN("mcp__t3-code__delegate_task", "Agent", "Task") | not) then "allow"
  elif ((.tool_input.subagent_type // "") | IN("Explore", "Plan")) then "allow"
  else ((.tool_input.task // .tool_input.prompt // "") | tostring | split("\n") | map(select(test("\\S")))) as $lines
    | if (($lines[0] // "") | test("^\\s*kit-brief: none \\(.*\\S.*\\)\\s*$")) then "allow"
      elif any($lines[]; test("^kit-brief: (?!none\\b)\\S+ \\S+ (build|review|second-look|fix)\\s*$")) then "allow"
      else "refuse" end
  end' 2>/dev/null) || exit 0
[[ $verdict == refuse ]] || exit 0
printf '%s\n' 'Brief refused: a coding brief comes from `scripts/agents/kit brief <ticket> [--stage build|review|second-look|fix] [--note "<text>"]` (in a project without ticket files: `scripts/agents/kit brief --task "<title>" --owner <id> --note "<the task>"`); pass its whole output (it ends with a kit-brief: marker line). For research, review-only or a question, make the first line `kit-brief: none (<reason>)`.' >&2
exit 2
