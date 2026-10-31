#!/usr/bin/env bash
# Usage: stop-guard.sh < hook.json; refuse the end of a turn while a kit go job of this worktree runs (the Stop
# hook, Claude and Codex). The rules are in stop-guard.mjs beside it; without Node it never blocks.
set -euo pipefail
trap 'exit 0' ERR
here=$(dirname -- "${BASH_SOURCE[0]}")
# shellcheck source=../kit-lib.sh
source "$here/../kit-lib.sh"
kit_node > /dev/null 2>&1 || exit 0
exec timeout 15 "$KIT_NODE" "$here/stop-guard.mjs"
