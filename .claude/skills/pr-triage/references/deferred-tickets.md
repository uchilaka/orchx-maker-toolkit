# Linking deferred tickets to the PR they came from

Shared rule for every skill that turns a review finding into a Linear ticket instead of
fixing it: `/live-code-review` (Defer), `/pr-triage` (OUT-OF-SCOPE) and
`/pr-comment-triage` (`ticket`). Each skill still owns *whether* to defer; this file owns
*how the ticket is linked*, so someone opening it months later can get back to the
review, the code and its siblings without searching.

Added 2026-10-12, after the four PR #15 deferrals (LAR-394..397) shipped with no parent
and had to be grouped by hand under LAR-402.

## Every deferred ticket

1. **Attach the PR.** Pass `links: [{url: <PR url>, title: "PR #<N>: <PR title>"}]` to
   `save_issue`. An attachment shows in Linear's sidebar and survives description edits; a
   URL buried in the body does neither.
2. **Attach the thread too**, when the finding came from a review comment: the comment's
   `html_url`, titled `Review thread: <path>:<line>` (or `Review comment` when it isn't
   line-anchored).
3. **Name the source in the first line of the body:**
   `Deferred from the <skill> of PR #<N> (<finding IDs>).` Then the ticket must stand
   alone: the problem, a concrete failure scenario, the file and line, the proposed fix,
   and acceptance criteria.
4. **Link the code back.** An inline `TODO(<ID>): <summary>` at the flagged location, in
   the file's comment syntax. The owning skill already requires this; it's listed so the
   loop is complete in one place.

## Grouping: one parent per PR

When a PR ends up with **two or more** deferred tickets, they go under one parent.

1. **Find an existing parent first.** Run `list_issues` with `query: "PR #<N>"` on the
   team, and keep only results whose attachments include this exact PR URL. PR numbers
   repeat across repos, so the URL match is the check, not the title.
   - A parent exists → use it.
   - No parent, but an earlier run filed one ungrouped ticket for this PR → create the
     parent and move that ticket under it too.
2. **Create the parent** with `save_issue`:
   - title `<repo> PR #<N> follow-ups: <PR title>`
   - the same PR attachment as the children
   - body: one line saying it groups the findings deferred from that PR's review, and
     closes when every sub-issue is done
   - state Backlog, no priority, and the children's team and project
3. **Set `parentId`** on every child, including any created earlier in the same run.

A single deferred ticket gets no parent. It's already linked by its PR attachment.

## Relations

Add `relatedTo` only when two tickets genuinely overlap: one's fix changes the other's
scope, or one references the other's acceptance criteria. Use `blocks`/`blockedBy` only
for a real ordering dependency. Don't link siblings to each other just for being siblings;
the parent already does that.

## Never

- **Reference a deferred ticket with a closing keyword** (`Fixes`, `Closes`, `Resolves`)
  in a PR body or commit message. GitHub's Linear integration closes the ticket when the
  PR merges, and deferred work is by definition not done. Use `Refs <ID>`.
- **Create a second parent** for a PR that already has one. Always search first (step 1
  above).

## Report back

In the skill's summary, list each ticket with its parent, e.g.
`LAR-395 (Medium) → parent LAR-402`, and say whether the parent was created or reused.
