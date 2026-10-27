#!/usr/bin/env bash
# Usage: unit.sh [files...]; print unit counts/failures, retain the full log under .scratch/unit/.
set -euo pipefail
timeout=${ASE_UNIT_TIMEOUT_MS:-120000}
[[ $timeout =~ ^[0-9]+$ ]] && (( timeout > 0 )) || { echo "Usage: unit.sh [files...] (existing test files); ASE_UNIT_TIMEOUT_MS must be a positive integer (ms)" >&2; exit 2; }
for file in "$@"; do
  [[ $file != -* && -f $file ]] || { echo "Usage: unit.sh [files...] (existing test files)" >&2; exit 2; }
done
# This script's folder, absolute because a relative one (from ./unit.sh) breaks after the full suite's cd below.
# CDPATH= keeps cd from printing the folder when the caller exports CDPATH.
here=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/agents/kit-lib.sh
source "${KIT_LIB:-$here/kit-lib.sh}"
# The test runner and the full suite's files come from unit.run and unit.files in scripts/agents/kit.json.
problems=$(kit_settings_problems) || { printf 'unit.sh: %s\n' "${problems//$'\n'/; }" >&2; exit 1; }
read -ra runner <<< "$(kit_setting .unit.run)"
(( ${#runner[@]} )) || { echo "unit.sh needs unit.run in scripts/agents/kit.json" >&2; exit 1; }
if (( ! $# )); then
  # The full suite is what kit unit lists: unit.files matched against git's tracked and untracked,
  # not-ignored files, so both run the same files. Its paths are relative to the project's top folder.
  cd -- "$(kit_root)"
  if ! listing=$(node "$here/kit.d/unit" --list 2>&1); then
    problem=$(sed -n 's/^problem: //p' <<< "$listing" | head -n 1)
    printf 'unit.sh: %s\n' "${problem:-kit unit --list failed}" >&2
    exit 1
  fi
  files=()
  while IFS= read -r line; do
    if [[ $line == *' — all' ]]; then files+=("${line% — all}"); fi
  done <<< "$listing"
  (( ${#files[@]} )) || { echo "unit.sh: no files match unit.files in scripts/agents/kit.json" >&2; exit 1; }
  set -- "${files[@]}"
fi
mkdir -p .scratch/unit
log=.scratch/unit/$(date -u +%Y%m%dT%H%M%S)-$$.log
status=0
"${runner[@]}" --test-timeout="$timeout" "$@" > "$log" 2>&1 || status=$?
node "$here/unit-summary.mjs" "$log" || { (( status )) || status=1; }
echo "log: $log"
exit "$status"
