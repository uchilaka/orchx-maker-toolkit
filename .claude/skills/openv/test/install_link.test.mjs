// openv install-link.sh (plan S15). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, existsSync, lstatSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(SKILL_DIR, 'bin', 'install-link.sh');
const WORKTREE_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');

function sandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'openv-s15-')));
  const home = path.join(root, 'home');
  const binDir = path.join(home, '.local', 'bin');
  const link = path.join(binDir, 'openv');
  mkdirSync(home, { recursive: true });
  const run = (action, { pathEnv = `${binDir}:/usr/bin:/bin`, sourceRoot = WORKTREE_ROOT } = {}) =>
    spawnSync('bash', [INSTALLER, action], {
      encoding: 'utf8',
      env: { HOME: home, PATH: pathEnv, OPENV_LINK_PATH: link, ...(sourceRoot ? { SKILL_SOURCE_ROOT: sourceRoot } : {}) },
    });
  return { root, home, binDir, link, run };
}

test('install creates the symlink, and a second run is a no-op', () => {
  const s = sandbox();
  const r1 = s.run('install');
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /installed ->/);
  assert.strictEqual(r1.stderr, '');
  assert.strictEqual(readlinkSync(s.link), path.join(WORKTREE_ROOT, '.claude/skills/openv/bin/openv'));

  const r2 = s.run('install');
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /already linked/);
});

test('install re-points a foreign symlink and names the old target', () => {
  const s = sandbox();
  mkdirSync(s.binDir, { recursive: true });
  symlinkSync('/bin/true', s.link);
  const r = s.run('install');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed -> .* \(was -> \/bin\/true\)/);
  assert.strictEqual(readlinkSync(s.link), path.join(WORKTREE_ROOT, '.claude/skills/openv/bin/openv'));
});

test('install refuses to overwrite a regular file', () => {
  const s = sandbox();
  mkdirSync(s.binDir, { recursive: true });
  writeFileSync(s.link, '#!/bin/sh\necho mine\n');
  chmodSync(s.link, 0o755);
  const r = s.run('install');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /refusing to replace non-symlink/);
});

test('install warns when the link directory is not on PATH', () => {
  const s = sandbox();
  const r = s.run('install', { pathEnv: '/usr/bin:/bin' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /not on PATH/);
});

test('uninstall removes an openv link and leaves foreign files or links alone', () => {
  const s = sandbox();
  assert.strictEqual(s.run('install').status, 0);
  const r1 = s.run('uninstall');
  assert.strictEqual(r1.status, 0);
  assert.match(r1.stdout, /removed/);
  assert.strictEqual(existsSync(s.link), false);

  mkdirSync(s.binDir, { recursive: true });
  symlinkSync('/bin/true', s.link);
  const r2 = s.run('uninstall');
  assert.strictEqual(r2.status, 0);
  assert.match(r2.stderr, /leaving/);
  assert.strictEqual(lstatSync(s.link).isSymbolicLink(), true);
});

test('without SKILL_SOURCE_ROOT, install targets the main checkout rather than the worktree', () => {
  const s = sandbox();
  const r = s.run('install', { sourceRoot: '' });
  // Only check when main checkout actually has openv merged; otherwise it fails cleanly naming main.
  if (r.status === 0) {
    assert.ok(!readlinkSync(s.link).includes('worktrees/openv-plugin'));
  } else {
    assert.match(r.stderr, /source script missing/);
    assert.ok(!r.stderr.includes('worktrees/openv-plugin'));
  }
});
