"""Tests for chrome-test-profile-cleanup.py.
Run: python3 .claude/skills/browser-test-assist/scripts/test_chrome_test_profile_cleanup.py
(also part of `mise run test`)"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest

_spec = importlib.util.spec_from_file_location(
    "cleanup", os.path.join(os.path.dirname(__file__), "chrome-test-profile-cleanup.py"))
cl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cl)

# publish-prep: allow portability — a made-up home path in a fake process table
PROFILE = "/Users/u/.cache/chrome-devtools-mcp/test-profile"


def table(*rows):
    """rows: (pid, ppid, command)."""
    return {pid: cl.Proc(pid, ppid, cmd) for pid, ppid, cmd in rows}


# A realistic tree: iTerm owns two Claude sessions. Each runs its own
# chrome-devtools MCP server, which launched a test-profile Chrome with a
# helper. The user's own Chrome runs separately under launchd.
TREE = table(
    (1, 0, "launchd"),
    (100, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
    # session A: the one ending
    (200, 100, "-zsh"),
    (210, 200, "claude"),
    # publish-prep: allow portability — a fake hook command line, matching what a global install runs
    (220, 210, "/bin/sh -c ~/.claude/skills/browser-test-assist/scripts/chrome-test-profile-cleanup.py"),
    (221, 220, "python3 chrome-test-profile-cleanup.py"),
    (230, 210, f"npm exec chrome-devtools-mcp@1.10.1 --userDataDir={PROFILE}"),
    (231, 230, f"node chrome-devtools-mcp --userDataDir={PROFILE}"),
    (232, 231, f"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir={PROFILE}"),
    (233, 232, "Google Chrome Helper (Renderer) --type=renderer"),
    (240, 210, "node some-other-mcp"),
    # session B: still live, must be left alone
    (300, 100, "-zsh"),
    (310, 300, "claude"),
    (330, 310, f"npm exec chrome-devtools-mcp@1.10.1 --userDataDir={PROFILE}"),
    (332, 330, f"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir={PROFILE}"),
    # leftovers from a session that crashed: reparented to launchd
    (400, 1, f"node chrome-devtools-mcp --userDataDir={PROFILE}"),
    (410, 1, f"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir={PROFILE}"),
    (411, 410, "Google Chrome Helper (GPU) --type=gpu-process"),
    # the user's own Chrome (also the claude-in-chrome extension browser)
    (500, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    (501, 500, "Google Chrome Helper (Renderer) --type=renderer"),
)


class SelectTest(unittest.TestCase):
    def test_finds_the_ending_sessions_claude(self):
        self.assertEqual(cl.session_root(TREE, 221), 210)

    def test_no_claude_ancestor_means_no_session_targets(self):
        self.assertIsNone(cl.session_root(TREE, 100))

    def test_targets_this_sessions_server_and_its_chrome_tree(self):
        targets = cl.select(TREE, PROFILE, root=210, me=221)
        for pid in (230, 231, 232, 233):
            self.assertIn(pid, targets)

    def test_targets_orphans_left_by_a_crashed_session(self):
        targets = cl.select(TREE, PROFILE, root=210, me=221)
        for pid in (400, 410, 411):
            self.assertIn(pid, targets)

    def test_leaves_another_live_session_alone(self):
        targets = cl.select(TREE, PROFILE, root=210, me=221)
        for pid in (310, 330, 332):
            self.assertNotIn(pid, targets)

    def test_leaves_the_users_own_chrome_alone(self):
        targets = cl.select(TREE, PROFILE, root=210, me=221)
        self.assertNotIn(500, targets)
        self.assertNotIn(501, targets)

    def test_never_targets_itself_claude_or_unrelated_children(self):
        targets = cl.select(TREE, PROFILE, root=210, me=221)
        for pid in (210, 220, 221, 240, 1, 100):
            self.assertNotIn(pid, targets)

    def test_never_targets_its_own_shell_even_when_it_names_the_profile(self):
        # e.g. the hook is run as `CHROME_CLEANUP_PROFILE=<path> cleanup.py`
        t = dict(TREE)
        t[220] = cl.Proc(220, 210, f"/bin/sh -c CHROME_CLEANUP_PROFILE={PROFILE} cleanup.py")
        self.assertNotIn(220, cl.select(t, PROFILE, root=210, me=221))

    def test_without_a_root_only_orphans_are_targeted(self):
        targets = cl.select(TREE, PROFILE, root=None, me=221)
        self.assertEqual(targets, {400, 410, 411})

    def test_a_similar_but_different_profile_is_not_matched(self):
        t = table((1, 0, "launchd"),
                  (600, 1, f"Google Chrome --user-data-dir={PROFILE}-old"))
        self.assertEqual(cl.select(t, PROFILE, root=None, me=999), set())


class EndToEndTest(unittest.TestCase):
    """Runs the real script against a real orphaned process."""

    def test_kills_an_orphan_with_the_profile_and_spares_one_without(self):
        with tempfile.TemporaryDirectory() as d:
            profile = os.path.join(d, "test-profile")
            pids = {}
            for name, argv0 in (("hit", f"fake-chrome --user-data-dir={profile}"),
                                ("miss", "fake-chrome --user-data-dir=/elsewhere")):
                # Double fork so the sleeper is reparented to launchd (ppid 1).
                # Its stdio must not hold our pipe open, or run() waits 60 s.
                out = subprocess.run(
                    ["bash", "-c",
                     f"(exec -a '{argv0}' sleep 60 </dev/null >/dev/null 2>&1 & echo $!)"],
                    capture_output=True, text=True, check=True).stdout.strip()
                pids[name] = int(out)
            time.sleep(0.3)
            try:
                env = dict(os.environ, CHROME_CLEANUP_PROFILE=profile,
                           CHROME_CLEANUP_STATE=d)
                subprocess.run([sys.executable, os.path.join(
                    os.path.dirname(__file__), "chrome-test-profile-cleanup.py")],
                    env=env, check=True, timeout=20)
                time.sleep(0.3)
                self.assertFalse(alive(pids["hit"]), "orphan with the profile survived")
                self.assertTrue(alive(pids["miss"]), "unrelated process was killed")
            finally:
                for pid in pids.values():
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A killed child of launchd can linger as a zombie for a moment.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                           capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


if __name__ == "__main__":
    unittest.main()
