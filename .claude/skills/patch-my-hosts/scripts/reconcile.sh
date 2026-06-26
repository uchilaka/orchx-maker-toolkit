#!/usr/bin/env bash
# Pure-ish function: (current hosts file, upstream archive) -> patched candidate.
# Writes the candidate to a temp file and prints its path on stdout.
# Returns 0 on success; non-zero on error or missing sentinels in --strict mode.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

hosts_in="$HOSTS_FILE"
archive=""
strict=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hosts) hosts_in="$2"; shift 2 ;;
    --archive) archive="$2"; shift 2 ;;
    --strict) strict=1; shift ;;
    -h|--help)
      cat <<EOF
reconcile.sh — build a patched /etc/hosts candidate with the upstream wrapped in sentinels.

Options:
  --hosts <path>     Source hosts file (default: $HOSTS_FILE)
  --archive <path>   Upstream archive to embed (default: \$LATEST_LINK)
  --strict           Fail if sentinels are not already present in the source
EOF
      exit 0
      ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -z "$archive" ] && archive="$(readlink "$LATEST_LINK" 2>/dev/null || true)"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  log "no upstream archive available — run fetch-upstream.sh first"
  exit 1
fi

if [ ! -r "$hosts_in" ]; then
  log "cannot read source hosts file: $hosts_in"
  exit 1
fi

week="$(basename "$archive" .hosts)"

# Detect sentinel positions. Awk yields two line numbers (begin / end) or empty.
mapfile -t sentinels < <(
  awk -v B="$BEGIN_SENTINEL" -v E="$END_SENTINEL" '
    $0 == B { print "BEGIN " NR }
    $0 == E { print "END   " NR }
  ' "$hosts_in"
)

begin_line=""
end_line=""
for entry in "${sentinels[@]:-}"; do
  case "$entry" in
    "BEGIN "*) begin_line="${entry#BEGIN }" ;;
    "END   "*) end_line="${entry#END   }" ;;
  esac
done

if [ "$strict" -eq 1 ] && { [ -z "$begin_line" ] || [ -z "$end_line" ]; }; then
  log "strict mode: sentinels not found in $hosts_in"
  exit 3
fi

# Sanity: if one sentinel is present without the other, refuse to guess.
if { [ -n "$begin_line" ] && [ -z "$end_line" ]; } || { [ -z "$begin_line" ] && [ -n "$end_line" ]; }; then
  log "found one sentinel but not the other in $hosts_in — refusing to reconcile"
  exit 4
fi

# Sanity: if begin/end are out of order, abort.
if [ -n "$begin_line" ] && [ -n "$end_line" ] && [ "$end_line" -le "$begin_line" ]; then
  log "sentinel order is inverted in $hosts_in (BEGIN line $begin_line, END line $end_line)"
  exit 5
fi

out="/tmp/hosts.${week}.patched"

# Derive Fetched timestamp from the archive's mtime so re-running against the
# same archive produces byte-identical output (true idempotency).
fetched_iso="$(date -u -r "$archive" +%Y-%m-%dT%H:%M:%SZ)"

emit_managed_block() {
  printf '%s\n' "$BEGIN_SENTINEL"
  printf '# Version: %s    Fetched: %s\n' "$week" "$fetched_iso"
  printf '# DO NOT EDIT BETWEEN SENTINELS — changes are overwritten on next sync.\n'
  printf '# Custom entries belong OUTSIDE this block.\n'
  cat "$archive"
  printf '%s\n' "$END_SENTINEL"
}

if [ -z "$begin_line" ]; then
  # No sentinels yet — first-run flow. Append the managed block after the existing
  # content, separated by a single blank line.
  {
    cat "$hosts_in"
    # Ensure there's a trailing newline before the blank separator
    tail -c1 "$hosts_in" | od -An -c 2>/dev/null | grep -q '\\n' || printf '\n'
    printf '\n'
    emit_managed_block
  } > "$out"
else
  # Sentinels present — replace the managed slice.
  head_end=$((begin_line - 1))
  tail_start=$((end_line + 1))

  {
    if [ "$head_end" -ge 1 ]; then
      sed -n "1,${head_end}p" "$hosts_in"
    fi
    emit_managed_block
    sed -n "${tail_start},\$p" "$hosts_in"
  } > "$out"
fi

printf '%s\n' "$out"
