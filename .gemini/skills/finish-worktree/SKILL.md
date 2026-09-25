---
name: finish-worktree
description: Exits a git worktree, prepares a draft PR from the diff, applies project PR templates, and outputs copy-pasteable markdown. Use when a task in a worktree is complete.
---

# Finish Git Worktree

Use this skill to finalize work in a git worktree and prepare a draft PR without using the GitHub CLI (`gh`).

## 1. Verify and Commit
- Ensure all relevant changes are committed in the worktree (`git status`).
- Review the diff against the base branch (`git diff main...HEAD`).

## 2. Format PR Markdown
- Look for the project's PR template (e.g., `.github/pull_request_template.md`).
- Generate the final PR content in Markdown format, filling out the template based on the diff and task context.
- **Show the full PR markdown content to the user** in a code block so they can copy/paste it into GitHub.
- **DO NOT** use `gh pr create` or any CLI integrations to post the PR directly.

## 3. Update Checkpoint Doc
- Overwrite the checkpoint doc at `~/.claude/projects/<project-key>/draft-prs/<jira-ticket>_<short-slug>.md` with the final PR content you just generated.
