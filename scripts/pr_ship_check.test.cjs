// /pr-ship-check's gate: fix-now items from a review record, and blocking threads.
// Run: node --test scripts/pr_ship_check.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFixNow, blockingUnanswered, gate } = require(path.join(
  __dirname, '..', '.claude', 'skills', 'pr-ship-check', 'scripts', 'ship-data.cjs'));

const LIVE_REVIEW = `# PR #12 review

### 🔴 SQL built by interpolation
- **Where**: app/models/user.rb:42
- **Triage**: Fix now — user input reaches the query — Fixed in \`abc1234\`

### 🟡 Missing index
- **Triage**: Fix now — new filter column

### 🟢 Rename helper
- **Triage**: Deferred — see LAR-9

Prose that says fix now, or Fixed in deadbeef, isn't an item.
`;

const TABLE_REVIEW = `| # | Finding | Outcome |
|---|---|---|
| 1 | Guard bypass | Fixed in d744d75: document as advisory |
| 2 | BASH_ENV | Fix in PR: scrub env |
| 3 | Same-named repos | Documented in d744d75; fix is plan S18 |
| 4 | Foreign symlink | Plan S7 |
`;

test('parseFixNow reads /live-code-review Triage lines, with or without a fixing commit', () => {
  const items = parseFixNow(LIVE_REVIEW);
  assert.deepEqual(items.map((i) => [i.format, i.sha]), [['triage', 'abc1234'], ['triage', null]]);
  assert.match(items[1].text, /new filter column/);
});

test('parseFixNow reads table rows whose outcome is Fix in PR or Fixed in <sha>, and nothing else', () => {
  const items = parseFixNow(TABLE_REVIEW);
  assert.deepEqual(items.map((i) => [i.format, i.sha]), [['table', 'd744d75'], ['table', null]]);
});

test('parseFixNow ignores prose, headings, deferred and dismissed lines', () => {
  assert.deepEqual(parseFixNow('## Fix now\n\nWe fix now and then.\n- **Triage**: Dismissed — noise\n'), []);
});

const thread = (resolved, ...comments) => ({ isResolved: resolved, comments: comments.map(([author, body]) => ({ author, body })) });

test('blockingUnanswered keeps only unresolved blocking threads nobody else has replied to', () => {
  const threads = [
    thread(false, ['rev', '🛑 **issue (blocking):** leaks the token']),                 // open
    thread(false, ['rev', 'issue (blocking): race'], ['me', 'Fixed in abc1234']),         // answered
    thread(true, ['rev', '🛑 issue (blocking): resolved one']),                            // resolved
    thread(false, ['rev', '💡 suggestion (non-blocking): rename']),                         // not blocking
    thread(false, ['rev', '🛑 issue (non-blocking): downgraded by its label']),              // not blocking
    thread(false, ['rev', 'nitpick: spacing']),                                            // not blocking
    thread(false, ['rev', 'This is a blocker for release'], ['rev', 'bump']),             // open: only its author
  ];
  assert.deepEqual(blockingUnanswered(threads).map((t) => t.comments[0].body), [
    '🛑 **issue (blocking):** leaks the token',
    'This is a blocker for release',
  ]);
});

test('gate passes only when every fix-now item cites a commit on the PR head and no blocking thread is open', () => {
  const onHead = (sha) => sha === 'abc1234';
  const items = parseFixNow(LIVE_REVIEW);
  const r = gate({ records: ['r.md'], items, onHead, threads: [] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.openFixNow.map((i) => i.reason), ['no fixing commit recorded']);

  const fixed = parseFixNow(LIVE_REVIEW.replace('new filter column', 'new filter column — Fixed in `abc1234`'));
  assert.equal(gate({ records: ['r.md'], items: fixed, onHead, threads: [] }).pass, true);

  const elsewhere = parseFixNow('- **Triage**: Fix now — x — Fixed in `fff9999`\n');
  assert.deepEqual(gate({ records: ['r.md'], items: elsewhere, onHead, threads: [] }).openFixNow.map((i) => i.reason),
    ['commit fff9999 is not on the PR head']);

  const blocked = gate({ records: ['r.md'], items: fixed, onHead, threads: [thread(false, ['rev', 'issue (blocking): x'])] });
  assert.equal(blocked.pass, false);
  assert.equal(blocked.openBlockingThreads.length, 1);
});

test('gate fails without a review record, since the skill runs after reviews land', () => {
  const r = gate({ records: [], items: [], onHead: () => true, threads: [] });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /no review record/);
});

// Regressions from the PR #37 review: each of these shapes fooled the gate.

test('parseFixNow counts a table row with Fix now in its triage column, even with an empty outcome (C1)', () => {
  const record = `| ID | Finding | Decision | Status |
|----|---------|----------|--------|
| S1 | x | Fix now | Done \`fd0683c\` |
| C1 | y | Fix now | |
`;
  assert.deepEqual(parseFixNow(record).map((i) => i.sha), ['fd0683c', null]);
  assert.equal(gate({ records: ['r.md'], items: parseFixNow(record), onHead: () => true, threads: [] }).pass, false);
});

test('parseFixNow skips table headers and "won\'t fix in PR" rows (C9)', () => {
  const record = `| Finding | Fix in PR? |
|---|---|
| a | Won't fix in PR, deferred to LAR-9 |
| b | Fix in PR |
`;
  assert.deepEqual(parseFixNow(record).map((i) => i.text), ['| b | Fix in PR |']);
});

test('parseFixNow reads **Triage:** with the colon inside the bold (C8)', () => {
  assert.deepEqual(parseFixNow('- **Triage:** Fix now — x — Fixed in `ABC1234`\n').map((i) => i.sha), ['abc1234']);
});

test('parseFixNow joins a hard-wrapped Triage bullet, in either direction (C7)', () => {
  const shaWrapped = '  - **Triage**: Fix now — a long rationale that wraps\n    past the column. Fixed in `abc1234`\n- next\n';
  assert.deepEqual(parseFixNow(shaWrapped).map((i) => i.sha), ['abc1234']);
  const labelWrapped = '- 🔴 **Leak** — x.rb:1\n  - **Triage**: Fix now\n    — Fixed in `abc1234`\n';
  assert.deepEqual(parseFixNow(labelWrapped).map((i) => i.sha), ['abc1234']);
  assert.deepEqual(parseFixNow('- finding\n\n    indented code, not a continuation. Fixed in `abc1234`\n'), []);
});

test('blockingUnanswered decides by the comment\'s label, not by words in its body (C3)', () => {
  const threads = [
    thread(false, ['rev', '🛑 **issue (blocking):** unlike the non-blocking nit above, this leaks']),
    thread(false, ['rev', 'nit: rename this, not a blocker']),
    thread(false, ['rev', 'suggestion (non-blocking): a blocker for some, not here']),
  ];
  assert.deepEqual(blockingUnanswered(threads).map((t) => t.comments[0].body),
    ['🛑 **issue (blocking):** unlike the non-blocking nit above, this leaks']);
});
