#!/usr/bin/env bash
# Copy the scheduled scripts to a stable location, render the LaunchAgent plist
# pointing at them, and load it.
#
#   --no-load  render and copy only; skip launchctl (used by the tests, together
#              with PATCH_MY_HOSTS_LAUNCH_AGENTS_DIR and PATCH_MY_HOSTS_STATE_DIR)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

SKILL_DIR="$(cd "$HERE/.." && pwd)"
TEMPLATE="$SKILL_DIR/LaunchAgents/com.larcity.patch-my-hosts.plist"
INSTALLED="$LAUNCH_AGENTS_DIR/com.larcity.patch-my-hosts.plist"
LABEL="com.larcity.patch-my-hosts"

load=1
for arg in "$@"; do
  case "$arg" in
    --no-load) load=0 ;;
    *) log "unknown flag: $arg"; exit 2 ;;
  esac
done

[ -f "$TEMPLATE" ] || { log "template not found: $TEMPLATE"; exit 1; }

ensure_state_dirs
mkdir -p "$LAUNCH_AGENTS_DIR" "$BIN_DIR"

# Copy via a temp file and mv, so launchd never runs a half-written script.
for f in "${STABLE_SCRIPTS[@]}"; do
  cp "$HERE/$f" "$BIN_DIR/.$f.tmp"
  chmod 0755 "$BIN_DIR/.$f.tmp"
  mv "$BIN_DIR/.$f.tmp" "$BIN_DIR/$f"
done
log "copied ${STABLE_SCRIPTS[*]} to $BIN_DIR"

FETCH_SCRIPT="$BIN_DIR/fetch-upstream.sh"

# TODO(LAR-350): unescaped sed replacement — a path containing & or | would
# corrupt the rendered plist. Escape replacement values or switch templating approach.
# Render template
sed \
  -e "s|@@FETCH_SCRIPT@@|$FETCH_SCRIPT|g" \
  -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
  "$TEMPLATE" > "$INSTALLED"

log "wrote $INSTALLED"

if [ "$load" -eq 0 ]; then
  log "--no-load: skipping launchctl"
  exit 0
fi

uid="$(id -u)"
domain="gui/$uid"

# Unload first if already loaded — bootout is idempotent and tolerant
if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$domain/$LABEL" 2>/dev/null || true
fi

# TODO(LAR-350): no rollback if bootstrap fails here — the previous agent is
# already booted out, leaving no schedule + a possibly-bad plist on disk.
launchctl bootstrap "$domain" "$INSTALLED"
log "loaded $LABEL into $domain"

log "schedule:"
launchctl print "$domain/$LABEL" | grep -E '^\s*(state|program|next run)' | head -10 || true
