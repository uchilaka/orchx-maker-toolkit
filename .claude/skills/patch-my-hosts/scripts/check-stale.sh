#!/usr/bin/env bash
# SessionStart hook: emit a one-line nudge if a refresh is pending or the
# archive is older than 7 days. Exits 0 silently otherwise.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

# Steady state: state dir doesn't even exist yet. Stay quiet.
[ -d "$STATE_DIR" ] || exit 0

reason=""

if [ -f "$PENDING" ]; then
  reason="upstream refresh pending"
elif [ -f "$LAST_FETCHED" ]; then
  last_epoch=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$(cat "$LAST_FETCHED")" +%s 2>/dev/null || echo 0)
  now_epoch=$(date -u +%s)
  age_days=$(( (now_epoch - last_epoch) / 86400 ))
  if [ "$age_days" -gt 7 ]; then
    reason="archive is ${age_days}d stale"
  fi
else
  reason="never fetched"
fi

[ -z "$reason" ] && exit 0

week=""
if [ -L "$LATEST_LINK" ]; then
  week="$(basename "$(readlink "$LATEST_LINK")" .hosts)"
fi

if [ -n "$week" ]; then
  printf 'patch-my-hosts: %s (archive: %s). Run /patch-my-hosts to preview the patch for /etc/hosts.\n' "$reason" "$week"
else
  printf 'patch-my-hosts: %s. Run /patch-my-hosts to fetch the upstream and preview the patch for /etc/hosts.\n' "$reason"
fi
