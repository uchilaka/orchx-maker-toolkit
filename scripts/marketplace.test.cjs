// Structural checks on .claude-plugin/marketplace.json. `claude plugin
// validate` only rejects type errors: on CLI 2.1.296 and 2.1.326 it passes a
// dependency on a plugin that doesn't exist and a hook command whose script is
// missing, so nothing else would catch either before an install breaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.MARKETPLACE_ROOT || path.join(__dirname, '..');
const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
const plugins = marketplace.plugins;

// Every command hook in a plugin entry, flattened.
const hooksOf = (p) => Object.entries(p.hooks || {}).flatMap(([event, matchers]) =>
  matchers.flatMap((m) => (m.hooks || []).map((h) => ({ event, matcher: m.matcher, ...h }))));

// The script a hook runs: its first word, with ${CLAUDE_PLUGIN_ROOT} as the
// plugin's source folder.
// The script a hook command runs: its first word, or the second when the
// command starts with `bash` (openv's guard, so it runs without the exec bit).
const scriptOf = (p, command) => {
  const first = command.replace(/^bash\s+/, '').match(/^("[^"]*"\S*|\S+)/)[1].replace(/"/g, '');
  return path.join(ROOT, p.source, first.replace('${CLAUDE_PLUGIN_ROOT}', ''));
};

test('plugin names are unique', () => {
  const names = plugins.map((p) => p.name);
  assert.deepEqual(names, [...new Set(names)]);
});

test('every listed skill folder exists and has a SKILL.md', () => {
  for (const p of plugins) for (const s of p.skills || []) {
    assert.ok(fs.existsSync(path.join(ROOT, p.source, s, 'SKILL.md')), `${p.name}: ${s}/SKILL.md`);
  }
});

test('dependencies name plugins in this marketplace', () => {
  const names = new Set(plugins.map((p) => p.name));
  for (const p of plugins) for (const d of p.dependencies || []) {
    assert.ok(names.has(d), `${p.name} depends on unknown plugin ${d}`);
  }
});

// Every entry shares source "./", the whole repo, so an entry with no `skills`
// array ships every skill on disk. Each entry names its skills explicitly — a
// hook-only plugin sets "skills": [] (the PR #26 spike: hot-reload-preview
// showed Skills(0) with it) — and no skill is named twice, so an install with
// every plugin has one copy of each skill. check-mermaid-artifact is a
// standalone plugin, which is why this isn't "only orchx-maker lists skills".
test('every plugin lists its skills explicitly', () => {
  for (const p of plugins) {
    assert.ok(Array.isArray(p.skills), `${p.name} must set "skills" (use [] for none)`);
  }
});

test('no skill ships in two plugins', () => {
  const seen = new Map();
  for (const p of plugins) for (const s of p.skills || []) {
    const key = path.normalize(path.join(p.source, s));
    assert.ok(!seen.has(key), `${s} is in both ${seen.get(key)} and ${p.name}`);
    seen.set(key, p.name);
  }
});

// A plugin with hooks ships either no skills (hot-reload-preview), or only
// skills its own hook scripts live in (openv, whose guard protects its skill).
// Either way, installing it never adds a skill the user didn't choose: every
// skill it brings is one its hooks need. A hooks-only plugin listing a skill
// that already ships elsewhere is caught by "no skill ships in two plugins".
// LAR-394 tracks the reverse check: that every real skill is listed by some
// plugin.
const skillsWithoutHooks = (p) => {
  const scripts = hooksOf(p).map((h) => scriptOf(p, h.command));
  return (p.skills || []).filter((s) => {
    const dir = path.join(ROOT, p.source, s, path.sep);
    return !scripts.some((script) => script.startsWith(dir));
  });
};

test('a hook plugin ships only skills its hook scripts live in', () => {
  for (const p of plugins.filter((p) => p.hooks)) {
    assert.deepEqual(skillsWithoutHooks(p), [], `${p.name} has hooks, so each skill it lists must hold one of its hook scripts`);
  }
});

test('the hook-plugin rule rejects a skill no hook script lives in', () => {
  const hook = (script) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}"/${script} || exit 2` }] }] });
  const guard = '.claude/skills/openv/hooks/guard-secrets.sh';
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: [], hooks: hook(guard) }), []);
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/openv'], hooks: hook(guard) }), []);
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/browse'], hooks: hook(guard) }), ['./.claude/skills/browse']);
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/openv', './.claude/skills/browse'], hooks: hook(guard) }), ['./.claude/skills/browse']);
  // A trailing slash on the skill is the same folder (PR #52, L5).
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/openv/'], hooks: hook(guard) }), []);
  // So is a command that runs the script through bash.
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/openv'], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash "\${CLAUDE_PLUGIN_ROOT}"/${guard}` }] }] } }), []);
  // A sibling folder whose name starts with the skill's isn't inside it.
  assert.deepEqual(skillsWithoutHooks({ source: './', skills: ['./.claude/skills/open'], hooks: hook(guard) }), ['./.claude/skills/open']);
});

test('every hook script exists and is executable', () => {
  for (const p of plugins) for (const h of hooksOf(p)) {
    const script = scriptOf(p, h.command);
    assert.ok(fs.existsSync(script), `${p.name}: ${script} is missing`);
    fs.accessSync(script, fs.constants.X_OK);
  }
});

test('SessionStart hooks fire on startup only, silently', () => {
  for (const p of plugins) for (const h of hooksOf(p).filter((h) => h.event === 'SessionStart')) {
    assert.equal(h.matcher, 'startup', `${p.name}: /clear, /compact and resume shouldn't fire it`);
    assert.match(h.command, />\/dev\/null 2>&1$/, `${p.name}: hook output would cost context`);
  }
});

// TODO(LAR-449): one definition instead of two. Until then they must agree:
// same script, same arguments, and no folder, so both resolve the autostart
// folder the same way and a machine with both installs runs one server.
test('the plugin hook and browse/install/hooks.json run the same command', () => {
  const plugin = hooksOf(plugins.find((p) => p.name === 'hot-reload-preview'))[0].command;
  const install = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'browse', 'install', 'hooks.json'), 'utf8'))
    .hooks.SessionStart[0].hooks[0].command;
  const tail = (c) => c.replace(/^.*?ensure-server\.sh"?/, '');
  assert.equal(tail(plugin), tail(install));
  assert.equal(tail(plugin), ' --open >/dev/null 2>&1', 'no folder argument');
});

// The guard must block when it can't run. Claude Code blocks a tool call only
// on exit 2, so a missing script (127) would let every command through. The
// fallback after `||` blocks only what the guard covers (commands naming
// openv, pass-cli or pass:), so a broken install doesn't block the commands
// that repair it (PR #52, L1). `bash` runs the script without its exec bit
// (L2). Monitor runs shell commands too (L3). The guard itself exits only 0
// or 2, so nothing it allows is blocked. Both install paths register the same
// command (LAR-528); hook_command.test.mjs runs it.
const openvGuard = () => {
  const p = plugins.find((p) => p.name === 'openv');
  const pre = (p.hooks && p.hooks.PreToolUse) || [];
  const install = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'skills', 'openv', 'install', 'hooks.json'), 'utf8')).hooks;
  return { p, pre, install };
};

test('openv registers its guard as a PreToolUse(Bash|Monitor) hook that blocks when it can\'t run', () => {
  const { pre } = openvGuard();
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Bash|Monitor');
  assert.match(pre[0].hooks[0].command, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}"\/\.claude\/skills\/openv\/hooks\/guard-secrets\.sh \|\| \{/);
});

test('the openv plugin hook and openv/install/hooks.json register the same guard', () => {
  const { p, install } = openvGuard();
  assert.deepEqual(Object.keys(p.hooks), Object.keys(install), 'same events');
  const tail = (c) => c.replace(/^.*?\/hooks\/guard-secrets\.sh"?/, '');
  const plugin = p.hooks.PreToolUse[0];
  const local = install.PreToolUse[0];
  assert.equal(local.matcher, plugin.matcher);
  assert.equal(tail(local.hooks[0].command), tail(plugin.hooks[0].command));
  assert.match(local.hooks[0].command, /^bash "\{\{SKILL_DIR\}\}\/hooks\/guard-secrets\.sh"/);
});
