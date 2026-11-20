// `worker.mjs take`: one handed-off item (ticket, plan, PR or prompt) with a goal becomes a
// single-item run, so the orchestrator can land it without triaging the backlog.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpRoot, writeJson, abwEnv, runNode } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url));
const REPOS = tmpRoot('abw-take-repos-');
const REPO = path.join(REPOS, 'x');
mkdirSync(path.join(REPO, '.git'), { recursive: true });

function sandbox() {
  const root = tmpRoot('abw-take-');
  const env = { ...abwEnv(root), ABW_REPOS_ROOT: REPOS };
  const plan = path.join(root, 'PLAN.md');
  writeFileSync(plan, '# A plan\n');
  const prompt = path.join(root, 'handoff.txt');
  writeFileSync(prompt, 'Hand-off from claude-code to claude-code\n');
  writeJson(env.ABW_SNAPSHOT, {
    captured_at: Number(env.ABW_NOW) - 30,
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: Number(env.ABW_NOW) + 3600 },
      seven_day: { used_percentage: 20, resets_at: Number(env.ABW_NOW) + 86400 },
    },
  });
  let n = 0;
  return {
    env, plan, prompt,
    run(args) {
      const r = runNode(CLI, { args, env });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
      return { code: r.status, json, out: r.stdout + r.stderr };
    },
    item(fields) {
      n += 1;
      return writeJson(path.join(root, `item-${n}.json`), {
        kind: 'plan', ref: plan, goal: 'Tasks 2 to 4 pass their checks', title: 'Session store',
        repo: REPO, size: 'M', ...fields,
      });
    },
    runJson: () => JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'run.json'), 'utf8')),
    takeJson: (id) =>
      JSON.parse(readFileSync(path.join(env.ABW_STATE_DIR, 'takes', `${id}.json`), 'utf8')),
  };
}

test('take: a plan becomes a one-item run with an HO id, its goal recorded', () => {
  const box = sandbox();
  const r = box.run(['take', '--item', box.item()]);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.json, { id: 'HO-1', kind: 'plan', tickets: 1, runId: box.runJson().id });
  const [tk] = box.runJson().tickets;
  assert.strictEqual(tk.id, 'HO-1');
  assert.strictEqual(tk.status, 'queued');
  assert.strictEqual(tk.size, 'M');
  assert.deepStrictEqual(tk.take, { kind: 'plan', ref: box.plan, goal: 'Tasks 2 to 4 pass their checks' });
  assert.strictEqual(box.takeJson('HO-1').goal, 'Tasks 2 to 4 pass their checks');
});

test('take: HO ids are never reused across runs', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['take', '--item', box.item()]).json.id, 'HO-1');
  assert.strictEqual(box.run(['stop', '--reason', 'done']).code, 0);
  const second = box.run(['take', '--item', box.item({ kind: 'prompt', ref: box.prompt })]);
  assert.strictEqual(second.code, 0, second.out);
  assert.strictEqual(second.json.id, 'HO-2');
});

test('take: a ticket keeps its Linear id; a bad id is refused', () => {
  const box = sandbox();
  const r = box.run(['take', '--item', box.item({ kind: 'ticket', ref: 'LAR-77' })]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.json.id, 'LAR-77');
  const bad = sandbox();
  const e = bad.run(['take', '--item', bad.item({ kind: 'ticket', ref: 'lar 77' })]);
  assert.strictEqual(e.code, 1);
  assert.match(e.json.error, /ticket ref must look like ABC-123/);
});

test('take: a PR ref must be a GitHub pull URL', () => {
  const ok = sandbox();
  const r = ok.run(['take', '--item', ok.item({ kind: 'pr', ref: 'https://github.com/o/r/pull/12' })]);
  assert.strictEqual(r.code, 0, r.out);
  for (const ref of ['#12', 'https://github.com/o/r/pull/12;rm', 'http://github.com/o/r/pull/1']) {
    const box = sandbox();
    const e = box.run(['take', '--item', box.item({ kind: 'pr', ref })]);
    assert.strictEqual(e.code, 1, ref);
    assert.match(e.json.error, /pr ref must be a https:\/\/github.com\/<owner>\/<repo>\/pull\/<n> URL/);
  }
});

test('take: plan and prompt refs must be existing files; a plan must be markdown', () => {
  for (const [fields, msg] of [
    [{ kind: 'plan', ref: '/nonexistent/PLAN.md' }, /plan ref is not a readable file/],
    [{ kind: 'prompt', ref: '/nonexistent/p.txt' }, /prompt ref is not a readable file/],
    [{ kind: 'plan', ref: 'PROMPT' }, /plan ref must be an absolute path to a \.md file/],
  ]) {
    const box = sandbox();
    const e = box.run(['take', '--item', box.item(fields)]);
    assert.strictEqual(e.code, 1, JSON.stringify(fields));
    assert.match(e.json.error, msg);
  }
});

test('take: goal is required and bounded; kind must be known; XL is refused', () => {
  for (const [fields, msg] of [
    [{ goal: '' }, /goal is required/],
    [{ goal: 'x'.repeat(501) }, /goal is longer than 500 characters/],
    [{ kind: 'email' }, /kind must be one of ticket,plan,pr,prompt/],
    [{ size: 'XL' }, /size must be one of S,M,L/],
  ]) {
    const box = sandbox();
    const e = box.run(['take', '--item', box.item(fields)]);
    assert.strictEqual(e.code, 1, JSON.stringify(fields));
    assert.match(e.json.error, msg);
  }
});

test('take: refused while a run is active', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['take', '--item', box.item()]).code, 0);
  const e = box.run(['take', '--item', box.item()]);
  assert.strictEqual(e.code, 1);
  assert.match(e.json.error, /a run is already active/);
});

test('take: open work from an inactive run is carried, after the take', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['take', '--item', box.item()]).code, 0);
  assert.strictEqual(box.run(['begin', 'HO-1']).code, 0);
  assert.strictEqual(box.run(['stop', '--reason', 'crashed']).code, 0); // HO-1 becomes capped
  const r = box.run(['take', '--item', box.item({ kind: 'ticket', ref: 'LAR-9' })]);
  assert.strictEqual(r.code, 0, r.out);
  const tickets = box.runJson().tickets;
  assert.deepStrictEqual(tickets.map((tk) => [tk.id, tk.status]), [['LAR-9', 'queued'], ['HO-1', 'capped']]);
  assert.strictEqual(r.json.tickets, 2);
});

test('take: the item runs through begin and finish like a ticket', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['take', '--item', box.item()]).code, 0);
  assert.strictEqual(box.run(['begin', 'HO-1']).code, 0);
  const f = box.run(['finish', 'HO-1', '--result',
    'RESULT {"outcome":"pr","pr":"https://github.com/o/r/pull/3","branch":"HO-1/session-store"}']);
  assert.strictEqual(f.code, 0, f.out);
  assert.strictEqual(box.runJson().tickets[0].status, 'pr');
});

test('take: a relative prompt ref is stored as an absolute path, since the agent runs elsewhere', () => {
  const box = sandbox();
  const rel = path.relative(process.cwd(), box.prompt);
  const r = box.run(['take', '--item', box.item({ kind: 'prompt', ref: rel })]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(box.takeJson('HO-1').ref, box.prompt);
  assert.strictEqual(box.runJson().tickets[0].take.ref, box.prompt);
});

test('take: a carried take keeps its kind, ref and goal, so a later run can resume it', () => {
  const box = sandbox();
  assert.strictEqual(box.run(['take', '--item', box.item()]).code, 0);
  assert.strictEqual(box.run(['begin', 'HO-1']).code, 0);
  assert.strictEqual(box.run(['stop', '--reason', 'crashed']).code, 0);
  assert.strictEqual(box.run(['take', '--item', box.item({ kind: 'ticket', ref: 'LAR-9' })]).code, 0);
  const carried = box.runJson().tickets.find((tk) => tk.id === 'HO-1');
  assert.deepStrictEqual(carried.take, { kind: 'plan', ref: box.plan, goal: 'Tasks 2 to 4 pass their checks' });
});
