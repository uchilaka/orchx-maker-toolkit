import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from '../scripts/backlog-worker-status.mjs';
import {
  NOW, tmpRoot, writeJson, runNode,
} from './helpers.mjs';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(SKILL, 'scripts', 'backlog-worker-status.mjs');
const tmp = tmpRoot('abw-status-');
let n = 0;
const RUNS = path.join(tmp, 'runs');

const t = (id, status, extra = {}) => ({
  id, title: `Title ${id}`, size: 'S', repo: 'r', status, ...extra,
});
// Writes a run.json into a fresh dir and returns the dir.
function dirWith(run) {
  const dir = path.join(tmp, `d${n++}`);
  writeJson(path.join(dir, 'run.json'), {
    id: 'r1', active: false, startedAt: NOW - 3600, heartbeatAt: NOW - 120,
    window: { resetsAt: NOW + 1000, source: 'x' }, tickets: [], ...run,
  });
  return dir;
}
const rep = (run) => report({ now: NOW, dir: dirWith(run), runsDir: RUNS });

test('no run.json gives null', () => {
  const dir = path.join(tmp, `d${n++}`);
  mkdirSync(dir);
  assert.strictEqual(report({ now: NOW, dir, runsDir: RUNS }), null);
});

test('inactive run with no open tickets gives null', () => {
  assert.strictEqual(rep({ tickets: [t('LAR-1', 'pr', { pr: 'u' }), t('LAR-2', 'skipped')] }), null);
});

test('inactive run with only queued/running tickets gives null', () => {
  assert.strictEqual(rep({ tickets: [t('LAR-1', 'queued'), t('LAR-2', 'running')] }), null);
});

test('active run with fresh heartbeat is in progress and lists running tickets', () => {
  const out = rep({
    active: true, heartbeatAt: NOW - 120,
    tickets: [t('LAR-1', 'running', { branch: 'LAR-1/x' }), t('LAR-2', 'pr', { pr: 'u' })],
  });
  assert.ok(out.startsWith('## Backlog worker: run in progress'));
  assert.match(out, /\*\*Running\*\*\n- LAR-1 Title LAR-1 — LAR-1\/x/);
  assert.doesNotMatch(out, /LAR-2/);
  assert.doesNotMatch(out, /Resume with/);
});

test('liveness boundary: 600s is live, 601s is stopped', () => {
  const tk = [t('LAR-1', 'running')];
  assert.match(rep({ active: true, heartbeatAt: NOW - 600, tickets: tk }), /run in progress/);
  const stale = rep({ active: true, heartbeatAt: NOW - 601, tickets: tk });
  assert.match(stale, /stopped unexpectedly/);
});

test('active run with stale heartbeat says stopped unexpectedly and how to resume', () => {
  const out = rep({ active: true, heartbeatAt: NOW - 1200, tickets: [t('LAR-1', 'running')] });
  assert.match(out, /stopped unexpectedly/);
  assert.match(out, /Resume with \/agentic-backlog-worker/);
});

test('active run with no open tickets still reports', () => {
  const out = rep({ active: true, tickets: [t('LAR-1', 'pr', { pr: 'u' })] });
  assert.match(out, /run in progress/);
});

test('inactive run lists capped and handed-off tickets under separate labels', () => {
  const out = rep({
    tickets: [
      t('LAR-1', 'capped', { branch: 'LAR-1/a' }),
      t('LAR-2', 'handoff', { pr: 'https://gh/pr/2', branch: 'LAR-2/b' }),
      t('LAR-3', 'capped'),
    ],
  });
  assert.match(out, /\*\*Capped \(resumable\)\*\*\n- LAR-1 Title LAR-1 — LAR-1\/a\n- LAR-3 Title LAR-3 — \(no branch\)/);
  assert.match(out, /\*\*Handed off\*\*\n- LAR-2 Title LAR-2 — https:\/\/gh\/pr\/2/);
  assert.match(out, /Resume with \/agentic-backlog-worker/);
});

test('queued tickets of an active run count as open', () => {
  const out = rep({ active: true, tickets: [t('LAR-1', 'queued')] });
  assert.match(out, /LAR-1/);
});

test('more than 5 tickets are capped with an overflow line naming the run file', () => {
  const tickets = Array.from({ length: 8 }, (_, i) => t(`LAR-${i}`, 'capped'));
  const out = rep({ startedAt: Date.UTC(2027, 0, 15, 23, 59) / 1000, tickets });
  assert.strictEqual(out.split('\n').filter((l) => l.startsWith('- ')).length, 5);
  assert.ok(out.includes(`_…and 3 more — see ${path.join(RUNS, 'RUN_2027-01-15.md')}._`));
});

test('the overflow line names the run file the debrief recorded', () => {
  const tickets = Array.from({ length: 6 }, (_, i) => t(`LAR-${i}`, 'capped'));
  const out = rep({ debriefPath: '/x/RUN_2027-01-15-2.md', tickets });
  assert.ok(out.includes('see /x/RUN_2027-01-15-2.md._'));
});

test('acknowledged (closed-out) tickets are not surfaced', () => {
  const ack = { acknowledged: true };
  assert.strictEqual(rep({ tickets: [t('LAR-1', 'capped', ack), t('LAR-2', 'handoff', ack)] }), null);
  const out = rep({ tickets: [t('LAR-1', 'capped', ack), t('LAR-2', 'handoff')] });
  assert.doesNotMatch(out, /LAR-1/);
  assert.match(out, /LAR-2/);
});

test('exactly 5 tickets give no overflow line', () => {
  const tickets = Array.from({ length: 5 }, (_, i) => t(`LAR-${i}`, 'capped'));
  assert.doesNotMatch(rep({ tickets }), /more — see/);
});

test('corrupt run.json is reported, not silent', () => {
  const dir = path.join(tmp, `d${n++}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'run.json'), '{nope');
  const out = report({ now: NOW, dir, runsDir: RUNS });
  assert.ok(out.startsWith(`Backlog worker: couldn't read ${path.join(dir, 'run.json')} (`));
});

test('CLI exits 0 with empty stdout when there is no run', () => {
  const dir = path.join(tmp, `d${n++}`);
  mkdirSync(dir);
  const r = runNode(SCRIPT, { env: { ABW_STATE_DIR: dir, ABW_RUNS_DIR: RUNS } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('CLI exits 0 and reports a corrupt run', () => {
  const dir = path.join(tmp, `d${n++}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'run.json'), '{nope');
  const r = runNode(SCRIPT, { env: { ABW_STATE_DIR: dir, ABW_RUNS_DIR: RUNS } });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^Backlog worker: couldn't read /);
});

test('install/hooks.json parses and its command exists in the skill dir', () => {
  const hooks = JSON.parse(readFileSync(path.join(SKILL, 'install', 'hooks.json'), 'utf8'));
  const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.ok(cmd.startsWith('{{SKILL_DIR}}/'));
  assert.ok(existsSync(path.join(SKILL, cmd.replace('{{SKILL_DIR}}/', ''))));
});

test('ticket lines are sanitized: newlines, markdown and HTML in untrusted fields', () => {
  const out = rep({
    tickets: [t('LAR-1', 'capped', {
      title: 'Fix\n## injected [x](http://e) <b>hi</b> `code` a|b',
      branch: 'br\nanch',
    })],
  });
  const line = out.split('\n').find((l) => l.startsWith('- LAR-1'));
  assert.ok(line, out);
  assert.ok(!line.includes('\n'));
  assert.ok(!line.includes('<b>'));
  assert.ok(!line.includes('`'));
  assert.ok(line.includes('\\[x\\]'));
  assert.ok(!out.includes('\n## injected'));
});
