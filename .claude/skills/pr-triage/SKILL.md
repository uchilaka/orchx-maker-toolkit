---
name: pr-triage
description: Triage, verify and remediate incoming review comments on a PR — then reply per thread and resolve what was decisively addressed. Use when the user says "/pr-triage", "address the review comments", "handle the PR feedback", "drain the threads", or pastes a PR/discussion URL asking to deal with it. Also runs as the comment stage of the after-push workflow. Distinct from /pr-review (which AUTHORS a review and never posts) — this one consumes other people's reviews and does post replies. Also distinct from /pr-comment-triage, which never changes code and only routes each comment to a Notion plan, a Linear ticket or a question for the user — use that one when the feedback needs scoping beyond this PR rather than fixing in it.
---

# /pr-triage — drain a PR's review threads

Consumes reviews other people left. The counterpart to `/pr-review`, which authors one and
never posts.

```
fetch ──▶ verify ──▶ classify ──▶ act ──▶ reply ──▶ resolve or leave open
           │                       │
           └── inconclusive ───────┴── stop condition ──▶ hand back
```

## Verify before you act. Always.

**This is the rule the whole skill exists to enforce.** Acting on an unverified finding has
cost real damage twice: duplicated work already applied on another PR, and a host-check
security bypass introduced while "addressing feedback."

For each thread, reproduce or refute the claim with a command whose output you can paste.
Then classify:

| Verdict | Means | Action |
| ------- | ----- | ------ |
| **VALID** | Reproduced. The failure is real. | Fix, unless a stop condition fires |
| **ALREADY-FIXED** | Real once; a later commit addressed it | Reply citing the SHA, resolve |
| **INVALID** | Does not reproduce, and you can show why | Reply with the evidence. Do **not** fix |
| **OUT-OF-SCOPE** | Real, but not this PR's job | Linear ticket + inline TODO, reply with the ID |

**Show the classification table before changing anything.** A finding you cannot classify
with evidence is inconclusive — that is a stop condition, not a reason to guess.

Never fix an INVALID finding to be agreeable. A defensive change that works around a
non-existent failure is code the next engineer has to reverse-engineer.

## Bot and human reviewers get identical treatment

One pipeline, one standard of proof. A bot can be right and a human wrong; encoding a
trust prior by author would be a bias that ages badly as bots improve.

The register differs only because the *reader* differs — see Replies below.

## What it may do unattended

- **Post a reply** on each thread, attributed as Claude on the user's behalf.
- **Apply, commit and push** a fix for a VALID finding, and cite the SHA in the reply.
- **Resolve a thread it decisively addressed.** Decisively means: the fix is pushed and
  verified, or the finding is INVALID with reproduction output in the reply.

**Leave the thread open otherwise** — including any thread where you asked the reviewer a
question. Resolving a thread you are still waiting on closes a conversation someone else
was having.

## Stop and hand back when

Any one of these, even mid-run. Report what is done, what is pending, and why you stopped.

1. **Verification is inconclusive.** You can neither reproduce nor refute it.
2. **The fix touches auth, security, or migrations.** Query scoping, authorization,
   secrets, or anything that must be safe on a live table. Draft the fix, do not push it.
3. **The finding implies a design decision** — a choice between valid approaches rather
   than a correction. Ask the reviewer which they meant; that is usually the real answer.
4. **A human replied to Claude's reply.** Stop rather than arguing autonomously in public
   on someone's behalf.

## Working the threads

1. **Fetch all threads, resolved state included**, via the GraphQL `reviewThreads` query —
   the REST comments endpoint does not carry resolution state.
2. **Cluster by root cause before acting.** Five comments about one bad assumption are one
   fix and one explanation, repeated as five short replies that point at the same commit.
   Fixing them one at a time produces five divergent fixes.
3. **Order: cheapest verification first.** A doc typo is settled in seconds; a claimed race
   condition is not. Front-loading the cheap ones means a stop condition later still leaves
   most of the PR drained.
4. **One commit per root cause, not per thread.** Reference the threads it closes.

## Replies

Per thread, never only to the review summary. Each reply carries:

- the verdict, stated plainly in the first line
- the **evidence** — the command and its actual output, not a description of it
- the fixing SHA, or the Linear ID, or the reason there is no change

Register comes from `/pro-voice`. Two axes apply here:

- **A human's thread** is *other × peer*: curious, assume a constraint you cannot see.
  "Curious about X — did you consider…" leaves room for the answer to be *because of
  something you don't know*, which is frequently true.
- **A bot's thread** is still evidence-first but terser. There is no relationship to
  maintain and no constraint it is holding back.

Always leave the door open on an INVALID: name what would change your mind. "Happy to be
wrong if you're seeing this on a different Ruby — the version you reproduced on would
settle it."

End every posted reply with the attribution line:

```
—
Posted by Claude on Uche's behalf.
```

## Deferrals

OUT-OF-SCOPE findings become a Linear issue plus an inline `# TODO(LAR-123): <summary>`
at the flagged location, using the file's comment syntax. A deferred finding that lives
only in a PR comment rots the moment the PR merges.

Link each ticket to the PR, its thread and a per-PR parent ticket following
`${CLAUDE_SKILL_DIR}/references/deferred-tickets.md`. Read it before filing the first ticket.

## Never

- Post a review, or a top-level PR comment. This skill replies **within** existing threads.
- Resolve a thread you did not address, or one awaiting a human answer.
- Force-push, or rewrite a pushed commit, while a review is open — it invalidates the
  threads anchored to those lines.
