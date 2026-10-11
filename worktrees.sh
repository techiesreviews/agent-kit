#!/usr/bin/env bash
# Usage: worktrees.sh [--prune] [--older-than DAYS=3]; list registered worktrees, optionally remove eligible ones.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/worktrees.mjs" "$@"
