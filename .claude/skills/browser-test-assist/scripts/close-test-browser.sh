#!/usr/bin/env bash
# Stop the Chrome that runs the test profile, and nothing else.
#
# Why this exists: the test browser is the same app as the user's everyday
# Chrome. When two instances of one app are running, macOS sends `open <url>`
# to the one that has been running longest, so a test browser left open
# quietly receives every link opened from the terminal (/browse included),
# even while the user's own Chrome window is in front.
#
# Only the main process is signalled: it is the one whose command line has
# --user-data-dir=<profile> and no --type= flag. Helper processes (renderer,
# GPU) carry --type= and exit with it. A profile path that only starts with the
# test profile's path is a different profile and is left alone. Exits 0 whether
# or not anything was running; the chrome-devtools MCP relaunches the browser
# on its next tool call.
set -uo pipefail

PROFILE_DIR="${BTA_PROFILE_DIR:-$HOME/.cache/chrome-devtools-mcp/test-profile}"
FLAG="--user-data-dir=$PROFILE_DIR"

pids=()
while read -r pid cmd; do
  [[ -n "$pid" ]] || continue
  is_test=0 is_helper=0
  for word in $cmd; do
    [[ "$word" == "$FLAG" ]] && is_test=1
    [[ "$word" == --type=* ]] && is_helper=1
  done
  (( is_test && !is_helper )) && pids+=("$pid")
done < <(ps -axo pid=,command=)

if (( ${#pids[@]} == 0 )); then
  echo "no test browser running"
  exit 0
fi

# A process that has exited but not been reaped yet (state Z) still answers
# `kill -0`. It holds no window or profile lock, so count it as gone: its
# parent, the MCP server, may be busy and reap it later.
running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [[ -n "$state" && "$state" != Z* ]]
}

kill -TERM "${pids[@]}" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  still=0
  for pid in "${pids[@]}"; do running "$pid" && still=1; done
  (( still )) || break
  sleep 0.5
done

if (( still )); then
  echo "WARN  test browser did not exit after 5s (pids: ${pids[*]}); quit it by hand"
  exit 0
fi
echo "closed ${#pids[@]} test browser process(es)"
