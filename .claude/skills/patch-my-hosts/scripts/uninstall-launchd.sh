#!/usr/bin/env bash
# Bootout the LaunchAgent and remove the installed plist and the stable script
# copies. The archive and state stay, so a reinstall picks up where it left off.
#
#   --no-load  skip launchctl (used by the tests)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

INSTALLED="$LAUNCH_AGENTS_DIR/com.larcity.patch-my-hosts.plist"
LABEL="com.larcity.patch-my-hosts"

load=1
for arg in "$@"; do
  case "$arg" in
    --no-load) load=0 ;;
    *) log "unknown flag: $arg"; exit 2 ;;
  esac
done

if [ "$load" -eq 1 ]; then
  uid="$(id -u)"
  domain="gui/$uid"
  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$domain/$LABEL"
    log "booted out $LABEL"
  else
    log "$LABEL not loaded — nothing to bootout"
  fi
fi

if [ -f "$INSTALLED" ]; then
  rm -f "$INSTALLED"
  log "removed $INSTALLED"
fi

for f in "${STABLE_SCRIPTS[@]}"; do
  if [ -f "$BIN_DIR/$f" ]; then
    rm -f "$BIN_DIR/$f"
    log "removed $BIN_DIR/$f"
  fi
done
log "if you added the SessionStart hook, remove it too: it runs $BIN_DIR/check-stale.sh"
