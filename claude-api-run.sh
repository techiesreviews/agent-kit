#!/usr/bin/env bash
# Runs `claude` with the API key from KIT_API_KEY_FILE, read here and handed to claude's environment only.
# The key is never printed, logged or put on a command line; every argument goes to claude as it came.
set -euo pipefail
file=${KIT_API_KEY_FILE-}
if [[ -z $file ]]; then echo "claude-api-run: KIT_API_KEY_FILE is not set" >&2; exit 2; fi
if [[ $file != /* ]]; then echo "claude-api-run: KIT_API_KEY_FILE must be an absolute path" >&2; exit 2; fi
if [[ ! -f $file || ! -r $file ]]; then echo "claude-api-run: the API key file named by KIT_API_KEY_FILE cannot be read" >&2; exit 2; fi
mode=$(stat -L -c '%a' -- "$file" 2>/dev/null || stat -L -f '%Lp' -- "$file")
if (( 8#$mode & 8#077 )); then echo "claude-api-run: the API key file can be read by others (mode $mode); run chmod 600 on it" >&2; exit 2; fi
key=''
IFS= read -r key < "$file" || [[ -n $key ]] || :
key=${key//[$' \t\r']/}
if [[ -z $key ]]; then echo "claude-api-run: the API key file is empty" >&2; exit 2; fi
if [[ -z ${KIT_API_CONFIG_DIR-} && -z ${HOME-} ]]; then echo "claude-api-run: HOME is not set, so the config folder cannot be chosen; set KIT_API_CONFIG_DIR" >&2; exit 2; fi
dir=${KIT_API_CONFIG_DIR:-${HOME}/.claude-api}
if [[ $dir != /* ]]; then echo "claude-api-run: KIT_API_CONFIG_DIR must be an absolute path" >&2; exit 2; fi
if ! mkdir -p -- "$dir" 2>/dev/null; then echo "claude-api-run: the config folder $dir cannot be made" >&2; exit 2; fi
chmod 700 -- "$dir" 2>/dev/null || :
if ! command -v claude > /dev/null 2>&1; then echo "claude-api-run: the claude command is not installed or not on PATH" >&2; exit 2; fi
# Other ways to sign in or to reach another service would win over the key: drop them for this call.
unset KIT_API_KEY_FILE KIT_API_CONFIG_DIR ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
# CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 keeps the key out of everything Claude starts besides itself: the shell commands, the hooks
# (from settings or plugins) and the nested kit calls of a run. Only claude's own process has the key.
# The flag also makes claude set up its own sandbox, which leaves empty .env, .npmrc, yarn.lock ... files in the folder it runs in,
# so it goes off in one case only: a call that has a tool list of plain readers (Read, Grep, Glob) and starts no hooks (--bare, or
# --setting-sources with an empty value), and loads no MCP servers (--strict-mcp-config, with no --mcp-config but an empty server list), no
# plugins (--plugin-dir, --plugin-url) and no extra settings or agents (--settings, --agents), all of which can start programs of their
# own. No tool list, an empty one, or anything that may start another program keeps the flag on.
# Fail closed: every doubt keeps the flag on. A tool list is read as claude reads it (variadic: the words after --tools count; commas,
# spaces and line breaks all separate names), and --tools, --bare or --setting-sources count only where they are options of this call:
# not as the value of another option, and not after a bare -- (words after it are the prompt).
scrub=1
args=("$@")
count=${#args[@]}
end=$count
for ((i = 0; i < count; i++)); do
  if [[ ${args[i]} == -- ]]; then end=$i; break; fi
done
# is_option N: args[N] starts a new option (it is first, or follows a plain word, an option with its value in the same word, or a
# switch that takes no value); after another option it would be that option's value, which we cannot tell from here: not an option.
is_option() {
  local n=$1 before
  (( n < end )) || return 1
  (( n == 0 )) && return 0
  before=${args[n - 1]}
  [[ $before != -* || $before == *=* ]] && return 0
  case $before in
    -p|--print|--bare|--verbose|--strict-mcp-config|--dangerously-skip-permissions|--no-session-persistence|--restricted|--safe-mode|--include-partial-messages|--include-hook-events|-c|--continue|--fork-session) return 0 ;;
  esac
  return 1
}
tool_lists=0 readers=1 misplaced=0 bare=0 sources_empty=0 sources_other=0 strict_mcp=0 loads=0
for ((i = 0; i < count; i++)); do
  case ${args[i]} in
    --tools|--tools=*)
      if ! is_option "$i"; then misplaced=1; continue; fi
      tools=''
      if [[ ${args[i]} == --tools=* ]]; then tools=${args[i]#--tools=}
      else
        for ((j = i + 1; j < end; j++)); do
          [[ ${args[j]} == -* ]] && break
          tools+=${tools:+,}${args[j]}
        done
      fi
      tool_lists=$((tool_lists + 1))
      IFS=',' read -r -a names <<< "${tools//[[:space:]]/,}"
      named=0
      for name in "${names[@]}"; do
        case $name in Read|Grep|Glob) named=1 ;; '') ;; *) readers=0 ;; esac
      done
      (( named )) || readers=0 ;;
    --bare) if is_option "$i"; then bare=1; else misplaced=1; fi ;;
    --strict-mcp-config) if is_option "$i"; then strict_mcp=1; else misplaced=1; fi ;;
    --plugin-dir|--plugin-dir=*|--plugin-url|--plugin-url=*|--settings|--settings=*|--agents|--agents=*) loads=1 ;;
    --mcp-config|--mcp-config=*)
      # Only an empty server list starts nothing; the option is variadic, so every word after it counts.
      if ! is_option "$i"; then misplaced=1; continue; fi
      servers=''
      if [[ ${args[i]} == --mcp-config=* ]]; then servers=${args[i]#--mcp-config=}
      else
        for ((j = i + 1; j < end; j++)); do
          [[ ${args[j]} == -* ]] && break
          servers+=${args[j]}
        done
      fi
      servers=${servers//[[:space:]]/}
      [[ $servers == '{"mcpServers":{}}' ]] || loads=1 ;;
    --setting-sources|--setting-sources=*)
      if ! is_option "$i"; then misplaced=1; continue; fi
      if [[ ${args[i]} == --setting-sources=* ]]; then value=${args[i]#--setting-sources=}
      elif (( i + 1 < end )) && [[ ${args[i + 1]} != -* ]]; then value=${args[i + 1]}
      else value=x; fi
      if [[ -z $value ]]; then sources_empty=1; else sources_other=1; fi ;;
  esac
done
if (( tool_lists > 0 && readers && !misplaced && strict_mcp && !loads && (bare || (sources_empty && !sources_other)) )); then scrub=0; fi
ANTHROPIC_API_KEY=$key CLAUDE_CONFIG_DIR=$dir CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=$scrub exec claude "$@"
