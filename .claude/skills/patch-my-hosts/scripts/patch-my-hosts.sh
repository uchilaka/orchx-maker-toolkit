#!/usr/bin/env bash
# Main entrypoint: fetch -> reconcile -> diff -> print apply command.
# Never writes to /etc/hosts directly.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

dry_run=0
verbose=0
force_fetch=0
yes_first_run=0

# TODO(LAR-351): flag-parsing loop duplicated/inconsistent across patch-my-hosts.sh,
# fetch-upstream.sh, reconcile.sh — hoist shared skeleton into _lib.sh
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --verbose|-v) verbose=1; shift ;;
    --force-fetch) force_fetch=1; shift ;;
    --yes) yes_first_run=1; shift ;;
    -h|--help)
      cat <<EOF
patch-my-hosts.sh — sync /etc/hosts with the upstream blocklist (never writes /etc/hosts directly).

Options:
  --dry-run        Fetch + reconcile + diff; suppress the apply prompt and command
  --verbose, -v    Show the full diff instead of just the +X / -Y summary
  --force-fetch    Re-download the upstream even if this week's archive exists
  --yes            Skip the first-run confirmation prompt
EOF
      exit 0
      ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
done

ensure_state_dirs

# Step 1: fetch (idempotent unless --force-fetch)
fetch_args=()
[ "$force_fetch" -eq 1 ] && fetch_args+=(--force)
[ "$verbose" -eq 1 ] || fetch_args+=(--quiet)
"$HERE/fetch-upstream.sh" "${fetch_args[@]}"

archive="$(readlink "$LATEST_LINK")"
week="$(basename "$archive" .hosts)"

# First-run check: are sentinels present in /etc/hosts?
if ! grep -Fqx "$BEGIN_SENTINEL" "$HOSTS_FILE" 2>/dev/null; then
  log "first run — no managed block detected in $HOSTS_FILE"
  log "the patch will APPEND a new managed block to the end of the file; nothing else is touched"
  if [ "$dry_run" -eq 0 ] && [ "$yes_first_run" -eq 0 ]; then
    printf '\nProceed with first-run reconciliation? [yes/NO] '
    read -r reply
    case "$reply" in
      yes|YES|Yes) ;;
      *) log "aborted by user"; exit 1 ;;
    esac
  fi
fi

# Step 2: reconcile
patched="$("$HERE/reconcile.sh" --archive "$archive")"

# Step 3: diff
added=$(diff "$HOSTS_FILE" "$patched" | grep -c '^>' || true)
removed=$(diff "$HOSTS_FILE" "$patched" | grep -c '^<' || true)

printf '\n'
log "archive: $archive"
log "candidate: $patched"
log "diff summary: +$added / -$removed lines"

if [ "$verbose" -eq 1 ]; then
  printf '\n--- full diff ---\n'
  diff -u "$HOSTS_FILE" "$patched" || true
fi

if [ "$added" = "0" ] && [ "$removed" = "0" ]; then
  log "no changes — $HOSTS_FILE is already in sync with $week"
  # Clear the pending marker since nothing remains to apply
  [ -f "$PENDING" ] && rm -f "$PENDING" && log "cleared pending marker"
  exit 0
fi

# Step 4: print the apply one-liner
if [ "$dry_run" -eq 1 ]; then
  log "dry-run: not printing apply command"
  exit 0
fi

backup="/etc/hosts.$(date +%Y-%m-%d).bak"

cat <<EOF

To apply (review the diff first — preview with: diff -u $HOSTS_FILE $patched):

  sudo cp $HOSTS_FILE $backup && sudo cp $patched $HOSTS_FILE \\
    && dscacheutil -flushcache && sudo killall -HUP mDNSResponder

After applying, re-run this script to clear the pending marker.
EOF
