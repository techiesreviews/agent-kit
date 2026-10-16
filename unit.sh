#!/usr/bin/env bash
# Usage: unit.sh [files...]; print unit counts/failures, retain the full log under .scratch/unit/.
set -euo pipefail
timeout=${ASE_UNIT_TIMEOUT_MS:-120000}
[[ $timeout =~ ^[0-9]+$ ]] && (( timeout > 0 )) || { echo "Usage: unit.sh [files...] (existing test files); ASE_UNIT_TIMEOUT_MS must be a positive integer (ms)" >&2; exit 2; }
for file in "$@"; do
  [[ $file != -* && -f $file ]] || { echo "Usage: unit.sh [files...] (existing test files)" >&2; exit 2; }
done
mkdir -p .scratch/unit
log=.scratch/unit/$(date -u +%Y%m%dT%H%M%S)-$$.log
status=0
if (( $# )); then
  ./node_modules/.bin/tsx --test --test-timeout="$timeout" "$@" > "$log" 2>&1 || status=$?
else
  ./node_modules/.bin/tsx --test --test-timeout="$timeout" tests/*.test.ts > "$log" 2>&1 || status=$?
fi
node "$(dirname "${BASH_SOURCE[0]}")/unit-summary.mjs" "$log" || { (( status )) || status=1; }
echo "log: $log"
exit "$status"
