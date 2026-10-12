#!/usr/bin/env bash
# Usage: sol.sh <worktree> <brief-file> [effort=medium]; compatibility build entry.
set -euo pipefail
[[ $# == 2 || $# == 3 ]] || { echo "Usage: sol.sh <worktree> <brief-file> [effort=medium]" >&2; exit 2; }
exec "$(dirname "${BASH_SOURCE[0]}")/agent.sh" build "$1" "$2" --effort "${3:-medium}"
