import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyBaseline, mergeVerdicts, queueOrder, estimatesNeeded, computeDelta,
} from '../lib/baseline.mjs';
import { parseRules } from '../lib/repo-rules.mjs';
import {
  NOW, tmpRoot, writeJson, abwEnv, runNode,
} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
const TOOLKIT = path.resolve(path.dirname(CLI), '..', '..', '..', '..');
const THEMES = ['bugs', 'security', 'tests', 'features'];

const F = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, statusType: 'backlog', labels: [], project: null, parentId: null,
  updatedAt: '2027-01-15T07:00:00.000Z', estimate: null, ...extra,
});
const V = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, size: 'S', repo: '/r', status: 'queued', theme: 'bugs', ...extra,
});
const NO_RULES = parseRules('');
const opts = (extra = {}) => ({
  rules: NO_RULES, now: NOW, reconcile: false, isToolkitRepo: () => false, ...extra,
});

test('merge: needs-repo with a matching project rule → queued with that repo', () => {
  const rules = parseRules('project/CAMI: /opt/Developer/cami-ritv\n');
  const b = mergeVerdicts(emptyBaseline(), [F('LAR-1', { project: 'CAMI' })],
    [V('LAR-1', { status: 'needs-repo', repo: null, theme: 'cami' })], opts({ rules }));
  assert.strictEqual(b.tickets['LAR-1'].status, 'queued');
  assert.strictEqual(b.tickets['LAR-1'].repo, '/opt/Developer/cami-ritv');
});

test('merge: queued toolkit repo → skipped with toolkit reason', () => {
  const b = mergeVerdicts(emptyBaseline(), [F('LAR-1')], [V('LAR-1', { repo: '/tk' })],
    opts({ isToolkitRepo: (r) => r === '/tk' }));
  assert.deepStrictEqual(
    [b.tickets['LAR-1'].status, b.tickets['LAR-1'].repo, b.tickets['LAR-1'].reason],
    ['skipped', null, "repo is the backlog worker's own toolkit"],
  );
});

test('merge: removed ids leave the baseline; lastDelta lists new, changed and removed', () => {
  let b = mergeVerdicts(emptyBaseline(), [F('LAR-1'), F('LAR-2')], [V('LAR-1'), V('LAR-2')], opts());
  const fetched = [F('LAR-1', { updatedAt: 'later' }), F('LAR-2', { statusType: 'completed' }), F('LAR-3')];
  b = mergeVerdicts(b, fetched, [V('LAR-1', { size: 'M' }), V('LAR-3')], opts());
  assert.deepStrictEqual(Object.keys(b.tickets).sort(), ['LAR-1', 'LAR-3']);
  assert.deepStrictEqual(b.lastDelta, { new: ['LAR-3'], changed: ['LAR-1'], removed: ['LAR-2'] });
  assert.strictEqual(b.tickets['LAR-1'].updatedAt, 'later');
});

test('merge: first merge and reconcile set reconciledAt; incremental keeps it', () => {
  let b = mergeVerdicts(emptyBaseline(), [F('LAR-1')], [V('LAR-1')], opts());
  assert.deepStrictEqual([b.triagedAt, b.reconciledAt], [NOW, NOW]);
  b = mergeVerdicts(b, [], [], opts({ now: NOW + 100 }));
  assert.deepStrictEqual([b.triagedAt, b.reconciledAt], [NOW + 100, NOW]);
  b = mergeVerdicts(b, [F('LAR-1')], [], opts({ now: NOW + 200, reconcile: true }));
  assert.strictEqual(b.reconciledAt, NOW + 200);
});

test('merge: a verdict for a ticket neither fetched nor known throws', () => {
  assert.throws(() => mergeVerdicts(emptyBaseline(), [], [V('LAR-1')], opts()), /LAR-1/);
});

test('merge: a verdict status other than queued/needs-repo/skipped throws', () => {
  assert.throws(() => mergeVerdicts(emptyBaseline(), [F('LAR-1')], [V('LAR-1', { status: 'pr' })], opts()),
    /status/);
});

test('queueOrder: themeOrder respected; unknown theme after the last; worked excluded', () => {
  const b = mergeVerdicts(emptyBaseline(),
    ['LAR-1', 'LAR-2', 'LAR-3', 'LAR-4', 'LAR-5', 'LAR-6'].map((id) => F(id)), [
      V('LAR-1', { theme: 'features' }),
      V('LAR-2', { status: 'skipped', repo: null, reason: 'Spike label' }),
      V('LAR-3', { theme: 'odd' }),
      V('LAR-4', { theme: 'bugs' }),
      V('LAR-5', { status: 'needs-repo', repo: null }),
      V('LAR-6', { theme: 'bugs' }),
    ], opts());
  b.tickets['LAR-6'].worked = { status: 'pr', runId: 'run-1' };
  const order = queueOrder(b, THEMES).map((t) => t.id);
  assert.deepStrictEqual(order, ['LAR-4', 'LAR-1', 'LAR-3', 'LAR-5', 'LAR-2']);
  const [first] = queueOrder(b, THEMES);
  assert.deepStrictEqual(Object.keys(first).sort(), ['id', 'repo', 'size', 'status', 'theme', 'title']);
});

test('estimatesNeeded: estimate 3 with size M omitted; null estimate listed with points 2 for S', () => {
  const b = mergeVerdicts(emptyBaseline(),
    [F('LAR-1', { estimate: 3 }), F('LAR-2'), F('LAR-3'), F('LAR-4', { estimate: 2 })], [
      V('LAR-1', { size: 'M' }), V('LAR-2'),
      V('LAR-3', { status: 'skipped', repo: null, reason: 'x' }), V('LAR-4', { size: 'XL' }),
    ], opts());
  assert.deepStrictEqual(estimatesNeeded(b), [
    { id: 'LAR-2', size: 'S', points: 2 }, { id: 'LAR-4', size: 'XL', points: 8 },
  ]);
});

test('computeDelta: seeded null updatedAt + same title → unchanged', () => {
  const b = { ...emptyBaseline(), tickets: { 'LAR-1': { title: 'Ticket LAR-1', updatedAt: null, size: 'S', status: 'queued' } } };
  assert.deepStrictEqual(computeDelta(b, [F('LAR-1')], {}), { classify: [], removed: [], unchanged: 1 });
  assert.deepStrictEqual(computeDelta(b, [F('LAR-1', { title: 'Renamed' })], {}).classify, ['LAR-1']);
});

test('merge: an unchanged fetched ticket refreshes updatedAt and estimate (seed fill-in)', () => {
  const b0 = { ...emptyBaseline(), tickets: { 'LAR-1': { title: 'Ticket LAR-1', updatedAt: null, estimate: null, size: 'S', status: 'queued', repo: '/r' } } };
  const b = mergeVerdicts(b0, [F('LAR-1', { estimate: 2, project: 'P' })], [], opts());
  assert.deepStrictEqual([b.tickets['LAR-1'].updatedAt, b.tickets['LAR-1'].estimate, b.tickets['LAR-1'].project],
    ['2027-01-15T07:00:00.000Z', 2, 'P']);
});

// --- CLI -------------------------------------------------------------------------------------

function sandbox(reposRoot) {
  const root = tmpRoot('abw-merge-');
  const env = {
    ...abwEnv(root), ABW_REPOS_ROOT: reposRoot, ABW_REPO_RULES: path.join(root, 'rules.yml'),
  };
  return {
    root,
    env,
    file: (name, v) => writeJson(path.join(root, name), v),
    run(args) {
      const r = runNode(CLI, { args, env });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
      return { code: r.status, json, out: r.stdout + r.stderr };
    },
    baseline: () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'baseline.json'), 'utf8')),
    triage: () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'triage.json'), 'utf8')),
  };
}

function repos() {
  const root = tmpRoot('abw-repos-');
  const repo = path.join(root, 'x');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  return { root, repo };
}

test("CLI merge output's triage.json is accepted by start --tickets", () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  const r = box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1'), F('LAR-2')]),
    '--verdicts', box.file('v.json', [V('LAR-1', { repo }), V('LAR-2', { status: 'needs-repo', repo: null })])]);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.json.counts, { queued: 1, 'needs-repo': 1 });
  assert.deepStrictEqual(r.json.estimates, [
    { id: 'LAR-1', size: 'S', points: 2 }, { id: 'LAR-2', size: 'S', points: 2 },
  ]);
  assert.deepStrictEqual(r.json.needsRepo, { bugs: ['LAR-2'] });
  writeJson(box.env.ABW_SNAPSHOT, { captured_at: NOW - 30, rate_limits: { five_hour: { used_percentage: 5, resets_at: NOW + 3600 } } });
  const s = box.run(['start', '--tickets', r.json.queue]);
  assert.strictEqual(s.code, 0, s.out);
  assert.strictEqual(s.json.tickets, 2);
});

test('CLI merge: a toolkit repo verdict lands skipped, and start accepts the queue', () => {
  const box = sandbox(path.dirname(TOOLKIT));
  const r = box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]),
    '--verdicts', box.file('v.json', [V('LAR-1', { repo: TOOLKIT })])]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(box.triage()[0].status, 'skipped');
});

test('CLI merge: a queued repo start would refuse → exit 1, nothing written', () => {
  const { root } = repos();
  const box = sandbox(root);
  const r = box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]),
    '--verdicts', box.file('v.json', [V('LAR-1', { repo: '/nowhere' })])]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(existsSync(path.join(box.env.ABW_STATE_DIR, 'baseline.json')), false);
});

test('CLI merge with no files applies new repo rules', () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1', { project: 'P' })]),
    '--verdicts', box.file('v.json', [V('LAR-1', { status: 'needs-repo', repo: null })])]);
  assert.strictEqual(box.run(['rule', 'project/P', repo]).code, 0);
  const r = box.run(['merge']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(box.baseline().tickets['LAR-1'].status, 'queued');
});

test('merge --seed: 3 verdicts → baseline with 3 tickets, updatedAt null; refuses a second seed', () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  const v = box.file('v.json', [V('LAR-1', { repo }), V('LAR-2', { repo }),
    V('LAR-3', { status: 'skipped', repo: null, reason: 'Spike label' })]);
  const r = box.run(['merge', '--seed', '--verdicts', v]);
  assert.strictEqual(r.code, 0, r.out);
  const b = box.baseline();
  assert.strictEqual(Object.keys(b.tickets).length, 3);
  assert.strictEqual(b.tickets['LAR-1'].updatedAt, null);
  assert.strictEqual(b.reconciledAt, null);
  assert.strictEqual(box.run(['merge', '--seed', '--verdicts', v]).code, 1);
});

test('touched: updates updatedAt; next delta treats ticket as unchanged', () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]), '--verdicts', box.file('v.json', [V('LAR-1', { repo })])]);
  const t = box.run(['touched', '--file', box.file('t.json', [{ id: 'LAR-1', updatedAt: 'after-write', estimate: { value: 2 } }])]);
  assert.strictEqual(t.code, 0, t.out);
  assert.deepStrictEqual(t.json, { touched: 1 });
  assert.strictEqual(box.baseline().tickets['LAR-1'].estimate, 2);
  const d = box.run(['delta', '--fetched', box.file('f2.json', [F('LAR-1', { updatedAt: 'after-write' })])]);
  assert.deepStrictEqual(d.json, { classify: [], removed: [], unchanged: 1 });
});

test('touched: unknown id → exit 1, baseline unchanged', () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]), '--verdicts', box.file('v.json', [V('LAR-1', { repo })])]);
  const before = box.baseline();
  const t = box.run(['touched', '--file', box.file('t.json', [
    { id: 'LAR-1', updatedAt: 'x' }, { id: 'LAR-9', updatedAt: 'y' }])]);
  assert.strictEqual(t.code, 1);
  assert.match(t.json.error, /LAR-9/);
  assert.deepStrictEqual(box.baseline(), before);
});

test('merge --seed: lastDelta is null, so TRIAGE.md says first triage rather than listing every ticket', () => {
  const { root, repo } = repos();
  const box = sandbox(root);
  box.run(['merge', '--seed', '--verdicts', box.file('v.json', [V('LAR-1', { repo })])]);
  assert.strictEqual(box.baseline().lastDelta, null);
});
