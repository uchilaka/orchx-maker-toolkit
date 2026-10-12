const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Guards the behaviors the PR-triage consolidation plan's S1 inventory decided on
// (~/project-plans/global/PR_TRIAGE_CONSOLIDATION.md). Each test names the
// finding it protects, so a failure says which decision was undone.

const SKILL = path.join(__dirname, '..', '.claude', 'skills', 'pr-triage');
const FIXTURES = path.join(__dirname, 'fixtures', 'pr-triage');
const { MARKER, issueMarker, normalize, filter, chooseMode, approvalRequired } = require(path.join(SKILL, 'scripts', 'threads.cjs'));
const { validate } = require(path.join(SKILL, 'scripts', 'post-reply.cjs'));

const graphql = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'review-threads.json'), 'utf8'));
const issueComments = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'issue-comments.json'), 'utf8'));
const skillText = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');

const byId = (threads, id) => threads.find((t) => t.id === id);

// Proves the harness reads the fixtures before any failure below is trusted.
test('fixtures load: 5 review threads and 5 top-level comments', () => {
  assert.strictEqual(graphql.data.repository.pullRequest.reviewThreads.nodes.length, 5);
  assert.strictEqual(issueComments.length, 5);
});

// --- S1 finding 1: the fetch must carry resolution state -----------------------

test('normalize keeps every review thread with its isResolved state', () => {
  const threads = normalize(graphql, issueComments);
  const resolved = byId(threads, 'PRRT_resolved');
  assert.ok(resolved, 'the resolved thread is missing from the normalized output');
  assert.strictEqual(resolved.isResolved, true);
  assert.strictEqual(byId(threads, 'PRRT_kwDOR-u3Ps6rWCnK').isResolved, false);
});

test('normalize gives review threads the root comment id a reply needs', () => {
  const t = byId(normalize(graphql, issueComments), 'PRRT_kwDOR-u3Ps6rWCnK');
  assert.ok(t, 'thread missing');
  assert.strictEqual(t.kind, 'review');
  assert.strictEqual(t.rootCommentId, 4245082797);
  assert.strictEqual(t.path, '.claude/skills/browser-test-assist/SKILL.md');
  assert.strictEqual(t.line, 147);
});

// --- S11: top-level PR comments are input --------------------------------------

test('normalize includes each top-level comment as its own issue thread', () => {
  const issues = normalize(graphql, issueComments).filter((t) => t.kind === 'issue');
  assert.deepStrictEqual(issues.map((t) => t.rootCommentId).sort(), [2001, 2002, 2003, 2004, 2005]);
});

// --- S1 finding 2 and the filter -----------------------------------------------

test('filter skips resolved threads', () => {
  const { skipped } = filter(normalize(graphql, issueComments));
  assert.deepStrictEqual(skipped.find((s) => s.id === 'PRRT_resolved')?.reason, 'resolved');
});

test('filter skips threads carrying the handled marker, including the legacy one', () => {
  const { skipped } = filter(normalize(graphql, issueComments));
  assert.strictEqual(skipped.find((s) => s.id === 'PRRT_handled')?.reason, 'handled');
  assert.strictEqual(skipped.find((s) => s.id === 'PRRT_legacy_handled')?.reason, 'handled');
});

test('filter skips a top-level comment answered with its issue marker, and the answer itself', () => {
  const threads = normalize(graphql, issueComments);
  const { skipped } = filter(threads);
  const reasonFor = (n) => skipped.find((s) => s.id === threads.find((t) => t.rootCommentId === n)?.id)?.reason;
  assert.strictEqual(reasonFor(2001), 'handled');
  assert.strictEqual(reasonFor(2004), 'handled');
});

test('filter skips a CI bot status comment by its content', () => {
  const threads = normalize(graphql, issueComments);
  const ci = threads.find((t) => t.rootCommentId === 2002);
  assert.ok(ci, 'the claude[bot] CI comment is missing');
  assert.strictEqual(filter(threads).skipped.find((s) => s.id === ci.id)?.reason, 'ci-status');
});

test('filter keeps threads the viewer wrote (self-review findings)', () => {
  const threads = normalize(graphql, issueComments);
  const kept = filter(threads).toTriage.map((t) => t.id);
  assert.ok(kept.includes('PRRT_kwDOR-u3Ps6rWCnK'), 'the viewer-authored thread was dropped');
});

test('filter keeps bot reviewers: bots and humans get identical treatment', () => {
  const threads = normalize(graphql, issueComments);
  const kept = filter(threads).toTriage;
  assert.ok(kept.some((t) => t.id === 'PRRT_bot_reviewer'), 'the copilot review thread was dropped');
  assert.ok(kept.some((t) => t.rootCommentId === 2003), 'the coderabbit top-level comment was dropped');
});

test('filter leaves exactly the four threads that need triage', () => {
  const threads = normalize(graphql, issueComments);
  const { toTriage, skipped } = filter(threads);
  assert.strictEqual(toTriage.length, 4);
  assert.strictEqual(toTriage.length + skipped.length, threads.length);
});

// --- S3: route-only mode on someone else's PR ----------------------------------

test('chooseMode fixes on my own PR by default', () => {
  assert.strictEqual(chooseMode({ prAuthor: 'uchilaka', viewer: 'uchilaka' }), 'fix');
});

test("chooseMode routes only on a teammate's PR by default", () => {
  assert.strictEqual(chooseMode({ prAuthor: 'teammate', viewer: 'uchilaka' }), 'route-only');
});

test('chooseMode: --route-only wins on my own PR, --fix opts in on a teammate PR', () => {
  assert.strictEqual(chooseMode({ prAuthor: 'uchilaka', viewer: 'uchilaka', flags: ['--route-only'] }), 'route-only');
  assert.strictEqual(chooseMode({ prAuthor: 'teammate', viewer: 'uchilaka', flags: ['--fix'] }), 'fix');
});

test('chooseMode refuses --fix and --route-only together', () => {
  assert.throws(() => chooseMode({ prAuthor: 'uchilaka', viewer: 'uchilaka', flags: ['--fix', '--route-only'] }), /both/);
});

// --- S4: approval before anything leaves the machine, except after a push -------

test('approvalRequired on a manual run', () => {
  assert.strictEqual(approvalRequired([]), true);
  assert.strictEqual(approvalRequired(['--route-only']), true);
});

test('approvalRequired is off only for the after-push run', () => {
  assert.strictEqual(approvalRequired(['--after-push']), false);
  assert.strictEqual(approvalRequired(['--after-push', '--fix']), false);
});

// --- Replies: the marker, and the S11 shape of a top-level reply ---------------

const footer = `\n\n${MARKER}\n\n—\nPosted by Claude on behalf of @uchilaka.`;

test('validate refuses a review reply without the handled marker', () => {
  const res = validate('review', 'VALID: fixed in abc1234.');
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /marker/);
});

test('validate accepts a review reply with the marker', () => {
  assert.deepStrictEqual(validate('review', `VALID: fixed in abc1234.${footer}`), { ok: true, errors: [] });
});

test('validate refuses a top-level reply that does not quote and mention the original', () => {
  const body = `OUT-OF-SCOPE: tracked in LAR-397.\n\n${issueMarker(2005)}`;
  const res = validate('issue', body, { replyTo: 2005, author: 'teammate' });
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /quote/);
  assert.match(res.errors.join('\n'), /@teammate/);
});

test('validate refuses a top-level reply whose marker names a different comment', () => {
  const body = `> README.md still says…\n\n@teammate Fixed.\n\n${issueMarker(9999)}`;
  assert.strictEqual(validate('issue', body, { replyTo: 2005, author: 'teammate' }).ok, false);
});

test('validate accepts a well-formed top-level reply', () => {
  const body = `> README.md still says .claude/skills/ is scoped to this repo only.\n\n@teammate VALID: fixed in abc1234.\n\n${issueMarker(2005)}`;
  assert.deepStrictEqual(validate('issue', body, { replyTo: 2005, author: 'teammate' }), { ok: true, errors: [] });
});

// --- SKILL.md lint: the decisions that live in prose ---------------------------

// Returns the violations in a SKILL.md text. Kept separate from the tests below
// so its own negative cases prove it can fail.
function lintSkill(text) {
  const errors = [];
  if (!text.includes(MARKER)) errors.push(`SKILL.md does not name the handled marker ${MARKER}`);
  const never = (text.split(/^## Never\s*$/m)[1] || '').split(/^## /m)[0];
  if (!/top-level/i.test(never) || !/quot/i.test(never)) {
    errors.push('the "Never" section does not carry the S11 exception for quoting top-level replies');
  }
  if (/\b(skip|ignore|filter out)\b[^.\n]*\b(viewer|self-authored|your own|my own)\b/i.test(text) ||
      /author is `?viewer`?/i.test(text)) {
    errors.push('SKILL.md skips threads the viewer wrote, which drops self-review findings (S1 finding 2)');
  }
  // S2: out-of-scope work that needs design first gets a plan. The plan file is
  // local, so the reply must cite something a reviewer can open.
  const deferrals = (text.split(/^## Deferrals\s*$/m)[1] || '').split(/^## /m)[0];
  if (!/project-plans/.test(deferrals) || !/Notion[^.]*loaded/i.test(deferrals)) {
    errors.push('the "Deferrals" section does not describe the S2 plan route (project-plans, Notion only where loaded)');
  }
  if (!/reviewer can open|can't open|cannot open/i.test(deferrals)) {
    errors.push('the "Deferrals" section does not say a plan reply must cite something the reviewer can open (S2)');
  }
  // S3: route-only mode never edits code; a VALID finding becomes a ticket.
  if (!/route-only/.test(text) || !/route-only[\s\S]{0,400}VALID[^.]*ticket/i.test(text)) {
    errors.push('SKILL.md does not describe route-only mode turning VALID findings into tickets (S3)');
  }
  // S4: a manual run waits for go-ahead; only --after-push skips it.
  if (!/--after-push/.test(text) || !/go-ahead/i.test(text)) {
    errors.push('SKILL.md does not describe the approval gate and its --after-push exemption (S4)');
  }
  return errors;
}

test('lintSkill catches a "Deferrals" section without the S2 plan route', () => {
  const text = '## Deferrals\n\nOUT-OF-SCOPE findings become a Linear issue.\n';
  const errors = lintSkill(text);
  assert.ok(errors.some((e) => /S2 plan route/.test(e)));
  assert.ok(errors.some((e) => /reviewer can open/.test(e)));
});

test('lintSkill catches /pr-comment-triage\'s viewer filter (proves the lint can fail)', () => {
  const legacy = "- The root comment's author is `viewer` (the authenticated `gh` user) — that's the user's own comment, not incoming feedback.";
  assert.ok(lintSkill(legacy).some((e) => /viewer wrote/.test(e)));
});

test('lintSkill catches a "Never" section without the S11 exception', () => {
  const text = `${MARKER}\n\n## Never\n\n- Post a review, or a top-level PR comment.\n`;
  assert.ok(lintSkill(text).some((e) => /S11/.test(e)));
});

test('lintSkill catches a SKILL.md without route-only mode', () => {
  assert.ok(lintSkill('## Deferrals\n\nNothing.\n').some((e) => /S3/.test(e)));
});

test('lintSkill catches a SKILL.md without the approval gate', () => {
  assert.ok(lintSkill('## Deferrals\n\nNothing.\n').some((e) => /S4/.test(e)));
});

test('pr-triage SKILL.md passes the lint', () => {
  assert.deepStrictEqual(lintSkill(skillText), []);
});
