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

const ALPHA_HOOKS = {
  description: 'Start alpha when a session starts',
  mkdir: ['~/alpha-plans'],
  hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '{{SKILL_DIR}}/start.sh >/dev/null 2>&1' }] }] },
};

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
  // alpha ships optional hooks; beta doesn't.
  fs.mkdirSync(path.join(source, '.claude', 'skills', 'alpha', 'install'));
  fs.writeFileSync(path.join(source, '.claude', 'skills', 'alpha', 'install', 'hooks.json'), JSON.stringify(ALPHA_HOOKS));
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

// --- Optional hooks (install/hooks.json). These runs have no terminal, so with no
// flag the installer can't ask and adds nothing.

const settingsFile = () => path.join(home, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const writeSettings = (s) => fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
const alphaCommand = () => `${path.join(skills, 'alpha')}/start.sh >/dev/null 2>&1`;
const commands = (s, event = 'SessionStart') => (s.hooks?.[event] || []).flatMap((g) => g.hooks.map((h) => h.command));

test('hooks: with no terminal and no flag, install adds none and says how to', () => {
  const r = run('install', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: optional hooks not added .*--with-hooks alpha/);
  assert.ok(!fs.existsSync(settingsFile()));
  assert.ok(!fs.existsSync(path.join(home, 'alpha-plans')));
});

test('hooks: --with-hooks adds the hook at the installed path and creates its folders', () => {
  const r = run('install', '--with-hooks', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  const s = readSettings();
  assert.deepStrictEqual(s.hooks.SessionStart, [{ hooks: [{ type: 'command', command: alphaCommand() }], matcher: 'startup' }]);
  assert.ok(fs.statSync(path.join(home, 'alpha-plans')).isDirectory());
});

test('hooks: --with-hooks keeps the rest of settings.json, appends beside the user\'s own hooks, and backs it up', () => {
  const mine = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] };
  writeSettings({ model: 'opus', hooks: { SessionStart: [mine], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } });
  const r = run('install', '--with-hooks', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  const s = readSettings();
  assert.strictEqual(s.model, 'opus');
  assert.deepStrictEqual(s.hooks.SessionStart[0], mine);
  assert.deepStrictEqual(commands(s), ['echo mine', alphaCommand()]);
  assert.deepStrictEqual(commands(s, 'Stop'), ['echo stop']);
  const backups = fs.readdirSync(path.join(home, '.claude', 'skill-backups'));
  assert.strictEqual(backups.filter((b) => b.startsWith('settings.json-')).length, 1);
});

test('hooks: adding is idempotent, including on an already-installed skill', () => {
  run('install', 'alpha');
  run('install', '--with-hooks', 'alpha');
  const r = run('install', '--with-hooks', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: already installed/);
  assert.match(r.stdout, /alpha: optional hooks already in/);
  assert.deepStrictEqual(commands(readSettings()), [alphaCommand()]);
});

test('hooks: --no-hooks adds none', () => {
  const r = run('install', '--no-hooks', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /alpha: optional hooks skipped/);
  assert.ok(!fs.existsSync(settingsFile()));
});

test('hooks: a skill without install/hooks.json never touches settings.json', () => {
  const r = run('install', '--with-hooks', 'beta');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /hooks/);
  assert.ok(!fs.existsSync(settingsFile()));
});

test('hooks: --with-hooks with --no-hooks, or a hooks flag on uninstall, is a usage error', () => {
  assert.strictEqual(run('install', '--with-hooks', '--no-hooks', 'alpha').status, 2);
  assert.strictEqual(run('uninstall', '--with-hooks', 'alpha').status, 2);
  assert.strictEqual(run('install', '--bogus').status, 2);
});

test('hooks: settings.json that isn\'t valid JSON is left untouched, and install reports it', () => {
  fs.writeFileSync(settingsFile(), '{ not json');
  const r = run('install', '--with-hooks', 'alpha');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /isn't valid JSON/);
  assert.strictEqual(fs.readFileSync(settingsFile(), 'utf8'), '{ not json');
  assert.strictEqual(linkOf('alpha'), srcOf('alpha'));
});

test('hooks: a symlinked settings.json is edited through the link', () => {
  const real = path.join(path.dirname(home), 'dotfiles-settings.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, settingsFile());
  assert.strictEqual(run('install', '--with-hooks', 'alpha').status, 0);
  assert.ok(fs.lstatSync(settingsFile()).isSymbolicLink());
  assert.deepStrictEqual(commands(JSON.parse(fs.readFileSync(real, 'utf8'))), [alphaCommand()]);
});

test('hooks: uninstall removes only the skill\'s hook, and drops what it leaves empty', () => {
  writeSettings({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  run('install', '--with-hooks', 'alpha');
  const r = run('uninstall', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(readSettings(), { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] } });

  run('install', '--with-hooks', 'alpha');
  writeSettings({ model: 'opus', hooks: readSettings().hooks });
  run('uninstall', 'alpha');
  assert.deepStrictEqual(readSettings().hooks.SessionStart.length, 1);
});

test('hooks: uninstall of a skill that isn\'t installed still clears a hook left behind', () => {
  run('install', '--with-hooks', 'alpha');
  fs.unlinkSync(path.join(skills, 'alpha'));
  const r = run('uninstall', 'alpha');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(commands(readSettings()), []);
});

test('hooks: uninstall leaves the hook when the link points elsewhere', () => {
  run('install', '--with-hooks', 'alpha');
  fs.unlinkSync(path.join(skills, 'alpha'));
  fs.symlinkSync('/somewhere/else/alpha', path.join(skills, 'alpha'));
  assert.strictEqual(run('uninstall', 'alpha').status, 1);
  assert.deepStrictEqual(commands(readSettings()), [alphaCommand()]);
});

// The real browse fragment, installed for real into a throwaway HOME, must give
// a hook browse's own autostart test accepts.
test('hooks: browse\'s install/hooks.json passes browse\'s autostart hook test', () => {
  const repo = path.join(__dirname, '..');
  const r = spawnSync('bash', [SCRIPT, 'install', '--with-hooks', 'browse'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, SKILL_SOURCE_ROOT: repo },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, 'project-plans')));
  assert.ok(fs.existsSync(path.join(home, 'pr-reviews')));
  // Without NODE_TEST_CONTEXT, which the outer runner sets: with it, the child
  // reports to a parent runner instead of printing its own summary.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const t = spawnSync('node', ['--test', '--test-name-pattern=startup only', path.join(repo, '.claude/skills/browse/test/ensure-server.test.mjs')], {
    encoding: 'utf8', env: { ...env, HOME: home },
  });
  assert.strictEqual(t.status, 0, t.stdout);
  assert.match(t.stdout, /ℹ pass 1/);
});
