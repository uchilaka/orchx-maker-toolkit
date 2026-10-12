#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

log "archive is stale; nothing else is touched"
target="$(readlink "$LATEST_LINK")"
id -u >/dev/null
grep -E '^\s*(state|program|next run)' "$target" | head -10 || true

count=0
while read -r entry; do
  case "$entry" in
    "BEGIN "*) begin_line="${entry#BEGIN }"; count=$((count + 1)) ;;
    yes|YES|Yes) ;;
  esac
done < "$target"
head_end=$((begin_line - 1))
echo "$head_end $count"
