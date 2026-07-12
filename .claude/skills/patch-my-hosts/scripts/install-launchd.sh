#!/usr/bin/env bash
# Render the LaunchAgent plist with absolute paths and load it.
# TODO(LAR-352): no path-injection seam (INSTALLED_DIR is hardcoded) — makes this
# script structurally harder to test than reconcile.sh's --hosts/--archive overrides.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

SKILL_DIR="$(cd "$HERE/.." && pwd)"
TEMPLATE="$SKILL_DIR/LaunchAgents/com.larcity.patch-my-hosts.plist"
INSTALLED_DIR="$HOME/Library/LaunchAgents"
INSTALLED="$INSTALLED_DIR/com.larcity.patch-my-hosts.plist"
LABEL="com.larcity.patch-my-hosts"

[ -f "$TEMPLATE" ] || { log "template not found: $TEMPLATE"; exit 1; }

ensure_state_dirs
mkdir -p "$INSTALLED_DIR"

FETCH_SCRIPT="$HERE/fetch-upstream.sh"

# TODO(LAR-350): unescaped sed replacement — a path containing & or | would
# corrupt the rendered plist. Escape replacement values or switch templating approach.
# Render template
sed \
  -e "s|@@FETCH_SCRIPT@@|$FETCH_SCRIPT|g" \
  -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
  "$TEMPLATE" > "$INSTALLED"

log "wrote $INSTALLED"

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
