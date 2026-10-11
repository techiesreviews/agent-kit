#!/usr/bin/env bash
# Usage: unit.sh [files...]; print unit counts/failures, retain the full log under .scratch/unit/.
set -euo pipefail
for file in "$@"; do
  [[ $file != -* && -f $file ]] || { echo "Usage: unit.sh [files...] (existing test files)" >&2; exit 2; }
done
mkdir -p .scratch/unit
log=.scratch/unit/$(date -u +%Y%m%dT%H%M%S)-$$.log
status=0
if (( $# )); then
  ./node_modules/.bin/tsx --test "$@" > "$log" 2>&1 || status=$?
else
  npm test > "$log" 2>&1 || status=$?
fi
node "$(dirname "${BASH_SOURCE[0]}")/unit-summary.mjs" "$log" || { (( status )) || status=1; }
echo "log: $log"
exit "$status"
