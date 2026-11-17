"""Tests for scripts/check-artifact.py. Run: python3 test/test_check_artifact.py

Runs the real script as a subprocess, against real files and the real verified-targets
list, so the exit codes and output are exactly what the skill sees.
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "check-artifact.py")

MERMAID = "```mermaid\nflowchart LR\n  A --> B\n```\n"
ASCII_BOX = "```text\nlaptop ──push──► NAS\n  └─ spool ─────► Garage\n```\n"
ASCII_PLAIN = "```\n+-------+     +-----+\n| spool | --> | NAS |\n+-------+     +-----+\n```\n"
# Two diagram-looking lines, so only the language filter keeps this from being flagged.
SHELL = "```sh\necho 'spool --> NAS'\nprintf '+---- done ----+\\n'\n```\n"


def check(text, *args, targets=None):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "doc.md")
        with open(path, "w") as f:
            f.write(text)
        env = dict(os.environ)
        if targets is not None:
            tpath = os.path.join(d, "targets.txt")
            with open(tpath, "w") as f:
                f.write(targets)
            env["MERMAID_VERIFIED_TARGETS"] = tpath
        return subprocess.run([sys.executable, SCRIPT, path, *args], capture_output=True, text=True, env=env)


class AsciiDiagrams(unittest.TestCase):
    def test_a_box_drawing_diagram_in_a_text_fence_is_flagged(self):
        r = check("# Doc\n\n" + ASCII_BOX)
        self.assertEqual(r.returncode, 1)
        self.assertIn("ascii-diagram: line 3", r.stdout)

    def test_a_plus_and_pipe_diagram_in_a_bare_fence_is_flagged(self):
        r = check(ASCII_PLAIN)
        self.assertEqual(r.returncode, 1)
        self.assertIn("ascii-diagram: line 1", r.stdout)

    def test_a_shell_fence_with_arrows_and_pipes_is_not_a_diagram(self):
        r = check(SHELL)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("ascii-diagram", r.stdout)

    def test_a_mermaid_only_doc_with_no_target_is_clean(self):
        r = check(MERMAID)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("mermaid: 1", r.stdout)


class Targets(unittest.TestCase):
    LIST = "# name  verified  note\ngithub  2026-11-17  PR bodies\n"

    def test_an_unverified_target_needs_export(self):
        r = check(MERMAID + MERMAID, "--target", "linear", targets=self.LIST)
        self.assertEqual(r.returncode, 1)
        self.assertIn("target: linear (unverified): export 2 diagram(s)", r.stdout)

    def test_a_verified_target_keeps_the_fence(self):
        r = check(MERMAID, "--target", "GitHub", targets=self.LIST)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("target: github (verified 2026-11-17): keep mermaid fences", r.stdout)

    def test_an_unverified_target_with_no_diagrams_needs_nothing(self):
        r = check("# just prose\n", "--target", "linear", targets=self.LIST)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_the_shipped_list_verifies_github_only(self):
        self.assertEqual(check(MERMAID, "--target", "github").returncode, 0)
        self.assertEqual(check(MERMAID, "--target", "notion").returncode, 1)


if __name__ == "__main__":
    unittest.main()
