---
name: publish-prep
description: Check skills, agents and scripts before they're shared or released, then propose fixes as one batch for approval. Finds secrets and PII, machine-specific paths, frontmatter that won't trigger, and dependencies missing from a Requirements section. Use when the user says "/publish-prep", "prep this for publishing", "is this skill ready to share", "scrub this before I share it", or when /release reaches its publish-prep gate.
---

# Publish Prep

Gets a skill, agent or script ready for someone else's machine. A deterministic
checker finds the problems; you draft the fixes, the user approves them in one
batch, and you apply only what they approved.

## Requirements

- `node` 18 or later, to run the bundled checker.
- `gitleaks` (recommended). Without it, the checker falls back to a narrow set
  of token regexes and says so in its notes.
- Optional: a `.publish-prep.json` at the repo root listing what counts as
  personal for this repo (`internalDomains`, `personalPaths`,
  `personalConventions`, plus `assumedCommands` and `knownCommands` to quiet
  false positives).

## Workflow

### 1. Scope

- If the user named paths, check those.
- Otherwise check everything a release publishes: `.gemini/skills/*`, real
  (non-symlinked) `.claude/skills/*`, `.claude/agents/*.md` and
  `scripts/shareable/*`.

### 2. Run the checker

Run the included `scripts/publish_prep.cjs` (in this skill's directory) from the
root of the repo being prepared, with `--json`:

```bash
node <this-skill-dir>/scripts/publish_prep.cjs --json [<path>...]
```

In the toolkit repo itself, `mise run publish-prep -- --json` does the same.

- Exit `0`: nothing blocking. Exit `1`: at least one `high` finding. Exit `2`:
  usage error; show it and stop.
- Never re-derive findings by reading files yourself. The checker's output is the
  source of truth, so two runs give the same answer.

### 3. Report

Lead with the verdict: `BLOCKED (N high)` or `OK`. Then list open findings
grouped by item, most severe first. Each one gets severity, check, `file:line`
and the message. Separately, list the allowed findings with their reasons, and
pass on any `notes` (for example, gitleaks missing).

If there are no open findings, say so and stop.

### 4. Draft fixes

Draft a concrete edit for every open finding. Read the lines around each
`file:line` first, so the fix fits its context.

| Check | Draft |
| --- | --- |
| `secrets` | Replace with a placeholder (`<you@example.com>`, `<host>.<tailnet>.ts.net`). For a gitleaks hit, **never print the value**; say that the credential must be rotated if it was ever committed or shared. |
| `portability`, home path | `~`, `$HOME`, or a `<placeholder>` the reader fills in. |
| `portability`, personal convention | Make the location a setting the reader chooses, or phrase it as an example ("for example, a `plans/` folder of your choice"). |
| `portability`, unknown skill reference | Ship the referenced item too, declare it under Requirements, or drop the reference. Ask which, if it isn't obvious. |
| `frontmatter` | The exact replacement line, e.g. a description that names what it does and the phrases a user would type. |
| `dependencies` | Add the missing entries to the item's `## Requirements` section, creating the section if needed. A script outside a skill gets a `# Requires: …` header comment. Say what each env var holds. |

When a finding is deliberate (a doc example, an intentional platform path),
propose an allow comment instead of an edit, with the reason filled in:

```
<!-- publish-prep: allow portability — documents the macOS default path on purpose -->
```

Use `#` or `//` comment syntax in scripts. An allow with no reason is ignored.

### 5. One approval batch

Show every proposed change in **one** numbered list: the finding, then the diff
or allow comment. Ask the user once to choose, per number: **apply**, **allow**
(with the reason shown) or **skip**. "Apply all" and "apply all but 3, 5" are
fine answers.

**Apply nothing before the user answers.** No edits, and no "safe" fixes
applied ahead of the batch.

### 6. Apply and re-check

- Apply only the approved changes, keeping each file's line endings (LF).
- Re-run the checker the same way as step 2 and report before-and-after counts
  per severity.
- If any `high` finding remains, say plainly that the release gate is still
  blocked and name what's left.

## Rules

- Edit only files inside the items being checked. Never change
  `.publish-prep.json` without asking; widening what counts as "assumed" hides
  findings for every item.
- Never write a secret's value anywhere: not in the report, a diff, or a commit
  message.
- The checker is read-only by design. Don't add fixing logic to it; fixes stay
  here, where the user approves them.
