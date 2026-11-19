// Shared fixtures for the /agentic-backlog-worker tests. Run everything with:
//   node --test '.claude/skills/agentic-backlog-worker/test/*.test.mjs'   (from the repo root)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A fixed clock: 2027-01-15T08:00:00Z.
export const NOW = 1_800_000_000;

// A fresh temp dir, symlinks resolved (macOS's /var is /private/var), so paths the code
// realpaths compare equal to the ones the test built.
export const tmpRoot = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

// Writes `value` as JSON (a string is written as-is, for corrupt fixtures), creating the
// parent dir. Returns the path.
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

// Runs git with a throwaway identity and fails the test on a non-zero exit.
export function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// Every ABW_* path under `root` and a HOME there too, so nothing touches the real ~/.claude
// or ~/.config, and the clock pinned to NOW. HOME is created; the rest appear on first write.
export function abwEnv(root) {
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    ABW_STATE_DIR: path.join(root, 'state'),
    ABW_RUNS_DIR: path.join(root, 'runs'),
    ABW_SNAPSHOT: path.join(root, 'snap.json'),
    ABW_CONFIG: path.join(root, 'config.yml'),
    ABW_NOW: String(NOW),
  };
  mkdirSync(env.HOME, { recursive: true });
  return env;
}

// Runs a script with this node, as a hook runner would. `env` is layered over process.env.
export const runNode = (script, { input, env = {}, args = [] } = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    input, encoding: 'utf8', env: { ...process.env, ...env },
  });
