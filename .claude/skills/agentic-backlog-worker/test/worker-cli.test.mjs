import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z
// Stands in for /opt/Developer: `start` only accepts repos under it that contain .git.
const REPOS = realpathSync(mkdtempSync(path.join(tmpdir(), 'abw-repos-')));
const REPO = path.join(REPOS, 'x');
mkdirSync(path.join(REPO, '.git'), { recursive: true });
mkdirSync(path.join(REPOS, 'not-a-repo'));
const ESTIMATES_MSG =
  'Turn on T-shirt estimates: Linear → Settings → Teams → LarCity Engineering → Estimates';

// Every test gets its own sandbox: state, runs, snapshot, config and HOME all under one temp dir,
// so nothing touches the real ~/.claude or ~/.config.
function sandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'abw-cli-')));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    ABW_STATE_DIR: path.join(root, 'state'),
    ABW_RUNS_DIR: path.join(root, 'runs'),
    ABW_SNAPSHOT: path.join(root, 'snap.json'),
    ABW_CONFIG: path.join(root, 'config.yml'),
    ABW_NOW: String(NOW),
    ABW_REPOS_ROOT: REPOS,
  };
  mkdirSync(env.HOME, { recursive: true });
  const box = {
    root,
    env,
    run(args, extraEnv = {}) {
      const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    snapshot({ five, seven, capturedAt = NOW - 30, fiveResets = NOW + 3600 } = {}) {
      const limits = {};
      if (five !== undefined) limits.five_hour = { used_percentage: five, resets_at: fiveResets };
      if (seven !== undefined) limits.seven_day = { used_percentage: seven, resets_at: NOW + 86400 };
      writeFileSync(env.ABW_SNAPSHOT, JSON.stringify({ captured_at: capturedAt, rate_limits: limits }));
    },
    tickets(list) {
      const file = path.join(root, 'tickets.json');
      writeFileSync(file, JSON.stringify(list));
      return file;
    },
    runJson: () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'run.json'), 'utf8')),
    history: () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'history.json'), 'utf8')),
  };
  return box;
}

const T = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, size: 'S', repo: REPO, status: 'queued', ...extra,
});

function started(list = [T('LAR-1'), T('LAR-2')], snap = { five: 10, seven: 20 }) {
  const box = sandbox();
  box.snapshot(snap);
  const r = box.run(['start', '--tickets', box.tickets(list)]);
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  return box;
}

// --- preflight -------------------------------------------------------------------------------

test('preflight: 7d at 80 is sevenDayBlocked and carries config', () => {
  const box = sandbox();
  box.snapshot({ five: 10, seven: 80 });
  const r = box.run(['preflight']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.sevenDayBlocked, true);
  assert.strictEqual(r.json.capped, true);
  assert.strictEqual(r.json.config.max_parallel_tickets, 1);
  assert.strictEqual(r.json.window.open, false);
});

test('preflight: a fresh snapshot under the caps is an open window from the snapshot', () => {
  const box = sandbox();
  box.snapshot({ five: 10, seven: 20 });
  const r = box.run(['preflight']);
  assert.strictEqual(r.json.sevenDayBlocked, false);
  assert.strictEqual(r.json.capped, false);
  assert.strictEqual(r.json.needsResetTime, false);
  assert.deepStrictEqual(r.json.window, { open: true, resetsAt: NOW + 3600, source: 'snapshot' });
  assert.strictEqual(r.json.estimatesBlocked, null);
});

test('preflight: a missing snapshot needs a reset time', () => {
  const box = sandbox();
  const r = box.run(['preflight']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.usage.state, 'missing');
  assert.strictEqual(r.json.needsResetTime, true);
  assert.strictEqual(r.json.window, null);
  assert.strictEqual(r.json.sevenDayBlocked, null);
});

test('preflight: sevenDayBlocked is null (unknown) on a stale reading', () => {
  const box = sandbox();
  box.snapshot({ five: 10, seven: 90, capturedAt: NOW - 3600 });
  assert.strictEqual(box.run(['preflight']).json.sevenDayBlocked, null);
});

test('preflight: a stale snapshot with a future user reset does not need a reset time', () => {
  const box = sandbox();
  box.snapshot({ five: 10, capturedAt: NOW - 3600 });
  assert.strictEqual(box.run(['set-reset', String(NOW + 600)]).code, 0);
  const r = box.run(['preflight']);
  assert.strictEqual(r.json.needsResetTime, false);
  assert.deepStrictEqual(r.json.window, { open: false, resetsAt: NOW + 600, source: 'user' });
});

test('preflight: a user reset that has passed counts as missing', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['set-reset', String(NOW + 600)]).code, 0);
  const r = box.run(['preflight'], { ABW_NOW: String(NOW + 700) });
  assert.strictEqual(r.json.needsResetTime, true);
});

test('preflight: a 5h window that already reset is open', () => {
  const box = sandbox();
  box.snapshot({ five: 90, fiveResets: NOW - 10 });
  const r = box.run(['preflight']);
  assert.strictEqual(r.json.window.open, true);
});

test('preflight: --linear-estimates=disabled gives the exact instruction', () => {
  const box = sandbox();
  box.snapshot({ five: 10 });
  const r = box.run(['preflight', '--linear-estimates=disabled']);
  assert.strictEqual(r.json.estimatesBlocked, ESTIMATES_MSG);
  for (const v of ['enabled', 'unknown']) {
    assert.strictEqual(box.run(['preflight', `--linear-estimates=${v}`]).json.estimatesBlocked, null);
  }
  const bad = box.run(['preflight', '--linear-estimates=maybe']);
  assert.strictEqual(bad.code, 1);
  assert.ok(bad.json.error);
});

// --- set-reset / window ----------------------------------------------------------------------

test('set-reset: a past time exits 1 with an error', () => {
  const box = sandbox();
  const r = box.run(['set-reset', String(NOW - 1)]);
  assert.strictEqual(r.code, 1);
  assert.match(r.json.error, /past/);
  assert.strictEqual(box.run(['set-reset', 'tomorrow-ish']).code, 1);
});

test('set-reset: accepts ISO-8601, and start adopts the stored reset', () => {
  const box = sandbox();
  const iso = new Date((NOW + 1800) * 1000).toISOString();
  const r = box.run(['set-reset', iso]);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.json, { resetsAt: NOW + 1800, source: 'user', stored: 'window' });
  assert.strictEqual(box.run(['start', '--tickets', box.tickets([T('LAR-1')])]).code, 0);
  assert.deepStrictEqual(box.runJson().window, { resetsAt: NOW + 1800, source: 'user' });
  assert.ok(!existsSync(path.join(box.env.ABW_STATE_DIR, 'window.json')));
});

test('set-reset: with an active run it writes run.json', () => {
  const box = started();
  const r = box.run(['set-reset', String(NOW + 900)]);
  assert.strictEqual(r.json.stored, 'run');
  assert.deepStrictEqual(box.runJson().window, { resetsAt: NOW + 900, source: 'user' });
});

test('window: exits 3 when capped and 0 when open', () => {
  const box = sandbox();
  box.snapshot({ five: 80 });
  const capped = box.run(['window']);
  assert.strictEqual(capped.code, 3);
  assert.strictEqual(capped.json.open, false);
  box.snapshot({ five: 10 });
  assert.strictEqual(box.run(['window']).code, 0);
  assert.strictEqual(box.run(['window'], { ABW_NOW: 'x' }).code, 1);
});

test('window: no usage reading and no future reset is an error, not an endless wait', () => {
  const box = sandbox();
  const none = box.run(['window']);
  assert.strictEqual(none.code, 1);
  assert.strictEqual(none.json.error, 'no usage reading and no future reset known');
  // A future user reset makes it a wait; once that reset passes with still no reading, an error.
  box.run(['set-reset', String(NOW + 600)]);
  assert.strictEqual(box.run(['window']).code, 3);
  const after = box.run(['window'], { ABW_NOW: String(NOW + 700) });
  assert.strictEqual(after.code, 1);
  assert.strictEqual(after.json.error, 'no usage reading and no future reset known');
});

test('window --deadline: still closed at the deadline is an error', () => {
  const box = sandbox();
  box.snapshot({ five: 80 });
  assert.strictEqual(box.run(['window', '--deadline', String(NOW + 1)]).code, 3);
  const late = box.run(['window', '--deadline', String(NOW)]);
  assert.strictEqual(late.code, 1);
  assert.strictEqual(late.json.error, 'window did not open');
  box.snapshot({ five: 10 });
  assert.strictEqual(box.run(['window', '--deadline', String(NOW - 1)]).code, 0);
  assert.strictEqual(box.run(['window', '--deadline', 'soon']).code, 1);
});

// --- start -----------------------------------------------------------------------------------

test('start: records tickets, the snapshot window and usage at start', () => {
  const box = started([T('LAR-1', { theme: 'docs' }), T('LAR-2', { status: 'needs-repo', repo: null })]);
  const run = box.runJson();
  assert.strictEqual(run.active, true);
  assert.deepStrictEqual(run.window, { resetsAt: NOW + 3600, source: 'snapshot' });
  assert.deepStrictEqual(run.usageStart, { fiveHour: 10, sevenDay: 20 });
  assert.deepStrictEqual(run.tickets.map((t) => [t.id, t.status, t.theme]),
    [['LAR-1', 'queued', 'docs'], ['LAR-2', 'needs-repo', undefined]]);
});

test('start: refuses while a run is active, allowed again after stop', () => {
  const box = started();
  const again = box.run(['start', '--tickets', box.tickets([T('LAR-9')])]);
  assert.strictEqual(again.code, 1);
  assert.match(again.json.error, /active/);
  assert.strictEqual(box.run(['stop', '--reason', 'done']).code, 0);
  assert.strictEqual(box.run(['start', '--tickets', box.tickets([T('LAR-9')])]).code, 0);
});

test('start: rejects a bad status, a duplicate id and a non-array', () => {
  const box = sandbox();
  for (const list of [[T('LAR-1', { status: 'done' })], [T('LAR-1'), T('LAR-1')], { id: 'x' }]) {
    const r = box.run(['start', '--tickets', box.tickets(list)]);
    assert.strictEqual(r.code, 1, JSON.stringify(list));
    assert.ok(r.json.error);
  }
});

// --- afford / begin / finish -----------------------------------------------------------------

test('afford: uses the prior and the in-flight count', () => {
  const box = started([T('LAR-1'), T('LAR-2', { size: 'M' })], { five: 60 });
  assert.deepStrictEqual(
    box.run(['afford', 'LAR-1']).json,
    { id: 'LAR-1', ok: true, projected: 65, current5h: 60, size: 'S', inFlight: 0 },
  );
  box.run(['begin', 'LAR-1']);
  const r = box.run(['afford', 'LAR-2']);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.projected, 84); // 60 + 12 * 2
  assert.strictEqual(box.run(['afford', 'LAR-404']).code, 1);
});

test('afford: no usage reading is never affordable', () => {
  const box = started();
  box.snapshot({ five: 10, capturedAt: NOW - 3600 });
  const r = box.run(['afford', 'LAR-1']);
  assert.strictEqual(r.json.ok, false);
  assert.match(r.json.reason, /stale/);
});

test('finish: a PR records the cost from start5h to end5h', () => {
  const box = started();
  assert.strictEqual(box.run(['begin', 'LAR-1']).json.start5h, 10);
  assert.strictEqual(box.runJson().tickets[0].status, 'running');
  box.snapshot({ five: 17 });
  const result = JSON.stringify({ outcome: 'pr', pr: 'https://github.com/o/r/pull/9', branch: 'LAR-1/x' });
  const r = box.run(['finish', 'LAR-1', '--result', result, '--tokens', '4200']);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(r.json, { id: 'LAR-1', status: 'pr', delta5h: 7, recorded: true });
  const t = box.runJson().tickets[0];
  assert.strictEqual(t.pr, 'https://github.com/o/r/pull/9');
  assert.strictEqual(t.end5h, 17);
  const [h] = box.history();
  assert.deepStrictEqual([h.size, h.delta5h, h.tokens, h.shared], ['S', 7, 4200, false]);
});

test('finish: tickets that overlap are recorded as shared', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  assert.strictEqual(box.run(['begin', 'LAR-2']).json.shared, true);
  box.snapshot({ five: 30 });
  for (const id of ['LAR-1', 'LAR-2']) {
    const r = box.run(['finish', id, '--result', '{"outcome":"handoff","reason":"two designs"}']);
    assert.strictEqual(r.code, 0, r.stdout);
  }
  // LAR-1 began alone but LAR-2 ran alongside it, so both deltas are shared.
  assert.deepStrictEqual(box.history().map((h) => h.shared), [true, true]);
  assert.deepStrictEqual(box.runJson().tickets.map((t) => t.status), ['handoff', 'handoff']);
});

test('finish: capped sets status capped and leaves the run active until stop', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  box.snapshot({ five: 76 });
  const r = box.run(['finish', 'LAR-1', '--result', 'RESULT {"outcome":"capped","reason":"5h cap"}']);
  assert.strictEqual(r.json.status, 'capped');
  assert.strictEqual(box.runJson().active, true);
  box.run(['stop', '--reason', 'capped mid-ticket']);
  const run = box.runJson();
  assert.strictEqual(run.active, false);
  assert.strictEqual(run.stopReason, 'capped mid-ticket');
  assert.deepStrictEqual(run.usageEnd, { fiveHour: 76, sevenDay: null });
});

test('finish: failed maps to handoff with a failed: reason', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  box.run(['finish', 'LAR-1', '--result', '{"outcome":"failed","reason":"gh unreachable"}']);
  const t = box.runJson().tickets[0];
  assert.strictEqual(t.status, 'handoff');
  assert.strictEqual(t.reason, 'failed: gh unreachable');
});

test('finish: unknown usage skips the cost record', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  box.snapshot({ five: 20, capturedAt: NOW - 3600 });
  const r = box.run(['finish', 'LAR-1', '--result', '{"outcome":"handoff","reason":"x"}']);
  assert.deepStrictEqual([r.json.delta5h, r.json.recorded], [null, false]);
  assert.ok(!existsSync(path.join(box.env.ABW_STATE_DIR, 'history.json')));
});

test('finish: rejects a bad RESULT, a missing PR url and a ticket that is not running', () => {
  const box = started();
  assert.strictEqual(box.run(['finish', 'LAR-1', '--result', '{"outcome":"pr"}']).code, 1);
  box.run(['begin', 'LAR-1']);
  for (const bad of ['not json', '{"outcome":"merged"}', '{"outcome":"pr"}', '{"outcome":"pr","pr":"x"}']) {
    const r = box.run(['finish', 'LAR-1', '--result', bad]);
    assert.strictEqual(r.code, 1, bad);
    assert.ok(r.json.error);
  }
  assert.strictEqual(box.run(['finish', 'LAR-1', '--result', '{"outcome":"handoff"}', '--tokens', '-1']).code, 1);
});

test('begin: refuses a ticket that is already running', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  assert.strictEqual(box.run(['begin', 'LAR-1']).code, 1);
});

// --- heartbeat / debrief ---------------------------------------------------------------------

test('heartbeat: updates heartbeatAt', () => {
  const box = started();
  const r = box.run(['heartbeat'], { ABW_NOW: String(NOW + 120) });
  assert.strictEqual(r.json.heartbeatAt, NOW + 120);
  assert.strictEqual(box.runJson().heartbeatAt, NOW + 120);
});

function worked() {
  const box = started([
    T('LAR-1', { title: 'Fix a | b', theme: 'cli' }),
    T('LAR-2', { title: 'Second\nline <script>x</script>' }),
    T('LAR-3'),
    T('LAR-4'),
    T('LAR-5', { status: 'needs-repo', repo: null, reason: 'no repo' }),
  ]);
  const outcomes = {
    'LAR-1': '{"outcome":"pr","pr":"https://github.com/o/r/pull/1","branch":"LAR-1/a"}',
    'LAR-2': '{"outcome":"handoff","reason":"pick | one","branch":"LAR-2/b"}',
    'LAR-3': '{"outcome":"failed","reason":"no worktree"}',
    'LAR-4': '{"outcome":"capped","reason":"cap"}',
  };
  for (const [id, result] of Object.entries(outcomes)) {
    box.run(['begin', id]);
    box.run(['finish', id, '--result', result]);
  }
  box.run(['stop', '--reason', 'capped']);
  return box;
}

test('debrief: plan-template run file with one tracker row per worked ticket', () => {
  const box = worked();
  const r = box.run(['debrief']);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(r.json.path, path.join(box.env.ABW_RUNS_DIR, 'RUN_2027-01-15.md'));
  const md = readFileSync(r.json.path, 'utf8');
  assert.ok(md.startsWith('# Backlog worker run 2027-01-15\n'));
  assert.match(md, /^## Status: IN PROGRESS$/m);
  for (const h of ['## Context', '## Tracker', '## Stop']) assert.ok(md.includes(`\n${h}\n`), h);
  const rows = md.split('\n').filter((l) => /^- \[[x ]\] /.test(l));
  assert.deepStrictEqual(rows.map((l) => l.slice(0, 5)), ['- [x]', '- [ ]', '- [ ]', '- [ ]']);
  assert.ok(rows[0].includes('https://github.com/o/r/pull/1'));
  assert.ok(rows[2].includes('failed: no worktree'));
  // No unclosed fences, and the file ends with exactly one newline.
  assert.strictEqual((md.match(/^```/gm) || []).length % 2, 0);
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'));
});

test('debrief: untrusted text cannot break the table or inject HTML', () => {
  const box = worked();
  const md = readFileSync(box.run(['debrief']).json.path, 'utf8');
  assert.ok(md.includes('Fix a \\| b'));
  assert.ok(md.includes('pick \\| one'));
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('Second\nline'));
  // Every table row has the same number of unescaped pipes as the header.
  const table = md.split('\n').filter((l) => l.startsWith('|'));
  const pipes = (l) => (l.replace(/\\\|/g, '').match(/\|/g) || []).length;
  assert.ok(table.length >= 7);
  for (const row of table) assert.strictEqual(pipes(row), pipes(table[0]), row);
});

test('debrief: resolved when inactive with nothing capped or handed off, and idempotent', () => {
  const box = started([T('LAR-1')]);
  box.run(['begin', 'LAR-1']);
  box.run(['finish', 'LAR-1', '--result', '{"outcome":"pr","pr":"https://github.com/o/r/pull/1"}']);
  box.run(['stop', '--reason', 'no eligible tickets left'], { ABW_NOW: String(NOW + 7200) });
  const first = readFileSync(box.run(['debrief']).json.path, 'utf8');
  assert.match(first, /^## Status: RESOLVED \(2027-01-15\)$/m);
  assert.match(first, /no eligible tickets left/);
  assert.strictEqual(readFileSync(box.run(['debrief']).json.path, 'utf8'), first);
});

test('dry run: queued triage, stop and debrief leave a run file with no tracker rows', () => {
  const box = started([T('LAR-1'), T('LAR-2')]);
  box.run(['stop', '--reason', 'dry-run']);
  const md = readFileSync(box.run(['debrief']).json.path, 'utf8');
  assert.match(md, /^## Status: RESOLVED/m);
  assert.ok(!/^- \[[x ]\] /m.test(md));
  assert.match(md, /dry-run/);
});

test('unknown command and no run both exit 1 with JSON errors', () => {
  const box = sandbox();
  for (const args of [['bogus'], ['heartbeat'], ['debrief'], ['begin', 'LAR-1'], []]) {
    const r = box.run(args);
    assert.strictEqual(r.code, 1, args.join(' '));
    assert.ok(r.json && r.json.error, args.join(' '));
  }
});

// --- fix round 1 -----------------------------------------------------------------------------

test('start: repo must be null (needs-repo or skipped) or a git repo under the repos root', () => {
  const box = sandbox();
  const bad = [
    T('LAR-1', { repo: path.join(REPOS, 'not-a-repo') }), // no .git
    T('LAR-1', { repo: tmpdir() }), // outside the root
    T('LAR-1', { repo: path.join(REPO, '..', '..') }), // escapes via ..
    T('LAR-1', { repo: null }), // queued needs a repo
    T('LAR-1', { repo: 'relative/x' }),
  ];
  for (const tk of bad) {
    const r = box.run(['start', '--tickets', box.tickets([tk])]);
    assert.strictEqual(r.code, 1, String(tk.repo));
    assert.match(r.json.error, /repo/);
  }
  const ok = [T('LAR-1'), T('LAR-2', { status: 'skipped', repo: null }), T('LAR-3', { status: 'needs-repo', repo: null })];
  assert.strictEqual(box.run(['start', '--tickets', box.tickets(ok)]).code, 0);
});

test('finish --no-cost records the outcome but no cost sample', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  box.snapshot({ five: 30 });
  const r = box.run(['finish', 'LAR-1', '--no-cost', '--result',
    '{"outcome":"capped","reason":"orchestrator stopped mid-ticket"}']);
  assert.deepStrictEqual([r.json.status, r.json.recorded], ['capped', false]);
  assert.ok(!existsSync(path.join(box.env.ABW_STATE_DIR, 'history.json')));
});

test('start: carries forward capped and handed-off tickets from an inactive run', () => {
  const box = started([T('LAR-1'), T('LAR-2'), T('LAR-3'), T('LAR-4')]);
  for (const [id, result] of [
    ['LAR-1', '{"outcome":"capped","reason":"cap","branch":"LAR-1/a"}'],
    ['LAR-2', '{"outcome":"handoff","reason":"pick one"}'],
    ['LAR-3', '{"outcome":"handoff","reason":"decided now"}'],
    ['LAR-4', '{"outcome":"pr","pr":"https://github.com/o/r/pull/4"}'],
  ]) {
    box.run(['begin', id]);
    box.run(['finish', id, '--result', result]);
  }
  box.run(['stop', '--reason', 'capped']);
  const oldId = box.runJson().id;
  // Triage skips LAR-2 (agent-handoff label) and re-queues LAR-3 because the decision is made.
  const triage = [T('LAR-2', { status: 'skipped', repo: null }), T('LAR-3'), T('LAR-9')];
  const r = box.run(['start', '--tickets', box.tickets(triage)], { ABW_NOW: String(NOW + 60) });
  assert.strictEqual(r.code, 0, r.stdout);
  const run = box.runJson();
  assert.deepStrictEqual(run.tickets.map((t) => [t.id, t.status]),
    [['LAR-1', 'capped'], ['LAR-2', 'handoff'], ['LAR-3', 'queued'], ['LAR-9', 'queued']]);
  assert.strictEqual(run.tickets[0].branch, 'LAR-1/a');
  assert.strictEqual(run.tickets[0].carriedFrom, oldId);
  assert.strictEqual(run.tickets[2].carriedFrom, undefined);
});

test('close-out acknowledges capped and handoff tickets so they are not carried again', () => {
  const box = started();
  box.run(['begin', 'LAR-1']);
  box.run(['finish', 'LAR-1', '--result', '{"outcome":"capped","reason":"cap"}']);
  assert.strictEqual(box.run(['close-out']).code, 1); // still active
  box.run(['stop', '--reason', 'capped']);
  const r = box.run(['close-out']);
  assert.deepStrictEqual(r.json.acknowledged, ['LAR-1']);
  const t = box.runJson().tickets[0];
  assert.deepStrictEqual([t.status, t.acknowledged], ['capped', true]);
  assert.match(readFileSync(box.run(['debrief']).json.path, 'utf8'), /^## Status: RESOLVED/m);
  box.run(['start', '--tickets', box.tickets([T('LAR-9')])]);
  assert.deepStrictEqual(box.runJson().tickets.map((tk) => tk.id), ['LAR-9']);
});

test('debrief: a second run on the same day gets RUN_<date>-2.md and keeps it', () => {
  const box = started([T('LAR-1')]);
  box.run(['stop', '--reason', 'first']);
  const first = box.run(['debrief']).json.path;
  assert.ok(first.endsWith('RUN_2027-01-15.md'));
  assert.strictEqual(box.run(['debrief']).json.path, first); // same run reuses its file
  box.run(['start', '--tickets', box.tickets([T('LAR-2')])], { ABW_NOW: String(NOW + 60) });
  box.run(['stop', '--reason', 'second']);
  const second = box.run(['debrief']).json.path;
  assert.ok(second.endsWith('RUN_2027-01-15-2.md'), second);
  assert.strictEqual(box.runJson().debriefPath, second);
  assert.strictEqual(box.run(['debrief']).json.path, second);
  assert.match(readFileSync(first, 'utf8'), /first/);
});
