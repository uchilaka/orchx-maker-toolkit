#!/bin/bash
# Status line for Claude Code. Shows model + rate-limit usage, and snapshots
# rate_limits to a state file so /agentic-backlog-worker can read usage
# without an API of its own (Claude Code only exposes it here).
IFS= read -rd '' input || true   # all of stdin, without forking cat
state="$HOME/.claude/state/statusline/rate-limits.json"

# Bars turn yellow at 50% and red at 75% (the worker's default stop line).
# Rendered and printed first: the visible bar must never wait on the snapshot.
jq -r '
  def color(p): if p >= 75 then "\u001b[31m" elif p >= 50 then "\u001b[33m" else "\u001b[32m" end;
  def bar(p): (p/10|floor) as $n | ("█" * $n) + ("░" * (10-$n));
  def win($name; w):
    if w then
      (w.used_percentage|floor) as $p
      | "\($name) \(color($p))\(bar($p)) \($p)%\u001b[0m ↻\(w.resets_at|strflocaltime("%a %H:%M"))"
    else "\($name) –" end;
  "\(.model.display_name) · \(win("5h"; .rate_limits.five_hour)) · \(win("7d"; .rate_limits.seven_day))"' <<<"$input"

# Every open session runs this script, and idle ones report usage cached from
# their last API response -- days old, sometimes. Usage only grows within a
# window, so merge per window instead of last-writer-wins: a later resets_at is
# a new window and replaces; the same window keeps the higher reading; an older
# or absent window never overwrites. Writes the result to $tmp.
merge() {
  jq --argjson prev "$1" '
    def pick(o; n):
      if n == null then o
      elif o == null or n.resets_at > o.resets_at then n
      elif n.resets_at == o.resets_at and n.used_percentage > o.used_percentage then n
      else o end;
    def reading(r): [r.five_hour, r.seven_day] | map(if . then [.used_percentage, .resets_at] else null end);
    ($prev.rate_limits // {}) as $o
    | {five_hour: pick($o.five_hour; .rate_limits.five_hour),
       seven_day: pick($o.seven_day; .rate_limits.seven_day)}
    | with_entries(select(.value != null)) as $merged
    # captured_at means "last time a reading changed", not "last tick": idle sessions re-send
    # old readings forever. A stale unchanged reading therefore ages out and fails closed, by design.
    | {captured_at: (if $prev.captured_at == null or reading($merged) != reading($o)
                     then (now|floor) else $prev.captured_at end),
       rate_limits: $merged}' <<<"$input" > "$tmp"
}

snapshot() {
  # Only a payload that carries rate_limits is snapshotted. Checked here, inside
  # the detached job, so the render path pays for one jq only.
  jq -e '.rate_limits' >/dev/null 2>&1 <<<"$input" || return 0
  [ -d "${state%/*}" ] || mkdir -p "${state%/*}"
  lock="$state.lock"
  # Read-merge-write is not atomic, so serialize with an mkdir lock (atomic,
  # portable; macOS has no flock). Wait ABW_LOCK_WAIT_S (default ~3s), then
  # give up: skipping is safe because the next tick rewrites the snapshot and
  # the guard fails closed on a stale one. A lock is broken only when its own
  # mtime is over 10s old (a holder SIGKILLed mid-write never runs its trap).
  if ! mkdir "$lock" 2>/dev/null; then
    # Digits only: bash arithmetic expands a[$(cmd)] subscripts, so anything else is ignored.
    case $ABW_LOCK_WAIT_S in ''|*[!0-9]*) wait_s=3;; *) wait_s=$ABW_LOCK_WAIT_S;; esac
    deadline=$(($(date +%s) + wait_s))
    tries=0
    until mkdir "$lock" 2>/dev/null; do
      # GNU first: on GNU stat, -f is "filesystem status" and prints a report to
      # stdout. BSD stat rejects -c on stderr only. Non-numeric means "not stale".
      mtime=$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null)
      case "$mtime" in
        ''|*[!0-9]*) ;;
        *) [ $(($(date +%s) - mtime)) -gt 10 ] && rmdir "$lock" 2>/dev/null && continue ;;
      esac
      # A failed break attempt falls through to the deadline check and sleep, so
      # the wait bound holds (by wall clock, not poll count) even when the stale
      # lock cannot be removed.
      [ "$(date +%s)" -ge "$deadline" ] && return 0
      # Short polls for brief contention, then back off.
      tries=$((tries + 1))
      if [ "$tries" -le 5 ]; then sleep 0.02; else sleep 0.1; fi
    done
  fi
  # Unique without mktemp: only the lock holder writes, and $$ differs per run.
  tmp="$state.$$"
  # Own lock and own temp file only; rmdir never touches a foreign lock's contents.
  trap '[ -e "$tmp" ] && rm -f "$tmp"; rmdir "$lock" 2>/dev/null' EXIT

  { prev=$(<"$state"); } 2>/dev/null
  # A missing, corrupt or empty snapshot self-heals instead of wedging every
  # later merge: when the merge fails, it is retried once from an empty one.
  { merge "$prev" || merge '{}'; } 2>/dev/null \
    && mv "$tmp" "$state"   # write-then-rename: readers never see half a file
}

if [ -n "$ABW_STATUSLINE_FOREGROUND" ]; then
  snapshot   # test seam: lets tests observe the write deterministically
else
  # Detached, so the bar never waits on the write. A process-group kill still
  # takes the child down and leaves a lock, which the 10s age check clears.
  ( snapshot ) </dev/null >/dev/null 2>&1 &
fi
