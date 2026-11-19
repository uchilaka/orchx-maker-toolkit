#!/usr/bin/env python3
"""Export mermaid diagrams to PNG for destinations that can't render mermaid.

Usage:
  mermaid-export.py <file.mmd | file.md> [--out DIR]

A .mmd file becomes <stem>.png. A markdown file gives one <stem>-diagram-N.png per
```mermaid fence, numbered in document order. Output goes beside the source unless
--out is given. Prints one output path per line.

All-or-nothing: every diagram renders into a temp dir first and only moves into place
once all of them succeed, so a syntax error never leaves a partial set behind.

Rendering uses mermaid-cli via npx (its own version is pinned; its dependencies are
not) driving a local Chrome, so puppeteer never downloads its own browser. The browser
is MERMAID_CHROME if set, else Google Chrome's macOS path, else the first of
google-chrome, google-chrome-stable, chromium or chromium-browser on PATH.

Exit 0 on success, 1 when a markdown file has no mermaid fences, 2 on an error.

PNG, not JPEG: every export target accepts PNG, mermaid-cli writes it directly, and it
keeps text and thin lines crisp where JPEG compression blurs them. JPEG would need a
platform-specific converter (macOS `sips`) for a worse image. The background is forced
white so dark text stays readable in a destination's dark mode.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fences import mermaid_blocks  # noqa: E402  (shared with check-artifact.py)

# TODO(LAR-462): this pins mermaid-cli only. Its mermaid and puppeteer dependencies
# float within their semver ranges; a lockfile would pin the whole tree.
MMDC = "@mermaid-js/mermaid-cli@11.17.1"
CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
# Seconds per diagram. The first run downloads mermaid-cli, so this is generous.
TIMEOUT = 180


class ExportError(Exception):
    pass


def extract_blocks(markdown):
    return mermaid_blocks(markdown)


def find_chrome():
    if os.environ.get("MERMAID_CHROME"):
        return os.environ["MERMAID_CHROME"]
    for path in CHROME_PATHS:
        if os.path.exists(path):
            return path
    for name in CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return found
    raise ExportError("no Chrome or Chromium found; set MERMAID_CHROME to a browser binary")


def render(source, png, workdir):
    config = os.path.join(workdir, "puppeteer.json")
    with open(config, "w") as f:
        json.dump({"executablePath": find_chrome()}, f)
    mmd = os.path.splitext(png)[0] + ".mmd"
    with open(mmd, "w") as f:
        f.write(source)
    # Install scripts are off: the browser is a local one, so nothing needs a
    # postinstall, and an unpinned transitive dependency can't run code at install.
    env = {**os.environ, "PUPPETEER_SKIP_DOWNLOAD": "1", "npm_config_ignore_scripts": "true"}
    try:
        # cwd is the private work dir, not the caller's. npm reads the current project's
        # .npmrc and prefers a matching package in its node_modules, so a checkout being
        # processed could otherwise pick the registry, or the mermaid-cli that runs.
        subprocess.run(
            ["npx", "-y", MMDC, "-i", mmd, "-o", png, "-s", "2", "-b", "white", "-p", config, "-q"],
            check=True, env=env, cwd=workdir, capture_output=True, text=True, timeout=TIMEOUT,
        )
    except FileNotFoundError:
        raise ExportError("npx not found; install Node.js") from None
    except subprocess.TimeoutExpired:
        raise ExportError(f"mermaid-cli timed out after {TIMEOUT}s") from None
    except subprocess.CalledProcessError as e:
        raise ExportError(e.stderr.strip() or f"mermaid-cli exited {e.returncode}") from None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("source")
    p.add_argument("--out")
    args = p.parse_args(argv)

    src = os.path.abspath(args.source)
    stem, ext = os.path.splitext(os.path.basename(src))
    outdir = os.path.abspath(args.out) if args.out else os.path.dirname(src)
    try:
        with open(src) as f:
            text = f.read()
    except OSError as e:
        print(f"mermaid-export: {e}", file=sys.stderr)
        return 2

    if ext == ".mmd":
        jobs = [(text, f"{stem}.png")]
    else:
        blocks = extract_blocks(text)
        if not blocks:
            print(f"mermaid-export: no mermaid fences in {src}", file=sys.stderr)
            return 1
        jobs = [(b, f"{stem}-diagram-{i}.png") for i, b in enumerate(blocks, 1)]

    with tempfile.TemporaryDirectory() as work:
        rendered = []
        for i, (source, name) in enumerate(jobs):
            png = os.path.join(work, f"d{i}.png")
            try:
                render(source, png, work)
            except ExportError as e:
                print(f"mermaid-export: {name} failed to render:\n{e}", file=sys.stderr)
                return 2
            rendered.append((png, name))
        os.makedirs(outdir, exist_ok=True)
        outputs = []
        for png, name in rendered:
            dest = os.path.join(outdir, name)
            shutil.move(png, dest)
            outputs.append(dest)

    print("\n".join(outputs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
