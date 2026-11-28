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
  node=$(kit_node_find) || { kit_node_none "$?"; return 1; }
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

# The folders a build can write that kit_node_find never takes a Node from (README, "Programs by name"; TOOLS-412):
# the worktree around the current folder and KIT_ROOT, and each one's Git folder and shared Git folder, found from the
# worktree's own files (a .git folder, or a .git file naming one and its commondir file), never by running git, which
# PATH could lead into those folders too. It adds their physical paths to the caller's places array (none outside a
# worktree without KIT_ROOT), starts no program and leaves the current folder as it found it. A place that is the home
# folder or holds it is left out: a home kept in Git (`git init` in ~) would hold every nvm, volta or ~/.local/bin Node,
# and a build runs in a worktree, whose own .git is found first. The .git and commondir files are the build's to
# write, so the Git folder part trusts them (the worktree itself stays a place while any .git entry is in it).
kit_node_places() {
  local here=$PWD start dir git line common home='' place CDPATH=''
  local -a found=()
  [[ -n ${HOME:-} ]] && cd -P -- "$HOME" 2> /dev/null && home=${PWD%/}
  for start in "$here" "${KIT_ROOT:-}"; do
    cd -- "$here" 2> /dev/null || return 0
    [[ -n $start ]] && cd -P -- "$start" 2> /dev/null || continue
    # The machine's top folder is never a place: it would hold every Node.
    dir=${PWD%/}
    [[ -n $dir && $start == "${KIT_ROOT:-}" ]] && found+=("$dir")
    while [[ -n $dir && ! -e $dir/.git ]]; do dir=${dir%/*}; done
    [[ -n $dir ]] || continue
    found+=("$dir")
    git=$dir/.git
    if [[ -f $git ]]; then
      line=''
      IFS= read -r line < "$git" || :
      line=${line%$'\r'}
      [[ $line == 'gitdir: '* ]] || continue
      line=${line#gitdir: }
      [[ $line == /* ]] || line=$dir/$line
      git=$line
    fi
    cd -P -- "$git" 2> /dev/null && [[ $PWD != / ]] || continue
    git=$PWD
    found+=("$git")
    [[ -f $git/commondir ]] || continue
    common=''
    IFS= read -r common < "$git/commondir" || :
    common=${common%$'\r'}
    [[ -n $common ]] || continue
    [[ $common == /* ]] || common=${git%/}/$common
    cd -P -- "$common" 2> /dev/null && [[ $PWD != / ]] && found+=("$PWD")
  done
  cd -- "$here" 2> /dev/null || :
  for place in ${found[@]+"${found[@]}"}; do
    [[ -n $home && ( $home == "$place" || $home == "${place%/}"/* ) ]] || places+=("$place")
  done
}

# Whether the node at $1, a full path, stays outside every place named after it: the PATH folder it sits in, each link
# on the way to the program and the program's own folder, each taken physically, lie outside them and outside /proc
# and /dev (whose links lead anywhere). A relative path, or one whose folder cannot be read, counts as inside. It leaves
# the current folder as it found it, and starts readlink only for a link, by its full path (one found on PATH could be
# a build's too); without one, a link counts as inside.
kit_node_outside() {
  local here=$PWD file=$1 dir target place hops=0 status=1 CDPATH='' readlink=
  shift
  [[ $file == /* ]] || return 1
  while :; do
    dir=${file%/*}
    dir=${dir:-/}
    [[ $dir != /proc && $dir != /proc/* && $dir != /dev && $dir != /dev/* ]] || break
    cd -P -- "$dir" 2> /dev/null || break
    dir=$PWD
    [[ $dir != /proc && $dir != /proc/* && $dir != /dev && $dir != /dev/* ]] || break
    for place in "$@"; do
      [[ $dir == "$place" || $dir == "${place%/}"/* ]] && break 2
    done
    file=${dir%/}/${file##*/}
    if [[ ! -L $file ]]; then status=0; break; fi
    (( ++hops <= 40 )) || break
    if [[ -z $readlink ]]; then
      for readlink in /usr/bin/readlink /bin/readlink /run/current-system/sw/bin/readlink ''; do [[ -x $readlink ]] && break; done
      [[ -n $readlink ]] || break
    fi
    target=$("$readlink" -- "$file") || break
    [[ $target == /* ]] || target=${dir%/}/$target
    file=$target
  done
  cd -- "$here" 2> /dev/null || :
  return "$status"
}

# The first Node on PATH when it is >=24; else the newest Node >=24 later on PATH (an older Node can come first, as
# Homebrew's does on a Mac where CI installs Node 24, TOOLS-412); else the newest in the npx or nvm caches. A good first
# Node stops the search. A node in the worktree or its Git folder (kit_node_places: a worktree's node_modules/.bin, a
# direnv bin there, a link leading there) is dropped before it runs, so a build cannot plant the Node the kit runs, even
# when an older Node comes first and every later one is asked for its version; with no Node found, the status is 3 when
# such a node was dropped (kit_node_none says so), else 1. When KIT_NODE_PIN is set (by a guarded kit pr to its own
# trusted Node), only that path is checked so later PATH entries are never executed.
# When KIT_NODE_FOUND_FOR matches the current KIT_NODE, PATH and search root, that already-verified Node
# is reused without spawning node --version again so nested kit calls stay fast (an in-place Node swap
# or a newer Node added to an already-listed PATH folder waits until the variables change).
kit_node_find() (
  local candidate version root best='' major=0 minor=0 patch=0
  local next_major next_minor next_patch tier dir prev none=1
  local -a tried=() places=()
  if [[ -n ${KIT_NODE_PIN:-} ]]; then
    candidate=$KIT_NODE_PIN
    [[ $candidate == [A-Za-z]:\\* ]] && candidate=${candidate//\\//}
    [[ ( $candidate == /* || $candidate == [A-Za-z]:/* ) && -f $candidate && -x $candidate ]] || return 1
    version=$(kit_node_version "$candidate") || return 1
    [[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] && (( 10#${BASH_REMATCH[1]} >= 24 )) || return 1
    dir=${candidate%/*}
    dir=$(cd -- "${dir:-/}" && pwd -P) || return 1
    printf '%s/%s\n' "${dir%/}" "${candidate##*/}"
    return 0
  fi
  kit_node_places
  if [[ -n ${KIT_NODE:-} && -n ${KIT_NODE_FOUND_FOR:-} &&
    $KIT_NODE_FOUND_FOR == "${KIT_NODE}"$'\x1f'"${PATH-}"$'\x1f'"${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}" &&
    -f $KIT_NODE && -x $KIT_NODE ]] && kit_node_outside "$KIT_NODE" ${places[@]+"${places[@]}"}; then
    printf '%s\n' "$KIT_NODE"
    return 0
  fi
  shopt -s nullglob
  for tier in path cache; do
    if [[ $tier == cache ]]; then
      root=${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}
      [[ -n $root ]] || return "$none"
    fi
    while IFS= read -r candidate; do
      [[ -f $candidate && -x $candidate ]] || continue
      # Only the first PATH Node has run so far and it is >=24: keep it.
      [[ $tier == path && -n $best && ${#tried[@]} == 1 ]] && break
      # A node in the worktree or its Git folder never runs, not even for its version.
      kit_node_outside "$candidate" ${places[@]+"${places[@]}"} || { none=3; continue; }
      for prev in ${tried[@]+"${tried[@]}"}; do [[ $candidate -ef $prev ]] && continue 2; done
      tried+=("$candidate")
      version=$(kit_node_version "$candidate") || continue
      [[ $version =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || continue
      next_major=$((10#${BASH_REMATCH[1]})) next_minor=$((10#${BASH_REMATCH[2]})) next_patch=$((10#${BASH_REMATCH[3]}))
      if (( next_major >= 24 && (next_major > major || (next_major == major && next_minor > minor) || (next_major == major && next_minor == minor && next_patch > patch)) )); then
        best=$candidate major=$next_major minor=$next_minor patch=$next_patch
      fi
    done < <(
      if [[ $tier == path ]]; then type -aP node
      else printf '%s\n' "$root"/.npm/_npx/*/node_modules/node/bin/node "$root"/.nvm/versions/node/*/bin/node; fi
    )
    if [[ -n $best ]]; then
      printf '%s/%s\n' "$(cd -- "${best%/*}" && pwd -P)" "${best##*/}"
      return 0
    fi
  done
  return "$none"
)

# What kit says on stderr when kit_node_find found no Node, given its status ($1): 3 adds that a node was dropped for
# sitting in the worktree or its Git folder, so the person is not sent to install a Node they have.
kit_node_none() {
  printf '%s\n' 'kit: no Node >=24 found (system, npx cache or nvm)' >&2
  [[ $1 != 3 ]] || printf '%s\n' 'kit: a node inside this worktree or its Git folder was skipped: the kit never runs one there, since a build could have put it there; install Node 24 outside them' >&2
}

kit_node() {
  local node directory path=${PATH-} first status=0
  node=$(kit_node_find) || status=$?
  if (( status )); then
    kit_node_none "$status"
    # A KIT_NODE a parent left behind names a Node this lookup just failed to find.
    unset KIT_NODE KIT_NODE_FOUND_FOR
    return 1
  fi
  directory=${node%/*}
  first=${path%%:*}
  if [[ $first != "$directory" && ! ( $first == /* && -f "$first/node" && -x "$first/node" && "$first/node" -ef "$node" ) ]]; then
    export PATH="$directory${path:+:$path}"
  fi
  export KIT_NODE=$node
  if [[ -z ${KIT_NODE_PIN:-} ]]; then
    export KIT_NODE_FOUND_FOR="${KIT_NODE}"$'\x1f'"${PATH-}"$'\x1f'"${CLAUDE_NODE_SEARCH_ROOT:-${HOME:-}}"
  else
    unset KIT_NODE_FOUND_FOR
  fi
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
