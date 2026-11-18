"""Find the fenced code blocks in a markdown file.

Shared by check-artifact.py and mermaid-export.py, so the check and the export always
agree on how many diagrams a file holds. If they disagreed, the check could report N
diagrams to export while the export wrote a different number, and an agent would embed
the images in the wrong places or get stuck.

Follows CommonMark's fence rules: backtick or tilde fences of three or more, closed by
a bare fence of the same character that is at least as long, so a ```mermaid example
inside a ````markdown block stays an example. An unclosed fence runs to the end of the
file. One deliberate departure: an opening fence may be indented any amount, not only
0-3 spaces. CommonMark measures indent from the enclosing list item, which this doesn't
track, and a mermaid fence nested two lists deep sits at six spaces or more. Missing a
diagram means it ships unexported, so this errs toward finding one.
"""

import re
from typing import NamedTuple

OPEN = re.compile(r"^(?P<indent> *)(?P<fence>`{3,}|~{3,})(?P<info>.*)$")


class Fence(NamedTuple):
    lang: str  # first word of the info string, lowercased; "" when there is none
    body: str  # content lines, with the opening fence's indent removed
    line: int  # 1-based line number of the opening fence


def fences(text):
    lines = text.splitlines()
    found = []
    i = 0
    while i < len(lines):
        m = OPEN.match(lines[i])
        # A backtick fence's info string can't contain a backtick (that's inline code).
        if not m or (m["fence"][0] == "`" and "`" in m["info"]):
            i += 1
            continue
        char, size, indent = m["fence"][0], len(m["fence"]), len(m["indent"])
        close = re.compile(rf"^ *{re.escape(char)}{{{size},}}[ \t]*$")
        body = []
        j = i + 1
        while j < len(lines) and not close.match(lines[j]):
            body.append(_dedent(lines[j], indent) + "\n")
            j += 1
        info = m["info"].split()
        found.append(Fence(info[0].lower() if info else "", "".join(body), i + 1))
        i = j + 1
    return found


def mermaid_blocks(text):
    return [f.body for f in fences(text) if f.lang == "mermaid"]


def _dedent(line, indent):
    stripped = len(line) - len(line.lstrip(" "))
    return line[min(stripped, indent):]
