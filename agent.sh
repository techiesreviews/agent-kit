#!/usr/bin/env bash
# Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude] [--effort E].
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/agent-run.mjs" "$@"
