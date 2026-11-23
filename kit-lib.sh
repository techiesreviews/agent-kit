#!/usr/bin/env bash
# Shared helpers for agent-kit commands. Sourcing this file has no side effects.

# The project's top folder: KIT_ROOT (the front door sets it to the answer it found), else kitRoot in kit-lib.mjs
# asked about the kit folder given (the front door passes its own) or this file's. Without Node it prints nothing
# and returns 1.
kit_root() {
  if [[ -n ${KIT_ROOT:-} ]]; then printf '%s\n' "$KIT_ROOT"; return; fi
  kit_lib_node 'console.log(lib.kitRoot(process.argv[2]))' "$(cd -- "${1:-$(dirname -- "${BASH_SOURCE[0]}")}" && pwd -P)"
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
# Without jq it says so on stderr and returns 1, rather than reading as an unset value.
kit_setting() {
  command -v jq > /dev/null || { echo 'jq is not installed; install jq' >&2; return 1; }
  jq -r "($1) // empty | if type == \"string\" then . else tojson end" "$(kit_settings_file)" 2>/dev/null || :
}

# Run JavaScript on Node >=24 with kit-lib.mjs (the file beside this one) loaded as `lib`; the arguments after the code
# are process.argv[2] on. Without Node it says so on stderr and returns 1. A rule the shell and Node both need has its
# one copy in kit-lib.mjs, and the shell helpers below ask for it through here.
kit_lib_node() {
  local node code=$1
  shift
  node=$(kit_node_find) || { printf '%s\n' 'kit: no Node >=24 found (system, npx cache or nvm)' >&2; return 1; }
  "$node" --input-type=module -e "const lib = await import((await import('node:url')).pathToFileURL(process.argv[1]).href); $code" \
    "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/kit-lib.mjs" "$@"
}

# Print what the settings file lacks, one problem per line, as kitSettingsFileProblems in kit-lib.mjs finds it; return 1
# when it is missing, broken or lacks a required key, when jq, which the shell reads it with, is not installed, or
# without Node (which kit_lib_node names on stderr). When Node fails without naming a problem, it says the file went unchecked.
kit_settings_problems() {
  local problems status=0
  if ! command -v jq > /dev/null; then
    echo 'jq is not installed; install jq'
    return 1
  fi
  problems=$(kit_lib_node 'const problems = lib.kitSettingsFileProblems(process.argv[2]); if (problems.length) { console.log(problems.join("\n")); process.exitCode = 1; }' "$(kit_root)") || status=$?
  if (( status )) && [[ -z $problems ]]; then problems='scripts/agents/kit.json was not checked (kit-lib.mjs did not run)'; fi
  [[ -z $problems ]] || printf '%s\n' "$problems"
  return "$status"
}

# The persistent dev worktree: KIT_DEV_ROOT, else the settings' devRoot; empty when neither is set.
kit_dev_root() {
  if [[ -n ${KIT_DEV_ROOT:-} ]]; then printf '%s\n' "$KIT_DEV_ROOT"; else kit_setting .devRoot; fi
}

# The persistent main checkout, as kitMainRoot in kit-lib.mjs finds it: KIT_MAIN_ROOT, else the settings' mainRoot
# (only from a valid file), else the main worktree. Without Node it is the main worktree, quietly, so a command run
# on its own (kit doctor by path) can still say Node is missing.
kit_main_root() {
  local root common
  if [[ -n ${KIT_MAIN_ROOT:-} ]]; then printf '%s\n' "$KIT_MAIN_ROOT"; return; fi
  root=$(kit_root)
  KIT_ROOT=$root kit_lib_node 'console.log(lib.kitMainRoot())' 2>/dev/null && return
  if common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then printf '%s\n' "${common%/*}"
  else printf '%s\n' "$root"; fi
}

# While kit pr runs spec files alone (timing files, lone reruns) it holds the machine's quiet lock (kitQuietLock in
# kit-lib.mjs says when a job must wait, ticket ke-88) and no other kit job starts: wait for it, saying so once on
# stderr. Without Node nothing waits.
kit_quiet_wait() {
  local lock='' owner=''
  { IFS= read -r lock && IFS= read -r owner; } < <(kit_lib_node 'const held = lib.kitQuietLock(); if (held) console.log(`${held.path}\n${held.owner}`);' 2>/dev/null) || return 0
  printf "kit: waiting for %s's lone browser run (no kit job starts until it ends)\n" "$owner" >&2
  # In the background, so the front door's TERM and HUP traps fire at once instead of after the lone run; off the
  # caller's output, so a waiter left behind by an interrupted job holds no pipe open.
  "${KIT_FLOCK:-flock}" -s "$lock" true < /dev/null > /dev/null 2>&1 &
  wait "$!" || :
}

# Who works here, as kitOwner in kit-lib.mjs finds it: ASE_OWNER, else the worktree's owner file, else its branch,
# else unknown. Without Node it is ASE_OWNER on one line, else unknown.
kit_owner() {
  local root owner=${ASE_OWNER:-}
  root=$(kit_root)
  KIT_ROOT=$root kit_lib_node 'console.log(lib.kitOwner())' 2>/dev/null && return
  owner=${owner//[$'\r\n']/ }
  printf '%s\n' "${owner:-unknown}"
}

# What `node --version` prints, without the carriage return Node on Windows ends it with (TOOLS-335).
kit_node_version() {
  local version
  version=$("$1" --version 2>/dev/null) || return 1
  printf '%s\n' "${version%$'\r'}"
}

kit_node_find() (
  local candidate version root best='' major=0 minor=0 patch=0
  local next_major next_minor next_patch
  candidate=$(type -P node) || candidate=''
  if [[ -n $candidate ]] && version=$(kit_node_version "$candidate") &&
    [[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] && (( 10#${BASH_REMATCH[1]} >= 24 )); then
    printf '%s/%s\n' "$(cd -- "${candidate%/*}" && pwd -P)" "${candidate##*/}"
    return 0
  fi
  root=${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}
  [[ -n $root ]] || return 1
  shopt -s nullglob
  for candidate in "$root"/.npm/_npx/*/node_modules/node/bin/node "$root"/.nvm/versions/node/*/bin/node; do
    [[ -f $candidate && -x $candidate ]] || continue
    version=$(kit_node_version "$candidate") || continue
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
    # A KIT_NODE a parent left behind names a Node this lookup just failed to find.
    unset KIT_NODE
    return 1
  fi
  directory=${node%/*}
  if [[ ${path%%:*} != "$directory" ]]; then
    export PATH="$directory${path:+:$path}"
  fi
  export KIT_NODE=$node
}

# The front door's RESULT line when it finds no Node >=24 (kit_node says so on stderr): fixed words, so nothing in it
# needs hiding.
kit_node_missing() {
  printf '%s\n' 'RESULT: fail no Node >=24 found (system, npx cache or nvm)'
}

# Text with every URL's user-info part taken out, as kitHideUserInfo in kit-lib.mjs does it, so no message, log or
# report the kit writes shows a remote's token. The text goes to Node on stdin, whole: Git Bash on Windows rewrites
# path-like arguments it hands Node. Without Node it prints nothing and returns 1.
kit_hide_user_info() {
  printf '%s' "${1-}" | kit_lib_node 'process.stdout.write(`${lib.kitHideUserInfo((await import("node:fs")).readFileSync(0, "utf8"))}\n`)'
}

# The RESULT line, as kitResult in kit-lib.mjs writes it: the status, then the other words joined by spaces, on one
# line, with URL user-info hidden; returns 2 for a status other than ok or fail. Status and words go to Node on stdin,
# split by a NUL (which no shell word holds). Without Node, or when kit-lib.mjs does not load (its error is above; kit
# update runs in both cases, to bring a kit that works), the line keeps an ok or fail status and its words, holding
# back each word with a URL in it, as it cannot hide the URL's user info (a URL holds no whitespace); it returns 1 for
# any other status.
kit_result() {
  local status=${1-} text code url shown=''
  local IFS=' '
  if (( $# )); then shift; fi
  text="$*"
  printf '%s\0%s' "$status" "$text" | kit_lib_node 'const [status, text] = (await import("node:fs")).readFileSync(0, "utf8").split("\0"); lib.kitResult(status, text);' && return
  code=$?
  if (( code == 2 )); then return 2; fi
  if [[ $status != ok && $status != fail ]]; then
    if kit_node_find > /dev/null; then printf '%s\n' 'RESULT: fail kit-lib.mjs did not run (its error is above)'; else kit_node_missing; fi
    return 1
  fi
  text=${text//[$'\n\r']/ }
  # The leftmost match starts its word: a match holds no whitespace and needs ://.
  while [[ $text =~ [^[:space:]]*://[^[:space:]]* ]]; do
    url=${BASH_REMATCH[0]}
    shown+="${text%%"$url"*}(URL held back)"
    text=${text#*"$url"}
  done
  printf 'RESULT: %s %s\n' "$status" "$shown$text"
}
