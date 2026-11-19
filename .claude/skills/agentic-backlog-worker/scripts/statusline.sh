#!/bin/bash
# Status line for Claude Code. Shows model + rate-limit usage, and snapshots
# rate_limits to a state file so /agentic-backlog-worker can read usage
# without an API of its own (Claude Code only exposes it here).
input=$(cat)
state="$HOME/.claude/state/statusline/rate-limits.json"

# Bars turn yellow at 50% and red at 75% (the worker's default stop line).
# Rendered and printed first: the visible bar must never wait on the snapshot.
echo "$input" | jq -r '
  def color(p): if p >= 75 then "\u001b[31m" elif p >= 50 then "\u001b[33m" else "\u001b[32m" end;
  def bar(p): (p/10|floor) as $n | ("█" * $n) + ("░" * (10-$n));
  def win($name; w):
    if w then
      (w.used_percentage|floor) as $p
      | "\($name) \(color($p))\(bar($p)) \($p)%\u001b[0m ↻\(w.resets_at|strflocaltime("%a %H:%M"))"
    else "\($name) –" end;
  "\(.model.display_name) · \(win("5h"; .rate_limits.five_hour)) · \(win("7d"; .rate_limits.seven_day))"'

snapshot() {
  # Every open session runs this script, and idle ones report usage cached
  # from their last API response -- days old, sometimes. Usage only grows
  # within a window, so merge per window instead of last-writer-wins: a
  # later resets_at is a new window and replaces; the same window keeps the
  # higher reading; an older or absent window never overwrites.
  mkdir -p "${state%/*}"
  lock="$state.lock"
  tmp=""
  # Read-merge-write is not atomic, so serialize with an mkdir lock (atomic,
  # portable; macOS has no flock). Wait ~3s, then give up: skipping is safe
  # because the next tick rewrites the snapshot and the guard fails closed on
  # a stale one. A lock is broken only when its own mtime is over 10s old
  # (a holder SIGKILLed mid-write never runs its trap).
  tries=0
  until mkdir "$lock" 2>/dev/null; do
    mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null)
    if [ -n "$mtime" ] && [ $(($(date +%s) - mtime)) -gt 10 ]; then
      rmdir "$lock" 2>/dev/null
      continue
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 150 ] && return 0
    sleep 0.02
  done
  # Own lock and own temp file only; rmdir never touches a foreign lock's contents.
  trap 'rm -f "$tmp"; rmdir "$lock" 2>/dev/null' EXIT

  prev=$(cat "$state" 2>/dev/null)
  # A corrupt or empty snapshot self-heals instead of wedging every later merge.
  echo "$prev" | jq -e . >/dev/null 2>&1 || prev='{}'
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
    && mv "$tmp" "$state"   # write-then-rename: readers never see half a file
}

if echo "$input" | jq -e '.rate_limits' >/dev/null 2>&1; then
  if [ -n "$ABW_STATUSLINE_FOREGROUND" ]; then
    snapshot   # test seam: lets tests observe the write deterministically
  else
    # Detached, so a cancelled parent can't interrupt the write and the bar
    # never waits on it.
    ( snapshot ) </dev/null >/dev/null 2>&1 &
  fi
fi
