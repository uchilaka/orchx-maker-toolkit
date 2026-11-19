// openv run and export (plan S5). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'openv');
const CANARY_A = 'sk-canary-a92e10';
const CANARY_WEIRD = "it's $HOME `x` \"hi\"\nline2\\end";

// Stub pass-cli that mimics `pass-cli run [--no-masking] --env-file F -- <cmd>...`:
// loads VAR=value lines, swaps any pass:// ref for a canary value (so export tests
// verify real resolution without touching Proton Pass), and runs <cmd>.
const STUB_PASS = `#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
with open(os.environ['PASS_CALLS'], 'a') as f:
  f.write(' '.join(args) + '\\n')
if args[:1] != ['run']:
  sys.exit(1)
i = 1
env_file = None
no_mask = False
while i < len(args):
  if args[i] == '--no-masking':
    no_mask = True; i += 1
  elif args[i] == '--env-file':
    env_file = args[i + 1]; i += 2
  elif args[i] == '--':
    cmd = args[i + 1:]; break
  else:
    sys.stderr.write(f'unexpected arg: {args[i]}\\n'); sys.exit(2)
env = os.environ.copy()
secrets = []
for line in open(env_file):
  line = line.rstrip('\\n')
  if not line or line.lstrip().startswith('#') or '=' not in line:
    continue
  k, v = line.split('=', 1)
  if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
    v = v[1:-1]
  if v.startswith('pass://'):
    v = ${JSON.stringify(CANARY_WEIRD)} if 'WEIRD' in k else ${JSON.stringify(CANARY_A)}
    secrets.append(v)
  env[k] = v
if no_mask:
  sys.exit(subprocess.call(cmd, env=env))
p = subprocess.run(cmd, env=env, capture_output=True, text=True)
out, err = p.stdout, p.stderr
for s in secrets:
  out = out.replace(s, '<concealed by Proton Pass>')
  err = err.replace(s, '<concealed by Proton Pass>')
sys.stdout.write(out)
sys.stderr.write(err)
sys.exit(p.returncode)
`;

function sandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'openv-s5-')));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'pass-cli.calls');
  for (const d of [home, config, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, 'pass-cli'), STUB_PASS);
  chmodSync(path.join(bin, 'pass-cli'), 0o755);
  const write = (rel, body) => {
    const f = path.join(config, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const baseEnv = (extra = {}) => {
    const e = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin`, OPENV_CONFIG_DIR: config, PASS_CALLS: calls, ...extra };
    if (!('CLAUDECODE' in extra)) delete e.CLAUDECODE;
    if (!('OPENCODE_SESSION_ID' in extra)) delete e.OPENCODE_SESSION_ID;
    return e;
  };
  const run = (args, { cwd = root, shell = 'bash', env = {} } = {}) =>
    spawnSync(shell, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: baseEnv(env) });
  // Spawns a shell script inside a real PTY so [ -t 0 ] is true, matching a user's terminal.
  const runPty = (targetShell, command, { cwd = root, env = {} } = {}) => {
    const py = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
  os.chdir(${JSON.stringify(cwd)})
  os.execv(${JSON.stringify(targetShell)}, [${JSON.stringify(targetShell)}, '-c', ${JSON.stringify(command)}])
out = bytearray()
while True:
  try:
    chunk = os.read(fd, 4096)
    if not chunk: break
    out.extend(chunk)
  except OSError:
    break
_, st = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(st))
`;
    return spawnSync('python3', ['-c', py], { encoding: 'utf8', env: baseEnv(env) });
  };
  const passCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const repo = (name) => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    return dir;
  };
  return { root, config, write, run, runPty, passCalls, repo };
}

test('openv run passes the resolved profile to pass-cli run and preserves the child exit code', () => {
  const s = sandbox();
  const dir = s.repo('acme');
  s.write('acme/dev.env', 'SECRET_KEY=pass://V/item/field\nLIT=plain\n');
  s.write('global/dev.env', 'SECRET_KEY=pass://V/other/field\n');
  const r = s.run(['run', 'dev', '--', '/bin/sh', '-c', 'printf "%s:%s\\n" "$LIT" "$SECRET_KEY"; exit 7'], { cwd: dir });
  assert.strictEqual(r.status, 7);
  assert.strictEqual(r.stdout.trim(), 'plain:<concealed by Proton Pass>');
  assert.ok(!r.stdout.includes(CANARY_A));
  assert.match(s.passCalls()[0], new RegExp(`^run --env-file ${s.config}/acme/dev\\.env -- `));
});

test('openv run falls back to global profile outside a repo or when project lacks the env', () => {
  const s = sandbox();
  const dir = s.repo('acme');
  s.write('global/openrouter.env', 'API=pass://S/I/API Key\n');
  assert.strictEqual(s.run(['run', 'openrouter', '--', 'true'], { cwd: dir }).status, 0);
  assert.strictEqual(s.run(['run', 'openrouter', '--', 'true']).status, 0);
  assert.match(s.passCalls()[0], /global\/openrouter\.env/);
});

test('openv run rejects bad usage, missing profiles and path traversal', () => {
  const s = sandbox();
  for (const args of [['run'], ['run', 'dev'], ['run', 'dev', '--'], ['run', 'dev', 'true']]) {
    assert.strictEqual(s.run(args).status, 64, args.join(' '));
  }
  assert.strictEqual(s.run(['run', 'nope', '--', 'true']).status, 1);
  assert.strictEqual(s.run(['run', '../escape', '--', 'true']).status, 1);
  assert.deepStrictEqual(s.passCalls(), []);
});

test('openv export is refused without a TTY, even when agent env vars are unset', () => {
  const s = sandbox();
  s.write('global/dev.env', 'SECRET=pass://V/i/f\n');
  const r = s.run(['export', 'dev']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /interactive terminal/);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(s.passCalls(), []);
});

test('openv export is refused under CLAUDECODE or OPENCODE_SESSION_ID even with a TTY', () => {
  const s = sandbox();
  s.write('global/dev.env', 'SECRET=pass://V/i/f\n');
  for (const env of [{ CLAUDECODE: '1' }, { OPENCODE_SESSION_ID: 'ses_abc' }]) {
    const r = s.runPty('/bin/bash', `${SCRIPT} export dev`, { env });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /disabled inside agent sessions/);
    assert.ok(!r.stdout.includes(CANARY_A));
  }
  assert.deepStrictEqual(s.passCalls(), []);
});

// Resolves a shell from PATH rather than assuming /bin (Ubuntu runners have no zsh
// unless test.yml installs it). Locally a missing shell skips its case; under CI it
// fails instead, like publish_prep's gitleaks tests, so coverage can't silently drop.
const findShell = (name) => {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

test('eval "$(openv export dev)" works in both zsh and bash, including quotes, $ and newlines', async (t) => {
  for (const name of ['zsh', 'bash']) await t.test(name, (st) => {
    const sh = findShell(name);
    if (!sh) {
      assert.ok(!process.env.CI, `${name} is not installed; CI must install it (see .github/workflows/test.yml)`);
      st.skip(`${name} is not installed`);
      return;
    }
    const s = sandbox();
    s.write('global/dev.env', 'SECRET=pass://V/i/f\nWEIRD=pass://V/i/w\nPLAIN=hello\n');
    const cmd = `eval "$(/bin/bash ${SCRIPT} export dev)"; python3 -c "import os; print(repr((os.environ['SECRET'], os.environ['WEIRD'], os.environ['PLAIN'])))"`;
    const r = s.runPty(sh, cmd);
    assert.strictEqual(r.status, 0, `${sh}: ${r.stdout}`);
    assert.ok(r.stdout.includes(`(${JSON.stringify(CANARY_A).replace(/"/g, "'")}, `), r.stdout);
    // Check via JSON line to avoid repr quoting ambiguity.
    const cmd2 = `eval "$(/bin/bash ${SCRIPT} export dev)"; python3 -c "import json,os; print(json.dumps([os.environ['SECRET'], os.environ['WEIRD'], os.environ['PLAIN']]))"`;
    const r2 = s.runPty(sh, cmd2);
    assert.strictEqual(r2.status, 0, r2.stdout);
    const line = r2.stdout.trim().split('\n').pop().trim();
    assert.deepStrictEqual(JSON.parse(line), [CANARY_A, CANARY_WEIRD, 'hello']);
  });
});

test('openv export handles an empty profile without calling pass-cli', () => {
  const s = sandbox();
  s.write('global/empty.env', '# nothing here\n');
  const r = s.runPty('/bin/bash', `/bin/bash ${SCRIPT} export empty`);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.stdout.trim(), '');
  assert.deepStrictEqual(s.passCalls(), []);
});
