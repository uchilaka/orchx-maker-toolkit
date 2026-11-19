import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRules, loadRules, resolveRepo, appendRule,
} from '../lib/repo-rules.mjs';
import { tmpRoot, abwEnv, runNode } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
// The toolkit checkout this test runs from: <root>/.claude/skills/agentic-backlog-worker/test.
const TOOLKIT = path.resolve(path.dirname(CLI), '..', '..', '..', '..');

test('parseRules: project and ticket lines; ticket wins in resolveRepo', () => {
  const rules = parseRules([
    '# answers from triage',
    'project/CAMI v1.0: /opt/Developer/cami-ritv',
    'ticket/LAR-50: /opt/Developer/sails-app',
    '',
  ].join('\n'));
  assert.strictEqual(resolveRepo(rules, { id: 'LAR-9', project: 'CAMI v1.0' }), '/opt/Developer/cami-ritv');
  assert.strictEqual(resolveRepo(rules, { id: 'LAR-50', project: 'CAMI v1.0' }), '/opt/Developer/sails-app');
  assert.strictEqual(resolveRepo(rules, { id: 'LAR-1', project: null }), null);
});

test("parseRules: project name 'Ops: Q4 #2' round-trips through appendRule", () => {
  const file = path.join(tmpRoot('abw-rules-'), 'repo-rules.yml');
  appendRule(file, 'project/Ops: Q4 #2', '/opt/Developer/ops');
  const rules = loadRules(file);
  assert.strictEqual(resolveRepo(rules, { id: 'LAR-1', project: 'Ops: Q4 #2' }), '/opt/Developer/ops');
});

test("parseRules: 'repo/x: /a' throws unknown prefix", () => {
  assert.throws(() => parseRules('repo/x: /a\n'), /unknown rule prefix/);
  assert.throws(() => parseRules('project/x /a\n'), /invalid rule line/);
  assert.throws(() => parseRules('project/x: relative\n'), /invalid rule line/);
});

test('appendRule: same key replaces, not duplicates', () => {
  const file = path.join(tmpRoot('abw-rules-'), 'repo-rules.yml');
  appendRule(file, 'ticket/LAR-1', '/opt/Developer/a');
  appendRule(file, 'project/P', '/opt/Developer/p');
  appendRule(file, 'ticket/LAR-1', '/opt/Developer/b');
  const text = readFileSync(file, 'utf8');
  assert.strictEqual(text.match(/ticket\/LAR-1:/g).length, 1);
  assert.strictEqual(resolveRepo(loadRules(file), { id: 'LAR-1', project: 'P' }), '/opt/Developer/b');
});

test('loadRules: a missing file is no rules', () => {
  const rules = loadRules(path.join(tmpRoot('abw-rules-'), 'nope.yml'));
  assert.strictEqual(resolveRepo(rules, { id: 'LAR-1', project: 'P' }), null);
});

// --- CLI -------------------------------------------------------------------------------------

function sandbox(reposRoot) {
  const root = tmpRoot('abw-rule-cli-');
  const env = { ...abwEnv(root), ABW_REPOS_ROOT: reposRoot, ABW_REPO_RULES: path.join(root, 'rules.yml') };
  return {
    env,
    run(args) {
      const r = runNode(CLI, { args, env });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
      return { code: r.status, json, out: r.stdout + r.stderr };
    },
  };
}

test('CLI rule project/X <toolkit path> → exit 1, file unchanged', () => {
  const box = sandbox(path.dirname(TOOLKIT));
  const r = box.run(['rule', 'project/X', TOOLKIT]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.json.error, /toolkit/);
  assert.strictEqual(existsSync(box.env.ABW_REPO_RULES), false);
});

test('CLI rule project/X <path outside repos root> → exit 1', () => {
  const repos = tmpRoot('abw-repos-');
  const outside = tmpRoot('abw-outside-');
  mkdirSync(path.join(outside, '.git'));
  const box = sandbox(repos);
  const r = box.run(['rule', 'project/X', outside]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.json.error, /not under/);
});

test('CLI rule ticket/LAR-1 <valid repo> → {ok, key, repo}', () => {
  const repos = tmpRoot('abw-repos-');
  const repo = path.join(repos, 'x');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const box = sandbox(repos);
  const r = box.run(['rule', 'ticket/LAR-1', repo]);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.json, { ok: true, key: 'ticket/LAR-1', repo });
  assert.match(readFileSync(box.env.ABW_REPO_RULES, 'utf8'), /^ticket\/LAR-1: /m);
});

test('CLI rule with a bad key → exit 1', () => {
  const repos = tmpRoot('abw-repos-');
  const repo = path.join(repos, 'x');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const box = sandbox(repos);
  for (const key of ['ticket/lar 1', 'project/', 'other/x', 'project/a\nticket/LAR-2']) {
    const r = box.run(['rule', key, repo]);
    assert.strictEqual(r.code, 1, `${key}: ${r.out}`);
  }
  // A pre-existing rules file stays as it was after rejected writes.
  writeFileSync(box.env.ABW_REPO_RULES, 'ticket/LAR-9: /opt/Developer/z\n');
  box.run(['rule', 'other/x', repo]);
  assert.strictEqual(readFileSync(box.env.ABW_REPO_RULES, 'utf8'), 'ticket/LAR-9: /opt/Developer/z\n');
});
