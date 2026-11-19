import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../lib/config.mjs';
import {
  RunStateError, loadRun, saveRun, newRun, heartbeat, setTicket,
  loadHistory, recordCost, expectedCost, affordable,
} from '../lib/run-state.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'abw-run-state-'));
let n = 0;
const freshDir = () => path.join(tmp, `d${n++}`);
const cfg = { ...DEFAULTS };
const hist = (size, deltas, extra = {}) =>
  deltas.map((delta5h) => ({ size, delta5h, tokens: 1, shared: false, at: 1, ...extra }));

test('expectedCost uses priors with no history', () => {
  assert.strictEqual(expectedCost('S', [], cfg), 5);
  assert.strictEqual(expectedCost('M', [], cfg), 12);
});

test('expectedCost is p75 nearest-rank with 3+ samples', () => {
  assert.strictEqual(expectedCost('S', hist('S', [2, 3, 9]), cfg), 9);
  assert.strictEqual(expectedCost('S', hist('S', [9, 1, 2, 3]), cfg), 3);
});

test('expectedCost keeps the prior with only 2 samples', () => {
  assert.strictEqual(expectedCost('S', hist('S', [2, 3]), cfg), 5);
});

test('expectedCost excludes shared samples and other sizes', () => {
  const h = [...hist('S', [2, 3]), ...hist('S', [90], { shared: true }), ...hist('M', [50])];
  assert.strictEqual(expectedCost('S', h, cfg), 5);
});

test('expectedCost is Infinity for sizes without a prior', () => {
  for (const s of ['L', 'XL', 'x', undefined]) {
    assert.strictEqual(expectedCost(s, [], cfg), Infinity);
  }
});

test('affordable: M at 60 is ok, projected 72', () => {
  assert.deepStrictEqual(
    affordable({ current5h: 60, size: 'M', inFlight: 0, history: [], config: cfg }),
    { ok: true, projected: 72 },
  );
});

test('affordable: strict less-than against the cap', () => {
  const r = affordable({ current5h: 64, size: 'M', inFlight: 0, history: [], config: cfg });
  assert.deepStrictEqual(r, { ok: false, projected: 76 });
  const edge = affordable({ current5h: 63, size: 'M', inFlight: 0, history: [], config: cfg });
  assert.strictEqual(edge.ok, false); // 75 is not < 75
  assert.strictEqual(edge.projected, 75);
});

test('affordable: inFlight multiplies the expected cost', () => {
  const r = affordable({ current5h: 50, size: 'M', inFlight: 1, history: [], config: cfg });
  assert.deepStrictEqual(r, { ok: true, projected: 74 });
  const r2 = affordable({ current5h: 52, size: 'M', inFlight: 1, history: [], config: cfg });
  assert.strictEqual(r2.ok, false);
});

test('affordable: L, XL and unknown sizes are never ok', () => {
  for (const size of ['L', 'XL', 'weird']) {
    const r = affordable({ current5h: 0, size, inFlight: 0, history: [], config: cfg });
    assert.strictEqual(r.ok, false);
  }
});

test('saveRun then loadRun round-trips and creates the dir', () => {
  const dir = path.join(freshDir(), 'nested');
  const run = newRun({ now: 1000, window: { resetsAt: 2000, source: 'snapshot' } });
  saveRun(dir, run);
  assert.deepStrictEqual(loadRun(dir), run);
  assert.strictEqual(statSync(dir).mode & 0o777, 0o700);
  assert.deepStrictEqual(readdirSync(dir), ['run.json']); // no temp files left behind
});

test('loadRun returns null when run.json is missing', () => {
  assert.strictEqual(loadRun(freshDir()), null);
});

test('loadRun throws RunStateError on corrupt or incomplete run.json', () => {
  for (const body of ['{not json', '{"id":"r","active":true}', '{"active":true,"tickets":[]}', '[]', 'null']) {
    const dir = freshDir();
    saveRun(dir, newRun({ now: 1, window: { resetsAt: 2, source: 'user' } }));
    writeFileSync(path.join(dir, 'run.json'), body);
    assert.throws(() => loadRun(dir), RunStateError, body);
  }
});

test('loadRun throws RunStateError when run.json is unreadable', () => {
  const dir = freshDir();
  // A directory at run.json makes readFileSync fail with EISDIR rather than ENOENT.
  mkdirSync(path.join(dir, 'run.json'), { recursive: true });
  assert.throws(() => loadRun(dir), RunStateError);
});

test('newRun builds a UTC id and initial fields', () => {
  const now = Date.UTC(2026, 10, 18, 9, 5, 7) / 1000;
  const run = newRun({ now, window: { resetsAt: now + 100, source: 'user' } });
  assert.deepStrictEqual(run, {
    id: 'run-20261118-090507',
    active: true,
    startedAt: now,
    heartbeatAt: now,
    window: { resetsAt: now + 100, source: 'user' },
    tickets: [],
  });
});

test('heartbeat and setTicket mutate and return the run', () => {
  const run = newRun({ now: 1, window: { resetsAt: 2, source: 'user' } });
  run.tickets.push({ id: 'LAR-1', title: 't', size: 'S', repo: 'r', status: 'queued' });
  assert.strictEqual(heartbeat(run, 50), run);
  assert.strictEqual(run.heartbeatAt, 50);
  assert.strictEqual(setTicket(run, 'LAR-1', { status: 'running', branch: 'b' }), run);
  assert.deepStrictEqual(run.tickets[0],
    { id: 'LAR-1', title: 't', size: 'S', repo: 'r', status: 'running', branch: 'b' });
  assert.throws(() => setTicket(run, 'LAR-9', { status: 'pr' }), RunStateError);
});

test('recordCost appends to history.json and loadHistory reads it', () => {
  const dir = freshDir();
  assert.deepStrictEqual(loadHistory(dir), []);
  recordCost(dir, { size: 'S', delta5h: 4, tokens: 100, shared: false });
  recordCost(dir, { size: 'M', delta5h: 11, tokens: 200, shared: true });
  const h = loadHistory(dir);
  assert.strictEqual(h.length, 2);
  assert.deepStrictEqual(h.map(({ at, ...rest }) => rest), [
    { size: 'S', delta5h: 4, tokens: 100, shared: false },
    { size: 'M', delta5h: 11, tokens: 200, shared: true },
  ]);
  assert.ok(Number.isInteger(h[0].at));
});

test('a corrupt history.json is empty history and does not throw', () => {
  const dir = freshDir();
  recordCost(dir, { size: 'S', delta5h: 4, tokens: 1, shared: false });
  writeFileSync(path.join(dir, 'history.json'), '{oops');
  assert.deepStrictEqual(loadHistory(dir), []);
  writeFileSync(path.join(dir, 'history.json'), '{"a":1}');
  assert.deepStrictEqual(loadHistory(dir), []);
  recordCost(dir, { size: 'S', delta5h: 5, tokens: 1, shared: false });
  assert.strictEqual(loadHistory(dir).length, 1);
});
