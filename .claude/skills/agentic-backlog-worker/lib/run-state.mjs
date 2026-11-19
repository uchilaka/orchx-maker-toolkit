// Run state, per-ticket cost history and the affordability check for /agentic-backlog-worker.
// `run.json` and `history.json` live in a caller-supplied dir. Times are Unix seconds.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DEFAULTS, readJson } from './config.mjs';

export const TICKET_STATUSES = Object.freeze(
  ['queued', 'running', 'pr', 'handoff', 'capped', 'skipped', 'needs-repo'],
);

// Thrown for a run.json that cannot be trusted. The status hook reports it rather than
// silently starting from a blank run.
export class RunStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunStateError';
  }
}

const RUN_FILE = 'run.json';
const HISTORY_FILE = 'history.json';

// Temp file in the same dir (so rename is atomic) with a unique name so concurrent writers
// never share one.
export function writeJsonAtomic(dir, name, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path.join(dir, name));
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
}

export function loadRun(dir) {
  const file = path.join(dir, RUN_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new RunStateError(`cannot read ${file}: ${err.message}`);
  }
  let run;
  try {
    run = JSON.parse(text);
  } catch (err) {
    throw new RunStateError(`${file} is not valid JSON: ${err.message}`);
  }
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new RunStateError(`${file} is not a run object`);
  }
  for (const key of ['id', 'active', 'tickets']) {
    if (!(key in run)) throw new RunStateError(`${file} is missing "${key}"`);
  }
  if (!Array.isArray(run.tickets)) throw new RunStateError(`${file}: "tickets" must be an array`);
  return run;
}

export function saveRun(dir, run) {
  writeJsonAtomic(dir, RUN_FILE, run);
}

const pad = (n) => String(n).padStart(2, '0');

// The UTC calendar day (YYYY-MM-DD) of a Unix-seconds time.
export const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

// The debrief file name of a run: RUN_<UTC start day>.md, or -2, -3 … for the nth run that day.
export const runFileName = (run, n = 1) => `RUN_${isoDate(run.startedAt)}${n === 1 ? '' : `-${n}`}.md`;

export function newRun({ now, window }) {
  const d = new Date(now * 1000);
  const id = `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return { id, active: true, startedAt: now, heartbeatAt: now, window, tickets: [] };
}

export function heartbeat(run, now) {
  run.heartbeatAt = now;
  return run;
}

export function setTicket(run, id, patch) {
  const ticket = run.tickets.find((t) => t.id === id);
  if (!ticket) throw new RunStateError(`unknown ticket: ${id}`);
  Object.assign(ticket, patch);
  return run;
}

// Cost estimation is advisory (the usage guard is the hard stop), so a missing or corrupt
// history is just an empty one.
export function loadHistory(dir) {
  const parsed = readJson(path.join(dir, HISTORY_FILE));
  return Array.isArray(parsed) ? parsed : [];
}

export function recordCost(dir, { size, delta5h, tokens, shared }) {
  const history = loadHistory(dir);
  history.push({ size, delta5h, tokens, shared, at: Math.floor(Date.now() / 1000) });
  writeJsonAtomic(dir, HISTORY_FILE, history);
}

const MIN_SAMPLES = 3;

// Expected 5h-usage cost (percentage points) of one ticket of `size`. Only S and M are
// eligible; every other size is Infinity so it can never be afforded.
export function expectedCost(size, history, config = DEFAULTS) {
  const prior = { S: config.cost_prior_s, M: config.cost_prior_m }[size];
  if (prior === undefined) return Infinity;
  const samples = history
    .filter((h) => h.size === size && !h.shared && Number.isFinite(h.delta5h))
    .map((h) => h.delta5h)
    .sort((a, b) => a - b);
  if (samples.length < MIN_SAMPLES) return prior;
  return samples[Math.ceil(0.75 * samples.length) - 1]; // p75, nearest rank
}

// Projects usage if this ticket starts alongside `inFlight` others, each costing the same.
export function affordable({ current5h, size, inFlight = 0, history = [], config = DEFAULTS }) {
  const projected = current5h + expectedCost(size, history, config) * (inFlight + 1);
  return { ok: projected < config.usage_cap_5h, projected };
}
