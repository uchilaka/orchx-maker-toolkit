#!/usr/bin/env bash
# Bootout the LaunchAgent and remove the installed plist.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

INSTALLED="$HOME/Library/LaunchAgents/com.larcity.patch-my-hosts.plist"
LABEL="com.larcity.patch-my-hosts"

uid="$(id -u)"
domain="gui/$uid"

if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$domain/$LABEL"
  log "booted out $LABEL"
else
  log "$LABEL not loaded — nothing to bootout"
fi

if [ -f "$INSTALLED" ]; then
  rm -f "$INSTALLED"
  log "removed $INSTALLED"
fi
