# Live Code Review — template & conventions

This mirrors `/pr-review`'s stoplight-emoji system and file-save conventions so both skills produce consistent, comparable review docs — extended with a triage/ticketing layer since `/live-code-review` closes the loop on deferred work instead of leaving it as an unlinked comment.

## Stoplight legend (same as `/pr-review`)

| Emoji | Meaning |
|-------|---------|
| 🔴 | Blocker — must fix before merge |
| ⚠️ | Improvement — should fix, not necessarily in this PR |
| 🟢 | Nitpick — style preference, take it or leave it |
| ❓ | Question — need clarification to review properly |
| 🎉 | Praise — good pattern, clever solution, nice cleanup |

## Findings categories

Map each sub-agent's output to one category. Skip categories with no findings.

1. **Security** — from `security-reviewer`
2. **Bugs & Correctness** — from `correctness-reviewer`
3. **Simplification & Maintainability** — from `code-simplifier` (report-only pass)
4. **Testing** — from `test-coverage-reviewer`

If a sub-agent surfaces something that doesn't fit its home category (e.g. security agent notices a test gap), file it under the category it actually belongs to, not the agent it came from.

## File naming & location

Same convention as `/pr-review`:

```
~/pr-reviews/<project>/<JIRA-TICKET>_PR-<NUMBER>_<short-slug>.md
```

- No Jira ticket found → omit that segment: `PR-1290_donor-committee-mapping.md`
- No PR/MR exists yet (branch-only review) → `<JIRA-TICKET>_branch-review_<slug>.md`
- `<project>` is the repo directory name.

This doc is the durable local record. Only fix-now and deferred findings are posted to the PR/MR, as SKILL.md Step 6 describes.

## Review file format

```markdown
# Live Code Review: <title or slug>

| Field        | Value |
|--------------|-------|
| PR/MR        | <URL or "branch-only"> |
| Branch       | <branch name> |
| Jira         | <ticket or "—"> |
| Date         | <YYYY-MM-DD> |
| Reviewers    | security-reviewer, code-simplifier, correctness-reviewer, test-coverage-reviewer |
| PR comments  | <"Pending" (until Step 7) / "Not posted (branch-only review)" / "Not posted (user declined)" / "Posted: N line comments + summary"> |

## Summary

<2-3 sentence overview: what the PR/MR does, overall assessment>

## Findings

### <Category Name>

- 🔴 **<short title>** — <file:line> — <description>
  - **Triage**: Fix now — <one-line rationale from review-triage, confirmed/overridden by user> — Fixed in `<sha>` (append once the fix is committed; `/pr-ship-check` reads it)
- ⚠️ **<short title>** — <file:line> — <description>
  - **Triage**: Deferred — <one-line rationale>
  - **Ticket**: [LINEAR-123](<url>)

## Deferred / Ticketed

| Finding | Ticket | Location |
|---------|--------|----------|
| <short title> | [LINEAR-123](<url>) | <file:line> |

_(omit this section entirely if nothing was deferred)_

## Dismissed

| Finding | Reason |
|---------|--------|
| <short title> | <why this wasn't tracked or fixed> |

_(omit this section entirely if nothing was dismissed)_

## Verdict

<One of: Ship it / Ship with fixes / Needs work / Needs discussion>
```

## Notes on the Triage line

Every finding that survives to the saved doc should carry a **Triage** line showing the final decision (Fix now / Deferred / Dismissed) and a short rationale — this is the collaborative outcome between the user and the `review-triage` agent's recommendation, not the raw agent recommendation. If the user overrode the triage agent's suggestion, the rationale should reflect the user's actual reasoning, not the agent's original one.

## Notes on the PR comments field

This is the one place `/live-code-review` intentionally diverges from `/pr-review`'s "never post to the PR" rule — fix-now and deferred findings are posted as real line-anchored comments on the PR/MR itself: by default on the user's own work in progress, and on anyone else's only after the user confirms the finalized list (see SKILL.md Step 6). The local doc is still the durable record either way; this field just says whether a copy also went out to the PR/MR, and how many comments landed. Dismissed findings and praise never get posted, regardless of what this field says.
