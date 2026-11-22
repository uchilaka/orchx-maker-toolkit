// openv's guard as Claude Code runs it: the registered hook command, through a
// shell, from both install paths (the plugin's marketplace entry and
// install/hooks.json). guard.test.mjs covers the script; this covers the
// wiring, where a wrong path would exit 127 and let every command through
// (LAR-528), or block every command (review of PR #52, L1). Run from the repo
// root:
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

const payload = (command, { tool = 'Bash', cwd = '/srv/repos/app' } = {}) => JSON.stringify({
  session_id: 's', transcript_path: '/var/tmp/claude/t.jsonl', cwd,
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command, description: 'd' }, tool_use_id: 't',
});

// A copy of the plugin tree with just this skill, so a test can break it. The
// root has a space in it, so an unquoted path fails here (PR #52, T2).
function pluginCopy(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'openv hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(SKILL_DIR, path.join(root, SKILL_REL), { recursive: true });
  return { root, skill: path.join(root, SKILL_REL) };
}

// TODO(LAR-557): also run install/hooks.json through claude_skill_hooks.cjs
// and the symlinked skill folder install:claude-global creates.
// TODO(LAR-558): substitute ${CLAUDE_PLUGIN_ROOT} into the text, as Claude
// Code does, with a root containing a $.
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

  test(`${label}: blocks a denied command sent through Monitor`, (t) => {
    const denied = inst.run(shell, pluginCopy(t), payload('pass-cli item view x', { tool: 'Monitor' }));
    assert.strictEqual(denied.status, 2, denied.stderr);
  });

  // When the script can't start, the command blocks only what the guard
  // would have had to look at: commands naming openv, pass-cli or pass:.
  // Everything else, including the commands to repair the install, runs.
  test(`${label}: with the script missing, blocks only commands the guard covers`, (t) => {
    const tree = pluginCopy(t);
    rmSync(path.join(tree.skill, 'hooks', 'guard-secrets.sh'));
    const denied = inst.run(shell, tree, payload('pass-cli item view x'));
    assert.strictEqual(denied.status, 2);
    assert.match(denied.stderr, /openv guard couldn't run/);
    assert.strictEqual(inst.run(shell, tree, payload('openv run dev -- env')).status, 2);
    const ls = inst.run(shell, tree, payload('ls'));
    assert.strictEqual(ls.status, 0, ls.stderr);
    // A cwd that names openv doesn't count: only the command does.
    assert.strictEqual(inst.run(shell, tree, payload('ls', { cwd: '/opt/openv-hooks' })).status, 0);
  });

  test(`${label}: runs the guard even when the script isn't executable`, (t) => {
    const tree = pluginCopy(t);
    chmodSync(path.join(tree.skill, 'hooks', 'guard-secrets.sh'), 0o644);
    const denied = inst.run(shell, tree, payload('pass-cli item view x'));
    assert.strictEqual(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /openv guard: blocked/);
    assert.strictEqual(inst.run(shell, tree, payload('ls')).status, 0);
  });
}
