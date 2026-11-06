#!/usr/bin/env bash
# Runs `claude` with the API key from KIT_API_KEY_FILE, read here and handed to claude's environment only.
# The key is never printed, logged or put on a command line; every argument goes to claude as it came.
set -euo pipefail
file=${KIT_API_KEY_FILE-}
if [[ -z $file ]]; then echo "claude-api-run: KIT_API_KEY_FILE is not set" >&2; exit 2; fi
if [[ $file != /* ]]; then echo "claude-api-run: KIT_API_KEY_FILE must be an absolute path" >&2; exit 2; fi
if [[ ! -f $file || ! -r $file ]]; then echo "claude-api-run: the API key file named by KIT_API_KEY_FILE cannot be read" >&2; exit 2; fi
mode=$(stat -c '%a' -- "$file" 2>/dev/null || stat -f '%Lp' -- "$file")
if (( 8#$mode & 8#077 )); then echo "claude-api-run: the API key file can be read by others (mode $mode); run chmod 600 on it" >&2; exit 2; fi
key=''
IFS= read -r key < "$file" || [[ -n $key ]] || :
key=${key//[$' \t\r']/}
if [[ -z $key ]]; then echo "claude-api-run: the API key file is empty" >&2; exit 2; fi
dir=${KIT_API_CONFIG_DIR:-${HOME}/.claude-api}
if [[ $dir != /* ]]; then echo "claude-api-run: KIT_API_CONFIG_DIR must be an absolute path" >&2; exit 2; fi
mkdir -p -- "$dir"
chmod 700 -- "$dir" 2>/dev/null || :
unset KIT_API_KEY_FILE KIT_API_CONFIG_DIR
# CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 keeps the key out of the shell commands, hooks and nested kit calls a builder starts.
ANTHROPIC_API_KEY=$key CLAUDE_CONFIG_DIR=$dir CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 exec claude "$@"
