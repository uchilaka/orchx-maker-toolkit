#!/bin/bash
# Status line for Claude Code. Shows model + rate-limit usage, and snapshots
# rate_limits to a state file so /agentic-backlog-worker can read usage
# without an API of its own (Claude Code only exposes it here).
input=$(cat)
state="$HOME/.claude/state/statusline/rate-limits.json"

if echo "$input" | jq -e '.rate_limits' >/dev/null 2>&1; then
  mkdir -p "${state%/*}"
  # Every open session runs this script, and idle ones report usage cached
  # from their last API response -- days old, sometimes. Usage only grows
  # within a window, so merge per window instead of last-writer-wins: a
  # later resets_at is a new window and replaces; the same window keeps the
  # higher reading; an older or absent window never overwrites.
  # Read-merge-write is not atomic, so two sessions could both read the old
  # file and the lower reading win the rename. Serialize with an mkdir lock
  # (atomic and portable; macOS has no flock). Waits ~5s, then breaks the lock
  # on the assumption its holder died -- a stale lock must not freeze the
  # status line.
  lock="$state.lock"
  tries=0
  until mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 250 ]; then rm -rf "$lock"; tries=0; fi
    sleep 0.02
  done
  trap 'rm -rf "$lock"' EXIT
  prev=$(cat "$state" 2>/dev/null || echo '{}')
  # Unique temp per run so a crashed writer never leaves a shared "$state.tmp".
  tmp=$(mktemp "${state}.XXXXXX")
  echo "$input" | jq --argjson prev "$prev" '
    def pick(o; n):
      if n == null then o
      elif o == null or n.resets_at > o.resets_at then n
      elif n.resets_at == o.resets_at and n.used_percentage > o.used_percentage then n
      else o end;
    ($prev.rate_limits // {}) as $o
    | {captured_at: (now|floor),
       rate_limits: {five_hour: pick($o.five_hour; .rate_limits.five_hour),
                     seven_day: pick($o.seven_day; .rate_limits.seven_day)}}
    | .rate_limits |= with_entries(select(.value != null))' > "$tmp" \
    && mv "$tmp" "$state" || rm -f "$tmp"   # write-then-rename: readers never see half a file
  rm -rf "$lock"; trap - EXIT   # release; the trap must not delete the next holder's lock
fi

# Bars turn yellow at 50% and red at 75% (the worker's default stop line).
echo "$input" | jq -r '
  def color(p): if p >= 75 then "\u001b[31m" elif p >= 50 then "\u001b[33m" else "\u001b[32m" end;
  def bar(p): (p/10|floor) as $n | ("█" * $n) + ("░" * (10-$n));
  def win($name; w):
    if w then
      (w.used_percentage|floor) as $p
      | "\($name) \(color($p))\(bar($p)) \($p)%\u001b[0m ↻\(w.resets_at|strflocaltime("%a %H:%M"))"
    else "\($name) –" end;
  "\(.model.display_name) · \(win("5h"; .rate_limits.five_hour)) · \(win("7d"; .rate_limits.seven_day))"'
