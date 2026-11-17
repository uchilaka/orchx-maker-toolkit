#!/bin/sh
# The session-start autostart hook, and a shell entry point for older callers.
# The logic lives in browse-ctl.mjs; this maps the arguments onto it.
# TODO(LAR-449): two hooks call this, install/hooks.json and the hot-reload-preview
# entry in .claude-plugin/marketplace.json; keep them in step until they're one.
#
#   ensure-server.sh [path] [port] [--open]
#
# - With a path (a leading ~ is expanded), serves it. A port, if given, is used
#   as-is (refused if something else holds it); otherwise the first free one
#   from 3200. Errors go to stderr with a non-zero exit, as before.
# - With no path, it's the hook: it serves the autostart folder
#   (browse-ctl.mjs autostart), else ~/project-plans, else nothing. It always
#   exits 0 and appends any error to <state dir>/autostart.log, since a hook
#   that fails would complain at every session start and its output is
#   discarded anyway.
# - --open is dropped over SSH, and on Linux without a display, where a tab
#   would open on the wrong machine or nowhere.
# - Servers started here are "shared": a session's "done" (stop --mine)
#   leaves them running. Other browse servers are left alone.
set -u

# TODO(LAR-398): reject unknown --* arguments; extra ones are dropped, as before.
open="" path="" port=""
for a in "$@"; do
  case $a in
    --open) open=--open ;;
    *) if [ -z "$path" ]; then path=$a; elif [ -z "$port" ]; then port=$a; fi ;;
  esac
done

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

hook=""
if [ -z "$path" ]; then
  hook=1
  state=${BROWSE_STATE_DIR:-$HOME/.claude/state/browse}
  (umask 077 && mkdir -p "$state")
  log=$state/autostart.log
  # At most one line per failed startup, but capped anyway.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt 65536 ]; then mv "$log" "$log.old"; fi
  exec 2>>"$log"
fi

fail() {
  if [ -n "$hook" ]; then
    echo "$(stamp) browse: $*" >&2
    exit 0
  fi
  echo "browse: $*" >&2
  exit 1
}

case $path in
  "~") path=$HOME ;;
  "~/"*) path=$HOME/${path#"~/"} ;;
esac

# The registry's process checks rely on ps and POSIX signals.
os=$(uname -s)
case $os in
  Darwin|Linux) ;;
  *) fail "unsupported OS ($os); browse runs on macOS and Linux" ;;
esac

# A hook's PATH can lack node (a version manager set up only in an interactive
# shell), so try the usual install locations too. BROWSE_NODE overrides all.
if [ -n "${BROWSE_NODE:-}" ]; then
  node_bin=$BROWSE_NODE
else
  node_bin=$(command -v node || true)
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" /usr/bin/node; do
    [ -n "$node_bin" ] && break
    [ -x "$c" ] && node_bin=$c
  done
fi
{ [ -n "$node_bin" ] && [ -x "$node_bin" ]; } || fail "no node found (set BROWSE_NODE to its path)"

if [ -n "$open" ]; then
  if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
    open=""
  elif [ "$os" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    open=""
  fi
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
ctl=$script_dir/browse-ctl.mjs

if [ -n "$hook" ]; then
  # stdout passes through on fd 3; stderr lines get a timestamp for the log.
  { "$node_bin" "$ctl" ensure --autostart --shared $open 2>&1 >&3 3>&- |
    while IFS= read -r line; do echo "$(stamp) $line"; done >&2; } 3>&1
  exit 0
fi
exec "$node_bin" "$ctl" ensure "$path" --shared $open ${port:+--port "$port"}
