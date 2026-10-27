#!/usr/bin/env bash
# Usage: unit.sh [files...]; print unit counts/failures, retain the full log under .scratch/unit/.
set -euo pipefail
timeout=${ASE_UNIT_TIMEOUT_MS:-120000}
[[ $timeout =~ ^[0-9]+$ ]] && (( timeout > 0 )) || { echo "Usage: unit.sh [files...] (existing test files); ASE_UNIT_TIMEOUT_MS must be a positive integer (ms)" >&2; exit 2; }
for file in "$@"; do
  [[ $file != -* && -f $file ]] || { echo "Usage: unit.sh [files...] (existing test files)" >&2; exit 2; }
done
# shellcheck source=scripts/agents/kit-lib.sh
source "${KIT_LIB:-$(dirname -- "${BASH_SOURCE[0]}")/kit-lib.sh}"
# The test runner and the full suite's files come from unit.run and unit.files in scripts/agents/kit.json.
problems=$(kit_settings_problems) || { printf 'unit.sh: %s\n' "${problems//$'\n'/; }" >&2; exit 2; }
read -ra runner <<< "$(kit_setting .unit.run)"
(( ${#runner[@]} )) || { echo "unit.sh needs unit.run in scripts/agents/kit.json" >&2; exit 2; }
if (( ! $# )); then
  pattern=$(kit_setting .unit.files)
  [[ -n $pattern ]] || { echo "unit.sh needs unit.files in scripts/agents/kit.json to run the full suite" >&2; exit 2; }
  # shellcheck disable=SC2086 # The pattern is a glob such as tests/*.test.ts.
  set -- $pattern
fi
mkdir -p .scratch/unit
log=.scratch/unit/$(date -u +%Y%m%dT%H%M%S)-$$.log
status=0
"${runner[@]}" --test-timeout="$timeout" "$@" > "$log" 2>&1 || status=$?
node "$(dirname "${BASH_SOURCE[0]}")/unit-summary.mjs" "$log" || { (( status )) || status=1; }
echo "log: $log"
exit "$status"
