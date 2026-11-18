"""Tests for scripts/check-artifact.py. Run: python3 test/test_check_artifact.py

Runs the real script as a subprocess, against real files and the real verified-targets
list, so the exit codes and output are exactly what the skill sees.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "check-artifact.py")

spec = importlib.util.spec_from_file_location("check_artifact", SCRIPT)
check_artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_artifact)

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
        # A developer's own override must not change what the shipped list says.
        env.pop("MERMAID_VERIFIED_TARGETS", None)
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

    def test_a_single_arrow_line_is_not_a_diagram(self):
        r = check("```text\nspool --> NAS\n```\n")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("ascii-diagram", r.stdout)

    def test_the_line_reported_is_the_fence_line_after_earlier_fences(self):
        r = check(MERMAID + "\nprose\n\n" + ASCII_PLAIN)
        # MERMAID is lines 1-4, then a blank line, "prose", a blank line: the fence is on 8.
        self.assertIn("ascii-diagram: line 8", r.stdout)

    def test_an_ascii_diagram_needs_redrawing_even_for_a_verified_target(self):
        r = check(ASCII_PLAIN, "--target", "github", targets="github 2026-11-17\n")
        self.assertEqual(r.returncode, 1)
        self.assertIn("ascii-diagram", r.stdout)

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
        # Verifying a target is a deliberate act: adding one must update this test.
        self.assertEqual(set(check_artifact.load_targets(check_artifact.DEFAULT_TARGETS)), {"github"})
        self.assertEqual(check(MERMAID, "--target", "github").returncode, 0)
        self.assertEqual(check(MERMAID, "--target", "notion").returncode, 1)

    def test_a_trailing_comment_on_a_target_line_is_ignored(self):
        r = check(MERMAID, "--target", "github", targets="github 2026-11-17  # PR bodies\n")
        self.assertEqual(r.returncode, 0, r.stdout)


class Fences(unittest.TestCase):
    """Every way a mermaid diagram can be written must be counted, or it ships unexported."""

    def count(self, text):
        r = check(text, "--target", "linear", targets="github 2026-11-17\n")
        return r.stdout.splitlines()[0]

    def test_a_fence_indented_under_a_list_item_counts(self):
        self.assertEqual(self.count("1. Step\n\n   ```mermaid\n   A --> B\n   ```\n"), "mermaid: 1")

    def test_a_deeply_nested_list_fence_counts(self):
        self.assertEqual(self.count("- a\n  - b\n\n      ```mermaid\n      A\n      ```\n"), "mermaid: 1")

    def test_a_tilde_fence_counts(self):
        self.assertEqual(self.count("~~~mermaid\nA --> B\n~~~\n"), "mermaid: 1")

    def test_the_language_is_case_insensitive_and_may_be_followed_by_a_tab(self):
        self.assertEqual(self.count("```Mermaid\nA\n```\n\n```mermaid\ttitle\nB\n```\n"), "mermaid: 2")

    def test_a_longer_language_word_is_not_mermaid(self):
        self.assertEqual(self.count("```mermaidjs\nA\n```\n"), "mermaid: 0")

    def test_a_mermaid_example_inside_a_longer_fence_is_not_a_diagram(self):
        self.assertEqual(self.count("````markdown\n```mermaid\nA\n```\n````\n"), "mermaid: 0")

    def test_a_backtick_line_with_a_language_does_not_close_a_fence(self):
        # CommonMark: the `text` fence runs on through ```mermaid to the bare ```.
        self.assertEqual(self.count("```text\nunclosed\n```mermaid\nA\n```\n"), "mermaid: 0")

    def test_only_a_fence_as_long_and_of_the_same_character_closes_one(self):
        self.assertEqual(self.count("````\n```\n````\n```mermaid\nA\n```\n"), "mermaid: 1")
        self.assertEqual(self.count("~~~\n```\n~~~\n```mermaid\nA\n```\n"), "mermaid: 1")

    def test_a_backtick_line_with_a_backtick_in_its_info_is_not_a_fence(self):
        # "```foo`bar" is inline code, so it mustn't open a fence that swallows the next one.
        self.assertEqual(self.count("```foo`bar\n```mermaid\nA\n```\n"), "mermaid: 1")

    def test_crlf_line_endings_are_handled(self):
        self.assertEqual(self.count("```mermaid\r\nA\r\n```\r\n"), "mermaid: 1")


class Errors(unittest.TestCase):
    """A crash must not exit 1, which the skill reads as "something to do"."""

    def test_a_target_line_with_no_date_is_an_error_naming_the_line(self):
        r = check(MERMAID, "--target", "github", targets="# header\nlinear\n")
        self.assertEqual(r.returncode, 2)
        self.assertIn(":2:", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_a_missing_source_file_is_an_error(self):
        r = subprocess.run([sys.executable, SCRIPT, "/nonexistent/doc.md"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertNotIn("Traceback", r.stderr)

    def test_a_missing_targets_file_is_an_error(self):
        env = {**os.environ, "MERMAID_VERIFIED_TARGETS": "/nonexistent/targets.txt"}
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(MERMAID)
        try:
            r = subprocess.run([sys.executable, SCRIPT, f.name, "--target", "linear"],
                               capture_output=True, text=True, env=env)
        finally:
            os.unlink(f.name)
        self.assertEqual(r.returncode, 2)
        self.assertNotIn("Traceback", r.stderr)


if __name__ == "__main__":
    unittest.main()
