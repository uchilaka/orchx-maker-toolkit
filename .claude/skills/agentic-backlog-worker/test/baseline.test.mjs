import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBaseline, saveBaseline, emptyBaseline, validateFetched, computeDelta, reconcileDue,
  fetchSince,
} from '../lib/baseline.mjs';
import { RunStateError } from '../lib/run-state.mjs';
import {
  NOW, tmpRoot, writeJson, abwEnv, runNode,
} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));

// A fetched ticket as SKILL.md step 3 writes it from list_issues.
const F = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, statusType: 'backlog', labels: [], project: null, parentId: null,
  updatedAt: '2027-01-15T07:00:00.000Z', estimate: null, ...extra,
});
// A baseline ticket as merge stores it.
const B = (id, extra = {}) => ({
  title: `Ticket ${id}`, project: null, parentId: null, labels: [],
  updatedAt: '2027-01-15T07:00:00.000Z', estimate: null, size: 'S', status: 'queued',
  repo: '/r', ...extra,
});
const base = (tickets, extra = {}) => ({ ...emptyBaseline(), tickets, ...extra });

test('computeDelta: new id → classify', () => {
  const d = computeDelta(base({}), [F('LAR-1')], {});
  assert.deepStrictEqual(d, { classify: ['LAR-1'], removed: [], unchanged: 0 });
});

test('computeDelta: changed updatedAt → classify; same updatedAt → unchanged', () => {
  const b = base({ 'LAR-1': B('LAR-1'), 'LAR-2': B('LAR-2') });
  const d = computeDelta(b, [F('LAR-1', { updatedAt: '2027-01-15T07:30:00.000Z' }), F('LAR-2')], {});
  assert.deepStrictEqual(d, { classify: ['LAR-1'], removed: [], unchanged: 1 });
});

test("computeDelta: statusType 'started' → removed, not classify", () => {
  const b = base({ 'LAR-1': B('LAR-1') });
  const d = computeDelta(b, [F('LAR-1', { statusType: 'started', updatedAt: 'x' }),
    F('LAR-9', { statusType: 'completed' })], {});
  // LAR-9 was never in the baseline, so there is nothing to remove for it.
  assert.deepStrictEqual(d, { classify: [], removed: ['LAR-1'], unchanged: 0 });
});

test('computeDelta: reconcile drops baseline ids absent from fetch', () => {
  const b = base({ 'LAR-1': B('LAR-1'), 'LAR-2': B('LAR-2') });
  const d = computeDelta(b, [F('LAR-1')], { reconcile: true });
  assert.deepStrictEqual(d, { classify: [], removed: ['LAR-2'], unchanged: 1 });
});

test('computeDelta: incremental fetch keeps absent ids', () => {
  const b = base({ 'LAR-1': B('LAR-1'), 'LAR-2': B('LAR-2') });
  const d = computeDelta(b, [F('LAR-1')], {});
  assert.deepStrictEqual(d, { classify: [], removed: [], unchanged: 1 });
});

test('computeDelta: full → every eligible fetched id in classify', () => {
  const b = base({ 'LAR-1': B('LAR-1') });
  const d = computeDelta(b, [F('LAR-1'), F('LAR-2'), F('LAR-3', { statusType: 'canceled' })],
    { full: true });
  assert.deepStrictEqual(d, { classify: ['LAR-1', 'LAR-2'], removed: [], unchanged: 0 });
});

test('computeDelta: worked ticket with new updatedAt → unchanged (not classify)', () => {
  const b = base({ 'LAR-1': B('LAR-1', { worked: { status: 'pr', runId: 'run-1' } }) });
  const d = computeDelta(b, [F('LAR-1', { updatedAt: '2027-01-15T07:59:00.000Z' })], {});
  assert.deepStrictEqual(d, { classify: [], removed: [], unchanged: 1 });
});

test("computeDelta: 'unstarted' (Todo) is eligible", () => {
  const d = computeDelta(base({}), [F('LAR-1', { statusType: 'unstarted' })], {});
  assert.deepStrictEqual(d.classify, ['LAR-1']);
});

test("loadBaseline: corrupt JSON throws 'baseline unreadable'; version 2 throws", () => {
  const dir = tmpRoot('abw-bl-');
  assert.strictEqual(loadBaseline(dir), null);
  writeJson(path.join(dir, 'baseline.json'), '{nope');
  assert.throws(() => loadBaseline(dir), (e) => e instanceof RunStateError
    && /baseline unreadable/.test(e.message));
  writeJson(path.join(dir, 'baseline.json'), { ...emptyBaseline(), version: 2 });
  assert.throws(() => loadBaseline(dir), /baseline unreadable/);
});

test('saveBaseline round-trips through loadBaseline', () => {
  const dir = tmpRoot('abw-bl-');
  const b = base({ 'LAR-1': B('LAR-1') }, { triagedAt: NOW });
  saveBaseline(dir, b);
  assert.deepStrictEqual(loadBaseline(dir), b);
});

test('validateFetched: missing updatedAt throws; estimate {value:3} flattens to 3', () => {
  const { updatedAt, ...noStamp } = F('LAR-1');
  assert.throws(() => validateFetched([noStamp]), /LAR-1.*updatedAt/);
  assert.throws(() => validateFetched([F(7)]), /id/);
  assert.throws(() => validateFetched([F('LAR-1'), F('LAR-1')]), /duplicate/);
  assert.throws(() => validateFetched({}), /array/);
  const [t] = validateFetched([F('LAR-1', { estimate: { value: 3, name: 'M' } })]);
  assert.strictEqual(t.estimate, 3);
});

test('validateFetched: Linear label objects and project objects flatten to names', () => {
  const [t] = validateFetched([F('LAR-1', { labels: ['Bug', { name: 'UX' }], project: { name: 'P' } })]);
  assert.deepStrictEqual([t.labels, t.project], [['Bug', 'UX'], 'P']);
});

test('reconcileDue: null reconciledAt is due; 15 days old with 14 is due; 1 day is not', () => {
  assert.strictEqual(reconcileDue(emptyBaseline(), NOW, 14), true);
  assert.strictEqual(reconcileDue(base({}, { reconciledAt: NOW - 15 * 86400 }), NOW, 14), true);
  assert.strictEqual(reconcileDue(base({}, { reconciledAt: NOW - 86400 }), NOW, 14), false);
});

test('fetchSince: triagedAt − 600 as ISO; null without a triage', () => {
  assert.strictEqual(fetchSince(emptyBaseline()), null);
  assert.strictEqual(fetchSince(base({}, { triagedAt: NOW })),
    new Date((NOW - 600) * 1000).toISOString());
});

// --- CLI -------------------------------------------------------------------------------------

function cli(args, root) {
  const r = runNode(CLI, { args, env: abwEnv(root) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
  return { code: r.status, json, out: r.stdout + r.stderr };
}

test('CLI delta with no baseline → every fetched id to classify', () => {
  const root = tmpRoot('abw-delta-');
  const f = writeJson(path.join(root, 'fetched.json'), [F('LAR-1'), F('LAR-2')]);
  const r = cli(['delta', '--fetched', f], root);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.json, { classify: ['LAR-1', 'LAR-2'], removed: [], unchanged: 0 });
});

test('CLI delta with corrupt baseline → exit 1, baseline unreadable', () => {
  const root = tmpRoot('abw-delta-');
  const env = abwEnv(root);
  mkdirSync(env.ABW_STATE_DIR, { recursive: true });
  writeJson(path.join(env.ABW_STATE_DIR, 'baseline.json'), '[[');
  const f = writeJson(path.join(root, 'fetched.json'), [F('LAR-1')]);
  const r = cli(['delta', '--fetched', f], root);
  assert.strictEqual(r.code, 1);
  assert.match(r.json.error, /baseline unreadable/);
});

test('CLI delta --reconcile drops ids missing from the listing', () => {
  const root = tmpRoot('abw-delta-');
  const env = abwEnv(root);
  writeJson(path.join(env.ABW_STATE_DIR, 'baseline.json'),
    base({ 'LAR-1': B('LAR-1'), 'LAR-2': B('LAR-2') }));
  const f = writeJson(path.join(root, 'fetched.json'), [F('LAR-1')]);
  const r = cli(['delta', '--fetched', f, '--reconcile'], root);
  assert.deepStrictEqual(r.json, { classify: [], removed: ['LAR-2'], unchanged: 1 });
});
