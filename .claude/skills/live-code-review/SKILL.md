---
name: live-code-review
description: Run a comprehensive, multi-agent code review on a PR/MR once it's genuinely ready to ship — fans out to dedicated security, correctness, simplification, and test-coverage sub-agents in parallel, then a triage agent weighs each finding against shipping speed vs. risk before the user does final collaborative triage. Deferred findings become Linear tickets with linked inline TODOs, and fix-now/deferred findings are posted to the PR/MR as line-anchored comments — by default on the user's own work in progress, on anyone else's only after the user says yes. The "heavy" counterpart to /pr-review — ALWAYS wait for an explicit request (e.g. "/live-code-review", "run the full review", "comprehensive review before I merge", "do the deep review on this PR"). Never auto-invoke mid-task, and never guess between this and /pr-review — if the phrasing could mean either, ask which one before doing anything.
---

# Live Code Review

A comprehensive, multi-lens review for a PR/MR that's genuinely ready to ship. It exists alongside `/pr-review` (the quick, single-pass version) rather than replacing it — reach for this one when the user wants the full treatment: parallel specialized sub-agents, a triage pass that weighs velocity against risk, Linear tickets for anything deliberately deferred rather than silently dropped, and real line-anchored comments posted back to the PR/MR so teammates see the same findings without having to open a separate doc.

**This is an intentional exception to the usual "never post PR reviews to the PR" convention** (`/pr-review` still never posts). Only fix-now and deferred findings get posted here — dismissed findings and praise stay local-only. On the user's own work in progress they post by default; on anyone else's PR, nothing goes out until the user has seen exactly what will be posted and said yes (Step 7).

The word "live" in the name is load-bearing: this review only ever starts because the user explicitly asked for it, right now. Never trigger it as a side effect of other work, and never assume which review depth the user wants — ask if it's unclear.

## Trigger

Only start when the user explicitly asks for this — via `/live-code-review` or unambiguous phrasing like "run the full/comprehensive/deep review," "do a live code review," or "review this PR before I merge, the whole thing." If someone just says "review this" or "check my PR" with no signal about depth, and both skills are plausible, ask which they want rather than picking one.

## Inputs

Accepts one of:
- A PR/MR number
- Nothing (defaults to the open PR/MR on the current branch)
- If no PR/MR exists yet, offer to review the local branch diff vs. base instead

## Sub-agent roster

| Lens | Agent | Status |
|------|-------|--------|
| Security | `security-reviewer` | existing, used as-is |
| Simplification & maintainability | `code-simplifier` | existing, invoked in **report-only mode** (see Step 3) |
| Correctness & logic bugs | `correctness-reviewer` | new, dedicated to this workflow |
| Test coverage & quality | `test-coverage-reviewer` | new, dedicated to this workflow |
| Triage | `review-triage` | new, runs after the four above report |

## Workflow

### Step 0: Resolve target and fetch the diff

Run `scripts/fetch-pr-context.sh [number]`. It auto-detects GitHub vs. GitLab from the `origin` remote and shells out to `gh` or `glab` accordingly. Handle its exit codes:

- **0** — metadata + diff printed to stdout, proceed.
- **2** — no open PR/MR found. Ask the user whether to review the local branch diff instead (`git diff <base>...HEAD`); if so, there's no PR/MR metadata (URL, ticket-from-body) to attach later.
- **3** — required CLI (`gh`/`glab`) missing or unauthenticated. Tell the user which one and stop — don't try to work around it with raw API calls.
- **4** — no `origin` remote, or its host isn't recognizable as GitHub/GitLab. Ask the user whether to review the local branch diff instead, same as the no-PR-found case — this comes up for scratch repos, forks with unusual remote names, or self-hosted GitLab instances the URL match doesn't catch.

### Step 1: Load context

Read the repo-root `CLAUDE.md` and any `CLAUDE.md` files in directories the diff touches — sub-agents review against team conventions, not just the raw diff. Extract a Jira-style ticket ID from the branch name or PR/MR body (pattern like `[A-Z]+-\d+`) for the file-naming convention later.

### Step 2: Confirm scope only if genuinely ambiguous

This mode is always "deep" and always self-review — skip `/pr-review`'s perspective/depth interview. Only stop to ask if the diff itself is ambiguous (e.g. it visibly bundles unrelated concerns and it's unclear whether to review all of it, or there are multiple open PRs on this branch).

### Step 3: Fan out to the four review sub-agents — in parallel

Dispatch all four in a single message so they run concurrently, each given the diff + loaded CLAUDE.md context:

1. `security-reviewer` — no changes needed to how it's normally invoked.
2. `code-simplifier` — **override its default behavior explicitly in the dispatch prompt**: tell it this is a review-only pass, it must not use Edit/Write or otherwise modify files, and instead of applying refinements it should return the same structured-findings format the other lenses use (location, description, suggested simplification, rationale). Its native instructions default to editing directly, so this override is load-bearing — if you notice it edited files anyway despite the instruction, flag that to the user as a skill misfire, don't just silently accept the edits into the review.
3. `correctness-reviewer` — scoped to the diff.
4. `test-coverage-reviewer` — scoped to the diff.

Collect all findings into one aggregated list before moving on.

### Step 4: Triage pass

Send the full aggregated findings list, plus PR/MR context (title, description, anything about timeline pressure the user has mentioned), to `review-triage`. It returns a recommendation (fix now / defer / dismiss) and reasoning per finding — it does not decide, it informs the next step.

### Step 5: Collaborative triage with the user

Present the full findings list in one batch — grouped by category (Security / Bugs & Correctness / Simplification & Maintainability / Testing) per `references/review-template.md`, each with its stoplight emoji and the triage agent's recommendation + reasoning. Let the user respond in prose (e.g. "agree on 1 and 3, but let's fix 2 now too, and drop 4 — that's not actually a problem here") rather than forcing a per-finding Q&A — this is a batch decision, not an interrogation. Parse their response into a final decision per finding: **fix now**, **defer (ticket)**, or **dismiss**. If anything's unclear from their reply, ask before proceeding rather than guessing.

### Step 6: Execute the decisions

- **Fix now**: apply the edit directly. Follow the user's existing commit-cadence convention — commit once the fix is validated, referencing the review in the message. Then append " — Fixed in `<sha>`" to that finding's **Triage** line in the review doc, since `/pr-ship-check`'s gate reads exactly that.
- **Defer**: create a Linear issue via the `linear-server` MCP tools. If the Linear team/project for this repo isn't already obvious (check project memory first), ask once. Link it to the PR and, when two or more findings are deferred, a per-PR parent ticket following `~/.claude/guides/deferred-tickets.md` — read it before filing the first ticket. After the issue exists, insert an inline comment at the flagged location pointing to it — `// TODO(LINEAR-123): <short summary>`, using whatever comment syntax matches the file (`#` for Ruby/YAML/shell, `//` for JS/TS, etc.).
- **Dismiss**: no code change — just record the reasoning in the review doc so it's not silently lost.

### Step 7: Post to the PR/MR — by default on my own WIP, otherwise only when asked

Skip this step entirely if there's no PR/MR (branch-only review) — there's nothing to post to.

1. **Build the comment set**: take only the **fix-now** and **deferred** findings (never dismissed items or praise — those stay local-only, keeping the PR thread focused on things that actually need attention).
2. **Split by whether the finding's location is inside the diff**: a line-anchored review comment can only attach to a line that's actually part of the diff. For each finding, check whether its `file:line` falls within the diff hunks you already fetched.
   - **In the diff** → becomes a line comment: `path`, `line`, and a body combining the stoplight emoji, the finding, and the triage outcome (`Fix now — <what was done>` or `Deferred — see LINEAR-123`).
   - **Not in the diff** (e.g. a pre-existing bug on a touched line, or something structural) → fold it into the overall review summary body instead of forcing a line comment onto a line the PR didn't actually change.
3. **Decide whether to post** (rule set 2026-11-19), based on who authored the PR/MR. Compare its author with the authenticated user: `gh pr view <n> --json author -q .author.login` against `gh api user -q .login` (GitLab: `glab mr view <n> -F json` `.author.username` against `glab api user` `.username`).
   - **My own work in progress** (I authored it): post by default, without asking. Still show the finalized comment list (findings, bodies, inline vs. summary) in the final report, with the review's link.
   - **Anyone else's PR/MR, or authorship unclear**: once the review is complete, show the exact finalized comment list and ask one question: post it as PR comments, or keep it local? Post only on an explicit yes for this review. Earlier enthusiasm in the conversation is not a yes.
4. **Post it**: write the finalized list to a payload JSON (see the shape documented at the top of `scripts/post-review-comments.sh`) and run:
   ```
   scripts/post-review-comments.sh <github|gitlab> <owner/repo-or-project-path> <number> <payload.json>
   ```
   For GitHub this posts one review with all line comments atomically. For GitLab, it posts the summary as a top-level note first, then one discussion per line comment (GitLab has no batch-review endpoint, so partial failure is possible — if a discussion POST fails partway through, tell the user which ones landed and which didn't rather than silently retrying).
5. If the CLI reports a failure (e.g. a line genuinely isn't diff-eligible despite your check, auth issues), surface the exact error — don't retry blindly or fall back to guessing a different line.

### Step 8: Save the review

Follow `references/review-template.md` exactly for format and file naming (`~/pr-reviews/<project>/<JIRA>_PR-<NUMBER>_<slug>.md`, with the same fallbacks as `/pr-review` when there's no ticket or no PR). This local doc is the durable record regardless of whether Step 7 ran — note in it whether PR comments were posted and how many.

### Step 9: Offer to browse

After saving, offer to open the review with `/browse`, same as `/pr-review` does.

### Step 10: Ship check

If there's a PR/MR and every fix-now finding now carries `Fixed in <sha>`, run `/pr-ship-check <number>`. It re-checks that gate itself, along with the PR's blocking threads, and says whether the PR ships, splits or simplifies first. If any fix-now finding is still open, skip this step and name what's left.
