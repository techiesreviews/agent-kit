#!/usr/bin/env bash
# Usage: review-brief.sh <ticket-file> [base=origin/dev]; print the standard slice review brief.
set -euo pipefail
[[ $# == 1 || $# == 2 ]] || { echo "Usage: review-brief.sh <ticket-file> [base=origin/dev]" >&2; exit 2; }
exec node "$(dirname "${BASH_SOURCE[0]}")/review-brief.mjs" "$@"
