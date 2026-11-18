---
name: check-mermaid-artifact
description: Check a markdown artifact's diagrams before it is written anywhere — flag ASCII diagrams that should be mermaid, and export mermaid to PNG for any third-party destination not verified to render it (Linear, Jira, Notion, Google Docs, Slack, email). Use when the user says "/check-mermaid-artifact", "check the diagrams", "export the mermaid", "mermaid to png", "mermaid to image", or before posting a plan, spec, ticket or doc containing diagrams to an outside platform. Not for drawing new diagrams.
---

# /check-mermaid-artifact — diagrams that survive the trip

Two rules this enforces:

1. **Diagrams are mermaid, never ASCII**, in any markdown file. ASCII is only for replies
   in the terminal.
2. **A mermaid diagram bound for a third-party document is exported to PNG**, unless that
   target is listed in `${CLAUDE_SKILL_DIR}/verified-targets.txt` as rendering mermaid
   natively. Local files keep the fence alone.

## Steps

1. **Check.** Run:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/check-artifact.py" <file.md> --target <name>
   ```

   Omit `--target` for a local file. Exit 0 means nothing to do. Exit 1 means one of:
   - `ascii-diagram: line L` → redraw that block as a mermaid fence, then re-run.
   - `target: NAME (unverified): export N diagram(s)` → go to step 2.

2. **Export** (unverified targets only):

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/mermaid-export.py" <file.md> --out <dir>
   ```

   It prints one PNG path per diagram (`<stem>-diagram-N.png`, in document order). It
   writes all of them or none, so a syntax error leaves no partial set. It needs `npx`
   (fetches `@mermaid-js/mermaid-cli`, pinned) and Google Chrome; set `MERMAID_CHROME`
   to use another browser binary.

3. **Publish.** Upload each PNG through the destination's own upload path (for Linear,
   `prepare_file_upload`) and embed it where the fence was. Keep the mermaid source
   beside each image in a collapsible section, so the diagram stays editable.

## Verifying a new target

Post one diagram to the target through the same path the agent uses (API, MCP or CLI),
look at it rendered, then add a dated line to `verified-targets.txt`. Never add a target
on documentation alone.

## Tests

```bash
python3 "${CLAUDE_SKILL_DIR}/test/test_check_artifact.py"
python3 "${CLAUDE_SKILL_DIR}/test/test_mermaid_export.py"
MERMAID_RENDER_TESTS=1 python3 "${CLAUDE_SKILL_DIR}/test/test_mermaid_export.py"  # real render, downloads via npx
```
