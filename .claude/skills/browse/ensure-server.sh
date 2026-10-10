#!/bin/sh
# Leave exactly one /browse server running, serving <path> on <port>.
#
#   ensure-server.sh [path] [port] [--open]
#
# - A browse server already serving <path> is kept (open tabs keep their live
#   reload); any other browse server, on any port, is stopped first.
# - Something that isn't a browse server holding <port> is never killed — the
#   script exits 1 and says what holds it.
# - --open opens the browser, but only when a server was actually started, so
#   every new Claude session doesn't add another tab.
# - Uses http://plans.localhost:<port> once /etc/hosts maps that name
#   (BROWSE_HOST overrides it), otherwise http://localhost:<port>.
# - BROWSE_HOSTS_FILE replaces /etc/hosts for the lookup; the tests use it.
set -u

open_browser=0 path="" port=""
for a in "$@"; do
  case $a in
    --open) open_browser=1 ;;
    *) if [ -z "$path" ]; then path=$a; elif [ -z "$port" ]; then port=$a; fi ;;
  esac
done
requested=${path:-$HOME/project-plans}
port=${port:-3200}

script_dir=$(cd "$(dirname "$0")" && pwd)
server="$script_dir/serve-md.mjs"
log="$HOME/.claude/state/browse-server.log"
node_bin=$(command -v node || echo /opt/homebrew/bin/node)
path=$(cd "$requested" 2>/dev/null && pwd) || { echo "browse: no such directory: $requested" >&2; exit 1; }

host=${BROWSE_HOST:-plans.localhost}
# Whole-field match on 127.0.0.1 lines, stopping at a trailing # comment
awk -v h="$host" '$1 == "127.0.0.1" { for (i = 2; i <= NF && $i !~ /^#/; i++) if ($i == h) found = 1 }
  END { exit !found }' "${BROWSE_HOSTS_FILE:-/etc/hosts}" || host=localhost
url="http://$host:$port"

serving=$(curl -fsS --max-time 1 "http://127.0.0.1:$port/__health" 2>/dev/null)
if [ "$serving" = "$path" ]; then
  keep=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)
  for pid in $(pgrep -f "$server"); do
    [ "$pid" = "$keep" ] || kill "$pid" 2>/dev/null  # strays on other ports
  done
  echo "$url (already running)"
  exit 0
fi

# Refuse before stopping anything, so a failed run never leaves zero servers.
for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
  if ! ps -o command= -p "$pid" | grep -qF "$server"; then
    echo "browse: port $port is held by a non-browse process ($(ps -o comm= -p "$pid"), pid $pid); not touching it" >&2
    exit 1
  fi
done

# Stop every browse server, whatever it serves and whichever port it's on.
pkill -f "$server" 2>/dev/null
i=0
while lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 && [ $i -lt 20 ]; do
  sleep 0.1; i=$((i + 1))
done

BROWSE_HOST=$host nohup "$node_bin" "$server" "$path" --port "$port" </dev/null >"$log" 2>&1 &

i=0
until [ "$(curl -fsS --max-time 1 "http://127.0.0.1:$port/__health" 2>/dev/null)" = "$path" ]; do
  i=$((i + 1))
  if [ $i -ge 30 ]; then echo "browse: server didn't come up; see $log" >&2; exit 1; fi
  sleep 0.1
done

echo "$url (started)"
[ "$open_browser" = 1 ] && open "$url"
exit 0
