#!/usr/bin/env bash
# Shared helpers for agent-kit commands. Sourcing this file has no side effects.

kit_root() {
  if [[ -n ${KIT_ROOT:-} ]]; then
    printf '%s\n' "$KIT_ROOT"
  elif ! git rev-parse --show-toplevel 2>/dev/null; then
    (cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
  fi
}

# The shared kit's folder: KIT_HOME, else the folder holding this file. A KIT_HOME some front door
# filled in (equal to KIT_HOME_DEFAULT) may belong to another worktree, so it counts as unset.
kit_home() {
  if [[ -n ${KIT_HOME:-} && $KIT_HOME != "${KIT_HOME_DEFAULT:-}" ]]; then printf '%s\n' "$KIT_HOME"
  else (cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P); fi
}

kit_settings_file() {
  printf '%s/scripts/agents/kit.json\n' "$(kit_root)"
}

# Print one settings value by jq path (strings raw, others as JSON); nothing when it or the file is missing.
kit_setting() {
  jq -r "($1) // empty | if type == \"string\" then . else tojson end" "$(kit_settings_file)" 2>/dev/null || :
}

# Print what the settings file lacks, one problem per line; return 1 when it is missing, broken or lacks a required key.
kit_settings_problems() {
  local file problems
  file=$(kit_settings_file)
  if [[ ! -f $file ]]; then
    printf 'no scripts/agents/kit.json; add one with "project" and "branches": { "land": "<branch>" }\n'
    return 1
  fi
  if ! problems=$(jq -r '
    if type != "object" then "scripts/agents/kit.json must hold one JSON object" else
      (if (.project | type) == "string" and (.project | test("\\S")) then empty
        else "add \"project\": \"<name>\" to scripts/agents/kit.json" end),
      (if (.branches | type) == "object" and (.branches.land | type) == "string" and (.branches.land | test("\\S")) then empty
        else "add \"branches\": { \"land\": \"<branch>\" } to scripts/agents/kit.json" end)
    end' "$file" 2>&1); then
    printf 'scripts/agents/kit.json is unreadable: %s\n' "${problems//$'\n'/ }"
    return 1
  fi
  [[ -z $problems ]] || { printf '%s\n' "$problems"; return 1; }
}

# The persistent dev worktree: KIT_DEV_ROOT, else the settings' devRoot; empty when neither is set.
kit_dev_root() {
  if [[ -n ${KIT_DEV_ROOT:-} ]]; then printf '%s\n' "$KIT_DEV_ROOT"; else kit_setting .devRoot; fi
}

# The persistent main checkout: KIT_MAIN_ROOT, else the settings' mainRoot (only from a valid file,
# as kitMainRoot reads it), else the main worktree.
kit_main_root() {
  local main=${KIT_MAIN_ROOT:-} root common
  if [[ -z $main ]] && kit_settings_problems > /dev/null; then main=$(kit_setting .mainRoot); fi
  if [[ -z $main ]]; then
    root=$(kit_root)
    if common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then main=${common%/*}; else main=$root; fi
  fi
  printf '%s\n' "$main"
}

kit_owner() {
  local root owner='' _timestamp _rest
  local IFS=$' \t\n'
  if [[ -n ${ASE_OWNER:-} ]]; then
    owner=$ASE_OWNER
  else
    root=$(kit_root)
    if [[ -r $root/.scratch/owner ]]; then
      read -r _timestamp owner _rest < "$root/.scratch/owner" || :
    fi
    if [[ -z $owner || $owner == unknown ]]; then
      owner=$(git -C "$root" branch --show-current 2>/dev/null) || owner=''
    fi
  fi
  owner=${owner//$'\n'/ }
  owner=${owner//$'\r'/ }
  printf '%s\n' "${owner:-unknown}"
}

kit_node_find() (
  local candidate version root best='' major=0 minor=0 patch=0
  local next_major next_minor next_patch
  candidate=$(type -P node) || candidate=''
  if [[ -n $candidate ]] && version=$("$candidate" --version 2>/dev/null) &&
    [[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] && (( 10#${BASH_REMATCH[1]} >= 24 )); then
    printf '%s/%s\n' "$(cd -- "${candidate%/*}" && pwd -P)" "${candidate##*/}"
    return 0
  fi
  root=${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}
  [[ -n $root ]] || return 1
  shopt -s nullglob
  for candidate in "$root"/.npm/_npx/*/node_modules/node/bin/node "$root"/.nvm/versions/node/*/bin/node; do
    [[ -f $candidate && -x $candidate ]] || continue
    version=$("$candidate" --version 2>/dev/null) || continue
    [[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || continue
    next_major=$((10#${BASH_REMATCH[1]})) next_minor=$((10#${BASH_REMATCH[2]})) next_patch=$((10#${BASH_REMATCH[3]}))
    if (( next_major >= 24 && (next_major > major || (next_major == major && next_minor > minor) || (next_major == major && next_minor == minor && next_patch > patch)) )); then
      best=$candidate major=$next_major minor=$next_minor patch=$next_patch
    fi
  done
  [[ -n $best ]] || return 1
  printf '%s/%s\n' "$(cd -- "${best%/*}" && pwd -P)" "${best##*/}"
)

kit_node() {
  local node directory path=${PATH-}
  if ! node=$(kit_node_find); then
    printf '%s\n' 'kit: no Node >=24 found (system, npx cache or nvm)' >&2
    return 1
  fi
  directory=${node%/*}
  if [[ ${path%%:*} != "$directory" ]]; then
    export PATH="$directory${path:+:$path}"
  fi
  export KIT_NODE=$node
}

kit_result() {
  local status=${1-} text
  local IFS=' '
  if (( $# )); then shift; fi
  case $status in
    ok|fail) text="$*" ;;
    *) text="kit_result: bad status $status"; status=bad ;;
  esac
  text=${text//$'\n'/ }
  text=${text//$'\r'/ }
  if [[ $status == bad ]]; then
    printf 'RESULT: fail %s\n' "$text"
    return 2
  fi
  printf 'RESULT: %s %s\n' "$status" "$text"
}
