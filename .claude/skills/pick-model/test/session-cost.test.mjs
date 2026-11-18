import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { estimate, priceAt, listCurrent, parseArgs, loadModels, PROFILES } from '../scripts/session-cost.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'models.json');
const SCRIPT = path.join(here, '..', 'scripts', 'session-cost.mjs');
const models = JSON.parse(readFileSync(FIXTURE, 'utf8')).data;
const byId = Object.fromEntries(models.map((m) => [m.id, m]));
const run = (...args) => spawnSync('node', [SCRIPT, '--prices', FIXTURE, ...args], { encoding: 'utf8' });

// Proves the harness reads the fixture before any failure below is trusted.
test('fixture loads six models', () => assert.strictEqual(models.length, 6));

// Anchored to a real OpenCode step billed at $0.0147096 on Opus 5.5: 55,608 tokens
// read from cache, 356 written, 90 output, plus 2 uncached input tokens the
// estimate doesn't model. A one-step shape reproduces that bill once the step-0
// cache write of the starting context is subtracted and those 2 tokens added.
test('one step prices cache read, cache write and output like the real bill', () => {
  const shape = { steps: 1, startContext: 55_608, endContext: 55_964, outputPerStep: 90 };
  const { cost } = estimate(byId['anthropic/claude-opus-5.5'], shape);
  const stepZeroWrite = 55_608 * 0.000005;
  const uncachedInput = 2 * 0.000004;
  const step = cost - stepZeroWrite + uncachedInput;
  assert.ok(Math.abs(step - 0.0147096) < 1e-9, `got ${step}`);
});

test('tiered prices switch once the context reaches min_prompt_tokens', () => {
  const p = byId['openai/gpt-6.2-sol'].pricing;
  assert.strictEqual(priceAt(p, 271_999).cacheRead, 0.0000001);
  assert.strictEqual(priceAt(p, 272_000).cacheRead, 0.0000002);
  // A marathon crosses the tier, so it must cost more than flat base pricing would.
  const flat = { ...byId['openai/gpt-6.2-sol'], pricing: { ...p, overrides: [] } };
  assert.ok(estimate(byId['openai/gpt-6.2-sol'], PROFILES.marathon).cost > estimate(flat, PROFILES.marathon).cost);
});

test('a model without cache pricing pays full input on every step, and is flagged', () => {
  const r = estimate(byId['example/no-cache'], PROFILES.quick);
  assert.strictEqual(r.cached, false);
  const s = PROFILES.quick;
  const grow = (s.endContext - s.startContext) / s.steps;
  let expected = 0;
  for (let i = 0; i < s.steps; i++) expected += (s.startContext + i * grow + grow) * 0.000001 + s.outputPerStep * 0.000002;
  assert.ok(Math.abs(r.cost - expected) < 1e-9);
});

test('a profile larger than the context window is flagged as overflow', () => {
  assert.strictEqual(estimate(byId['example/no-cache'], PROFILES.marathon).overflow, true);
  assert.strictEqual(estimate(byId['anthropic/claude-opus-5.5'], PROFILES.marathon).overflow, false);
});

test('higher effort costs more, and an unknown effort is rejected', () => {
  const m = byId['anthropic/claude-opus-5.5'];
  assert.ok(estimate(m, PROFILES.standard, 'high').cost > estimate(m, PROFILES.standard, 'low').cost);
  assert.throws(() => estimate(m, PROFILES.standard, 'turbo'), /unknown effort/);
});

test('--list keeps current tool-calling models, and drops batch, routers and stale ones', () => {
  const now = 1795000000 * 1000;
  const ids = listCurrent(models, 30, now).map((m) => m.id);
  assert.deepStrictEqual(ids, ['openai/gpt-6.2-sol', 'example/no-cache']);
});

test('parseArgs strips the OpenCode provider prefix but keeps openrouter/auto', () => {
  const o = parseArgs(['openrouter/anthropic/claude-opus-5.5', 'openrouter/auto']);
  assert.deepStrictEqual(o.ids, ['anthropic/claude-opus-5.5', 'openrouter/auto']);
});

test('shape overrides relabel the run as custom', () => {
  const o = parseArgs(['--profile', 'quick', '--steps', '5', 'x/y']);
  assert.strictEqual(o.label, 'custom');
  assert.strictEqual(o.shape.steps, 5);
  assert.throws(() => parseArgs(['--steps', '0', 'x/y']), /must be a positive number/);
});

test('CLI ranks cheapest first', () => {
  const out = execFileSync('node', [SCRIPT, '--prices', FIXTURE, 'anthropic/claude-opus-5.5', 'openai/gpt-6.2-sol'], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  // The fixture isn't marked as guardrail-filtered, so the run must say so first.
  assert.match(lines[0], /UNFILTERED: guardrails not applied/);
  assert.match(lines[1], /^standard: 60 steps/);
  assert.match(lines[2], /openai\/gpt-6\.2-sol$/);
  assert.match(lines[3], /anthropic\/claude-opus-5\.5$/);
});

// --- guardrails: the shortlist must come from what this key may use ------------

const KEY = 'sk-or-test-not-a-real-key';
const page = (n, from = 0) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `p/m${from + i}` })) });
const fakeFetch = (pages, status = 200) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const body = pages[calls.length - 1] ?? { data: [] };
    return { ok: status === 200, status, json: async () => body };
  };
  return { impl, calls };
};

test('with a key, models come from /models/user with the key as bearer, across pages', async () => {
  const { impl, calls } = fakeFetch([page(200), page(200, 200), page(7, 400)]);
  const { models, filtered } = await loadModels({ apiKey: KEY, fetchImpl: impl });
  assert.strictEqual(filtered, true);
  assert.strictEqual(models.length, 407);
  assert.strictEqual(calls.length, 3);
  assert.ok(calls.every((c) => c.url.startsWith('https://openrouter.ai/api/v1/models/user?')));
  assert.deepStrictEqual(calls.map((c) => new URL(c.url).searchParams.get('offset')), ['0', '200', '400']);
  assert.strictEqual(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test('a rejected key fails with the status, and never echoes the key', async () => {
  const { impl } = fakeFetch([], 401);
  await assert.rejects(loadModels({ apiKey: KEY, fetchImpl: impl }), (err) => {
    assert.match(err.message, /HTTP 401 \(key rejected\)/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('without a key, the public list is used and a guardrail warning is raised', async () => {
  const { impl, calls } = fakeFetch([page(3)]);
  const warnings = [];
  const { models, filtered } = await loadModels({ fetchImpl: impl, warn: (m) => warnings.push(m) });
  assert.strictEqual(filtered, false);
  assert.strictEqual(models.length, 3);
  assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/models');
  assert.match(warnings[0], /guardrails are NOT applied/);
});

test('a model the filtered list omits is reported as not allowed, not as a typo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pick-model-'));
  const file = path.join(dir, 'allowed.json');
  writeFileSync(file, JSON.stringify({ filtered: true, data: models.filter((m) => m.id !== 'openai/gpt-6.2-sol') }));
  const r = spawnSync('node', [SCRIPT, '--prices', file, 'openai/gpt-6.2-sol'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /not allowed for this key .*: openai\/gpt-6\.2-sol/);
});

test('CLI exits 2 on an unknown model, a router, or no models', () => {
  for (const [args, msg] of [[['nope/model'], /not in the price list: nope\/model/], [['openrouter/auto'], /router with no fixed price/], [[], /at least one model/]]) {
    const r = run(...args);
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg);
  }
});
