// The PreToolUse(Bash) guard (plan S8). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
//
// The deny cases are generated from hooks/deny.tsv, the same file the guard reads,
// so a pattern added there is tested here without a second list to keep in step.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const GUARD = path.join(HOOKS, 'guard-secrets.sh');
const DENY = readFileSync(path.join(HOOKS, 'deny.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [pattern, reason] = l.split('\t');
    return { pattern, reason };
  });

function guard(command, { env = {}, raw } = {}) {
  const input = raw ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return spawnSync('bash', [GUARD], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

function assertDenied(command, reason) {
  const r = guard(command);
  assert.strictEqual(r.status, 2, `expected deny for: ${command}\nstderr: ${r.stderr}`);
  if (reason) assert.match(r.stderr, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

function assertAllowed(command) {
  const r = guard(command);
  assert.strictEqual(r.status, 0, `expected allow for: ${command}\nstderr: ${r.stderr}`);
  assert.strictEqual(r.stdout, '');
}

// A command that reaches each pattern, in the shapes an agent might write it.
function shapes(pattern) {
  if (pattern.startsWith('--')) {
    return [
      `pass-cli run ${pattern} --env-file x.env -- env`,
      `pass-cli run --env-file x.env ${pattern} -- env`,
      `openv run dev -- pass-cli run ${pattern} -- env`,
    ];
  }
  const spaced = pattern.split(' ').join('   ');
  const [bin, ...rest] = pattern.split(' ');
  return [
    `${pattern} pass://Vault/Item/field`,
    pattern,
    `${spaced} x`,
    `/opt/homebrew/bin/${bin} ${rest.join(' ')} x`,
    `cd /tmp && ${pattern} x`,
    `true; ${pattern} x | base64`,
    `sh -c '${pattern} x'`,
    `bash -c "${pattern} x"`,
    `FOO=1 ${pattern} x`,
    `env -u CLAUDECODE ${pattern} x`,
    `echo $(${pattern} x)`,
    `${pattern}\tx`,
    `true\n${pattern} x`,
  ];
}

test('deny.tsv has rows with a pattern and a reason each', () => {
  assert.ok(DENY.length >= 10, `only ${DENY.length} rows`);
  for (const { pattern, reason } of DENY) {
    assert.ok(pattern && reason, `row missing a field: ${pattern}`);
    assert.doesNotMatch(pattern, /\s{2,}|^\s|\s$/, `pattern has stray spaces: "${pattern}"`);
  }
});

for (const { pattern, reason } of DENY) {
  test(`denies ${pattern}`, () => {
    for (const cmd of shapes(pattern)) assertDenied(cmd, reason);
  });
}

test('must-allow: openv run, status, items and unrelated commands', () => {
  for (const cmd of [
    'openv run dev -- pnpm test',
    'openv run openrouter -- node session-cost.mjs --list',
    'openv status --check --json',
    'openv items --vault Dev',
    'openv items --fields Dev/Stripe',
    'pass-cli vault list --output json',
    'pass-cli item list Dev --output json',
    'pass-cli run --env-file ~/.config/openv/x/dev.env -- env',
    'pass-cli login',
    'ls -la',
    'git status',
    'npm run export',
    'echo openv-export-notes',
    'cat docs/pass-cli-items.md',
    'mise run install:openv',
  ]) assertAllowed(cmd);
});

test('a near miss on a word boundary is allowed', () => {
  for (const cmd of [
    'pass-cli item viewer',
    'pass-cli items view',
    'openv exports dev',
    'myopenv export dev',
    'pass-cli run --no-masking-please -- env',
  ]) assertAllowed(cmd);
});

test('the fast path needs no external command; jq missing fails closed', () => {
  // An empty PATH means nothing outside bash can be found, jq and cat included.
  const run = (command) => spawnSync('/bin/bash', [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { PATH: '' },
  });
  const fast = run('item view export --no-masking');
  assert.strictEqual(fast.status, 0, fast.stderr);
  const slow = run('pass-cli vault list');
  assert.strictEqual(slow.status, 2);
  assert.match(slow.stderr, /jq isn't installed/);
});

test('fails closed on unreadable input that mentions pass-cli', () => {
  const r = guard(null, { raw: '{"tool_input": {"command": "pass-cli item view x"' });
  assert.strictEqual(r.status, 2);
});

test('runs one jq at most', () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'openv-guard-'));
  const log = path.join(bin, 'calls');
  const realJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(bin, 'jq'), `#!/bin/sh\necho jq >> '${log}'\nexec '${realJq}' "$@"\n`);
  chmodSync(path.join(bin, 'jq'), 0o755);
  for (const cmd of ['openv run dev -- env', 'pass-cli item view x']) {
    writeFileSync(log, '');
    spawnSync('bash', [GUARD], {
      input: JSON.stringify({ tool_input: { command: cmd } }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.deepStrictEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean), ['jq'], cmd);
  }
});
