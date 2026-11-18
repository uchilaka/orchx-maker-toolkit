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

Everything else this skill mentions (a plans folder, a secret-injection tool, a skill
install task, review subagents) is **conditional**: include it only when it exists in
the user's setup, which you can see from the session, the repo's own docs, or
the instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`). Never tell the next
harness to use a tool that isn't there.

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
- Any plan or checkpoint file touched in this session, wherever the user's instruction
  files say plans live: its status and the next unchecked step IDs. Skip this if
  there is none.

Also note **machine side effects outside the repo** from this session: symlinks
created (`~/.local/bin/*`, `~/.claude/skills/*`), `~/.config/` files edited, or
dotfiles commits.

**Never include secret values** (API keys, tokens, or anything decrypted from a
credential store). Name only the file path, or the profile name if the user's setup
has a secret-injection tool.

### 3. Apply directional rules

Include only the delta that matters for `from -> to`:

- **`opencode -> claude-code`:**
  - Flag any checks or passes OpenCode could not run because Claude-only hooks, plugins,
    or named subagents were absent. Name the subagents only if the user's Claude setup
    defines them.
  - Note any OpenCode config changes made during the session (`opencode.jsonc`, and its
    `policies` or provider settings if they were touched) so Claude Code doesn't treat
    them as unexpected drift.
  - If the session symlinked skills or tools into a worktree, note that the links will
    dangle once the worktree is pruned and need re-pointing at the main checkout. Name
    the repo's own install task for this only if it has one.
- **`claude-code -> opencode`:**
  - Warn OpenCode explicitly what did **not** transfer: Claude `PreToolUse` /
    `SessionStart` hooks, `permissions.deny`, enabled plugins, and named Claude
    subagents (OpenCode exposes `general` and `explore` unless custom agents are
    configured).
  - State which instruction files govern the session: the repo's `CLAUDE.md` or
    `AGENTS.md`, plus any user-level file listed in `opencode.jsonc` `"instructions"`.
  - If the user's setup injects secrets through a tool, name that tool and its command
    form so OpenCode uses it instead of reading credential stores directly.
- **`* -> gemini`:**
  - Point to the repo's `GEMINI.md` (and `.gemini/skills/`, if present) as Gemini's
    source of truth; note that Claude hooks and OpenCode `policies` do not apply.
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
