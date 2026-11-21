---
name: pr-review
description: Review a pull request or branch diff and save structured feedback locally as markdown — never posts to GitHub. Interviews for perspective (self vs. teammate) and depth (quick scan vs. deep dive), spawns the security-reviewer agent when the diff touches a security surface, and saves to ~/pr-reviews/<project>/ using the <JIRA>_PR-<NUM>_<slug>.md convention, then ends with /triage-findings, which commits verified fix-now findings on the user's own work. Use when the user says "/pr-review", "review this PR", "review PR 123", "review my branch", or asks for a quick review pass. This is the lighter counterpart to /live-code-review — if the user's phrasing could mean either a quick pass or the full multi-agent review, ask which they want before starting.
---

# PR Review Skill

Review a pull request, save structured feedback locally, then triage it with `/triage-findings`. Never post to GitHub.

## Trigger

When the user says `/pr-review`, "review this PR", "review PR #123", or "review my branch".

## Inputs

Accepts one of:
- A PR number (e.g. `#1234` or `1234`)
- A branch name
- Nothing (defaults to the current branch)

## Workflow

### Step 1: Interview

Ask two quick questions before starting (skip any the user already answered):

1. **Perspective** — "Is this a self-review or a teammate's PR?"
   - **Self-review**: Use direct, concise language. No hedging. Point out issues plainly.
   - **Teammate review**: Use blameless, curious language. Frame issues as questions or observations. Assume good intent.

2. **Depth** — "Quick scan or deep dive?"
   - **Quick scan**: Review only the diff. Focus on obvious bugs, security, and style.
   - **Deep dive**: Also explore surrounding code — check callers of changed methods, verify test coverage, look at related files for consistency.

### Step 2: Gather the diff

```bash
# If PR number provided:
gh pr diff <number>
gh pr view <number> --json number,title,url,headRefName,body,author

# If current branch (no PR yet):
git diff main...HEAD
git log main...HEAD --oneline
```

Extract the ticket key from the branch name or PR body: any Jira- or Linear-style key matching `[A-Z]+-\d+`, such as `LAR-522`.

### Step 3: Security check

Automatically spawn the `security-reviewer` agent when the diff touches ANY of:
- Authentication or authorization code
- User input handling, form processing
- Database queries, migrations, or schema changes
- API endpoints, controllers, GraphQL mutations/queries
- File uploads or downloads
- Environment variables, secrets, credentials
- Middleware or request processing
- Data access patterns or scoping

Include the security agent's findings in the Security section of the review.

### Step 4: Review

Organize findings into these categories using stoplight emojis for severity:

| Emoji | Meaning |
|-------|---------|
| :red_circle: | Blocker — must fix before merge |
| :warning: | Improvement — should fix, not necessarily in this PR |
| :green_apple: | Nitpick — style preference, take it or leave it |
| :question: | Question — need clarification to review properly |
| :tada: | Praise — good pattern, clever solution, nice cleanup |

#### Review Categories

1. **Architecture** — Design decisions, separation of concerns, coupling, patterns
2. **Bugs & Correctness** — Logic errors, edge cases, race conditions, nil handling
3. **Security** — Auth, input validation, SQL injection, data exposure (merge security agent findings here)
4. **Performance** — N+1 queries, missing indexes, unnecessary allocations, slow patterns
5. **Testing** — Coverage gaps, fragile tests, missing edge cases, test quality
6. **Risks & Release** — Migration safety, backwards compatibility, deployment concerns, feature flag needs
7. **Accessibility** — Frontend changes only: screen reader support, keyboard nav, ARIA attributes
8. **Style** — Naming, formatting, idiomatic code, consistency with codebase conventions

Skip empty categories. Only include categories that have findings.

#### Tone adjustment

- **Self-review**: `"Missing index on actor_id — add it before merge."`
- **Teammate review**: `"Curious about the indexing strategy here — did you consider adding an index on actor_id? The query in line 42 filters on it."`

### Step 5: Save the review

Save to `~/pr-reviews/<project>/` using this naming convention:
```
<JIRA-TICKET>_PR-<NUMBER>_<short-slug>.md
```
Example: `LAR-522_PR-46_move-review-skills-into-repo.md`

If no ticket is found, omit that segment: `PR-46_move-review-skills-into-repo.md`
If no PR exists yet (branch-only review), use: `LAR-522_branch-review_<slug>.md`

#### Review file format

```markdown
# PR Review: <title or slug>

| Field        | Value |
|--------------|-------|
| PR           | <URL or "branch-only"> |
| Branch       | <branch name> |
| Jira         | <ticket or "—"> |
| Date         | <YYYY-MM-DD> |
| Perspective  | <self / teammate> |
| Depth        | <quick scan / deep dive> |

## Summary

<2-3 sentence overview: what the PR does, overall assessment>

## Findings

### <Category Name>

- <emoji> **<short title>** — <file:line> — <description>

## Verdict

<One of: Ship it / Ship with fixes / Needs work / Needs discussion>
```

### Step 6: Triage

Run `/triage-findings` on the saved doc, and pass it the PR context from Step 2 (number, author, title, body). For a branch-only review, pass the branch name instead; the doc's `PR` row already says `branch-only`. It decides own-WIP or teammate mode from authorship, not from the Step 1 perspective answer. On the user's own work it applies and commits the verified fix-now findings without asking, then puts everything else to the user in one batch. On anyone else's PR it asks first. It never posts to the PR, so this skill still never posts.

### Step 7: Offer to browse

Once triage has handed back, including the user's answer to its batch if it asked one, offer to open the review with `/browse`.
