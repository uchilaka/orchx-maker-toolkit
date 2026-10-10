#!/bin/sh
# Kept for the SessionStart autostart hook and older callers. The logic lives in
# browse-ctl.mjs; this maps the old arguments onto it.
#
#   ensure-server.sh [path] [port] [--open]
#
# - path defaults to ~/project-plans. A port, if given, is used as-is
#   (refused if something else holds it); otherwise the first free one from 3200.
# - Servers started here are "shared": a session's "done" (stop --mine)
#   leaves them running.
# - Other browse servers are left alone; any number can run, one per path.
set -u

open="" path="" port=""
for a in "$@"; do
  case $a in
    --open) open=--open ;;
    *) if [ -z "$path" ]; then path=$a; elif [ -z "$port" ]; then port=$a; fi ;;
  esac
done

script_dir=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node || echo /opt/homebrew/bin/node)
exec "$node_bin" "$script_dir/browse-ctl.mjs" ensure "${path:-$HOME/project-plans}" --shared $open ${port:+--port "$port"}
