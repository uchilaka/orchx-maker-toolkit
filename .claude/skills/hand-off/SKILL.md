---
name: hand-off
description: Generate a copy-pasteable hand-off prompt for continuing work in another AI coding harness (or a fresh session of the same one), tailored to the source and target harnesses (OpenCode -> Claude Code, Claude Code -> OpenCode, either -> Gemini CLI, or same-harness reset). Gathers live git/worktree/PR state, active plan progress, machine side effects, and harness-specific gaps (hooks, subagents, policies, secrets). Use when the user says "/hand-off", "hand off to claude", "hand off to opencode", "write a hand-off prompt", "switching harnesses", or "hitting usage limits".
---

# /hand-off: directional session transfer

A hand-off prompt bridges two harnesses that share files on disk but **not**
conversation history, hooks, plugins, or subagent catalogs. Tailor what it says to
which harness is handing off (`from`) and which one is picking up (`to`).

## Requirements

- `git` (for repo, branch, worktree, and commit state).
- `gh` (optional, for open PR status).

## Steps

### 1. Determine direction (`from` -> `to`)

- **Detect `from`** from the running environment:
  - `OPENCODE_SESSION_ID` set -> `opencode`
  - `CLAUDECODE` set -> `claude-code`
  - Neither set -> infer from context or ask.
- **Identify `to`** from the user's request ("headed back to claude code", "moving to
  opencode", "fresh session", etc.). If unclear, ask one short question with the likely
  targets (`claude-code`, `opencode`, `gemini`, or `same-harness`).

### 2. Gather live state from disk (never guess)

Run a single read-only check in the working repo:

- `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short`
- `git worktree list` and `git log --oneline -5`
- Open PRs via `gh pr list --author @me --state open --json number,title,headRefName,isDraft`
  (skip silently if `gh` isn't available or unauthenticated)
- Any active project plan or checkpoint touched in this session (e.g. `docs/plans/`,
  `~/project-plans/<repo>/`, or a draft-PR note): its status and the next unchecked
  step IDs.

Also note **machine side effects outside the repo** from this session: symlinks
created (`~/.local/bin/*`, `~/.claude/skills/*`), `~/.config/` files edited, or
dotfiles commits.

**Never include secret values** (API keys, tokens, `sk-or-*`, or decrypted `pass-cli`
values). Name only file paths or `openv` profile names.

### 3. Apply directional rules

Include only the delta that matters for `from -> to`:

- **`opencode -> claude-code`:**
  - Flag any checks or passes OpenCode could not run because Claude-only hooks, plugins,
    or named subagents (`security-reviewer`, `correctness-reviewer`, etc.) were absent.
  - Note any `opencode.jsonc` / `policies` / OpenRouter changes made during the session
    so Claude Code doesn't treat them as unexpected drift.
  - Note any worktree-mounted skills (`SKILL_SOURCE_ROOT=$PWD mise run install:...`) that
    will need re-linking from `main` after merge.
- **`claude-code -> opencode`:**
  - Warn OpenCode explicitly what did **not** transfer: Claude `PreToolUse` /
    `SessionStart` hooks, `permissions.deny`, enabled plugins, and named Claude
    subagents (OpenCode exposes `general` and `explore` unless custom agents are
    configured).
  - State which rules govern the session (`CLAUDE.md`, `~/CLAUDE.md` if wired into
    `~/.config/opencode/opencode.jsonc` `"instructions"`).
  - Note safe secret handling (e.g. `openv run <env> -- ...` rather than reading
    credential stores or running `pass-cli item view`).
- **`* -> gemini`:**
  - Point to `GEMINI.md` and `.gemini/skills/` as Gemini's source of truth; note that
    Claude hooks and OpenCode `policies` do not apply.
- **Same-harness reset (`claude-code -> claude-code`, `opencode -> opencode`):**
  - Omit harness-gap notes; focus strictly on git/worktree state, test baseline,
    decisions made, and the exact next step.

### 4. Emit the prompt

Output a **single fenced `text` code block** ready to copy-paste into the target
harness, using this structure (omit empty sections):

```text
Hand-off from <from> to <to> in <repo-path> (<YYYY-MM-DD>).

State of the repo & PRs:
- <checkout / branch / clean or dirty status>
- <open PRs, worktrees, and merge/rebase order if branches conflict>

Completed & verified:
- <commits, tests/checks that passed, and key deviations from any plan>

Machine state outside the repo:
- <symlinks, ~/.config edits, dotfiles commits>

Harness notes (<from> -> <to>):
- <directional caveats from step 3>

Next:
1. <exact next action or tracker step>
```

Keep the prompt dense and factual: paths, commit SHAs, PR numbers, and test counts over
prose. If there is a blocking caveat (such as uncommitted work on `main`), add one
short line below the block; otherwise end with the block.
