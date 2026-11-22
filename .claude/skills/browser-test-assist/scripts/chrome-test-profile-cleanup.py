#!/usr/bin/env python3
"""SessionEnd hook: stop the Chrome the chrome-devtools MCP left behind.

The chrome-devtools MCP (~/.claude.json) launches its own Chrome on the
test profile at ~/.cache/chrome-devtools-mcp/test-profile. Nothing closed
that browser when a session ended, and a crashed session left its MCP server
and Chrome running, reparented to launchd. A leftover Chrome can then catch
links clicked in the terminal. On 2026-11-22 there were 20 such servers, the
oldest 40 days old.

What it stops (SIGTERM, then SIGKILL after a grace period):
  1. Processes under this session's `claude` whose command line names the
     test profile (its MCP server and that server's Chrome), with their
     descendants (Chrome's helpers don't all repeat the profile path).
  2. Orphans: processes whose parent is launchd (pid 1) and whose command
     line names the test profile, with their descendants. No live session
     owns those.

What it never touches: another live session's MCP and Chrome (they sit under
that session's `claude`), the user's own Chrome and the claude-in-chrome
extension browser (no test-profile path), and this hook's own ancestors.

Never fails the session end: any error is logged and the exit code is 0.
Logs pids only, never command lines, since some carry secrets in their
environment-looking arguments.

Overrides, for tests: CHROME_CLEANUP_PROFILE (the profile path) and
CHROME_CLEANUP_STATE (where last.log goes). `--dry-run` lists targets.
"""

import collections
import datetime
import os
import re
import signal
import subprocess
import sys
import time

DEFAULT_PROFILE = os.path.expanduser("~/.cache/chrome-devtools-mcp/test-profile")
DEFAULT_STATE = os.path.expanduser("~/.claude/state/chrome-test-profile-cleanup")
GRACE_SECONDS = 3.0

Proc = collections.namedtuple("Proc", "pid ppid cmd")


def read_procs():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="],
                         capture_output=True, text=True, check=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 2:
            continue
        pid, ppid = int(parts[0]), int(parts[1])
        procs[pid] = Proc(pid, ppid, parts[2] if len(parts) > 2 else "")
    return procs


def is_claude(cmd):
    first = cmd.split()[0] if cmd.split() else ""
    return os.path.basename(first) == "claude" or "@anthropic-ai/claude-code" in cmd


def session_root(procs, start):
    """The nearest `claude` at or above `start`: the session that is ending."""
    pid, seen = start, set()
    while pid in procs and pid not in seen and pid > 1:
        seen.add(pid)
        if is_claude(procs[pid].cmd):
            return pid
        pid = procs[pid].ppid
    return None


def descendants(procs, pid):
    children = collections.defaultdict(list)
    for p in procs.values():
        children[p.ppid].append(p.pid)
    out, stack = set(), list(children[pid])
    while stack:
        c = stack.pop()
        if c not in out:
            out.add(c)
            stack.extend(children[c])
    return out


def ancestors(procs, pid):
    out = set()
    while pid in procs and pid not in out and pid > 0:
        out.add(pid)
        pid = procs[pid].ppid
    return out


def select(procs, profile, root, me):
    # The path must end there, so "test-profile-old" is not a match.
    names_profile = re.compile(re.escape(profile) + r"(?=$|[\s\"'])").search
    seeds = set()
    if root is not None:
        seeds |= {pid for pid in descendants(procs, root) if names_profile(procs[pid].cmd)}
    seeds |= {p.pid for p in procs.values() if p.ppid == 1 and names_profile(p.cmd)}
    targets = set(seeds)
    for pid in seeds:
        targets |= descendants(procs, pid)
    return targets - ancestors(procs, me)


def stop(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + GRACE_SECONDS
    remaining = set(pids)
    while remaining and time.monotonic() < deadline:
        time.sleep(0.1)
        remaining = {pid for pid in remaining if _alive(pid)}
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return remaining


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def main(argv):
    profile = os.environ.get("CHROME_CLEANUP_PROFILE", DEFAULT_PROFILE)
    state = os.environ.get("CHROME_CLEANUP_STATE", DEFAULT_STATE)
    me = os.getpid()
    procs = read_procs()
    root = session_root(procs, me)
    targets = select(procs, profile, root, me)
    if "--dry-run" in argv:
        for pid in sorted(targets):
            print(pid, procs[pid].ppid)
        print(f"{len(targets)} target(s); session root {root}")
        return
    killed_hard = stop(targets) if targets else set()
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "last.log"), "w") as f:
        f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} "
                f"root={root} stopped={sorted(targets)} sigkill={sorted(killed_hard)}\n")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:  # a hook must never block the session ending
        print(f"chrome-test-profile-cleanup: {e}", file=sys.stderr)
    sys.exit(0)
