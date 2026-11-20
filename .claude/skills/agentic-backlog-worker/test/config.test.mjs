import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULTS, loadConfig, defaultConfigPath, stateDir, runsDir, snapshotPath,
} from '../lib/config.mjs';
import { tmpRoot } from './helpers.mjs';

const tmp = tmpRoot('abw-config-');
let n = 0;
const write = (text) => {
  const p = path.join(tmp, `config-${n++}.yml`);
  writeFileSync(p, text);
  return p;
};
const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

test('a missing file deep-equals DEFAULTS', () => {
  assert.deepStrictEqual(loadConfig(path.join(tmp, 'nope.yml')), { ...DEFAULTS });
});

test('DEFAULTS carry the documented values and are frozen', () => {
  assert.deepStrictEqual({ ...DEFAULTS }, {
    usage_cap_5h: 75, usage_cap_7d: 75, max_parallel_tickets: 1, teams: ['LAR'],
    snapshot_max_age_min: 15, cost_prior_s: 5, cost_prior_m: 12,
    full_triage_after_days: 14,
    theme_order: ['bugs', 'security', 'ci-pinning', 'chores', 'cleanups', 'tests', 'features'],
    denied_repos: [],
  });
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('usage_cap_5h: 60 overrides only that key', () => {
  const cfg = loadConfig(write('usage_cap_5h: 60\n'));
  assert.deepStrictEqual(cfg, { ...DEFAULTS, usage_cap_5h: 60 });
});

test('teams inline list parses', () => {
  assert.deepStrictEqual(loadConfig(write('teams: [LAR, LBD]\n')).teams, ['LAR', 'LBD']);
});

test('comments and blank lines are ignored', () => {
  const cfg = loadConfig(write('# top\n\nusage_cap_7d: 50 # trailing\n\n  # indented\n'));
  assert.deepStrictEqual(cfg, { ...DEFAULTS, usage_cap_7d: 50 });
});

test('an unknown key throws', () => {
  assert.throws(() => loadConfig(write('foo: 1\n')), /unknown config key: foo/);
});

test('a non-numeric cap throws', () => {
  assert.throws(() => loadConfig(write('usage_cap_5h: lots\n')), /usage_cap_5h must be a number 1-100/);
});

test('caps outside 1-100 throw', () => {
  assert.throws(() => loadConfig(write('usage_cap_7d: 0\n')), /usage_cap_7d must be a number 1-100/);
  assert.throws(() => loadConfig(write('usage_cap_7d: 101\n')), /usage_cap_7d must be a number 1-100/);
});

test('max_parallel_tickets must be an integer >= 1', () => {
  assert.throws(() => loadConfig(write('max_parallel_tickets: 0\n')), /max_parallel_tickets/);
  assert.throws(() => loadConfig(write('max_parallel_tickets: 1.5\n')), /max_parallel_tickets/);
  assert.strictEqual(loadConfig(write('max_parallel_tickets: 3\n')).max_parallel_tickets, 3);
});

test('snapshot_max_age_min and cost priors must be > 0', () => {
  assert.throws(() => loadConfig(write('snapshot_max_age_min: 0\n')), /snapshot_max_age_min/);
  assert.throws(() => loadConfig(write('cost_prior_s: -1\n')), /cost_prior_s/);
  assert.throws(() => loadConfig(write('cost_prior_m: x\n')), /cost_prior_m/);
});

test('path helpers use defaults under HOME and honor overrides at call time', () => {
  const clear = { ABW_CONFIG: undefined, ABW_STATE_DIR: undefined, ABW_RUNS_DIR: undefined, ABW_SNAPSHOT: undefined };
  const unset = () => { for (const k of Object.keys(clear)) delete process.env[k]; };
  withEnv({ HOME: '/h' }, () => {
    unset();
    assert.strictEqual(defaultConfigPath(), '/h/.config/agentic-backlog-worker/config.yml');
    assert.strictEqual(stateDir(), '/h/.claude/state/agentic-backlog-worker');
    assert.strictEqual(runsDir(), '/h/project-plans/agentic-backlog-worker');
    assert.strictEqual(snapshotPath(), '/h/.claude/state/statusline/rate-limits.json');
  });
  withEnv({ HOME: '/h', ABW_CONFIG: '/c', ABW_STATE_DIR: '/s', ABW_RUNS_DIR: '/r', ABW_SNAPSHOT: '/n' }, () => {
    assert.strictEqual(defaultConfigPath(), '/c');
    assert.strictEqual(stateDir(), '/s');
    assert.strictEqual(runsDir(), '/r');
    assert.strictEqual(snapshotPath(), '/n');
  });
});

test('loadConfig() with no argument reads ABW_CONFIG', () => {
  withEnv({ ABW_CONFIG: write('usage_cap_5h: 40\n') }, () => {
    assert.strictEqual(loadConfig().usage_cap_5h, 40);
  });
});

test('full_triage_after_days and theme_order parse and validate', () => {
  const cfg = loadConfig(write('full_triage_after_days: 7\ntheme_order: [tests, bugs]\n'));
  assert.deepStrictEqual([cfg.full_triage_after_days, cfg.theme_order], [7, ['tests', 'bugs']]);
  assert.throws(() => loadConfig(write('full_triage_after_days: 0\n')), /full_triage_after_days/);
  assert.throws(() => loadConfig(write('theme_order: []\n')), /theme_order/);
});

test('denied_repos: an inline list of absolute paths parses; an empty list is allowed', () => {
  assert.deepStrictEqual(loadConfig(write('denied_repos: [/opt/a, /opt/b]\n')).denied_repos,
    ['/opt/a', '/opt/b']);
  assert.deepStrictEqual(loadConfig(write('denied_repos: []\n')).denied_repos, []);
});

test('denied_repos: a relative path throws', () => {
  assert.throws(() => loadConfig(write('denied_repos: [/opt/a, cami]\n')),
    /denied_repos must list absolute paths/);
});
