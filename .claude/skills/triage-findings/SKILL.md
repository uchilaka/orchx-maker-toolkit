---
name: triage-findings
description: Triage the findings in a saved ~/pr-reviews review doc — the review-triage agent recommends fix now / defer / dismiss for each, then on the user's own work in progress the verified fix-now findings are applied and committed one per fix, and on anyone else's PR the user decides in one batch. The shared last step of /pr-review and /live-code-review. Use when the user says "/triage-findings", "triage these findings", "triage the review", or hands over a ~/pr-reviews doc to act on. Not a review itself (that's /pr-review or /live-code-review), and not for comments other people left on a PR (that's /pr-triage).
argument-hint: <review-doc-path> [pr-number]
---

# /triage-findings

Turns a saved review into decisions, and on the user's own work in progress, into commits. It's the one copy of the triage logic: `/pr-review` and `/live-code-review` both end by calling it, and it can be run by hand on any doc in `~/pr-reviews/`.

It never pushes, never posts to the PR, and never files a ticket without the user's go-ahead. Posting stays with `/live-code-review`.

## Inputs

- **Review doc**: usually a path under `~/pr-reviews/<project>/`, but any review doc in the same format works. When called by a review skill, it's the doc that skill just saved. Run by hand with no path, list the five newest docs for the current repo's `<project>` and ask which one.
- **PR context**: number, author, title and body. A calling skill passes what it already fetched. Otherwise the number is the argument if one was given, else the one in the doc's `PR` row (a URL ending in the number). If both exist and disagree, stop and ask. Fetch the rest with `gh pr view <n> --json number,author,title,body,headRefName` (GitLab: `glab mr view <n> -F json`). A doc whose `PR` row (`PR/MR` in `/live-code-review` docs) is `branch-only` has no PR.

Every finding is a line in the doc's `## Findings` that starts with a stoplight emoji. Praise (🎉 / `:tada:`) is never triaged.

## Step 1: Recommend

Send every non-praise finding, with its location, severity and description, plus the PR context, to the `review-triage` agent. It returns fix now / defer / dismiss and a reason for each. It recommends; it doesn't decide.

If the doc already has **Triage** lines (a re-run), skip findings that already carry `Fixed in <sha>`, a ticket, or a dismissal, and say how many were skipped.

## Step 2: Decide the mode

The mode is **own WIP** when the work is the user's:

- **With a PR**: the PR's author equals `gh api user -q .login` (GitLab: `glab api user`, `.username`). Draft or ready doesn't matter.
- **Without a PR**: the doc's branch is checked out, and every commit on it since the default branch (`git log <default>..HEAD --format=%ae`) is authored by `git config user.email`.

Anything else is **teammate** mode, including authorship you can't establish. Say which mode you chose and why in one line, then follow its path.

## Step 3 (teammate): one batch decision

First verify every fix-now finding as in 4a, without applying anything. Then present every finding in one batch, grouped by category, each with its stoplight emoji, review-triage's recommendation and reason, and the 4a verdict with its code quote for fix-now findings. Let the user answer in prose ("agree on 1 and 3, fix 2 too, drop 4") and turn that into fix now / defer / dismiss per finding. Ask if anything is unclear rather than guessing. Nothing is applied before the user answers.

This batch is the user's only decision point. Then carry out the answer as Step 5 describes, without asking again. Fixes the user approves are applied as in 4b. They skip 4c, because the user has already seen and decided on each one.

## Step 4 (own WIP): fix-now without asking

Work through the findings review-triage marked **fix now**. Don't stop for confirmation anywhere in this step.

### 4a. Verify

Read the current code at each finding's location and classify it:

| Verdict | Meaning | Action |
|---|---|---|
| VALID | The problem is in the current code | Apply (4b), unless carved out (4c) |
| ALREADY-FIXED | The code no longer has it | Report it with the line that shows it's gone |
| INVALID | The finding is wrong about the code | Report it with the evidence |
| OUT-OF-SCOPE | Real, but not something this branch introduced or should change | Move it to the batch in Step 5 as a defer candidate |

Print the table, with a quote of the code behind each verdict, then keep going.

### 4b. Apply, validate, commit

For each VALID finding, one at a time. When one finding's test depends on another's fix, apply the fix first.

1. Re-read the finding's location. If an earlier fix in this run already fixed it, don't make an empty commit: mark it ALREADY-FIXED and write ` — Fixed in \`<sha>\`` with the earlier fix's SHA. Otherwise make the smallest edit that fixes it.
2. Validate with the repo's own checks: the test and lint commands its `CLAUDE.md` names, otherwise its `mise` tasks (`mise tasks`), otherwise its `package.json` scripts or `Makefile`. Run the narrowest set that covers the touched files when the repo supports it. If that set already fails at `HEAD`, before your edit, the fix can't be validated: restore the file, hold the finding for Step 5 with the failing output, and don't count it as an attempt.
3. If it passes, commit that fix alone, staging only the files it touched. Follow the repo's commit-message convention and name the finding and the review doc in the body. Then write the finding's **Triage** line straight away (format in Step 6), ending in ` — Fixed in \`<sha>\``. `/pr-ship-check` gates on exactly that text. Every other Triage line waits for Step 6.
4. If it fails, try again. After 3 failed attempts, restore the touched files to `HEAD` (`git restore <files>`), mark the finding's **Triage** line `needs attention — <what was tried, what failed>`, and move on to the next finding.

If the repo has no test or lint command you can find, don't commit unvalidated: hold the finding for Step 5 and say why.

### 4c. Architectural carve-out

Hold a VALID finding for Step 5, without applying it, when its fix would:

- change a public interface (an exported function's signature, an API route or payload, a CLI flag, a skill's arguments),
- change a schema or add a migration,
- touch more than 3 files, or
- change how something other code depends on behaves (it now throws, returns something different, or has different side effects) when you can't establish that nothing outside this repo is affected.

The last item turns on who can reach the code:

- **Every caller is in this repo**, and grep finds them all: the impact is knowable, so apply the fix. Name any caller the change leaves unhandled (a new throw nobody catches) in the Step 5 batch as a follow-up.
- **It can be reached from outside the repo**: it's exported from a published package (a `package.json` without `"private": true`, a gem, a published crate), or it's a CLI flag, an HTTP API, or a skill's arguments. Hold it.
- **You can't tell**, for example a dynamic `require`, a symbol looked up by name, or a package other apps in a monorepo use: hold it, and say in the batch what you searched and what you couldn't rule out.

Security findings aren't carved out for size: apply them even when they touch more than 3 files. They are held when they'd change behavior someone outside the repo depends on, and then they lead the batch, marked as security. Silently breaking a library's users is its own risk.

## Step 5: The user's batch

In teammate mode, Step 3 was the batch: go straight to carrying out the answer below. In own-WIP mode, put everything that still needs a decision to the user in one message:

- **Defer** and **dismiss** recommendations,
- carved-out fixes (4c) and findings held for lack of a validator,
- OUT-OF-SCOPE findings from 4a,
- and in own-WIP mode, a one-line summary of what was committed, ALREADY-FIXED and INVALID, with the SHAs.

Then carry out the answer:

- **Fix now** (a held fix the user approves, or a teammate-mode fix): apply, validate and commit as in 4b.
- **Defer**: only after the user approves the list, file each as a Linear issue with the `linear` MCP tools (`mcp__linear__save_issue`). If the team isn't obvious from project memory or `~/CLAUDE.md`, ask in the same batch message, not as a separate question. Name the PR by its full URL in the body, never a bare `#N`. With no PR, name the branch and the review doc's path instead. When two or more are deferred, put them under one parent ticket for the PR, following `~/.claude/guides/deferred-tickets.md`. Add an inline `TODO(<ISSUE-ID>): <summary>` at each location, in the file's comment syntax, and commit those TODOs together.
- **Dismiss**: no change; record the reason.

## Step 6: Write back

Every triaged finding in the doc ends up with a **Triage** line under it, in the format `references/review-template.md` in `/live-code-review` uses:

```markdown
- 🔴 **<title>** — <file:line> — <description>
  - **Triage**: Fix now — <reason> — Fixed in `<sha>`
```

A deferred finding also gets a `**Ticket**: [<ISSUE-ID>](<url>)` line under its Triage line. Add or update the doc's `## Deferred / Ticketed` and `## Dismissed` tables the same way. The reason on a Triage line is the final one: when the user overrode review-triage, record the user's reason.

## Step 7: Hand back

Report, outcome first: commits made (SHA and finding), what's held or needs attention, tickets filed. Then:

- Called by `/live-code-review`: return to its posting step, and don't run `/pr-ship-check`. It runs that itself after posting.
- Otherwise, if every fix-now finding carries `Fixed in <sha>` and there's a PR: run `/pr-ship-check <number>`.
- Otherwise name what's still open.

Nothing is pushed. Say so, and leave pushing to the user.
