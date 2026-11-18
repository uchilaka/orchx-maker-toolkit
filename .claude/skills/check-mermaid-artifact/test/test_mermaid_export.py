"""Tests for scripts/mermaid-export.py. Run: python3 test/test_mermaid_export.py

Two layers:
- Pipeline tests run offline on any OS. They swap out only the mermaid-cli call for one
  that writes a real PNG, so the naming, --out, all-or-nothing and error paths run for
  real.
- Render tests call the real mermaid-cli through npx and the local Chrome. The first run
  downloads the CLI package, so they're opt-in: MERMAID_RENDER_TESTS=1.
"""

import contextlib
import importlib.util
import io
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "mermaid-export.py")

spec = importlib.util.spec_from_file_location("mermaid_export", SCRIPT)
mermaid_export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mermaid_export)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
GOOD = "flowchart LR\n  A[Spool] -->|push| B[(Garage)]\n"


def run(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True)


def is_png(path):
    with open(path, "rb") as f:
        return f.read(8) == PNG_MAGIC


class ExtractBlocks(unittest.TestCase):
    def test_only_mermaid_fences_are_extracted_in_order(self):
        md = "# T\n\n```mermaid\nA\n```\n\n```sh\necho hi\n```\n\n```mermaid\nB\n```\n"
        self.assertEqual(mermaid_export.extract_blocks(md), ["A\n", "B\n"])

    def test_a_fence_with_attributes_after_the_language_still_counts(self):
        self.assertEqual(mermaid_export.extract_blocks("```mermaid title\nA\n```\n"), ["A\n"])

    def test_no_fences_gives_an_empty_list(self):
        self.assertEqual(mermaid_export.extract_blocks("plain text"), [])


def tiny_png():
    """A real 1x1 white PNG, standing in for what mermaid-cli writes."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\xff\xff")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


class Pipeline(unittest.TestCase):
    """Everything except mermaid-cli itself, which `fake_render` stands in for."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.rendered = []
        self.fail_on = None
        self.real_render = mermaid_export.render
        mermaid_export.render = self.fake_render

    def tearDown(self):
        mermaid_export.render = self.real_render
        self.tmp.cleanup()

    def fake_render(self, source, png, workdir):
        self.rendered.append(source)
        if self.fail_on is not None and self.fail_on in source:
            raise subprocess.CalledProcessError(1, "mmdc", stderr="Parse error on line 2")
        with open(png, "wb") as f:
            f.write(tiny_png())

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mermaid_export.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_an_mmd_file_is_rendered_whole_and_lands_beside_the_source(self):
        src = self.write("flow.mmd", GOOD)
        code, out, _ = self.main(src)
        self.assertEqual(code, 0)
        self.assertEqual(self.rendered, [GOOD])
        dest = os.path.join(self.dir, "flow.png")
        self.assertEqual(out.split(), [dest])
        self.assertTrue(is_png(dest))

    def test_markdown_renders_each_mermaid_fence_in_order_and_skips_other_fences(self):
        src = self.write("plan.md", "```mermaid\nA\n```\n\n```sh\nls\n```\n\n```mermaid\nB\n```\n")
        code, out, _ = self.main(src)
        self.assertEqual(code, 0)
        self.assertEqual(self.rendered, ["A\n", "B\n"])
        self.assertEqual(out.split(), [os.path.join(self.dir, f"plan-diagram-{i}.png") for i in (1, 2)])

    def test_out_creates_the_directory_and_writes_only_there(self):
        src = self.write("flow.mmd", GOOD)
        outdir = os.path.join(self.dir, "nested", "out")
        code, out, _ = self.main(src, "--out", outdir)
        self.assertEqual(code, 0)
        self.assertEqual(os.listdir(outdir), ["flow.png"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "flow.png")))

    def test_a_failure_on_a_later_diagram_writes_none_of_them(self):
        src = self.write("plan.md", "```mermaid\nA\n```\n\n```mermaid\nBROKEN\n```\n")
        self.fail_on = "BROKEN"
        code, out, err = self.main(src)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("plan-diagram-2.png failed to render", err)
        self.assertIn("Parse error on line 2", err)
        self.assertEqual(sorted(os.listdir(self.dir)), ["plan.md"])

    def test_markdown_without_mermaid_exits_1_and_renders_nothing(self):
        src = self.write("none.md", "```sh\nls\n```\n")
        code, _, err = self.main(src)
        self.assertEqual(code, 1)
        self.assertIn("no mermaid fences", err)
        self.assertEqual(self.rendered, [])


@unittest.skipUnless(os.environ.get("MERMAID_RENDER_TESTS") == "1",
                     "real mermaid-cli render; set MERMAID_RENDER_TESTS=1 (downloads via npx)")
class Render(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_an_mmd_file_becomes_one_png(self):
        src = self.write("flow.mmd", GOOD)
        r = run(src)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = os.path.join(self.dir, "flow.png")
        self.assertEqual(r.stdout.strip(), out)
        self.assertTrue(is_png(out))

    def test_a_markdown_file_gives_one_png_per_mermaid_fence(self):
        md = f"# Plan\n\n```mermaid\n{GOOD}```\n\n```sh\nls\n```\n\n```mermaid\n{GOOD}```\n"
        src = self.write("plan.md", md)
        outdir = os.path.join(self.dir, "out")
        r = run(src, "--out", outdir)
        self.assertEqual(r.returncode, 0, r.stderr)
        expected = [os.path.join(outdir, f"plan-diagram-{i}.png") for i in (1, 2)]
        self.assertEqual(r.stdout.split(), expected)
        self.assertTrue(all(is_png(p) for p in expected))
        self.assertEqual(sorted(os.listdir(outdir)), ["plan-diagram-1.png", "plan-diagram-2.png"])

    def test_invalid_mermaid_fails_and_leaves_no_png(self):
        src = self.write("bad.mmd", "flowchart LR\n  A -->\n")
        r = run(src)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "bad.png")))

    def test_markdown_without_mermaid_is_an_error(self):
        src = self.write("none.md", "# nothing to draw\n")
        r = run(src)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no mermaid", r.stderr)


if __name__ == "__main__":
    unittest.main()
