#!/usr/bin/env bash
# Usage: review-brief.sh <ticket-file> [base=origin/<land> | --commit SHA]; print a slice review brief.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/review-brief.mjs" "$@"
