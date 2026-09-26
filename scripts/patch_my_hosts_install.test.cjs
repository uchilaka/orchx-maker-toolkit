const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL = path.join(__dirname, '..', '.claude', 'skills', 'patch-my-hosts');
const SCRIPTS = path.join(SKILL, 'scripts');
const STABLE = ['_lib.sh', 'fetch-upstream.sh', 'check-stale.sh'];

// Every run gets its own state and LaunchAgents directories, and --no-load, so
// the suite never touches the real ~/Library/LaunchAgents or launchd.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmh-'));
  const env = {
    ...process.env,
    PATCH_MY_HOSTS_STATE_DIR: path.join(root, 'state'),
    PATCH_MY_HOSTS_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
  };
  const run = (script, args = []) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  return { root, env, run, state: env.PATCH_MY_HOSTS_STATE_DIR, agents: env.PATCH_MY_HOSTS_LAUNCH_AGENTS_DIR };
}

test('install copies the scheduled scripts to a stable bin/ outside the skill', () => {
  const sb = sandbox();
  const res = sb.run(path.join(SCRIPTS, 'install-launchd.sh'), ['--no-load']);
  assert.strictEqual(res.status, 0, res.stderr);
  for (const f of STABLE) {
    const copy = path.join(sb.state, 'bin', f);
    assert.ok(fs.existsSync(copy), `missing ${copy}`);
    assert.ok(fs.statSync(copy).mode & 0o100, `${f} is not executable`);
    assert.strictEqual(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
  }
});

test('the rendered plist runs the stable copy, never a path inside the skill', () => {
  const sb = sandbox();
  sb.run(path.join(SCRIPTS, 'install-launchd.sh'), ['--no-load']);
  const plist = fs.readFileSync(path.join(sb.agents, 'com.larcity.patch-my-hosts.plist'), 'utf8');
  assert.ok(plist.includes(`<string>${path.join(sb.state, 'bin', 'fetch-upstream.sh')}</string>`), plist);
  assert.ok(!plist.includes(SKILL), 'plist points into the skill directory, which moves on plugin update');
});

test('the stable check-stale.sh works on its own, after the skill directory is gone', () => {
  const sb = sandbox();
  sb.run(path.join(SCRIPTS, 'install-launchd.sh'), ['--no-load']);
  fs.writeFileSync(path.join(sb.state, 'pending'), '');
  const res = sb.run(path.join(sb.state, 'bin', 'check-stale.sh'));
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout + res.stderr, /pending/);
});

test('uninstall removes the plist and the stable copies', () => {
  const sb = sandbox();
  sb.run(path.join(SCRIPTS, 'install-launchd.sh'), ['--no-load']);
  // Precondition: without it, this test passes against an installer that
  // never wrote anything.
  assert.ok(fs.existsSync(path.join(sb.agents, 'com.larcity.patch-my-hosts.plist')), 'install wrote no plist');
  assert.ok(fs.existsSync(path.join(sb.state, 'bin', 'fetch-upstream.sh')), 'install copied nothing');
  const res = sb.run(path.join(SCRIPTS, 'uninstall-launchd.sh'), ['--no-load']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(path.join(sb.agents, 'com.larcity.patch-my-hosts.plist')));
  for (const f of STABLE) assert.ok(!fs.existsSync(path.join(sb.state, 'bin', f)), `${f} left behind`);
  assert.ok(fs.existsSync(path.join(sb.state)), 'uninstall must keep the archive and state');
});

test('SKILL.md never hardcodes its own install location', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.ok(!md.includes('~/.claude/skills/'), 'a plugin install does not live under ~/.claude/skills/');
  assert.match(md, /\$\{CLAUDE_SKILL_DIR\}\/scripts\/patch-my-hosts\.sh/);
  assert.match(md, /~\/\.local\/share\/patch-my-hosts\/bin\/check-stale\.sh/);
});
