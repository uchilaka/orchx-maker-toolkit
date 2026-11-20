// /pr-ship-check's gate: fix-now items from a review record, and blocking threads.
// Run: node --test scripts/pr_ship_check.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFixNow, blockingUnanswered, prCommitMatcher, gate } = require(path.join(
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

test('prCommitMatcher accepts only the PR\'s own commits, by full or abbreviated SHA (C2)', () => {
  const onHead = prCommitMatcher(['ABC1234def5678abc1234def5678abc1234def56', '9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.equal(onHead('abc1234'), true);
  assert.equal(onHead('9999999aaaa'), true);
  assert.equal(onHead('2bd07f1'), false); // on the base branch, so an ancestor of the head, but not this PR's
});

test('gate fails when the threads didn\'t fit in one page (C4)', () => {
  const r = gate({ records: ['r.md'], items: [], onHead: () => true, threads: [], truncated: true });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /more review threads/);
});

// The CLI's exit codes, with gh and git stubbed on PATH so nothing reaches GitHub.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const SCRIPT = path.join(__dirname, '..', '.claude', 'skills', 'pr-ship-check', 'scripts', 'ship-data.cjs');

function runCli({ origin, prJson, prError }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-data-'));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n[ "$1 $2" = "remote get-url" ] && { printf "%s\\n" "$STUB_ORIGIN"; exit 0; }\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then\n  [ -n "$STUB_PR_ERROR" ] && { printf "%s\\n" "$STUB_PR_ERROR" >&2; exit 1; }\n  printf "%s\\n" "$STUB_PR_JSON"; exit 0\nfi\nexit 1\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [SCRIPT, '7'], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, STUB_ORIGIN: origin, STUB_PR_JSON: JSON.stringify(prJson || {}), STUB_PR_ERROR: prError || '' },
  });
  fs.rmSync(bin, { recursive: true });
  return r;
}

const ORIGIN = 'git@github.com:me/repo.git';
const PR = { number: 7, state: 'OPEN', url: 'https://github.com/me/repo/pull/7' };

test('ship-data exits 4 for a non-github origin, including a look-alike host (SEC5)', () => {
  assert.equal(runCli({ origin: 'git@gitlab.com:me/repo.git', prJson: PR }).status, 4);
  assert.equal(runCli({ origin: 'git@notgithub.com:me/repo.git', prJson: PR }).status, 4);
});

test('ship-data exits 4 for a PR in another repo, so nothing posts to the wrong PR (C6)', () => {
  const r = runCli({ origin: ORIGIN, prJson: { ...PR, url: 'https://github.com/other/repo/pull/7' } });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /not in origin's repo/);
});

test('ship-data exits 2 for a merged or closed PR, and when there is none (C5)', () => {
  assert.equal(runCli({ origin: ORIGIN, prJson: { ...PR, state: 'MERGED' } }).status, 2);
  assert.equal(runCli({ origin: ORIGIN, prJson: { ...PR, state: 'CLOSED' } }).status, 2);
  assert.equal(runCli({ origin: ORIGIN, prError: 'no pull requests found for branch "x"' }).status, 2);
});

test('ship-data exits 3 when gh fails for any other reason', () => {
  assert.equal(runCli({ origin: ORIGIN, prError: 'HTTP 502: Bad Gateway' }).status, 3);
});
