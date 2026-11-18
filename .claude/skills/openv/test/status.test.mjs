// openv status (plan S3). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
// Every run gets a throwaway HOME and config dir, and a stub pass-cli first on
// PATH that records each call, so "status makes no pass-cli calls" is checked
// against what actually ran, not against reading the script.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'openv');
// The canary must never appear in output: it stands in for a secret someone
// pasted into a profile as a literal.
const CANARY = 'sk-canary-4f1d9e';

function sandbox({ loggedIn = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'openv-')));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'pass-cli.calls');
  for (const d of [home, config, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, 'pass-cli'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit ${loggedIn ? 0 : 1}\n`);
  chmodSync(path.join(bin, 'pass-cli'), 0o755);
  const write = (rel, body) => {
    const f = path.join(config, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const run = (args, { cwd = root, shell = 'bash', env = {} } = {}) =>
    spawnSync(shell, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin`, OPENV_CONFIG_DIR: config, ...env },
    });
  const passCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const repo = (name) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    return dir;
  };
  return { root, home, config, write, run, passCalls, repo };
}

const json = (r) => {
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// Proves the stub records calls before "no calls" below is trusted.
test('the pass-cli stub records calls', () => {
  const s = sandbox();
  s.run(['status', '--check']);
  assert.deepStrictEqual(s.passCalls(), ['vault list']);
});

test('plain status makes no pass-cli calls; --check makes exactly one', () => {
  const s = sandbox();
  s.write('global/openrouter.env', 'OPENROUTER_API_KEY=pass://SHARE/ITEM/API Key\n');
  s.run(['status']);
  s.run(['status', '--json']);
  assert.deepStrictEqual(s.passCalls(), []);
  s.run(['status', '--check', '--json']);
  assert.deepStrictEqual(s.passCalls(), ['vault list']);
});

test('--check reports login state from the exit code alone', () => {
  assert.strictEqual(json(sandbox({ loggedIn: true }).run(['status', '--check', '--json'])).login, 'yes');
  assert.strictEqual(json(sandbox({ loggedIn: false }).run(['status', '--check', '--json'])).login, 'no');
  assert.strictEqual(json(sandbox().run(['status', '--json'])).login, undefined);
});

test('a project profile wins over a global one of the same name; others merge in', () => {
  const s = sandbox();
  const dir = s.repo('acme');
  s.write('acme/dev.env', 'DB_URL=pass://V/db/url\n');
  s.write('global/dev.env', 'DB_URL=pass://V/other/url\n');
  s.write('global/openrouter.env', 'OPENROUTER_API_KEY=pass://S/I/API Key\n');
  const out = json(s.run(['status', '--json'], { cwd: dir }));
  assert.strictEqual(out.project, 'acme');
  assert.deepStrictEqual(out.profiles.map((p) => [p.env, p.scope]), [['dev', 'project'], ['openrouter', 'global']]);
  assert.strictEqual(out.profiles[0].vars[0].ref, 'pass://V/db/url');
});

test('outside a git repo there is no project, and global profiles still resolve', () => {
  const s = sandbox();
  s.write('global/dev.env', 'X=pass://V/i/f\n');
  const out = json(s.run(['status', '--json']));
  assert.strictEqual(out.project, null);
  assert.deepStrictEqual(out.profiles.map((p) => p.scope), ['global']);
});

test('a worktree resolves to its main checkout, so worktrees share profiles', () => {
  const s = sandbox();
  const main = s.repo('acme');
  const wt = path.join(s.root, 'acme-worktrees', 'feature');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature', wt]);
  s.write('acme/dev.env', 'A=pass://V/i/f\n');
  assert.strictEqual(json(s.run(['status', '--json'], { cwd: wt })).project, 'acme');
});

test('a project vaults file replaces the global allowlist; comments and blanks are ignored', () => {
  const s = sandbox();
  const dir = s.repo('acme');
  s.write('vaults', 'Personal\n# not a vault\n\n  Platform Monorepo  \n');
  assert.deepStrictEqual(json(s.run(['status', '--json'], { cwd: dir })).vaults.names, ['Personal', 'Platform Monorepo']);
  s.write('acme/vaults', 'Acme Only\n');
  const out = json(s.run(['status', '--json'], { cwd: dir }));
  assert.deepStrictEqual(out.vaults.names, ['Acme Only']);
  assert.match(out.vaults.file, /acme\/vaults$/);
});

test('refs are shown, literal values never are, in text or JSON', () => {
  const s = sandbox();
  s.write('global/dev.env', [
    '# comment with = sign',
    `export PASTED_SECRET="${CANARY}"`,
    "QUOTED_REF='pass://V/item/field'",
    'LOG_LEVEL=debug',
    'not an assignment',
    '',
  ].join('\n'));
  for (const args of [['status'], ['status', '--json']]) {
    const r = s.run(args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY), `canary leaked by ${args.join(' ')}`);
  }
  const vars = json(s.run(['status', '--json'])).profiles[0].vars;
  assert.deepStrictEqual(vars, [
    { name: 'PASTED_SECRET', kind: 'literal', ref: null },
    { name: 'QUOTED_REF', kind: 'ref', ref: 'pass://V/item/field' },
    { name: 'LOG_LEVEL', kind: 'literal', ref: null },
  ]);
});

test('JSON stays valid with quotes, backslashes and spaces in names', () => {
  const s = sandbox();
  s.write('vaults', 'Bob\'s "Work" \\ Vault\n');
  s.write('global/dev.env', 'K=pass://Bob\'s "Work" \\ Vault/item/field\n');
  const out = json(s.run(['status', '--json']));
  assert.deepStrictEqual(out.vaults.names, ['Bob\'s "Work" \\ Vault']);
  assert.strictEqual(out.profiles[0].vars[0].ref, 'pass://Bob\'s "Work" \\ Vault/item/field');
});

test('link state: missing, linked, foreign and dangling', () => {
  const s = sandbox();
  const link = path.join(s.home, '.local', 'bin', 'openv');
  const state = () => json(s.run(['status', '--json'])).link.state;
  assert.strictEqual(state(), 'missing');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(SCRIPT, link);
  assert.strictEqual(state(), 'linked');
  const s2 = sandbox();
  const link2 = path.join(s2.home, '.local', 'bin', 'openv');
  mkdirSync(path.dirname(link2), { recursive: true });
  writeFileSync(link2, '#!/bin/sh\n');
  assert.strictEqual(json(s2.run(['status', '--json'])).link.state, 'foreign');
  const s3 = sandbox();
  const link3 = path.join(s3.home, '.local', 'bin', 'openv');
  mkdirSync(path.dirname(link3), { recursive: true });
  symlinkSync(path.join(s3.root, 'gone'), link3);
  assert.strictEqual(json(s3.run(['status', '--json'])).link.state, 'dangling');
});

test('runs under macOS /bin/bash 3.2 with the same output', () => {
  const s = sandbox();
  s.write('global/dev.env', 'X=pass://V/i/f\n');
  const a = s.run(['status', '--json']);
  const b = s.run(['status', '--json'], { shell: '/bin/bash' });
  assert.strictEqual(b.status, 0, b.stderr);
  assert.strictEqual(b.stdout, a.stdout);
});

test('an unknown status option and an unknown command fail', () => {
  const s = sandbox();
  assert.strictEqual(s.run(['status', '--nope']).status, 1);
  assert.strictEqual(s.run(['nope']).status, 64);
});
