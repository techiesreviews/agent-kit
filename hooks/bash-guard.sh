#!/usr/bin/env bash
# Usage: bash-guard.sh < hook.json; reject unsafe Claude Bash commands.
set -euo pipefail
# Only deliberate policy rejections exit 2; infrastructure errors allow the call.
trap 'exit 0' ERR
command=$(jq -er 'select(.hook_event_name == "PreToolUse" and .tool_name == "Bash") | .tool_input.command | select(type == "string")' 2>/dev/null)
reason=$(printf '%s\n' "$command" | awk '
function base(s) { sub(/^.*\//, "", s); return s }
function reject(s) { if (!reason) reason = s }
function inspect(a, n, timed, depth,    i,j,k,name,text) {
  i = 1
  while (i <= n && a[i] ~ /^[A-Za-z_][A-Za-z_0-9]*=/) i++
  # Common execution wrappers leave the following word as the command.
  while (i <= n) {
    name = base(a[i])
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
      if (source ~ /server|vite|http\.server|playwright/)
        reject("start servers through scripts/agents/port.sh")
      i++; while (i <= n && a[i] ~ /^-/) i++
      continue
    }
    if (name == "env" || name == "sudo" || name == "command" || name == "exec" || name == "nohup") {
      i++
      while (i <= n && (a[i] ~ /^-/ || a[i] ~ /^[A-Za-z_][A-Za-z_0-9]*=/)) {
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
  if (timed) {
    j = i
    if (name ~ /^(ba|da|z|k)?sh$/) {
      j++
      while (j <= n && a[j] ~ /^-/) j++
    }
    if (base(a[j]) == "port.sh" || base(a[j]) == "full-suite.sh")
      reject("run port.sh directly; use run_in_background for long runs")
  }
  if (name == "git") {
    j = i + 1
    while (j <= n && a[j] ~ /^-/) {
      if (a[j] == "-C" || a[j] == "-c" || a[j] == "--git-dir" || a[j] == "--work-tree" || a[j] == "--namespace" || a[j] == "--config-env") j++
      j++
    }
    if (a[j] == "stash" && a[j+1] != "list" && a[j+1] != "show")
      reject("commit work in progress on your own branch")
  }
  if (name == "pkill" || name == "killall")
    reject("kill your own PID or process group: kill -- -PGID")
  if (name == "pgrep") for (j = i + 1; j <= n; j++)
    if (a[j] == "--full" || a[j] ~ /^-[^-]*f/) pattern = 1
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
function scan(s, timed, depth,    a,n,i,c,q,word,started,escaped,delimiter,strip,heredoc,end,line) {
  # Quotes belong to one argument. Thus literal commit -m strings are skipped;
  # shell -c arguments are scanned explicitly. Never execute the input.
  n = 0
  for (i = 1; i <= length(s) + 1; i++) {
    c = substr(s, i, 1)
    if (escaped) { if (c != "\n") word = word c; escaped = 0; continue }
    if (c == "\\" && q != "\047") { escaped = 1; started = 1; continue }
    # Expansions execute even inside a double-quoted commit message.
    if (c == "$" && q != "\047" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") {
      end = substitutionEnd(s, i + 2)
      if (end && depth < 16) {
        scan(substr(s, i + 2, end - i - 2), 0, depth + 1)
        word = word "EXPANSION"; started = 1; i = end; continue
      }
    }
    if (q) {
      if (c == q) q = ""
      else word = word c
      continue
    }
    if (c == "\047" || c == "\"") { q = c; started = 1; continue }
    if (c == "#" && !started) {
      while (i <= length(s) && substr(s, i, 1) != "\n") i++
      c = "\n"
    }
    if (c == "" || c ~ /[ \t\r\n;&|()<>]/) {
      if (started) {
        if (heredoc) { delimiter = word; heredoc = 0 }
        else a[++n] = word
        word = ""; started = 0
      }
      if (c == "<" && substr(s, i + 1, 1) == "<" && substr(s, i + 2, 1) != "<") {
        i++; heredoc = 1
        strip = substr(s, i + 1, 1) == "-"
        if (strip) i++
        continue
      }
      if (c == "" || c ~ /[\n;&|()]/) {
        inspect(a, n, timed, depth); delete a; n = 0
        if (c != "|" || substr(s, i + 1, 1) == "|") pattern = 0
        if (c == "|" && substr(s, i + 1, 1) == "|") i++
      }
      if (c == "\n" && delimiter != "") {
        # Skip common heredoc bodies, including quoted delimiters and <<-.
        while (i < length(s)) {
          end = index(substr(s, i + 1), "\n")
          if (!end) end = length(s) - i + 1
          line = substr(s, i + 1, end - 1); i += end
          if (strip) sub(/^\t+/, "", line)
          if (line == delimiter) break
        }
        delimiter = ""
      }
      continue
    }
    word = word c; started = 1
  }
}
{ source = source $0 "\n" }
END { scan(source, 0, 0); if (reason) print reason }
')
if [[ -n $reason ]]; then
  printf '%s\n' "$reason" >&2
  exit 2
fi
