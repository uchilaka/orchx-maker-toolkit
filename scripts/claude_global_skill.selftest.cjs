const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'claude-global-skill.sh');

// Each test gets a throwaway HOME and a throwaway source checkout, so nothing here
// can touch the real ~/.claude/skills.
let home, source, skills;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-global-skill-'));
  home = path.join(root, 'home');
  source = path.join(root, 'checkout');
  skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(source, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(source, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  // A mount:claude symlink is a Gemini skill, not a repo-local Claude skill.
  fs.symlinkSync('../../.gemini/skills/gamma', path.join(source, '.claude', 'skills', 'gamma'));
});

afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

function run(...args) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, SKILL_SOURCE_ROOT: source },
  });
}

const linkOf = (name) => fs.readlinkSync(path.join(skills, name));
const srcOf = (name) => path.join(source, '.claude', 'skills', name);

test('install with no names links every real repo-local skill, never mounts', () => {
  const r = run('install');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(linkOf('alpha'), srcOf('alpha'));
  assert.strictEqual(linkOf('beta'), srcOf('beta'));
  assert.ok(!fs.existsSync(path.join(skills, 'gamma')));
});

test('install is idempotent', () => {
  run('install', 'alpha');
  const r = run('install', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: already installed/);
});

test('install fails on an unknown skill', () => {
  const r = run('install', 'nope');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /nope: no skill at/);
});

test('install re-points a symlink that targets somewhere else and reports the old target', () => {
  fs.symlinkSync('/stale/path/alpha', path.join(skills, 'alpha'));
  const r = run('install', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(linkOf('alpha'), srcOf('alpha'));
  assert.match(r.stdout, /was -> \/stale\/path\/alpha/);
});

test('install backs up a real directory whose content matches the source, then links', () => {
  fs.cpSync(srcOf('alpha'), path.join(skills, 'alpha'), { recursive: true });
  const r = run('install', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(linkOf('alpha'), srcOf('alpha'));
  const backups = fs.readdirSync(path.join(home, '.claude', 'skill-backups'));
  assert.strictEqual(backups.length, 1);
  assert.match(backups[0], /^alpha-\d{8}T\d{6}$/);
});

test('install refuses to replace a real directory whose content differs', () => {
  fs.mkdirSync(path.join(skills, 'alpha'));
  fs.writeFileSync(path.join(skills, 'alpha', 'SKILL.md'), 'local edits\n');
  const r = run('install', 'alpha');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /alpha: .* differs from/);
  assert.strictEqual(fs.readFileSync(path.join(skills, 'alpha', 'SKILL.md'), 'utf8'), 'local edits\n');
});

test('uninstall removes a link into this checkout', () => {
  run('install', 'alpha');
  const r = run('uninstall', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(skills, 'alpha')));
});

test('uninstall leaves a link that points elsewhere, and a real directory', () => {
  fs.symlinkSync('/somewhere/else/alpha', path.join(skills, 'alpha'));
  fs.mkdirSync(path.join(skills, 'beta'));
  const r = run('uninstall', 'alpha', 'beta');
  assert.strictEqual(r.status, 1);
  assert.strictEqual(linkOf('alpha'), '/somewhere/else/alpha');
  assert.ok(fs.statSync(path.join(skills, 'beta')).isDirectory());
});

test('uninstall of something not installed is a no-op', () => {
  const r = run('uninstall', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: not installed/);
});

test('rejects a name containing a path separator', () => {
  const r = run('install', '../alpha');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid skill name/);
});

test('install refuses a mount:claude symlink named explicitly', () => {
  const r = run('install', 'gamma');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /gamma: .* is a mount:claude symlink/);
});
