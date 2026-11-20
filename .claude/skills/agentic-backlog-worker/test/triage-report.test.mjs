import { test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTriage } from '../lib/triage-report.mjs';
import { emptyBaseline, mergeVerdicts } from '../lib/baseline.mjs';
import { parseRules } from '../lib/repo-rules.mjs';
import {
  NOW, tmpRoot, writeJson, abwEnv, runNode,
} from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
const THEMES = ['bugs', 'tests'];
const F = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, statusType: 'backlog', labels: [], project: null, parentId: null,
  updatedAt: 'u1', estimate: null, ...extra,
});
const V = (id, extra = {}) => ({
  id, title: `Ticket ${id}`, size: 'S', repo: '/opt/Developer/r', status: 'queued', theme: 'bugs', ...extra,
});
const build = (fetched, verdicts) => mergeVerdicts(emptyBaseline(), fetched, verdicts, {
  rules: parseRules(''), now: NOW, isToolkitRepo: () => false,
});

test("renderTriage: no '- [ ]' in output", () => {
  const ids = ['LAR-1', 'LAR-2'];
  const md = renderTriage({ baseline: build(ids.map((id) => F(id)), ids.map((id) => V(id))), run: null, themeOrder: THEMES });
  assert.doesNotMatch(md, /- \[ \]/);
  assert.match(md, /^# Backlog triage/m);
  for (const h of ['## Since the last run', '## Waiting on you', '## Next up', '## All tickets']) {
    assert.ok(md.includes(h), h);
  }
});

test("renderTriage: title 'a | b\\u0007 [x](y)' renders cleaned, row has exactly 8 pipes", () => {
  const title = 'a | b\u0007 [x](y)\nnext';
  const md = renderTriage({ baseline: build([F('LAR-1', { title })], [V('LAR-1', { title })]), run: null, themeOrder: THEMES });
  const row = md.split('\n').find((l) => l.startsWith('| LAR-1 |'));
  assert.ok(row, md);
  assert.strictEqual(row.match(/(?<!\\)\|/g).length, 8, row);
  assert.doesNotMatch(row, /\]\(/);
  assert.doesNotMatch(md, /\u0007/);
});

test('renderTriage: next up lists first 10 queued in queue order', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `LAR-${i + 1}`);
  const verdicts = ids.map((id, i) => V(id, { theme: i < 6 ? 'tests' : 'bugs' }));
  const md = renderTriage({ baseline: build(ids.map((id) => F(id)), verdicts), run: null, themeOrder: THEMES });
  const next = md.split('## Next up')[1].split('##')[0];
  const listed = [...next.matchAll(/LAR-\d+/g)].map((m) => m[0]);
  assert.deepStrictEqual(listed, ['LAR-7', 'LAR-8', 'LAR-9', 'LAR-10', 'LAR-11', 'LAR-12', 'LAR-1', 'LAR-2', 'LAR-3', 'LAR-4']);
});

test('renderTriage: draft PR from run appears under Waiting on you', () => {
  const run = {
    id: 'run-20270115-080000',
    tickets: [
      { id: 'LAR-1', title: 't', status: 'pr', pr: 'https://github.com/o/r/pull/9' },
      { id: 'LAR-2', title: 't', status: 'handoff', reason: 'needs a decision' },
      { id: 'LAR-3', title: 't', status: 'capped', branch: 'LAR-3/x' },
    ],
  };
  const b = build([F('LAR-4')], [V('LAR-4', { status: 'needs-repo', repo: null, theme: 'cami' })]);
  const waiting = renderTriage({ baseline: b, run, themeOrder: THEMES }).split('## Waiting on you')[1].split('## Next up')[0];
  assert.match(waiting, /LAR-1.*https:\/\/github\.com\/o\/r\/pull\/9/);
  assert.match(waiting, /LAR-2.*needs a decision/);
  assert.match(waiting, /LAR-3/);
  assert.match(waiting, /cami.*LAR-4/);
});

test('renderTriage: since the last run lists lastDelta ids', () => {
  const b = { ...build([F('LAR-1')], [V('LAR-1')]), lastDelta: { new: ['LAR-1'], changed: [], removed: ['LAR-9'] } };
  const since = renderTriage({ baseline: b, run: null, themeOrder: THEMES }).split('## Since the last run')[1].split('##')[0];
  assert.match(since, /New: LAR-1/);
  assert.match(since, /Gone from backlog: LAR-9/);
});

// --- CLI -------------------------------------------------------------------------------------

function sandbox() {
  const root = tmpRoot('abw-report-');
  const repos = tmpRoot('abw-repos-');
  const repo = path.join(repos, 'x');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = { ...abwEnv(root), ABW_REPOS_ROOT: repos, ABW_REPO_RULES: path.join(root, 'rules.yml') };
  const run = (args) => {
    const r = runNode(CLI, { args, env });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
    return { code: r.status, json, out: r.stdout + r.stderr };
  };
  return { root, env, repo, run, file: (n, v) => writeJson(path.join(root, n), v) };
}

test('merge writes TRIAGE.md and returns its path', () => {
  const box = sandbox();
  const r = box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]),
    '--verdicts', box.file('v.json', [V('LAR-1', { repo: box.repo })])]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.json.triagePath, path.join(box.env.ABW_RUNS_DIR, 'TRIAGE.md'));
  assert.match(readFileSync(r.json.triagePath, 'utf8'), /\| LAR-1 \|/);
});

test('debrief: rewrites TRIAGE.md when a baseline exists, skips it when none', () => {
  const box = sandbox();
  writeJson(box.env.ABW_SNAPSHOT, { captured_at: NOW - 30, rate_limits: { five_hour: { used_percentage: 5, resets_at: NOW + 3600 } } });
  const tickets = box.file('t.json', [V('LAR-1', { repo: box.repo })]);
  assert.strictEqual(box.run(['start', '--tickets', tickets]).code, 0);
  assert.strictEqual(box.run(['debrief']).code, 0);
  const triage = path.join(box.env.ABW_RUNS_DIR, 'TRIAGE.md');
  assert.strictEqual(existsSync(triage), false);
  box.run(['merge', '--fetched', box.file('f.json', [F('LAR-2')]),
    '--verdicts', box.file('v.json', [V('LAR-2', { repo: box.repo })])]);
  assert.strictEqual(box.run(['stop', '--reason', 'test']).code, 0);
  const before = readFileSync(triage, 'utf8');
  assert.strictEqual(box.run(['debrief']).code, 0);
  assert.match(readFileSync(triage, 'utf8'), /\| LAR-2 \|/);
  assert.ok(before.length > 0);
});

test('renderTriage: a long id list is capped at 20 with a count of the rest', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `LAR-${i + 1}`);
  const b = { ...build([F('LAR-1')], [V('LAR-1')]), lastDelta: { new: ids, changed: [], removed: [] } };
  const since = renderTriage({ baseline: b, run: null, themeOrder: THEMES }).split('## Since the last run')[1].split('##')[0];
  assert.match(since, /LAR-20, \+5 more/);
  assert.doesNotMatch(since, /LAR-21/);
});

test('R2: merge replaces a symlinked TRIAGE.md instead of writing through it', () => {
  const box = sandbox();
  mkdirSync(box.env.ABW_RUNS_DIR, { recursive: true });
  const target = path.join(box.root, 'victim.txt');
  writeFileSync(target, 'untouched\n');
  symlinkSync(target, path.join(box.env.ABW_RUNS_DIR, 'TRIAGE.md'));
  const r = box.run(['merge', '--fetched', box.file('f.json', [F('LAR-1')]),
    '--verdicts', box.file('v.json', [V('LAR-1', { repo: box.repo })])]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(readFileSync(target, 'utf8'), 'untouched\n');
  assert.strictEqual(lstatSync(r.json.triagePath).isSymbolicLink(), false);
});
