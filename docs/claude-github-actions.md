# Claude GitHub Actions

Two workflows connect this repo to Claude via [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action). Both authenticate with the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.

| Workflow | File | Runs when |
| --- | --- | --- |
| Claude Code Review | `.github/workflows/claude-code-review.yml` | A PR conversation comment contains `@claude review` |
| Claude Code | `.github/workflows/claude.yml` | Any other `@claude` mention in an issue, PR comment, or review |

## Requesting a review

Code review is **on demand only**. Opening or pushing to a PR does not start one. To ask for a review, post a comment on the PR's conversation tab:

```text
@claude review
```

The review posts its findings as inline comments on the PR.

The review job only runs when all three of these hold:

1. The comment is on a pull request, not an issue.
2. The comment body contains `@claude review`. The match is case-insensitive and a substring match, so `@Claude Review` works and `@claude reviewer` also matches.
3. The commenter is an `OWNER`, `MEMBER`, or `COLLABORATOR`, so drive-by commenters can't spend the token.

An `@claude review` comment on a PR is excluded from `claude.yml`, so one comment starts exactly one run. An inline review comment (on a line of the diff) that says `@claude review` goes to the general `claude.yml` assistant, not to the review workflow.

## Gotchas

- **Changes only take effect from `main`.** GitHub always runs `issue_comment` workflows from the default branch's copy of the file. Edits to either workflow on a feature branch cannot be tested by commenting on that branch's PR. They apply after merge.
- **No `paths:` filter.** `issue_comment` events carry no file list, so the `paths:` option that `pull_request` triggers support is not available. To skip reviews based on changed files, check them in a job step (e.g. `gh pr diff --name-only`) instead.
- **Use `github.event.issue`, not `github.event.pull_request`.** On `issue_comment` the PR arrives as `github.event.issue`. `github.event.issue.pull_request` is only set when the comment is on a PR, which is how the workflow tells PRs from issues. The PR number is `github.event.issue.number`.

## Customizing

### Filter by PR author

To restrict reviews to certain PR authors, AND an extra clause onto the job's `if:` in `claude-code-review.yml`. There is a commented-out copy in the workflow file. `issue.user` is the PR author, and `comment.user` is the person who asked for the review:

```yaml
if: |
  github.event.issue.pull_request &&
  contains(github.event.comment.body, '@claude review') &&
  contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
  (github.event.issue.user.login == 'external-contributor' ||
   github.event.issue.user.login == 'new-developer' ||
   github.event.issue.author_association == 'FIRST_TIME_CONTRIBUTOR')
```

### Change the trigger phrase

Update the phrase in **both** workflows, the `contains(...)` in `claude-code-review.yml` and the exclusion in `claude.yml`, or a single comment will start two runs.
