#!/usr/bin/env bash
# PreToolUse(Bash) guard: blocks commands that would put a Proton Pass value in
# front of the agent (openv export, pass-cli item view, --no-masking, ...). The
# patterns and the matching rule are in deny.tsv; guard.jq does the matching.
#
# Exit 0 allows the command and exit 2 blocks it; Claude Code shows stderr to
# the agent. Any other exit lets the command through, which is why there's no
# `set -e` here: every failure path exits 2 on purpose.
#
# Advisory, not a sandbox: a command built at runtime (variables, eval, base64)
# gets past any text match. openv export's own CLAUDECODE/TTY refusal is the
# second layer.
#
# It runs before every Bash call. The fast path uses builtins only and looks at
# the command alone, not the cwd or transcript path (which may well contain
# "openv"), so a command that doesn't mention openv, pass-cli or pass: exits
# without forking. Otherwise one jq parses the input and matches it. When that
# can't run (no jq, missing files, bad input), the command is blocked.

IFS= read -r -d '' input || true # returns 1 at EOF, with all of stdin read

# The command's JSON string runs from "command":" to the next "," (which can't
# appear raw inside a JSON string, since its quotes are escaped). When the
# command is the last key, or the key isn't found, more of the input is kept,
# which only means jq gets to decide.
cmd="${input#*\"command\":\"}"
cmd="${cmd%%\",\"*}"
case "$cmd" in
  *openv* | *pass-cli* | *pass:*) ;;
  *) exit 0 ;;
esac

case "${BASH_SOURCE[0]}" in
  */*) hooks="${BASH_SOURCE[0]%/*}" ;;
  *) hooks=. ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "openv guard: jq isn't installed, so commands naming openv or pass-cli are blocked. Install it with: brew install jq" >&2
  exit 2
fi
if [ ! -r "$hooks/deny.tsv" ] || [ ! -r "$hooks/guard.jq" ]; then
  echo "openv guard: can't read deny.tsv or guard.jq in $hooks, so commands naming openv or pass-cli are blocked." >&2
  exit 2
fi

# jq's own error, if any, goes straight to stderr ahead of the line below.
reason="$(jq -r --rawfile deny "$hooks/deny.tsv" -f "$hooks/guard.jq" <<<"$input")" || {
  echo "openv guard: couldn't check this command (jq's error is above), so it's blocked." >&2
  exit 2
}

if [ -n "$reason" ]; then
  echo "openv guard: blocked \`$reason\`. Use \`openv run <env> -- <cmd>\`, which keeps values masked." >&2
  exit 2
fi
exit 0
