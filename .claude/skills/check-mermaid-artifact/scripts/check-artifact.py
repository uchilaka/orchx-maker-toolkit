#!/usr/bin/env python3
"""Check a markdown artifact's diagrams before it leaves the machine.

Usage:
  check-artifact.py <file.md> [--target NAME]

Reports:
  mermaid: N                     mermaid fences found
  ascii-diagram: line L          a fenced ASCII diagram that should be mermaid
  target: NAME (...): ...        whether NAME renders mermaid natively (keep the fences)
                                 or not (export each diagram with mermaid-export.py)

Exit 0 when nothing needs doing, 1 when something does, 2 on an error (an unreadable
file, or a malformed verified-targets line), so a crash is never read as work to do.

A target counts as verified only if it's listed in verified-targets.txt beside this
script (override with MERMAID_VERIFIED_TARGETS). Add one only after seeing a diagram
render there through the same path the agent writes to.
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fences import fences  # noqa: E402  (shared with mermaid-export.py)

DEFAULT_TARGETS = os.path.join(HERE, "..", "verified-targets.txt")

# Only fences with no language or a plain-text one can hold an ASCII diagram. Code
# fences (sh, python...) are full of arrows and pipes that aren't diagrams.
PLAIN_LANGS = {"", "text", "txt", "plain", "ascii", "plaintext"}
# Box-drawing and arrow glyphs, or ASCII boxes/arrows. Two or more such lines make a
# diagram, so a stray "->" in prose-like text doesn't.
# TODO(LAR-461): `tree` output (├── └──) in a bare fence is flagged as a diagram.
DIAGRAM_LINE = re.compile(r"[─-╿←-⇿▶►]|-->|<--|\+-{2,}")


def load_targets(path):
    targets = {}
    with open(path) as f:
        for n, line in enumerate(f, 1):
            fields = line.split("#", 1)[0].split()
            if not fields:
                continue
            if len(fields) < 2:
                raise ValueError(f"{path}:{n}: expected '<name> <verified-date>', got {line.strip()!r}")
            targets[fields[0].lower()] = fields[1]
    return targets


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("source")
    p.add_argument("--target")
    args = p.parse_args(argv)

    try:
        with open(args.source) as f:
            text = f.read()
        targets = None
        if args.target:
            targets = load_targets(os.environ.get("MERMAID_VERIFIED_TARGETS", DEFAULT_TARGETS))
    except (OSError, ValueError) as e:
        print(f"check-artifact: {e}", file=sys.stderr)
        return 2

    mermaid, ascii_fence_lines = 0, []
    for fence in fences(text):
        if fence.lang == "mermaid":
            mermaid += 1
        elif fence.lang in PLAIN_LANGS:
            if sum(bool(DIAGRAM_LINE.search(l)) for l in fence.body.splitlines()) >= 2:
                ascii_fence_lines.append(fence.line)

    needs_action = bool(ascii_fence_lines)
    print(f"mermaid: {mermaid}")
    for line in ascii_fence_lines:
        print(f"ascii-diagram: line {line} (redraw as mermaid)")

    if args.target:
        name = args.target.lower()
        if name in targets:
            print(f"target: {name} (verified {targets[name]}): keep mermaid fences")
        elif mermaid:
            print(f"target: {name} (unverified): export {mermaid} diagram(s) with mermaid-export.py")
            needs_action = True
        else:
            print(f"target: {name} (unverified): no diagrams to export")

    return 1 if needs_action else 0


if __name__ == "__main__":
    sys.exit(main())
