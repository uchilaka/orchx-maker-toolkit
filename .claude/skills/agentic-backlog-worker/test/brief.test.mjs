import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, readFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queueOrder } from '../lib/baseline.mjs';
import {
  NOW, tmpRoot, writeJson, abwEnv, runNode,
} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
const F = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, statusType: 'backlog', labels: [], project: null, parentId: null,
  updatedAt: 'u1', estimate: null, ...extra,
});

function sandbox() {
  const root = tmpRoot('abw-brief-');
  const repos = tmpRoot('abw-repos-');
  const repo = path.join(repos, 'x');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = { ...abwEnv(root), ABW_REPOS_ROOT: repos, ABW_REPO_RULES: path.join(root, 'rules.yml') };
  writeJson(env.ABW_SNAPSHOT, { captured_at: NOW - 30, rate_limits: { five_hour: { used_percentage: 5, resets_at: NOW + 3600 } } });
  const run = (args, extra = {}) => {
    const r = runNode(CLI, { args, env: { ...env, ...extra } });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
    return { code: r.status, json, out: r.stdout + r.stderr };
  };
  // Fetched files are stamped at NOW: merge takes triagedAt from the fetch file's mtime.
  const file = (n, v) => {
    const f = writeJson(path.join(root, n), v);
    utimesSync(f, NOW, NOW);
    return f;
  };
  const V = (id, extra = {}) => ({ id, title: `Ticket ${id}`, size: 'S', repo, status: 'queued', theme: 'bugs', ...extra });
  const baseline = () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'baseline.json'), 'utf8'));
  return { env, run, file, V, baseline, statePath: (n) => path.join(env.ABW_STATE_DIR, n) };
}

test('brief: no baseline → {baseline:false, reconcileDue:true}', () => {
  const box = sandbox();
  const r = box.run(['brief']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.json.baseline, false);
  assert.strictEqual(r.json.reconcileDue, true);
  assert.strictEqual(r.json.fetchSince, null);
});

test('brief: reconciledAt 15 days before NOW with default 14 → reconcileDue true', () => {
  const box = sandbox();
  const f = box.file('f.json', [F('LAR-1')]);
  utimesSync(f, NOW - 15 * 86400, NOW - 15 * 86400);
  box.run(['merge', '--fetched', f, '--verdicts', box.file('v.json', [box.V('LAR-1')])],
    { ABW_NOW: String(NOW - 15 * 86400) });
  assert.strictEqual(box.run(['brief']).json.reconcileDue, true);
  assert.strictEqual(box.run(['brief'], { ABW_NOW: String(NOW - 14 * 86400) }).json.reconcileDue, false);
});

test('brief: fetchSince = triagedAt − 600 as ISO; carries counts, nextUp, needsRepo, lastDelta', () => {
  const box = sandbox();
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1'), F('LAR-2')]),
    '--verdicts', box.file('v.json', [box.V('LAR-1'), box.V('LAR-2', { status: 'needs-repo', repo: null, theme: 'cami' })])]);
  const r = box.run(['brief']);
  assert.strictEqual(r.json.baseline, true);
  assert.strictEqual(r.json.fetchSince, new Date((NOW - 600) * 1000).toISOString());
  assert.deepStrictEqual(r.json.counts, { queued: 1, 'needs-repo': 1 });
  assert.deepStrictEqual(r.json.nextUp, [{ id: 'LAR-1', size: 'S', repo: 'x' }]);
  assert.deepStrictEqual(r.json.waiting.needsRepo, { cami: ['LAR-2'] });
  assert.deepStrictEqual(r.json.lastDelta, { new: ['LAR-1', 'LAR-2'], changed: [], removed: [] });
  assert.match(r.json.triagePath, /TRIAGE\.md$/);
});

test('brief: ticket text is cleaned', () => {
  const box = sandbox();
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]),
    '--verdicts', box.file('v.json', [box.V('LAR-1', { status: 'needs-repo', repo: null, theme: 'x`$(rm)`' })])]);
  const r = box.run(['brief']);
  const [group] = Object.keys(r.json.waiting.needsRepo);
  assert.doesNotMatch(group, /[`$()]/);
});

test('finish: pr outcome sets worked.pr; queueOrder then omits the ticket; brief lists the PR', () => {
  const box = sandbox();
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1'), F('LAR-2')]),
    '--verdicts', box.file('v.json', [box.V('LAR-1'), box.V('LAR-2')])]);
  assert.strictEqual(box.run(['start', '--tickets', box.statePath('triage.json')]).code, 0);
  assert.strictEqual(box.run(['begin', 'LAR-1']).code, 0);
  const pr = 'https://github.com/o/r/pull/9';
  const f = box.run(['finish', 'LAR-1', '--result', JSON.stringify({ outcome: 'pr', pr, branch: 'LAR-1/x' })]);
  assert.strictEqual(f.code, 0, f.out);
  const b = box.baseline();
  assert.strictEqual(b.tickets['LAR-1'].worked.pr, pr);
  assert.strictEqual(b.tickets['LAR-1'].worked.status, 'pr');
  assert.match(b.tickets['LAR-1'].worked.runId, /^run-/);
  assert.deepStrictEqual(queueOrder(b, ['bugs']).map((t) => t.id), ['LAR-2']);
  assert.deepStrictEqual(box.run(['brief']).json.waiting.prs, [{ id: 'LAR-1', pr }]);
});

test('finish: no baseline → finish still succeeds', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['start', '--tickets', box.file('t.json', [box.V('LAR-1')])]).code, 0);
  box.run(['begin', 'LAR-1']);
  const f = box.run(['finish', 'LAR-1', '--result', JSON.stringify({ outcome: 'handoff', reason: 'needs a call' })]);
  assert.strictEqual(f.code, 0, f.out);
});

test('I5: a corrupt baseline does not break finish; it warns and records the cost', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['start', '--tickets', box.file('t.json', [box.V('LAR-1')])]).code, 0);
  box.run(['begin', 'LAR-1']);
  writeJson(box.statePath('baseline.json'), '{corrupt');
  const f = box.run(['finish', 'LAR-1', '--result', JSON.stringify({ outcome: 'pr', pr: 'https://github.com/o/r/pull/1' })]);
  assert.strictEqual(f.code, 0, f.out);
  assert.match(f.json.warning, /baseline unreadable/);
  const d = box.run(['debrief']);
  assert.strictEqual(d.code, 0, d.out);
  assert.match(d.json.warning, /baseline unreadable/);
});
