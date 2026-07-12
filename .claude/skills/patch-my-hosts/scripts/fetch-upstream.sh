#!/usr/bin/env bash
# Fetch upstream blocklist into the weekly archive.
# Idempotent: skips download if this week's archive already exists, unless --force.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

# TODO(LAR-351): flag-parsing loop duplicated/inconsistent across fetch-upstream.sh,
# patch-my-hosts.sh, reconcile.sh — hoist shared skeleton into _lib.sh
force=0
quiet=0
for arg in "$@"; do
  case "$arg" in
    --force|--force-fetch) force=1 ;;
    --quiet) quiet=1 ;;
    -h|--help)
      cat <<EOF
fetch-upstream.sh — download the someonewhocares.org hosts list into the weekly archive.

Options:
  --force, --force-fetch   Re-download even if this week's archive exists
  --quiet                  Suppress informational log lines (errors still print)
EOF
      exit 0
      ;;
    *) printf 'unknown flag: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

ensure_state_dirs

week="$(iso_week)"
archive="$(archive_path_for_week "$week")"
sha_sidecar="${archive}.sha256"

if [ -f "$archive" ] && [ "$force" -eq 0 ]; then
  [ "$quiet" -eq 1 ] || log "archive for $week already present at $archive (use --force to refetch)"
else
  tmp="$(mktemp -t patch-my-hosts.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT
  [ "$quiet" -eq 1 ] || log "fetching $UPSTREAM_URL"
  if ! curl --fail --silent --show-error --location --max-time 60 -o "$tmp" "$UPSTREAM_URL"; then
    log "fetch failed"
    exit 1
  fi
  if [ ! -s "$tmp" ]; then
    log "fetched file is empty — refusing to overwrite archive"
    exit 1
  fi
  mv "$tmp" "$archive"
  trap - EXIT
fi

# TODO(LAR-348): this hashes the file against itself, not a pinned/trusted value —
# doesn't detect a compromised upstream. Consider TOFU-pinning against last-known-good.
# (Re)compute integrity sidecar
shasum -a 256 "$archive" | awk '{print $1}' > "$sha_sidecar"

# Update latest symlink
ln -sfn "$archive" "$LATEST_LINK"

# Update last-fetched timestamp
iso_now > "$LAST_FETCHED"

# Drop the pending marker so check-stale.sh and the next /patch-my-hosts invocation see it
touch "$PENDING"

[ "$quiet" -eq 1 ] || log "archive: $archive"
[ "$quiet" -eq 1 ] || log "latest -> $(readlink "$LATEST_LINK")"
[ "$quiet" -eq 1 ] || log "pending marker written"
