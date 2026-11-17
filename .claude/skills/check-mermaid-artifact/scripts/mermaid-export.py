#!/usr/bin/env python3
"""Export mermaid diagrams to JPEG for destinations that can't render mermaid.

Usage:
  mermaid-export.py <file.mmd | file.md> [--out DIR]

A .mmd file becomes <stem>.jpg. A markdown file gives one <stem>-diagram-N.jpg per
```mermaid fence, numbered in document order. Output goes beside the source unless
--out is given. Prints one output path per line.

All-or-nothing: every diagram renders into a temp dir first and only moves into place
once all of them succeed, so a syntax error never leaves a partial set behind.

Rendering uses mermaid-cli (pinned, via npx) driving the local Google Chrome, so
puppeteer never downloads its own browser. mermaid-cli has no JPEG output, so it writes
a PNG on a white background (JPEG has no transparency) and macOS `sips` converts it.
Set MERMAID_CHROME to use a different browser binary.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MMDC = "@mermaid-js/mermaid-cli@11.17.1"
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FENCE = re.compile(r"^```mermaid[^\n]*\n(.*?)^```", re.MULTILINE | re.DOTALL)


def extract_blocks(markdown):
    return FENCE.findall(markdown)


def render(source, png, workdir):
    chrome = os.environ.get("MERMAID_CHROME", DEFAULT_CHROME)
    config = os.path.join(workdir, "puppeteer.json")
    with open(config, "w") as f:
        json.dump({"executablePath": chrome}, f)
    mmd = png[: -len(".png")] + ".mmd"
    with open(mmd, "w") as f:
        f.write(source)
    env = {**os.environ, "PUPPETEER_SKIP_DOWNLOAD": "1"}
    subprocess.run(
        ["npx", "-y", MMDC, "-i", mmd, "-o", png, "-s", "2", "-b", "white", "-p", config, "-q"],
        check=True, env=env, capture_output=True, text=True,
    )


def to_jpeg(png, jpg):
    subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90", png, "--out", jpg],
        check=True, capture_output=True, text=True,
    )


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("source")
    p.add_argument("--out")
    args = p.parse_args(argv)

    src = os.path.abspath(args.source)
    stem, ext = os.path.splitext(os.path.basename(src))
    outdir = os.path.abspath(args.out) if args.out else os.path.dirname(src)
    with open(src) as f:
        text = f.read()

    if ext == ".mmd":
        jobs = [(text, f"{stem}.jpg")]
    else:
        blocks = extract_blocks(text)
        if not blocks:
            print(f"mermaid-export: no mermaid fences in {src}", file=sys.stderr)
            return 1
        jobs = [(b, f"{stem}-diagram-{i}.jpg") for i, b in enumerate(blocks, 1)]

    with tempfile.TemporaryDirectory() as work:
        for i, (source, name) in enumerate(jobs):
            png = os.path.join(work, f"d{i}.png")
            try:
                render(source, png, work)
            except subprocess.CalledProcessError as e:
                print(f"mermaid-export: {name} failed to render:\n{e.stderr.strip()}", file=sys.stderr)
                return 2
            to_jpeg(png, os.path.join(work, name))
        os.makedirs(outdir, exist_ok=True)
        outputs = []
        for _source, name in jobs:
            dest = os.path.join(outdir, name)
            shutil.move(os.path.join(work, name), dest)
            outputs.append(dest)

    print("\n".join(outputs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
