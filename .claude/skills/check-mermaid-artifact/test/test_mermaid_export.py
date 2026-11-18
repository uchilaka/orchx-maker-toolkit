"""Tests for scripts/mermaid-export.py. Run: python3 test/test_mermaid_export.py

Two layers:
- Pipeline tests run offline on any OS. They swap out `render` for one that writes a
  real PNG, so the naming, --out, all-or-nothing and error paths run for real.
- Invocation tests run the real `render` against a fake `npx` on PATH that records how
  it was called, so the mermaid-cli arguments, the environment and the error handling
  are checked offline too.
- Render tests call the real mermaid-cli through npx and the local Chrome. The first run
  downloads the CLI package, so they're opt-in: MERMAID_RENDER_TESTS=1.
"""

import contextlib
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from unittest import mock

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

    def test_an_indented_fence_is_extracted_without_its_indent(self):
        md = "1. Step\n\n   ```mermaid\n   flowchart LR\n     A --> B\n   ```\n"
        self.assertEqual(mermaid_export.extract_blocks(md), ["flowchart LR\n  A --> B\n"])

    def test_a_tilde_fence_is_extracted(self):
        self.assertEqual(mermaid_export.extract_blocks("~~~mermaid\nA\n~~~\n"), ["A\n"])


class AgreesWithTheCheck(unittest.TestCase):
    """The check says how many diagrams to export; the export must find exactly that many."""

    CORPUS = "\n".join([
        "```mermaid\nA\n```",
        "   ```Mermaid\n   B\n   ```",
        "~~~mermaid\nC\n~~~",
        "```mermaid\ttitle\nD\n```",
        "```mermaidjs\nnot a diagram\n```",
        "````markdown\n```mermaid\nexample\n```\n````",
        "```text\nunclosed\n```mermaid\nswallowed\n```",
    ]) + "\n"

    def test_both_scripts_count_the_same_fences(self):
        check = os.path.join(HERE, "..", "scripts", "check-artifact.py")
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(self.CORPUS)
        try:
            r = subprocess.run([sys.executable, check, f.name], capture_output=True, text=True)
        finally:
            os.unlink(f.name)
        blocks = mermaid_export.extract_blocks(self.CORPUS)
        self.assertEqual(blocks, ["A\n", "B\n", "C\n", "D\n"])
        self.assertEqual(r.stdout.splitlines()[0], f"mermaid: {len(blocks)}")


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
            raise mermaid_export.ExportError("Parse error on line 2")
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

    # TODO(LAR-463): also cover --out not created on failure, a failure on diagram 1, and
    # an existing PNG left untouched.
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


FAKE_NPX = """#!{python}
import json, os, sys, time
a = sys.argv[1:]
arg = lambda flag: a[a.index(flag) + 1]
source = open(arg("-i")).read()
with open(os.environ["FAKE_NPX_RECORD"], "a") as f:
    f.write(json.dumps({{
        "argv": a, "cwd": os.getcwd(), "config": json.load(open(arg("-p"))), "source": source,
        "skip_download": os.environ.get("PUPPETEER_SKIP_DOWNLOAD"),
        "ignore_scripts": os.environ.get("npm_config_ignore_scripts"),
    }}) + "\\n")
if "BROKEN" in source:
    sys.exit("Parse error on line 2")
if "SLOW" in source:
    time.sleep(10)
with open(arg("-o"), "wb") as out, open(os.environ["FAKE_PNG"], "rb") as png:
    out.write(png.read())
"""


def executable(path, text):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, 0o755)


class Invocation(unittest.TestCase):
    """The real `render`, against a fake npx that records how mermaid-cli was called."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.bin = os.path.join(self.dir, "bin")
        os.mkdir(self.bin)
        executable(os.path.join(self.bin, "npx"), FAKE_NPX.format(python=sys.executable))
        self.record = os.path.join(self.dir, "record.jsonl")
        png = os.path.join(self.dir, "fake.png")
        with open(png, "wb") as f:
            f.write(tiny_png())
        self.env = mock.patch.dict(os.environ, {
            "PATH": self.bin, "MERMAID_CHROME": "/x/chrome",
            "FAKE_NPX_RECORD": self.record, "FAKE_PNG": png,
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def export(self, text, *argv):
        src = os.path.join(self.dir, "plan.md")
        with open(src, "w") as f:
            f.write(text)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mermaid_export.main([src, *argv])
        return code, out.getvalue(), err.getvalue()

    def calls(self):
        with open(self.record) as f:
            return [json.loads(line) for line in f]

    def test_mermaid_cli_is_called_pinned_with_a_white_background_and_the_chosen_chrome(self):
        code, out, err = self.export("```mermaid\nA --> B\n```\n")
        self.assertEqual(code, 0, err)
        [call] = self.calls()
        argv = call["argv"]
        self.assertEqual(argv[:2], ["-y", mermaid_export.MMDC])
        self.assertRegex(mermaid_export.MMDC, r"^@mermaid-js/mermaid-cli@\d+\.\d+\.\d+$")
        self.assertEqual(argv[argv.index("-b") + 1], "white")
        self.assertEqual(argv[argv.index("-s") + 1], "2")
        self.assertEqual(call["config"], {"executablePath": "/x/chrome"})
        self.assertEqual(call["source"], "A --> B\n")
        self.assertEqual(call["skip_download"], "1")
        self.assertTrue(is_png(out.strip()))

    def test_npx_runs_in_the_private_work_dir_with_install_scripts_off(self):
        self.export("```mermaid\nA\n```\n")
        [call] = self.calls()
        config = call["argv"][call["argv"].index("-p") + 1]
        self.assertEqual(os.path.realpath(call["cwd"]), os.path.realpath(os.path.dirname(config)))
        self.assertNotEqual(os.path.realpath(call["cwd"]), os.path.realpath(os.getcwd()))
        self.assertEqual(call["ignore_scripts"], "true")

    def test_a_render_failure_exits_2_with_the_cli_error(self):
        code, out, err = self.export("```mermaid\nBROKEN\n```\n")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("plan-diagram-1.png failed to render", err)
        self.assertIn("Parse error on line 2", err)

    def test_missing_npx_exits_2_without_a_traceback(self):
        os.remove(os.path.join(self.bin, "npx"))
        code, _, err = self.export("```mermaid\nA\n```\n")
        self.assertEqual(code, 2)
        self.assertIn("npx", err)

    def test_a_hung_render_times_out_and_exits_2(self):
        with mock.patch.object(mermaid_export, "TIMEOUT", 1):
            code, _, err = self.export("```mermaid\nSLOW\n```\n")
        self.assertEqual(code, 2)
        self.assertIn("timed out", err)

    def test_an_unreadable_source_exits_2(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mermaid_export.main([os.path.join(self.dir, "missing.md")])
        self.assertEqual(code, 2)


class FindChrome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bin = self.tmp.name
        env = {k: v for k, v in os.environ.items() if k != "MERMAID_CHROME"}
        env["PATH"] = self.bin
        self.env = mock.patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.paths = mock.patch.object(mermaid_export, "CHROME_PATHS", ["/nonexistent/Google Chrome"])
        self.paths.start()

    def tearDown(self):
        self.paths.stop()
        self.env.stop()
        self.tmp.cleanup()

    def test_mermaid_chrome_wins(self):
        os.environ["MERMAID_CHROME"] = "/x/chrome"
        self.assertEqual(mermaid_export.find_chrome(), "/x/chrome")

    def test_a_chromium_on_path_is_used_when_the_macos_app_is_absent(self):
        chromium = os.path.join(self.bin, "chromium")
        executable(chromium, "#!/bin/sh\n")
        self.assertEqual(mermaid_export.find_chrome(), chromium)

    def test_no_browser_is_a_clear_error(self):
        with self.assertRaisesRegex(mermaid_export.ExportError, "MERMAID_CHROME"):
            mermaid_export.find_chrome()


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
