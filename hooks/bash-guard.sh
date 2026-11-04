#!/usr/bin/env bash
# Usage: bash-guard.sh < hook.json; reject unsafe agent Bash commands.
set -euo pipefail
# Only deliberate policy rejections exit 2; infrastructure errors allow the call.
trap 'exit 0' ERR
payload=$(cat)
command=$(jq -er 'select(.hook_event_name == "PreToolUse" and .tool_name == "Bash") | .tool_input.command | select(type == "string")' <<<"$payload" 2>/dev/null)
# The server hint names the project's own server helper: "servers" in scripts/agents/kit.json, else
# scripts/agents/port.sh where the project has one, else kit bg. Read only when a command could need it.
servers=''
if [[ $command == *setsid* ]]; then
  root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)} || root=''
  servers=$(jq -r '.servers | strings' "$root/scripts/agents/kit.json" 2>/dev/null) || servers=''
  if [[ -z $servers && -f $root/scripts/agents/port.sh ]]; then servers=scripts/agents/port.sh; fi
fi
servers=${servers:-scripts/agents/kit bg <name> -- <command>}
# ENVIRON, unlike awk -v, keeps backslashes in the hint as written.
reason=$(printf '%s\n' "$command" | KIT_SERVERS=$servers awk '
function base(s) { sub(/^.*\//, "", s); return s }
function reject(s) { if (!reason) reason = s }
# A later relative folder is joined to the one before it; an absolute one replaces it.
function within(dir, to) { return to ~ /^[\/~]/ || dir == "" ? to : dir "/" to }
# A folder the shell may or may not be in: the push check tries it beside the session and project folders.
function unsure(dir, to) { sub(/^UNSURE:/, "", dir); return "UNSURE:" within(dir, to) }
function value(word) { return substr(word, index(word, "=") + 1) }
function inspect(a, n, timed, depth, floor,    i,j,k,name,text,dir,gitdir) {
  if (a[1] == "done") loopDepth = loopDepth > floor ? loopDepth - 1 : floor
  i = 1
  # Common execution wrappers leave the following word as the command.
  while (i <= n) {
    if (a[i] ~ /^[A-Za-z_][A-Za-z_0-9]*=/) { if (a[i] ~ /^GIT_(DIR|WORK_TREE)=./) gitdir = value(a[i]); i++; continue }
    name = base(a[i])
    if (name == "while" || name == "until") loopDepth++
    if (name == "for" || name == "select") { loopDepth++; return 0 }
    if (name == "if" || name == "then" || name == "elif" || name == "else" || name == "do" || name == "while" || name == "until" || name == "{" || name == "!" || name == "time") {
      i++; continue
    }
    if (name == "timeout" || name == "gtimeout") {
      timed = 1; i++
      while (i <= n && a[i] ~ /^-/) {
        if (a[i] == "-k" || a[i] == "--kill-after" || a[i] == "-s" || a[i] == "--signal") i++
        i++
      }
      i++; continue
    }
    if (name == "setsid") {
      for (j = i + 1; j <= n; j++)
        if (a[j] ~ /server|vite|http\.server|playwright/)
          reject("start servers through " ENVIRON["KIT_SERVERS"])
      i++; while (i <= n && a[i] ~ /^-/) i++
      continue
    }
    if (name == "env" || name == "sudo" || name == "command" || name == "exec" || name == "nohup") {
      i++
      while (i <= n && (a[i] ~ /^-/ || a[i] ~ /^[A-Za-z_][A-Za-z_0-9]*=/)) {
        # env GIT_DIR=…, env -C or --chdir: the push may run in that folder.
        if (a[i] ~ /^GIT_(DIR|WORK_TREE)=./ || a[i] ~ /^--chdir=./) gitdir = value(a[i])
        if (a[i] == "-C" || a[i] == "--chdir") gitdir = a[i+1]
        if (a[i] == "-u" || a[i] == "--unset" || a[i] == "-C" || a[i] == "--chdir") i++
        i++
      }
      continue
    }
    if (name == "xargs" && pattern) {
      i++
      while (i <= n && a[i] ~ /^-/) {
        if (a[i] ~ /^-(I|n|P|L|s|E|d)$/ || a[i] ~ /^--(max-args|max-procs|max-lines|max-chars|eof|delimiter)$/) i++
        i++
      }
      continue
    }
    break
  }
  name = base(a[i])
  if (loopDepth > 0 && name == "sleep")
    reject("wait with scripts/agents/kit wait (pid, output or ci), not a sleep or pgrep -f loop")
  if (timed) {
    j = i
    if (name ~ /^(ba|da|z|k)?sh$/) {
      j++
      while (j <= n && a[j] ~ /^-/) j++
    }
    if (base(a[j]) == "port.sh" || base(a[j]) == "full-suite.sh")
      reject("run port.sh directly; wait for long runs through your CLI")
  }
  # The folder later commands run in, for the push check: cd here, git -C below.
  # A folder taken from the directory stack (cd -, popd, a bare pushd or pushd +N) is unknown, which the
  # push check treats like a variable. A cd in a pipeline or in the background runs in a subshell and
  # changes nothing; one after && or || may not run, so its folder is only possible.
  if ((name == "cd" || name == "pushd") && !subshell) {
    for (k = i + 1; k <= n && (a[k] ~ /^-[LPe@]+$/ || a[k] == "--"); k++) ;
    if (k > n) cwd = name == "cd" ? within(cwd, "~") : "$OLDPWD"
    else if (a[k] == "-" || (name == "pushd" && a[k] ~ /^[-+][0-9]+$/)) cwd = "$OLDPWD"
    else cwd = uncertain ? unsure(cwd, a[k]) : within(cwd, a[k])
  }
  if (name == "popd") cwd = "$OLDPWD"
  if (name == "export") for (k = i + 1; k <= n; k++) if (a[k] ~ /^GIT_(DIR|WORK_TREE)=./) exported = value(a[k])
  if (name == "git") {
    j = i + 1; dir = gitdir != "" ? unsure(cwd, gitdir) : exported != "" ? unsure(cwd, exported) : cwd
    while (j <= n && a[j] ~ /^-/) {
      if (a[j] == "-C") dir = within(dir, a[j+1])
      # Another repo named by --git-dir or --work-tree is possible too.
      if (a[j] ~ /^--(git-dir|work-tree)=./) dir = unsure(dir, value(a[j]))
      if (a[j] == "--git-dir" || a[j] == "--work-tree") dir = unsure(dir, a[j+1])
      if (a[j] == "-C" || a[j] == "-c" || a[j] == "--git-dir" || a[j] == "--work-tree" || a[j] == "--namespace" || a[j] == "--config-env") j++
      j++
    }
    if (a[j] == "stash" && a[j+1] != "list" && a[j+1] != "show")
      reject("commit work in progress on your own branch")
    # Pushes go back to the shell, which reads the settings and branches (awk runs no git).
    if (a[j] == "push") {
      text = "push\037" (dir == "" ? "." : dir)
      for (k = j + 1; k <= n; k++) text = text "\037" a[k]
      pushes[++pushCount] = text
    }
  }
  if (name == "pkill" || name == "killall")
    reject("kill your own PID or process group: kill -- -PGID")
  if (name == "pgrep") for (j = i + 1; j <= n; j++)
    if (a[j] == "--full" || a[j] ~ /^-[^-]*f/) {
      pattern = 1
      if (loopDepth > 0)
        reject("wait with scripts/agents/kit wait (pid, output or ci), not a sleep or pgrep -f loop")
    }
  if (pattern && name == "kill")
    reject("kill your own PID or process group: kill -- -PGID")
  if (name ~ /^(ba|da|z|k)?sh$/ || name == "eval") {
    for (j = i + 1; j <= n; j++) {
      if (name == "eval" || a[j] ~ /^-[^-]*c/) {
        text = ""
        k = name == "eval" ? j : j + 1
        if (name == "eval") for (; k <= n; k++) text = text " " a[k]
        else text = a[k]
        if (depth < 16) scan(text, timed, depth + 1)
        break
      }
    }
  }
  # A shell without -c or a script path executes its standard input.
  if (name ~ /^(ba|da|z|k)?sh$/) {
    for (j = i + 1; j <= n; j++) {
      if (a[j] ~ /^-[^-]*c/) return 0
      if (a[j] ~ /^-[^-]*s/) return timed ? 2 : 1
      if (a[j] == "--") return j == n ? (timed ? 2 : 1) : 0
      if (a[j] !~ /^-/) return 0
    }
    return timed ? 2 : 1
  }
  return 0
}
function substitutionEnd(s, start,    i,c,q,escaped,level) {
  level = 1
  for (i = start; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (escaped) { escaped = 0; continue }
    if (c == "\\" && q != "\047") { escaped = 1; continue }
    if (q) { if (c == q) q = ""; continue }
    if (c == "\047" || c == "\"") { q = c; continue }
    if (c == "(") level++
    if (c == ")" && --level == 0) return i
  }
  return 0
}
function backtickEnd(s, start,    i,c,escaped) {
  for (i = start; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (escaped) { escaped = 0; continue }
    if (c == "\\") { escaped = 1; continue }
    if (c == "`") return i
  }
  return 0
}
function expansions(s, depth,    i,c,end) {
  # In an unquoted heredoc, quote characters are data, not shell quotes.
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\\" && substr(s, i + 1, 1) ~ /[\\$`\n]/) { i++; continue }
    end = 0
    if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") {
      end = substitutionEnd(s, i + 2)
      if (end && depth < 16) scan(substr(s, i + 2, end - i - 2), 0, depth + 1)
    } else if (c == "`") {
      end = backtickEnd(s, i + 1)
      if (end && depth < 16) scan(substr(s, i + 1, end - i - 1), 0, depth + 1)
    }
    if (end) i = end
  }
}
function nested(s, timed, depth, first,    opening) {
  opening = first ~ /^(while|until|for|select)$/
  if (opening) loopDepth++
  scan(s, timed, depth)
  if (opening) loopDepth--
}
function scan(s, timed, depth,    a,n,i,c,q,word,started,escaped,quoted,redirect,strip,end,line,hd,hq,hs,hcode,hdepth,hn,bound,j,code,body,input,ni,floor,saved,expect,skip,k,group,gn,outer,after,nxt,prv) {
  # Quotes belong to one argument. Thus literal commit -m strings are skipped;
  # shell -c arguments are scanned explicitly. Never execute the input.
  n = 0
  floor = loopDepth
  # A cd inside bash -c or $( … ) stays there.
  outer = cwd
  for (i = 1; i <= length(s) + 1; i++) {
    c = substr(s, i, 1)
    if (escaped) { if (c != "\n") word = word c; escaped = 0; continue }
    if (c == "\\" && q != "\047") { escaped = 1; started = 1; quoted = 1; continue }
    # Expansions execute even inside a double-quoted commit message.
    if (c == "$" && q != "\047" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") {
      end = substitutionEnd(s, i + 2)
      if (end && depth < 16) {
        nested(substr(s, i + 2, end - i - 2), 0, depth + 1, a[1])
        word = word "EXPANSION"; started = 1; i = end; continue
      }
    }
    if (c == "`" && q != "\047") {
      end = backtickEnd(s, i + 1)
      if (end && depth < 16) {
        nested(substr(s, i + 1, end - i - 1), 0, depth + 1, a[1])
        word = word "EXPANSION"; started = 1; i = end; continue
      }
    }
    if (q) {
      if (c == q) q = ""
      else word = word c
      continue
    }
    if (c == "\047" || c == "\"") { q = c; started = 1; quoted = 1; continue }
    if (c == "#" && !started) {
      while (i <= length(s) && substr(s, i, 1) != "\n") i++
      c = "\n"
    }
    # Arithmetic for headers are a list too, including their semicolons.
    if (c == "(" && a[1] == "for" && substr(s, i + 1, 1) == "(") {
      end = substitutionEnd(s, i + 1)
      if (end) {
        inspect(a, n, timed, depth, floor)
        expansions(substr(s, i + 2, end - i - 3), depth)
        delete a; n = 0; i = end; continue
      }
    }
    if (c == "<" || c == ">" || (c == "&" && substr(s, i + 1, 1) == ">")) {
      # Only an adjacent unquoted number is a file descriptor. Drop the
      # operator and its target, wherever they occur in the command.
      if (started) {
        if (redirect == 2) { hd[++hn] = word; hq[hn] = quoted; hs[hn] = strip }
        else if (redirect == 3) input[++ni] = word
        else if (!redirect && (quoted || word !~ /^[0-9]+$/)) a[++n] = word
      }
      word = ""; started = 0; quoted = 0
      redirect = 1; strip = 0
      if (c == "&") { i++; c = ">" }
      if (substr(s, i + 1, 1) == c) {
        i++
        if (c == "<") {
          if (substr(s, i + 1, 1) == "<") { i++; redirect = 3 }
          else {
            redirect = 2; strip = substr(s, i + 1, 1) == "-"
            if (strip) i++
          }
        }
      } else if (substr(s, i + 1, 1) ~ /[&|<>]/) i++
      continue
    }
    if (c == "" || c ~ /[ \t\r\n;&|()]/) {
      if (started) {
        if (redirect == 2) { hd[++hn] = word; hq[hn] = quoted; hs[hn] = strip }
        else if (redirect == 3) input[++ni] = word
        else if (!redirect) a[++n] = word
        word = ""; started = 0; quoted = 0; redirect = 0
      }
      if (c == "" || c ~ /[\n;&|()]/) {
        # Case patterns are words, not commands: after "case … in" or ";;", up to ")".
        if (expect && n && (a[1] == "esac" || c !~ /[)|]/)) expect = 0
        skip = expect && n
        if (expect && c == ")") expect = 0
        # Whether this command may not run (it follows && or || or a pipe) or runs in a subshell (it ends in | or &).
        nxt = substr(s, i + 1, 1); prv = substr(s, i - 1, 1)
        uncertain = after
        subshell = (c == "|" && nxt != "|" && prv != "|") || (c == "&" && nxt != "&" && prv != "&")
        code = skip ? 0 : inspect(a, n, timed, depth, floor)
        after = (c == "&" && (nxt == "&" || prv == "&")) || c == "|"
        # A ( … ) group runs in a subshell: a cd inside it ends with the group.
        if (c == "(" && !n) group[++gn] = cwd
        if (c == ")" && !skip && gn) cwd = group[gn--]
        for (k = 1; k < n && a[k] ~ /^(do|then|else|elif|\{|!)$/; k++) ;
        if (!skip && n && a[k] == "case") expect = c == "|" || (c != ")" && a[n] == "in")
        if (c == ";" && substr(s, i + 1, 1) ~ /[;&]/) expect = 1
        if (code && depth < 16) for (j = 1; j <= ni; j++) scan(input[j], timed || code == 2, depth + 1)
        delete input; ni = 0
        for (j = bound + 1; j <= hn; j++) { hcode[j] = code; hdepth[j] = loopDepth }
        bound = hn; delete a; n = 0
        if (c != "|" || substr(s, i + 1, 1) == "|") pattern = 0
        if (c == "|" && substr(s, i + 1, 1) == "|") i++
      }
      if (c == "\n" && hn) {
        for (j = 1; j <= hn; j++) {
          body = ""
          while (i < length(s)) {
            end = index(substr(s, i + 1), "\n")
            if (!end) end = length(s) - i + 1
            line = substr(s, i + 1, end - 1); i += end
            if (hs[j]) sub(/^\t+/, "", line)
            if (line == hd[j]) break
            body = body line "\n"
          }
          saved = loopDepth; loopDepth = hdepth[j]
          if (!hq[j]) expansions(body, depth)
          if (hcode[j] && depth < 16) scan(body, timed || hcode[j] == 2, depth + 1)
          loopDepth = saved
        }
        delete hd; delete hq; delete hs; delete hcode; delete hdepth; hn = 0; bound = 0
      }
      continue
    }
    word = word c; started = 1
  }
  loopDepth = floor
  if (depth) cwd = outer
}
{ source = source $0 "\n" }
END { scan(source, 0, 0); if (reason) print "reason\037" reason; for (i = 1; i <= pushCount; i++) print pushes[i] }
')
# A push to the project's release branch (branches.release in scripts/agents/kit.json) puts it live
# without review, and one to its landing branch (branches.land) skips it: a branch goes into the landing
# branch, and the release branch takes only the landing branch, both through kit pr. A project whose
# settings name no release branch is not guarded. Prints the guarded branch a push would reach, else nothing.
guarded_target() {
  local dir=$1 folder named=''
  shift
  if [[ $dir == UNSURE:* ]]; then named=${dir#UNSURE:}; dir='$'; fi
  [[ $dir == '~' || $dir == '~/'* ]] && dir=$HOME${dir#'~'}
  [[ $dir == /* ]] || dir=$base/$dir
  # A folder named through a variable or $( … ), or one that is no repo (a failed cd leaves the shell
  # where it was), is checked as both the session's folder and its project folder.
  if [[ $dir != *'$'* && $dir != *EXPANSION* ]] && git -C "$dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    guarded_in "$dir" "$@"
    return 0
  fi
  # The folder the command names, when the shell may be there (a cd after &&, GIT_DIR, --git-dir, env -C).
  if [[ -n $named && $named != *'$'* && $named != *EXPANSION* ]]; then
    [[ $named == '~' || $named == '~/'* ]] && named=$HOME${named#'~'}
    [[ $named == /* ]] || named=$base/$named
    named=${named%/}; named=${named%/.git}
  else
    named=''
  fi
  for folder in "$base" ${CLAUDE_PROJECT_DIR:+"$CLAUDE_PROJECT_DIR"} ${named:+"$named"}; do
    folder=$(guarded_in "$folder" "$@") || folder=''
    if [[ -n $folder ]]; then printf '%s' "$folder"; return 0; fi
  done
}
guarded_in() {
  local dir=$1 root release land current arg remote='' all=0 skip=0 tag=0 tags=0 dst upstream guarded
  local -a refs=() dsts=()
  shift
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 0
  release=$(jq -r '.branches.release | strings' "$root/scripts/agents/kit.json" 2>/dev/null) || return 0
  [[ -n $release ]] || return 0
  land=$(jq -r '.branches.land | strings' "$root/scripts/agents/kit.json" 2>/dev/null) || land=''
  [[ -n $land && $land != "$release" ]] || land=''
  for arg; do
    if (( skip )); then skip=0; continue; fi
    case $arg in
      --dry-run) return 0 ;;
      --repo|--push-option|-o|--receive-pack|--exec) skip=1 ;;
      -o*) ;;
      --all|--mirror|--branches) all=1 ;;
      --tags) tags=1 ;;
      --*) ;;
      -*) [[ $arg =~ ^-[a-zA-Z0-9]*n[a-zA-Z0-9]*$ ]] && return 0 ;;
      *) if [[ -z $remote ]]; then remote=$arg; else refs+=("$arg"); fi ;;
    esac
  done
  if (( all )); then printf '%s\037release' "$release"; return 0; fi
  current=$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null) || current=''
  # --tags alone pushes tags only.
  if (( ! ${#refs[@]} && ! tags )); then
    # No refspec: where push.default and the upstream send the current branch.
    dst=$(git -C "$dir" rev-parse --symbolic-full-name '@{push}' 2>/dev/null) || dst=''
    dsts=("${dst#refs/remotes/*/}")
  fi
  for arg in "${refs[@]}"; do
    if (( tag )); then tag=0; continue; fi
    if [[ $arg == tag ]]; then tag=1; continue; fi
    arg=${arg#+}
    # A lone colon pushes every branch that exists on both sides.
    if [[ $arg == : ]]; then printf '%s\037release' "$release"; return 0; fi
    if [[ $arg == *:* ]]; then dst=${arg#*:}; [[ -n $dst ]] || dst=${arg%%:*}; else dst=$arg; fi
    # A destination from a variable or $( … ) is taken as the current branch and where it pushes.
    if [[ $dst == *'$'* || $dst == *EXPANSION* ]]; then
      upstream=$(git -C "$dir" rev-parse --symbolic-full-name '@{push}' 2>/dev/null) || upstream=''
      dsts+=("$current" "${upstream#refs/remotes/*/}")
      continue
    fi
    [[ $dst == HEAD || $dst == @ ]] && dst=$current
    # A named branch without a destination goes where push.default sends it (its upstream with "upstream").
    if [[ $arg != *:* && $arg != HEAD && $arg != @ ]]; then
      upstream=$(git -C "$dir" rev-parse --symbolic-full-name "${arg#refs/heads/}@{push}" 2>/dev/null) || upstream=''
      dsts+=("${upstream#refs/remotes/*/}")
    fi
    case $dst in
      refs/heads/*) dst=${dst#refs/heads/} ;;
      # A wildcard such as refs/*:refs/* takes branches along.
      refs/*)
        for guarded in "$release" ${land:+"$land"}; do [[ $dst == *'*'* && refs/heads/$guarded == $dst ]] && dsts+=("$guarded"); done
        continue ;;
    esac
    dsts+=("$dst")
  done
  for guarded in "$release" ${land:+"$land"}; do
    for dst in "${dsts[@]}"; do
      # Unquoted on the right, so a wildcard refspec (refs/heads/*) matches too.
      if [[ -n $dst && $guarded == $dst ]]; then printf '%s\037%s' "$guarded" "$([[ $guarded == "$release" ]] && echo release || echo land)"; return 0; fi
    done
  done
}
base=''
refusal=''
while IFS=$'\037' read -r -a fields; do
  if [[ ${fields[0]-} == reason ]]; then refusal=${fields[1]-}; break; fi
  [[ ${fields[0]-} == push ]] || continue
  # The session's folder, read only when a command pushes.
  if [[ -z $base ]]; then
    base=$(jq -r '.cwd | strings' <<<"$payload" 2>/dev/null) || base=''
    base=${base:-${CLAUDE_PROJECT_DIR:-$PWD}}
  fi
  branch=$(guarded_target "${fields[@]:1}") || branch=''
  if [[ $branch == *$'\037'land ]]; then
    branch=${branch%$'\037'land}
    refusal="Pushing straight to \`$branch\` skips review: a branch goes into \`$branch\` only through \`scripts/agents/kit pr --ticket <ticket>\` (docs too, in its docs tier)."
    break
  elif [[ -n $branch ]]; then
    branch=${branch%$'\037'release}
    refusal="Pushing straight to \`$branch\` puts it live without review. Land it with \`scripts/agents/kit pr --ticket <ticket>\` (or \`kit pr --release --base $branch\` for a release)."
    break
  fi
done <<<"$reason"
if [[ -n $refusal ]]; then
  printf '%s\n' "$refusal" >&2
  exit 2
fi
