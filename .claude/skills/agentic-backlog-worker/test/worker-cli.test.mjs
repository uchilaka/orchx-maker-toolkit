import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOW, tmpRoot, writeJson, git, abwEnv, runNode,
} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
// Stands in for /opt/Developer: `start` only accepts repos under it that contain .git.
const REPOS = tmpRoot('abw-repos-');
const REPO = path.join(REPOS, 'x');
mkdirSync(path.join(REPO, '.git'), { recursive: true });
mkdirSync(path.join(REPOS, 'not-a-repo'));
const ESTIMATES_MSG = 'Turn on T-shirt estimates: Linear → Settings → Teams → LAR → Estimates';

// Every test gets its own sandbox: state, runs, snapshot, config and HOME all under one temp dir,
// so nothing touches the real ~/.claude or ~/.config.
function sandbox() {
  const root = tmpRoot('abw-cli-');
  const env = { ...abwEnv(root), ABW_REPOS_ROOT: REPOS };
  const box = {
    root,
    env,
    run(args, extraEnv = {}) {
      const r = runNode(CLI, { args, env: { ...env, ...extraEnv } });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    // For the long-running loops: resolves on exit, so the test can act while it runs.
    spawn(args, extraEnv = {}) {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv } });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      const done = new Promise((resolve) => {
        child.on('close', (code) => {
          let json = null;
          try { json = JSON.parse(stdout); } catch { /* asserted by callers */ }
          resolve({ code, json, stdout });
        });
      });
      return { child, done };
    },
    snapshot({ five, seven, capturedAt = NOW - 30, fiveResets = NOW + 3600 } = {}) {
      const limits = {};
      if (five !== undefined) limits.five_hour = { used_percentage: five, resets_at: fiveResets };
      if (seven !== undefined) limits.seven_day = { used_percentage: seven, resets_at: NOW + 86400 };
      writeJson(env.ABW_SNAPSHOT, { captured_at: capturedAt, rate_limits: limits });
    },
    tickets: (list) => writeJson(path.join(root, 'tickets.json'), list),
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
  assert.strictEqual(capped.json.deadline, NOW + 3600 + 900); // the reset plus 15 minutes
  assert.strictEqual(box.run(['window', '--deadline', String(NOW + 5)]).json.deadline, NOW + 5);
  box.snapshot({ five: 80 });
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

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('window --wait: polls until the window opens, prints once and exits 0', async () => {
  const box = sandbox();
  box.snapshot({ five: 80 });
  const { done } = box.spawn(['window', '--wait'], { ABW_POLL_S: '0.05' });
  await sleep(300);
  box.snapshot({ five: 10 });
  const r = await done;
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(r.stdout.trim().split('\n').length, 1);
  assert.deepStrictEqual(r.json, { open: true, reason: '', resetsAt: NOW + 3600 });
});

test('window --wait: exits 1 when the deadline passes, or at once on an error', async () => {
  const box = sandbox();
  // The real clock, so the deadline can arrive while it polls.
  const t = Math.floor(Date.now() / 1000);
  box.snapshot({ five: 80, capturedAt: t, fiveResets: t + 3600 });
  const late = await box.spawn(['window', '--wait', '--deadline', String(t + 1)],
    { ABW_NOW: '', ABW_POLL_S: '0.1' }).done;
  assert.strictEqual(late.code, 1, late.stdout);
  assert.deepStrictEqual(late.json, { error: 'window did not open' });
  const none = await sandbox().spawn(['window', '--wait'], { ABW_POLL_S: '0.05' }).done;
  assert.strictEqual(none.code, 1);
  assert.strictEqual(none.json.error, 'no usage reading and no future reset known');
});

test('window --wait: without --deadline it keeps waiting while the window stays closed', async () => {
  // ABW_NOW holds the clock at NOW, so the default deadline (reset + 900s) never arrives.
  const box = sandbox();
  box.snapshot({ five: 80 });
  const { child, done } = box.spawn(['window', '--wait'], { ABW_POLL_S: '0.05' });
  let exited = false;
  done.then(() => { exited = true; });
  await sleep(400);
  assert.strictEqual(exited, false);
  child.kill();
  assert.strictEqual((await done).stdout, '');
});

test('heartbeat --loop: beats until the run is stopped, then exits 0', async () => {
  const box = started();
  const { done } = box.spawn(['heartbeat', '--loop'],
    { ABW_NOW: String(NOW + 60), ABW_HEARTBEAT_S: '0.05' });
  await sleep(300);
  assert.strictEqual(box.runJson().heartbeatAt, NOW + 60);
  // A beat can land between stop's read and write (the documented race), so stop until it holds.
  let exited = false;
  done.then(() => { exited = true; });
  for (let i = 0; i < 50 && !exited; i++) {
    if (box.runJson().active) box.run(['stop', '--reason', 'done']);
    await sleep(100);
  }
  const r = await done;
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(r.json, { skipped: 'inactive' });
  assert.strictEqual(box.runJson().active, false);
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
    const r = box.run(['finish', id, '--result', `{"outcome":"pr","pr":"https://github.com/o/r/pull/${id}"}`]);
    assert.strictEqual(r.code, 0, r.stdout);
  }
  // LAR-1 began alone but LAR-2 ran alongside it, so both deltas are shared.
  assert.deepStrictEqual(box.history().map((h) => h.shared), [true, true]);
  assert.deepStrictEqual(box.runJson().tickets.map((t) => t.status), ['pr', 'pr']);
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
    [T('LAR-1', { repo: path.join(REPOS, 'not-a-repo') }), /not a git repo checkout/], // no .git
    [T('LAR-1', { repo: tmpdir() }), /is not under/], // outside the root
    [T('LAR-1', { repo: path.join(REPO, '..', '..') }), /is not under/], // escapes via ..
    [T('LAR-1', { repo: null }), /repo must be an absolute path/], // queued needs a repo
    [T('LAR-1', { repo: 'relative/x' }), /repo must be an absolute path/],
    [T('LAR-1', { repo: path.join(REPOS, 'missing') }), /repo does not exist/],
  ];
  for (const [tk, message] of bad) {
    const r = box.run(['start', '--tickets', box.tickets([tk])]);
    assert.strictEqual(r.code, 1, String(tk.repo));
    assert.match(r.json.error, message, String(tk.repo));
  }
  const ok = [T('LAR-1'), T('LAR-2', { status: 'skipped', repo: null }), T('LAR-3', { status: 'needs-repo', repo: null })];
  assert.strictEqual(box.run(['start', '--tickets', box.tickets(ok)]).code, 0);
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

// --- fix round 2 -----------------------------------------------------------------------------

test('start: a linked worktree (its .git is a file) is not a repo', () => {
  const real = path.join(REPOS, 'real');
  const wt = path.join(REPOS, 'real-wt');
  git('init', '-q', real);
  git('-C', real, 'commit', '-q', '--allow-empty', '-m', 'init');
  git('-C', real, 'worktree', 'add', '-q', wt);
  const box = sandbox();
  const r = box.run(['start', '--tickets', box.tickets([T('LAR-1', { repo: wt })])]);
  assert.strictEqual(r.code, 1);
  assert.match(r.json.error, /not a git repo checkout/);
  assert.strictEqual(box.run(['start', '--tickets', box.tickets([T('LAR-1', { repo: real })])]).code, 0);
});

test('a crashed run with nothing resumable: stop --reason crashed, then a fresh start', () => {
  const box = started([T('LAR-1'), T('LAR-2')]);
  box.run(['begin', 'LAR-1']);
  box.run(['finish', 'LAR-1', '--result', '{"outcome":"pr","pr":"https://github.com/o/r/pull/1"}']);
  const later = { ABW_NOW: String(NOW + 7200) }; // heartbeat long stale
  assert.strictEqual(box.run(['start', '--tickets', box.tickets([T('LAR-3')])], later).code, 1);
  assert.strictEqual(box.run(['stop', '--reason', 'crashed'], later).code, 0);
  const r = box.run(['start', '--tickets', box.tickets([T('LAR-3')])], later);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(box.runJson().tickets.map((t) => t.id), ['LAR-3']);
});

test('skip: a carried ticket closed in Linear becomes skipped and is not carried again', () => {
  const box = started([T('LAR-1'), T('LAR-2')]);
  box.run(['begin', 'LAR-1']);
  box.run(['finish', 'LAR-1', '--result', '{"outcome":"capped","reason":"cap"}']);
  assert.strictEqual(box.run(['skip', 'LAR-1']).code, 1); // reason required
  const r = box.run(['skip', 'LAR-1', '--reason', 'closed in Linear']);
  assert.deepStrictEqual(r.json, { id: 'LAR-1', status: 'skipped' });
  const t = box.runJson().tickets[0];
  assert.deepStrictEqual([t.status, t.reason], ['skipped', 'closed in Linear']);
  box.run(['begin', 'LAR-2']);
  assert.strictEqual(box.run(['skip', 'LAR-2', '--reason', 'x']).code, 1); // running: finish it
  box.run(['finish', 'LAR-2', '--result', '{"outcome":"pr","pr":"https://github.com/o/r/pull/2"}']);
  assert.strictEqual(box.run(['skip', 'LAR-2', '--reason', 'x']).code, 1); // done is done
  box.run(['stop', '--reason', 'done']);
  box.run(['start', '--tickets', box.tickets([T('LAR-9')])]);
  assert.deepStrictEqual(box.runJson().tickets.map((tk) => tk.id), ['LAR-9']);
});

test('estimatesBlocked lists each configured team key', () => {
  const box = sandbox();
  writeFileSync(box.env.ABW_CONFIG, 'teams: [LAR, OPS]\n');
  const r = box.run(['preflight', '--linear-estimates=disabled']);
  assert.strictEqual(r.json.estimatesBlocked,
    'Turn on T-shirt estimates: Linear → Settings → Teams → LAR, OPS → Estimates');
});

test('start: id must look like ABC-123 and size must be S, M, L or XL', () => {
  const box = sandbox();
  for (const bad of [{ id: 'lar-1' }, { id: 'LAR1' }, { id: 'LAR-1\nx' }, { id: 'LAR-1; rm' },
    { size: 's' }, { size: 'XXL' }, { size: '' }]) {
    const r = box.run(['start', '--tickets', box.tickets([T('LAR-1', bad)])]);
    assert.strictEqual(r.code, 1, JSON.stringify(bad));
    assert.ok(r.json.error, JSON.stringify(bad));
  }
  const ok = box.run(['start', '--tickets', box.tickets(
    ['S', 'M', 'L', 'XL'].map((size, i) => T(`ENG-${i + 1}`, { size })))]);
  assert.strictEqual(ok.code, 0, ok.stdout);
});

test('stop: tickets still running become capped, record no cost, and are carried to the next run', () => {
  const box = started([T('LAR-1'), T('LAR-2')]);
  box.run(['begin', 'LAR-1']);
  box.snapshot({ five: 40, seven: 20 });
  assert.strictEqual(box.run(['stop', '--reason', 'user stop']).code, 0);
  const tk = box.runJson().tickets[0];
  assert.deepStrictEqual([tk.status, tk.reason], ['capped', 'run stopped mid-ticket']);
  assert.ok(!existsSync(path.join(box.env.ABW_STATE_DIR, 'history.json')));
  assert.strictEqual(tk.delta5h, undefined);
  const r = box.run(['start', '--tickets', box.tickets([T('LAR-9')])]);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(box.runJson().tickets.map((t) => [t.id, t.status]),
    [['LAR-1', 'capped'], ['LAR-9', 'queued']]);
});

test('heartbeat: a stopped run is left untouched and reports skipped', () => {
  const box = started();
  box.run(['stop', '--reason', 'done'], { ABW_NOW: String(NOW + 10) });
  const before = readFileSync(path.join(box.env.ABW_STATE_DIR, 'run.json'), 'utf8');
  const r = box.run(['heartbeat'], { ABW_NOW: String(NOW + 500) });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.json, { skipped: 'inactive' });
  assert.strictEqual(readFileSync(path.join(box.env.ABW_STATE_DIR, 'run.json'), 'utf8'), before);
});

// --- live review SEC1 --------------------------------------------------------------------------

test('debrief: a $(…) in an untrusted title does not survive into the file', () => {
  const box = started([T('LAR-1', { title: 'Fix $(touch PWNED) and `id` now' })]);
  box.run(['stop', '--reason', 'done $(id)']);
  const r = box.run(['debrief']);
  assert.strictEqual(r.code, 0, r.stdout);
  const text = readFileSync(r.json.path, 'utf8');
  assert.ok(text.includes('touch PWNED'), text);
  assert.doesNotMatch(text, /\$|\(touch|\(id/);
});

test('debrief: a forged run.json pointing the debrief at ~/.zshenv writes nothing', () => {
  const box = started([T('LAR-1')]);
  box.run(['stop', '--reason', 'x']);
  const zshenv = path.join(box.env.HOME, '.zshenv');
  writeJson(path.join(box.env.ABW_STATE_DIR, 'run.json'), { ...box.runJson(), debriefPath: zshenv });
  const r = box.run(['debrief']);
  assert.strictEqual(r.code, 1, r.stdout);
  assert.match(r.json.error, /"debriefPath" must be in the runs dir/);
  assert.strictEqual(existsSync(zshenv), false);
});

// Live review TST2: every case below has a real .git directory, so only the under-the-root check
// can reject it.
test('start: a git repo outside the repos root is rejected, by prefix or by symlink', () => {
  const sibling = path.join(`${REPOS}-evil`, 'bad');
  mkdirSync(path.join(sibling, '.git'), { recursive: true });
  const outside = path.join(tmpRoot('abw-outside-'), 'repo');
  mkdirSync(path.join(outside, '.git'), { recursive: true });
  const linkOut = path.join(REPOS, 'link-to-outside');
  const linkSib = path.join(REPOS, 'link-to-sibling');
  symlinkSync(outside, linkOut);
  symlinkSync(sibling, linkSib);
  const box = sandbox();
  for (const repo of [sibling, linkOut, linkSib]) {
    const r = box.run(['start', '--tickets', box.tickets([T('LAR-1', { repo })])]);
    assert.strictEqual(r.code, 1, repo);
    assert.match(r.json.error, /is not under/, repo);
  }
});

// --- live review COR2 / COR3 -------------------------------------------------------------------

test('finish: only a pr outcome records cost; capped, handoff and failed do not', () => {
  const box = started([T('LAR-1'), T('LAR-2'), T('LAR-3')]);
  for (const id of ['LAR-1', 'LAR-2', 'LAR-3']) box.run(['begin', id]);
  box.snapshot({ five: 30 });
  for (const [id, result] of [
    ['LAR-1', '{"outcome":"capped","reason":"cap"}'],
    ['LAR-2', '{"outcome":"handoff","reason":"two designs"}'],
    ['LAR-3', '{"outcome":"failed","reason":"no worktree"}'],
  ]) {
    const r = box.run(['finish', id, '--result', result]);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.strictEqual(r.json.recorded, false, id);
    assert.strictEqual(r.json.delta5h, 20, id); // still measured on the ticket, just not recorded
  }
  assert.strictEqual(existsSync(path.join(box.env.ABW_STATE_DIR, 'history.json')), false);
});

test('window: 7d at or above its cap is an error at once, not a 5h wait', async () => {
  const box = sandbox();
  for (const snap of [{ seven: 80 }, { five: 10, seven: 75 }]) {
    box.snapshot(snap);
    const r = box.run(['window']);
    assert.strictEqual(r.code, 1, JSON.stringify(snap));
    assert.strictEqual(r.json.error, '7d usage at or above cap');
  }
  const waited = await box.spawn(['window', '--wait'], { ABW_POLL_S: '0.05' }).done;
  assert.strictEqual(waited.code, 1);
  assert.deepStrictEqual(waited.json, { error: '7d usage at or above cap' });
  box.snapshot({ five: 10, seven: 74 });
  assert.strictEqual(box.run(['window']).code, 0);
});
