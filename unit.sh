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
problems=$(kit_settings_problems) || { printf 'unit.sh: %s\n' "${problems//$'\n'/; }" >&2; exit 1; }
read -ra runner <<< "$(kit_setting .unit.run)"
(( ${#runner[@]} )) || { echo "unit.sh needs unit.run in scripts/agents/kit.json" >&2; exit 2; }
if (( ! $# )); then
  # unit.files is one pattern or a list: globs (** spans folders) or a folder ending in / for every
  # JavaScript or TypeScript file under it, the same files kit unit picks.
  mapfile -t patterns < <(kit_setting '.unit.files | if type == "array" then .[] else . end')
  (( ${#patterns[@]} )) || { echo "unit.sh needs unit.files in scripts/agents/kit.json to run the full suite" >&2; exit 2; }
  shopt -s globstar nullglob
  files=()
  for pattern in "${patterns[@]}"; do
    if [[ $pattern == */ ]]; then
      [[ ! -d $pattern ]] || mapfile -t -O "${#files[@]}" files < <(find "$pattern" -type f -regex '.*\.\(js\|mjs\|cjs\|ts\|mts\|cts\|tsx\)' | sort)
    else
      # shellcheck disable=SC2206 # The pattern is a glob such as tests/*.test.ts.
      files+=($pattern)
    fi
  done
  shopt -u globstar nullglob
  (( ${#files[@]} )) || { echo "unit.sh: no files match unit.files in scripts/agents/kit.json" >&2; exit 2; }
  set -- "${files[@]}"
fi
mkdir -p .scratch/unit
log=.scratch/unit/$(date -u +%Y%m%dT%H%M%S)-$$.log
status=0
"${runner[@]}" --test-timeout="$timeout" "$@" > "$log" 2>&1 || status=$?
node "$(dirname "${BASH_SOURCE[0]}")/unit-summary.mjs" "$log" || { (( status )) || status=1; }
echo "log: $log"
exit "$status"
