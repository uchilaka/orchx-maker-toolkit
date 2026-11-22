---
name: pr-review
description: Review a pull request or branch diff and save structured feedback locally as markdown — never posts to GitHub. Interviews for perspective (self vs. teammate) and depth (quick scan vs. deep dive), spawns the security-reviewer agent when the diff touches a security surface, and saves to ~/pr-reviews/<project>/ using the <JIRA>_PR-<NUM>_<slug>.md convention. Use when the user says "/pr-review", "review this PR", "review PR 123", "review my branch", or asks for a quick review pass. This is the lighter counterpart to /live-code-review — if the user's phrasing could mean either a quick pass or the full multi-agent review, ask which they want before starting.
---

# PR Review Skill

Review a pull request and save structured feedback locally. Never post to GitHub.

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
gh pr view <number> --json number,title,url,headRefName,body

# If current branch (no PR yet):
git diff main...HEAD
git log main...HEAD --oneline
```

Extract the Jira ticket from the branch name or PR body (pattern: `COM-\d+`).

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
Example: `COM-1053_PR-1290_donor-committee-mapping.md`

If no Jira ticket is found, omit that segment: `PR-1290_donor-committee-mapping.md`
If no PR exists yet (branch-only review), use: `COM-1053_branch-review_<slug>.md`

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

### Step 6: Offer to browse

After saving, offer to open the review with `/browse`.

If the `/browse` skill does not exist yet, create it at `~/.claude/skills/browse/SKILL.md` using the spec at:
https://gist.github.com/uche-at-abt/d29c7d9a55a60a3558c8ca880da0ddf6#file-browse-md
