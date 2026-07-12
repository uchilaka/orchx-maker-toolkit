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
