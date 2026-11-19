import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
const run = (home, rate_limits) =>
  spawnSync('bash', [SCRIPT], { input: payload(rate_limits), encoding: 'utf8', env: { ...process.env, HOME: home } });
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
  assert.strictEqual(saved(home).five_hour.used_percentage, Math.max(...readings));
  assert.deepStrictEqual(readdirSync(stateDir(home)), ['rate-limits.json']);
});
