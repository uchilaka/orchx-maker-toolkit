#!/usr/bin/env python3
"""Check a markdown artifact's diagrams before it leaves the machine.

Usage:
  check-artifact.py <file.md> [--target NAME]

Reports:
  mermaid: N                     mermaid fences found
  ascii-diagram: line L          a fenced ASCII diagram that should be mermaid
  target: NAME (...): ...        whether NAME renders mermaid natively (keep the fences)
                                 or not (export each diagram with mermaid-export.py)

Exit 0 when nothing needs doing, 1 when something does.

A target counts as verified only if it's listed in verified-targets.txt beside this
script (override with MERMAID_VERIFIED_TARGETS). Add one only after seeing a diagram
render there through the same path the agent writes to.
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TARGETS = os.path.join(HERE, "..", "verified-targets.txt")

FENCE = re.compile(r"^```([^\n`]*)\n(.*?)^```", re.MULTILINE | re.DOTALL)
# Only fences with no language or a plain-text one can hold an ASCII diagram. Code
# fences (sh, python...) are full of arrows and pipes that aren't diagrams.
PLAIN_LANGS = {"", "text", "txt", "plain", "ascii", "plaintext"}
# Box-drawing and arrow glyphs, or ASCII boxes/arrows. Two or more such lines make a
# diagram, so a stray "->" in prose-like text doesn't.
DIAGRAM_LINE = re.compile(r"[─-╿←-⇿▶►]|-->|<--|\+-{2,}")


def load_targets(path):
    targets = {}
    with open(path) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                name, date, *_ = line.split()
                targets[name.lower()] = date
    return targets


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("source")
    p.add_argument("--target")
    args = p.parse_args(argv)

    with open(args.source) as f:
        text = f.read()

    mermaid, ascii_lines = 0, []
    for m in FENCE.finditer(text):
        lang = m.group(1).strip().split(" ")[0].lower()
        if lang == "mermaid":
            mermaid += 1
        elif lang in PLAIN_LANGS:
            if sum(bool(DIAGRAM_LINE.search(l)) for l in m.group(2).splitlines()) >= 2:
                ascii_lines.append(text.count("\n", 0, m.start()) + 1)

    action = bool(ascii_lines)
    print(f"mermaid: {mermaid}")
    for line in ascii_lines:
        print(f"ascii-diagram: line {line} (redraw as mermaid)")

    if args.target:
        name = args.target.lower()
        targets = load_targets(os.environ.get("MERMAID_VERIFIED_TARGETS", DEFAULT_TARGETS))
        if name in targets:
            print(f"target: {name} (verified {targets[name]}): keep mermaid fences")
        elif mermaid:
            print(f"target: {name} (unverified): export {mermaid} diagram(s) with mermaid-export.py")
            action = True
        else:
            print(f"target: {name} (unverified): no diagrams to export")

    return 1 if action else 0


if __name__ == "__main__":
    sys.exit(main())
