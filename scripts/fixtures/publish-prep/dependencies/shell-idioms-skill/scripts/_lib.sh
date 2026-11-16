#!/usr/bin/env bash
# Sourced by run.sh: a function and variables defined here are not dependencies.
readonly STATE_DIR="${SHELL_IDIOMS_STATE_DIR:-$HOME/.local/share/shell-idioms}"
readonly LATEST_LINK="$STATE_DIR/latest"
# An array assignment lists files, it doesn't run them.
COPIED_SCRIPTS=(_lib.sh run-helper.sh check-thing.sh)
# A quoted "<<" is data, not a heredoc, so it must not hide log() below.
readonly END_SENTINEL="# <<<<< END managed block <<<<<"

log() { printf '%s\n' "$*" >&2; }
