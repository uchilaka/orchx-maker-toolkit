#!/usr/bin/env bash
# PreToolUse(Bash) guard: blocks commands that would put a Proton Pass value in
# front of the agent (openv export, pass-cli item view, --no-masking, ...). The
# patterns live in deny.tsv next to this file, and guard.jq does the matching.
#
# Exit 0 allows the command; exit 2 blocks it, and Claude Code shows stderr to
# the agent. This is advisory, not a sandbox: a command built at runtime
# (variables, eval, base64) gets past any text match. openv export's own
# CLAUDECODE/TTY refusal is the second layer.
#
# It runs before every Bash call, so a command that doesn't mention openv,
# pass-cli or pass:// exits at once without forking anything. The rest is a
# single jq, which parses the hook input and does all the matching. When that
# can't run (no jq, unreadable input), a command naming those tools is blocked
# rather than let through.

# read is a builtin, so the fast path forks nothing. It returns 1 at EOF.
IFS= read -r -d '' input || true
case "$input" in
  *openv* | *pass-cli* | *pass://*) ;;
  *) exit 0 ;;
esac

hooks="$(dirname "${BASH_SOURCE[0]}")"

if ! command -v jq >/dev/null 2>&1; then
  echo "openv guard: jq isn't installed, so commands naming openv or pass-cli are blocked. Install it with: brew install jq" >&2
  exit 2
fi

reason="$(jq -r --rawfile deny "$hooks/deny.tsv" -f "$hooks/guard.jq" <<<"$input" 2>&1)" || {
  echo "openv guard: couldn't read the hook input, so a command naming openv or pass-cli is blocked. ($reason)" >&2
  exit 2
}

if [ -n "$reason" ]; then
  echo "openv guard: blocked \`$reason\`. Use \`openv run <env> -- <cmd>\`, which keeps values masked." >&2
  exit 2
fi
exit 0
