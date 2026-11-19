import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'statusline.sh');
const tmpHome = () => mkdtempSync(path.join(tmpdir(), 'abw-statusline-'));
const stateDir = (home) => path.join(home, '.claude', 'state', 'statusline');
const stateFile = (home) => path.join(stateDir(home), 'rate-limits.json');
const payload = (rate_limits) => JSON.stringify({ model: { display_name: 'O' }, rate_limits });
// The snapshot is written by a detached subshell; ABW_STATUSLINE_FOREGROUND runs it inline so
// sequential assertions are deterministic. Tests of the detached path pass sync = false.
const run = (home, rate_limits, sync = true) =>
  spawnSync('bash', [SCRIPT], {
    input: payload(rate_limits),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...(sync ? { ABW_STATUSLINE_FOREGROUND: '1' } : {}) },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leftovers = (home) => readdirSync(stateDir(home)).filter((f) => f !== 'rate-limits.json');
const settle = async (home, done) => {
  for (let i = 0; i < 200; i++) {
    if (done() && leftovers(home).length === 0) return;
    await sleep(50);
  }
};
const saved = (home) => JSON.parse(readFileSync(stateFile(home), 'utf8')).rate_limits;
const w = (used_percentage, resets_at) => ({ used_percentage, resets_at });

// Sequential runs share one state file; each step is [input, expected saved rate_limits].
test('merge: fresh, stale idle keeps higher, growth, new 5h window replaces, older ignored', () => {
  const home = tmpHome();
  const steps = [
    [{ five_hour: w(28, 100), seven_day: w(54, 900) }, { five_hour: w(28, 100), seven_day: w(54, 900) }],
    [{ seven_day: w(7, 900) }, { five_hour: w(28, 100), seven_day: w(54, 900) }],
    [{ five_hour: w(30, 100), seven_day: w(55, 900) }, { five_hour: w(30, 100), seven_day: w(55, 900) }],
    [{ five_hour: w(2, 200), seven_day: w(55, 900) }, { five_hour: w(2, 200), seven_day: w(55, 900) }],
    [{ five_hour: w(90, 50) }, { five_hour: w(2, 200), seven_day: w(55, 900) }],
  ];
  steps.forEach(([input, expected], i) => {
    const r = run(home, input);
    assert.strictEqual(r.status, 0, `step ${i + 1}: ${r.stderr}`);
    assert.deepStrictEqual(saved(home), expected, `step ${i + 1}`);
  });
});

test('no rate_limits: prints placeholder line and writes no file', () => {
  const home = tmpHome();
  const r = run(home, undefined);
  assert.strictEqual(r.stdout.trim(), 'O · 5h – · 7d –');
  assert.ok(!existsSync(stateFile(home)));
});

test('bar color and fill by band: 19 green/1, 53 yellow/5, 82 red/8', () => {
  for (const [pct, color, n] of [[19, '\x1b[32m', 1], [53, '\x1b[33m', 5], [82, '\x1b[31m', 8]]) {
    const out = run(tmpHome(), { five_hour: w(pct, 4_000_000_000) }).stdout;
    assert.ok(out.includes(`${color}${'█'.repeat(n)}░`), `${pct}%: ${JSON.stringify(out)}`);
    assert.strictEqual((out.match(/█/g) || []).length, n);
  }
});

test('20 parallel writers: valid JSON, max reading wins, no temp files left', async () => {
  const home = tmpHome();
  const readings = Array.from({ length: 20 }, (_, i) => 10 + i * 3);
  await Promise.all(readings.map((p) => new Promise((resolve, reject) => {
    const c = spawn('bash', [SCRIPT], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', reject);
    c.on('close', resolve);
    c.stdin.end(payload({ five_hour: w(p, 500) }));
  })));
  const max = Math.max(...readings);
  const reached = () => existsSync(stateFile(home)) && saved(home).five_hour.used_percentage === max;
  await settle(home, reached);
  assert.strictEqual(saved(home).five_hour.used_percentage, max);
  assert.deepStrictEqual(readdirSync(stateDir(home)), ['rate-limits.json']);
});

const lockDir = (home) => `${stateFile(home)}.lock`;
const withLock = (home, ageSec) => {
  mkdirSync(stateDir(home), { recursive: true });
  mkdirSync(lockDir(home));
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(lockDir(home), t, t);
};

test('render is not blocked by a fresh lock (returns within 500ms)', () => {
  const home = tmpHome();
  withLock(home, 0);
  const t0 = Date.now();
  const r = run(home, { five_hour: w(19, 4_000_000_000) }, false);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
  assert.ok(r.stdout.includes('19%'));
});

test('a lock whose mtime is 60s old is broken and the write lands', async () => {
  const home = tmpHome();
  withLock(home, 60);
  run(home, { five_hour: w(19, 500) }, false);
  await settle(home, () => existsSync(stateFile(home)));
  assert.strictEqual(saved(home).five_hour.used_percentage, 19);
  assert.ok(!existsSync(lockDir(home)));
});

test('a fresh foreign lock is left in place and the write is skipped', async () => {
  const home = tmpHome();
  withLock(home, 0);
  run(home, { five_hour: w(19, 500) }, false);
  await sleep(4000); // longer than the ~3s wait
  assert.ok(existsSync(lockDir(home)), 'foreign lock must survive');
  assert.ok(!existsSync(stateFile(home)), 'write must be skipped');
  assert.deepStrictEqual(leftovers(home), ['rate-limits.json.lock']);
});

test('a corrupt state file self-heals', () => {
  const home = tmpHome();
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(stateFile(home), '{not json');
  run(home, { five_hour: w(19, 500) });
  assert.deepStrictEqual(saved(home), { five_hour: w(19, 500) });
  assert.deepStrictEqual(leftovers(home), []);
});

test('stale-lock break works with a GNU-style stat (-f is a junk report, -c %Y is the epoch)', async () => {
  const home = tmpHome();
  withLock(home, 60);
  const bin = mkdtempSync(path.join(tmpdir(), 'abw-stat-'));
  const stub = path.join(bin, 'stat');
  writeFileSync(stub, [
    '#!/bin/bash',
    'if [ "$1" = "-c" ]; then exec /usr/bin/env stat_real_epoch "$3"; fi',
    'echo "  File: \\"$2\\"  ID: 0 Namelen: 255 Type: ext2/ext3"; exit 1',
  ].join('\n'));
  // The stub's "-c %Y" answers with the real mtime via a second helper on PATH.
  writeFileSync(path.join(bin, 'stat_real_epoch'),
    '#!/bin/bash\n/usr/bin/stat -f %m "$1" 2>/dev/null || /usr/bin/stat -c %Y "$1"\n');
  for (const f of ['stat', 'stat_real_epoch']) spawnSync('chmod', ['+x', path.join(bin, f)]);
  spawnSync('bash', [SCRIPT], {
    input: payload({ five_hour: w(19, 500) }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  await settle(home, () => existsSync(stateFile(home)));
  assert.strictEqual(saved(home).five_hour.used_percentage, 19);
});

test('an old lock that is a regular file cannot be removed: job gives up within 5s', () => {
  const home = tmpHome();
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(lockDir(home), '');
  const t = new Date(Date.now() - 60_000);
  utimesSync(lockDir(home), t, t);
  const t0 = Date.now();
  const r = run(home, { five_hour: w(19, 500) }, true); // foreground, so the job's lifetime is observable
  assert.ok(r.error === undefined && r.status === 0, `did not exit cleanly: ${r.error}`);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  assert.ok(!existsSync(stateFile(home)), 'write must be skipped');
});
