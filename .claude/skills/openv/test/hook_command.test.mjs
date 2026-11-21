// openv's guard as Claude Code runs it: the registered hook command, through a
// shell, from both install paths (the plugin's marketplace entry and
// install/hooks.json). guard.test.mjs covers the script; this covers the
// wiring, where a wrong path would exit 127 and let every command through
// (LAR-528). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
const SKILL_REL = path.relative(ROOT, SKILL_DIR);

const pluginCommand = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
  .plugins.find((p) => p.name === 'openv').hooks.PreToolUse[0].hooks[0].command;
const installCommand = JSON.parse(readFileSync(path.join(SKILL_DIR, 'install', 'hooks.json'), 'utf8'))
  .hooks.PreToolUse[0].hooks[0].command;

const payload = (command) => JSON.stringify({
  session_id: 's', transcript_path: '/var/tmp/claude/t.jsonl', cwd: '/srv/repos/app',
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
});

// A copy of the plugin tree with just this skill, so a test can break it.
function pluginCopy(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'openv-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(SKILL_DIR, path.join(root, SKILL_REL), { recursive: true });
  return { root, skill: path.join(root, SKILL_REL) };
}

// Each way the command reaches a shell: the plugin's, with CLAUDE_PLUGIN_ROOT
// in the environment, and install/hooks.json's, with {{SKILL_DIR}} replaced
// by the installer. Both under sh and bash.
const installs = [
  { name: 'plugin', run: (shell, { root }, input) => spawnSync(shell, ['-c', pluginCommand], { input, encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root } }) },
  { name: 'install/hooks.json', run: (shell, { skill }, input) => spawnSync(shell, ['-c', installCommand.split('{{SKILL_DIR}}').join(skill)], { input, encoding: 'utf8', env: { PATH: process.env.PATH } }) },
];

for (const shell of ['/bin/sh', '/bin/bash']) for (const inst of installs) {
  const label = `${inst.name} under ${shell}`;

  test(`${label}: blocks a denied command, allows an ordinary one`, (t) => {
    const tree = pluginCopy(t);
    const denied = inst.run(shell, tree, payload('pass-cli item view x'));
    assert.strictEqual(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /openv guard: blocked/);
    const allowed = inst.run(shell, tree, payload('openv run dev -- env'));
    assert.strictEqual(allowed.status, 0, allowed.stderr);
  });

  test(`${label}: blocks every command when the script is missing`, (t) => {
    const tree = pluginCopy(t);
    rmSync(path.join(tree.skill, 'hooks', 'guard-secrets.sh'));
    assert.strictEqual(inst.run(shell, tree, payload('ls')).status, 2);
  });

  test(`${label}: blocks every command when the script isn't executable`, (t) => {
    const tree = pluginCopy(t);
    chmodSync(path.join(tree.skill, 'hooks', 'guard-secrets.sh'), 0o644);
    assert.strictEqual(inst.run(shell, tree, payload('ls')).status, 2);
  });
}
