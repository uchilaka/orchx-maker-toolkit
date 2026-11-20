// The PreToolUse(Bash) guard (plan S8). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
//
// Most deny cases are generated from hooks/deny.tsv, the same file the guard
// reads, so a pattern added there is tested without a second list to keep in
// step. MUST_DENY doesn't come from it, so deleting a row can't also delete
// the test that would notice.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, mkdtempSync, writeFileSync, chmodSync, cpSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const GUARD = path.join(HOOKS, 'guard-secrets.sh');
const DENY_RAW = readFileSync(path.join(HOOKS, 'deny.tsv'), 'utf8');
// The skip rule from deny.tsv's header: empty, whitespace-only or # lines.
const SKIP = /^\s*(#|$)/;
const DENY = DENY_RAW.split('\n')
  .filter((l) => !SKIP.test(l))
  .map((l) => {
    const [pattern, reason] = l.split('\t');
    return { pattern, reason };
  });
const REAL_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
// Absolute, so a test can give the guard a PATH that holds only shims.
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

// The hook input Claude Code sends, with the fields that aren't the command.
// The cwd, transcript path and description name openv on purpose: only the
// command may count.
function payload(command) {
  return JSON.stringify({
    session_id: 'test',
    transcript_path: '/var/tmp/claude/projects/-srv-openv-guard/t.jsonl',
    cwd: '/srv/repos/openv-guard',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'Check the openv setup' },
    tool_use_id: 'toolu_openv',
  });
}

function guard(command, { env = process.env, raw, script = GUARD, bash = BASH } = {}) {
  return spawnSync(bash, [script], {
    input: raw ?? payload(command),
    encoding: 'utf8',
    env,
    cwd: tmpdir(), // the guard must find its files from its own path, not the cwd
  });
}

function assertDenied(command, reason, opts) {
  const r = guard(command, opts);
  assert.strictEqual(r.status, 2, `expected deny for: ${JSON.stringify(command)}\nstderr: ${r.stderr}`);
  // Claude Code shows stderr on a block; stdout is where a value could leak.
  assert.strictEqual(r.stdout, '', `stdout on block for: ${command}`);
  if (reason) assert.ok(r.stderr.includes(reason), `reason missing for: ${command}\n${r.stderr}`);
  return r;
}

function assertAllowed(command, opts) {
  const r = guard(command, opts);
  assert.strictEqual(r.status, 0, `expected allow for: ${JSON.stringify(command)}\nstderr: ${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  return r;
}

// A command that reaches each pattern, in the shapes an agent might write it.
function shapes(pattern) {
  if (pattern.startsWith('--')) {
    return [
      `pass-cli run ${pattern} --env-file x.env -- env`,
      `pass-cli run --env-file x.env -- env ${pattern}`,
      `pass-cli run ${pattern}=true -- env`,
      `openv run dev -- pass-cli run ${pattern} -- env`,
      `pass-cli run '${pattern}' -- env`,
    ];
  }
  const [bin, ...rest] = pattern.split(' ');
  const tail = rest.join(' ');
  return [
    `${pattern} pass://Vault/Item/field`,
    pattern,
    `${pattern.replaceAll(' ', '   ')} x`,
    `${pattern.replaceAll(' ', '\t')} x`,
    `${pattern.replaceAll(' ', ' \\\n  ')} x`,
    `${pattern.replaceAll(' ', '\n')} x`,
    `/opt/homebrew/bin/${pattern} x`,
    `"/opt/homebrew/bin/${bin}" ${tail} x`,
    `"\${CLAUDE_SKILL_DIR}/bin/${bin}" ${tail} x`,
    `'${bin}' "${tail}" x`,
    `$(which ${bin}) ${tail} x`,
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

const MUST_DENY = [
  'openv export dev',
  'pass-cli item view pass://V/I/password',
  'pass-cli inject -i t.env',
  'pass-cli run --no-masking --env-file x.env -- env',
  'pass-cli item list V --show-secrets',
];

test('deny.tsv: every row that is not skipped is <pattern><TAB><reason>', () => {
  // Checks the raw lines, so a malformed row can't hide behind the parser.
  const rows = DENY_RAW.split('\n').filter((l) => !SKIP.test(l));
  assert.ok(rows.length >= 10, `only ${rows.length} rows`);
  for (const l of rows) assert.match(l, /^\S+( \S+)*\t\S/, `bad row: ${JSON.stringify(l)}`);
});

for (const { pattern, reason } of DENY) {
  test(`denies ${pattern}`, () => {
    for (const cmd of shapes(pattern)) assertDenied(cmd, reason);
  });
}

test('denies the core value-revealing commands, independent of deny.tsv', () => {
  for (const cmd of MUST_DENY) assertDenied(cmd);
});

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
    'brew install jq',
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
    'pass-cli run x--no-masking -- env',
  ]) assertAllowed(cmd);
});

test('a flag alone is allowed when the command names neither openv nor pass-cli', () => {
  // The payload's cwd and transcript path name openv; only the command counts.
  for (const cmd of ['kubectl get secret --show-secrets', 'rg -- --no-masking docs/']) assertAllowed(cmd);
});

test('flag rows stay gated when the fast path passes the whole input to jq', () => {
  // With the command as the last key, the fast path can't cut it out, so the
  // cwd's "openv" sends it to jq. jq must still ignore the flag.
  const raw = JSON.stringify({ tool_input: { command: 'kubectl get secret --show-secrets' }, cwd: '/x/openv' });
  assertAllowed(null, { raw });
  const named = JSON.stringify({ tool_input: { command: 'pass-cli item list V --show-secrets' }, cwd: '/x' });
  assertDenied(null, '--show-secrets', { raw: named });
});

test('a missing, null or non-string command', () => {
  assertAllowed(null, { raw: JSON.stringify({ cwd: '/x/openv', tool_input: { command: null, description: 'openv' } }) });
  assertAllowed(null, { raw: JSON.stringify({ cwd: '/x/openv', tool_input: { description: 'pass-cli' } }) });
  const r = guard(null, { raw: JSON.stringify({ tool_input: { command: ['pass-cli', 'item', 'view'] } }) });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
});

test('fails closed on unreadable input that mentions pass-cli', () => {
  const r = guard(null, { raw: '{"tool_input": {"command": "pass-cli item view x"' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /couldn't check this command/);
});

// Logging stand-ins for every command the guard could plausibly fork. PATH is
// set to this folder alone, so anything else it ran would fail and show up as
// a wrong exit status.
function shimPath(t, { withJq = true } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), 'openv-guard-shims-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'calls.log');
  writeFileSync(log, '');
  for (const name of ['cat', 'dirname', 'basename', 'date', 'grep', 'sed', 'awk', 'tr', 'head', 'readlink']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> '${log}'\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  if (withJq) {
    writeFileSync(path.join(bin, 'jq'), `#!/bin/sh\necho jq >> '${log}'\nexec '${REAL_JQ}' "$@"\n`);
    chmodSync(path.join(bin, 'jq'), 0o755);
  }
  return { env: { PATH: bin }, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('the fast path forks nothing; a mention runs exactly one jq', { skip: !REAL_JQ && 'jq not installed' }, (t) => {
  const { env, calls } = shimPath(t);
  assertAllowed('git status', { env });
  assertAllowed('item view export --no-masking', { env });
  assert.deepStrictEqual(calls(), []);
  for (const cmd of ['openv run dev -- env', 'pass-cli item view x']) {
    const before = calls().length;
    guard(cmd, { env });
    assert.deepStrictEqual(calls().slice(before), ['jq'], cmd);
  }
});

test('without jq, only commands naming openv or pass-cli are blocked', (t) => {
  const { env } = shimPath(t, { withJq: false });
  // The cwd in the payload names openv: that alone mustn't lock out every command.
  assertAllowed('brew install jq', { env });
  const r = assertDenied('pass-cli vault list', null, { env });
  assert.match(r.stderr, /jq isn't installed/);
});

// A copy of hooks/ with deny.tsv replaced (or removed), to test how the guard
// treats a broken list.
function hooksWith(t, denyTsv) {
  const dir = mkdtempSync(path.join(tmpdir(), 'openv-guard-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(HOOKS, dir, { recursive: true });
  if (denyTsv === null) rmSync(path.join(dir, 'deny.tsv'));
  else writeFileSync(path.join(dir, 'deny.tsv'), denyTsv);
  return path.join(dir, 'guard-secrets.sh');
}

test('a missing, empty or malformed deny.tsv blocks instead of allowing', (t) => {
  const missing = assertDenied('openv run dev -- env', null, { script: hooksWith(t, null) });
  assert.match(missing.stderr, /can't read deny\.tsv/);
  for (const tsv of [
    '',
    '# only comments\n\n',
    'pass-cli item view    prints values\n', // tabs turned into spaces
    'openv export\tok\npass-cli foo\n', // a row with no reason
  ]) {
    const r = assertDenied('openv run dev -- env', null, { script: hooksWith(t, tsv) });
    assert.match(r.stderr, /deny\.tsv has/, JSON.stringify(tsv));
    assert.doesNotMatch(r.stderr, /null/);
  }
});

test('deny.tsv: whitespace-only lines are skipped and CRLF is tolerated', (t) => {
  const script = hooksWith(t, 'openv export\tprints values\r\n \t \r\n# c\r\n');
  assertAllowed('openv run dev -- env', { script });
  const r = assertDenied('openv export dev', 'prints values', { script });
  assert.doesNotMatch(r.stderr, /\r/);
});

test('works when its hooks folder is reached through a symlink', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openv-guard-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(HOOKS, path.join(dir, 'hooks'));
  const script = path.join(dir, 'hooks', 'guard-secrets.sh');
  assertDenied('pass-cli item view x', "prints an item's values", { script });
  assertAllowed('openv run dev -- env', { script });
});
