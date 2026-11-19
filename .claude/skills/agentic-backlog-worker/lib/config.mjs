// Config and path resolution for /agentic-backlog-worker. Config is flat YAML: `key: value`
// scalars and inline `[a, b]` lists, nothing nested, so no YAML dependency is needed.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  usage_cap_5h: 75,
  usage_cap_7d: 75,
  max_parallel_tickets: 1,
  teams: Object.freeze(['LAR']),
  snapshot_max_age_min: 15,
  cost_prior_s: 5,
  cost_prior_m: 12,
  // Days a triage baseline may go without a full Backlog/Todo listing (the reconcile).
  full_triage_after_days: 14,
  // Queue order of themes; a theme not listed sorts after the last one.
  theme_order: Object.freeze(['bugs', 'security', 'ci-pinning', 'chores', 'cleanups', 'tests', 'features']),
});

// ABW_* overrides are test-only: SKILL.md hardcodes the default paths.
// Paths read the environment at call time so tests can repoint HOME and the ABW_* overrides.
const home = () => process.env.HOME;
export const defaultConfigPath = () =>
  process.env.ABW_CONFIG || path.join(home(), '.config', 'agentic-backlog-worker', 'config.yml');
export const stateDir = () =>
  process.env.ABW_STATE_DIR || path.join(home(), '.claude', 'state', 'agentic-backlog-worker');
export const runsDir = () =>
  process.env.ABW_RUNS_DIR || path.join(home(), 'project-plans', 'agentic-backlog-worker');
export const snapshotPath = () =>
  process.env.ABW_SNAPSHOT || path.join(home(), '.claude', 'state', 'statusline', 'rate-limits.json');

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Parsed JSON, or null when the file can't be read (missing, unreadable) or isn't valid JSON.
// Lives here rather than with writeJsonAtomic so the usage guard's imports stay this file and
// usage.mjs.
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const toNumber = (raw) => (raw.trim() === '' ? NaN : Number(raw));

// Each validator receives the already-coerced value and returns an error message or null.
const percentCap = (key) => (v) =>
  isNum(v) && v >= 1 && v <= 100 ? null : `${key} must be a number 1-100`;
const positive = (key) => (v) => (isNum(v) && v > 0 ? null : `${key} must be a number > 0`);

const SCHEMA = {
  usage_cap_5h: { kind: 'number', check: percentCap('usage_cap_5h') },
  usage_cap_7d: { kind: 'number', check: percentCap('usage_cap_7d') },
  max_parallel_tickets: {
    kind: 'number',
    check: (v) =>
      Number.isInteger(v) && v >= 1 ? null : 'max_parallel_tickets must be an integer >= 1',
  },
  teams: {
    kind: 'list',
    check: (v) => (v.length > 0 ? null : 'teams must list at least one team'),
  },
  snapshot_max_age_min: { kind: 'number', check: positive('snapshot_max_age_min') },
  cost_prior_s: { kind: 'number', check: positive('cost_prior_s') },
  cost_prior_m: { kind: 'number', check: positive('cost_prior_m') },
  full_triage_after_days: { kind: 'number', check: positive('full_triage_after_days') },
  theme_order: {
    kind: 'list',
    check: (v) => (v.length > 0 ? null : 'theme_order must list at least one theme'),
  },
};

// Drops a `# comment`. Config values never contain `#`, so no quote handling is needed.
const stripComment = (line) => line.replace(/#.*$/, '').trim();

const parseList = (raw) => {
  const m = raw.match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
};

export function loadConfig(file = defaultConfigPath()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
  const cfg = { ...DEFAULTS };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error(`invalid config line: ${line}`);
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    const spec = SCHEMA[key];
    if (!spec) throw new Error(`unknown config key: ${key}`);
    let value;
    if (spec.kind === 'list') {
      value = parseList(raw);
      if (!value) throw new Error(`${key} must be an inline list like [a, b]`);
    } else {
      value = toNumber(raw);
    }
    const problem = spec.check(value);
    if (problem) throw new Error(problem);
    cfg[key] = value;
  }
  return cfg;
}
