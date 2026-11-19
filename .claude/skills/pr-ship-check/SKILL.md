---
name: pr-ship-check
description: After a PR's reviews have landed and every fix-now finding is addressed, decide whether it ships — and whether part of it should split out and ship ahead, or be simplified or separated first. Checks the fix-now gate from the ~/pr-reviews record and the PR's review threads, then gives high-confidence recommendations only, each with the files or commits and the evidence. Use when the user says "/pr-ship-check", "is this ready to ship", "can any of this ship ahead", "should I split this PR", "ship check", or at the end of /live-code-review or /pr-triage once their fix-now items are done. Not a review: it finds no new bugs (that's /pr-review or /live-code-review) and changes no code.
argument-hint: <pr-number>...
# Runs in its own subagent so the session that asked stays free (asked 2026-11-19).
# The subagent starts without the conversation, so callers pass PR numbers.
context: fork
agent: general-purpose
---

# /pr-ship-check — ship it, split it, or simplify it first

Runs once reviews are in and addressed. It answers three questions for each PR, with
evidence, and changes nothing:

1. **Can part of it ship ahead?** A commit or set of files that stands on its own.
2. **Is there a high-confidence separation-of-concerns or simplification change?**
3. **Is it ready to ship?** Ship / Ship after `<named step>` / Not ready.

"None found" is a full answer to the first two. A recommendation you can't back with
named files, commits and a check is a guess, so leave it out.

## Which PRs

**Check these PRs: $ARGUMENTS**

Those are the PR numbers or URLs this run was started with. Check every one of them.
Only if that line names no PR at all, check the current branch's PR instead.

This skill runs in its own subagent, which can't see the conversation that started it,
so whoever starts it (the user, `/live-code-review`, `/pr-triage`) passes the PR
numbers. Run everything below once per PR.

## What to hand back

The session that started this sees only your final message, so end with one short block
per PR: the verdict line, any spin-off or Step 4 item in one line each, the human-only
steps, and the record's path and the posted comment's URL. If the gate failed, give its
open items instead. If posting failed, say so and give the exact error.

## Step 1: The gate

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ship-data.cjs" <pr-number>
```

It prints JSON: the PR's state (`draft`, `mergeable`, `mergeState`, `ci`, `size`),
its `commits` with their files (merges listed without files), and `gate`. Exit codes:
`2` no open PR, `3` `gh`/`git` failure, `4` not a GitHub remote. Report those and
stop.

`gate.pass` is true only when:

- a review record for the PR exists in `~/pr-reviews/<project>/` (`*PR-<N>_*.md`);
- every fix-now item in it says `Fixed in <sha>`, and that commit is on the PR head;
- no unresolved review thread marked blocking (`(blocking)`, `🛑`, "blocker") is
  missing a reply from someone other than its author.

**If the gate fails, stop for that PR.** List `gate.openFixNow` (with each `reason`)
and `gate.openBlockingThreads`, and say which skill closes them (`/pr-triage` for
threads). Don't analyse a PR with open fix-now work: the answer would be stale.

If `gate.fixNowItems` is `0` but a record exists, read the record. The script only
recognises two formats: `**Triage**: Fix now` lines and table rows whose outcome says
`Fix in PR` / `Fixed in <sha>`. If the record has fix-now items in another shape, treat
the gate as failed and say so.

## Step 2: Read the change

`gh pr diff <n>`, the commit list from Step 1, and the PR body. For a large PR, read
commit by commit (`git show <sha>`) rather than the whole diff at once. Read the
review records too, so you don't repeat what they already raised.

## Step 3: Spin-offs

A part can ship ahead only if all of these hold. Check each; don't assume:

- **Independent:** nothing else in the PR imports, calls, configures or tests it.
  `grep` for its new names across the rest of the diff.
- **Useful alone:** it fixes or improves something on its own (a CI fix, a refactor,
  a docs or config change, a shared helper with an existing caller).
- **Passes alone.** Prove it before recommending it:

  ```bash
  git worktree add -q "$TMPDIR/ship-check-<n>" origin/<base>
  git -C "$TMPDIR/ship-check-<n>" cherry-pick <sha>...   # or check out just those files
  # run the repo's test task there (e.g. mise run test), then:
  git worktree remove --force "$TMPDIR/ship-check-<n>"
  ```

  Report the command and its result. If it fails or conflicts, it isn't a spin-off.

Merge commits never move. A spin-off is named by its commits or files, plus a
one-line PR title.

## Step 4: Separation of concerns and simplification

Keep these two apart, as the global rules require: an **architectural** concern (a
module doing two jobs, a dependency in the wrong direction, a layer bypassed) is a
different category from a **simplification** (duplicated logic, dead code, a
hand-rolled helper the codebase already has).

Only high-confidence items: the file and line, what to change, and why it's better.
Skip anything already in a review record, and anything that's a matter of taste.

## Step 5: The verdict

| Verdict | When |
|---|---|
| **Ship** | Gate passes, required CI is green (`SKIPPED` bot checks don't count), `mergeState` is `CLEAN`, and nothing from Steps 3–4 should land first |
| **Ship after `<step>`** | One named, small thing stands between it and merging: mark it ready (it's a draft), rebase or merge the base (`BEHIND`/`DIRTY`), wait for a running check, or land a spin-off first |
| **Not ready** | CI fails, the gate fails, or a Step 4 item is big enough that it should change before merge |

Also say, without judging it, what only a human can do: tick the PR template's "I've
read every line" boxes, or approve.

Size alone doesn't block shipping. If the PR is well past ~400 changed lines and has a
clean split, say so in Step 3; if it has no clean split, say that too.

## Step 6: Save, then post

Save to `~/pr-reviews/<project>/<prefix>_ship-check.md`, using the same
`<JIRA>_PR-<N>` prefix as the review record. Sections: Verdict (one line, then the
evidence), Gate, Spin-offs, Separation of concerns, Simplification, Human-only steps.
Each empty section says "None found".

Posting follows the same rule as `/live-code-review`:

- **The user's own PR** (`ownWork: true` in the JSON): post it as one PR comment by
  default, without asking: `gh pr comment <n> --body-file <file>`. Never hard-wrap
  the body: one line per paragraph.
- **Anyone else's PR:** show the comment and ask once whether to post it.

End the post with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Chained from other skills

`/live-code-review` and `/pr-triage` end by running this skill once their own fix-now
work is done. Run Step 1 first as always: if the gate fails there, report what's still
open and stop.

## Never

- Change code, push, merge, mark a PR ready, approve, or resolve threads. This skill
  recommends; the user acts.
- Recommend a spin-off you didn't prove with Step 3's check.
- Re-raise review findings as new ones.
