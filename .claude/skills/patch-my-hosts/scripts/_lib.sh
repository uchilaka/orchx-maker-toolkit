#!/usr/bin/env bash
# Shared constants and helpers for patch-my-hosts.

set -euo pipefail

UPSTREAM_URL="${PATCH_MY_HOSTS_UPSTREAM_URL:-https://someonewhocares.org/hosts/hosts}"

STATE_DIR="${PATCH_MY_HOSTS_STATE_DIR:-$HOME/.local/share/patch-my-hosts}"
ARCHIVE_DIR="$STATE_DIR/archive"
LATEST_LINK="$STATE_DIR/latest"
LAST_FETCHED="$STATE_DIR/last-fetched"
PENDING="$STATE_DIR/pending"
LOG_DIR="$STATE_DIR/logs"
# Stable copies of the scripts that launchd and the SessionStart hook run. The
# skill directory can't be referenced directly: a plugin install lives under a
# versioned path that changes (and is cleaned up) on every plugin update, so an
# absolute path into it would silently break the weekly job.
BIN_DIR="$STATE_DIR/bin"
STABLE_SCRIPTS=(_lib.sh fetch-upstream.sh check-stale.sh)

LAUNCH_AGENTS_DIR="${PATCH_MY_HOSTS_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

HOSTS_FILE="${PATCH_MY_HOSTS_HOSTS_FILE:-/etc/hosts}"

BEGIN_SENTINEL="# >>>>> BEGIN someonewhocares.org/hosts (managed by /patch-my-hosts) >>>>>"
END_SENTINEL="# <<<<< END   someonewhocares.org/hosts (managed by /patch-my-hosts) <<<<<"

iso_week() { date -u +%G-W%V; }
iso_now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

ensure_state_dirs() {
  mkdir -p "$ARCHIVE_DIR" "$LOG_DIR"
}

archive_path_for_week() {
  printf '%s/%s.hosts' "$ARCHIVE_DIR" "$1"
}

log() {
  printf '[patch-my-hosts] %s\n' "$*" >&2
}
