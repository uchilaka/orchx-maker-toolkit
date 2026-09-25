#!/usr/bin/env bash
# Verify the chrome-devtools MCP is registered with the hardened flag set this
# skill depends on. Prints one PASS/FAIL line per check; exits non-zero on any
# FAIL. Read-only: never edits config.
set -uo pipefail

PROFILE_DIR="${BTA_PROFILE_DIR:-$HOME/.cache/chrome-devtools-mcp/test-profile}"
CAPTURE_ROOT="${BTA_CAPTURE_ROOT:-$HOME/browser-tests}"
fail=0

check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $label"; else echo "FAIL  $label"; fail=1; fi
}

args="$(jq -r '.mcpServers["chrome-devtools"].args // [] | join(" ")' "$HOME/.claude.json" 2>/dev/null)"

check "chrome-devtools registered at user scope"  test -n "$args"
check "package version pinned (no @latest)"        bash -c '[[ "$0" =~ chrome-devtools-mcp@[0-9] ]]' "$args"
check "dedicated test profile (--userDataDir)"     bash -c '[[ "$0" == *"--userDataDir=$1"* ]]' "$args" "$PROFILE_DIR"
check "not attached to personal Chrome"            bash -c '[[ "$0" != *--autoConnect* && "$0" != *--browserUrl* && "$0" != *--wsEndpoint* ]]' "$args"
check "auth headers redacted"                      bash -c '[[ "$0" == *--redactNetworkHeaders* ]]' "$args"
check "CrUX URL sharing off"                       bash -c '[[ "$0" == *--no-performance-crux* ]]' "$args"
check "usage statistics off"                       bash -c '[[ "$0" == *--no-usage-statistics* ]]' "$args"
check "workspace is capture root"                  bash -c '[[ "$0" == *"--workspace=$1"* ]]' "$args" "$CAPTURE_ROOT"
check "capture root exists"                        test -d "$CAPTURE_ROOT"
check "profile dir exists"                         test -d "$PROFILE_DIR"

# A profile can only be open in one Chrome process. If a manual login session
# is still running against it, the MCP launch will fail on the profile lock.
if pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
  echo "WARN  test profile is open in a running Chrome; quit it before the MCP launches"
fi

exit "$fail"
