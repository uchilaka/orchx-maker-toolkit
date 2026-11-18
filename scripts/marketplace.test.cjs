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
const scriptOf = (p, command) => {
  const first = command.match(/^("[^"]*"\S*|\S+)/)[1].replace(/"/g, '');
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

// A plugin that exists for its hooks (hot-reload-preview) ships no skills, so
// installing it never adds a skill the user didn't choose. LAR-394 tracks the
// reverse check: that every real skill is listed by some plugin.
test('hook plugins ship no skills', () => {
  for (const p of plugins.filter((p) => p.hooks)) {
    assert.deepEqual(p.skills, [], `${p.name} has hooks, so it must set "skills": []`);
  }
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
