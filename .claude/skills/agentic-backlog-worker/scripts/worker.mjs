#!/usr/bin/env node
// Deterministic CLI the /agentic-backlog-worker orchestrator calls between its judgment steps.
// Every command prints one JSON object on stdout. Exit 0 on success, 1 with {"error"} on a
// failure, and a one-shot `window` exits 3 when the 5h window is not open. `window --wait` and
// `heartbeat --loop` keep running and print once when they end.
// Times are Unix seconds; ABW_NOW overrides the clock for tests, and ABW_POLL_S and
// ABW_HEARTBEAT_S shorten the two loops' intervals.
import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, realpathSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadConfig, stateDir, runsDir, snapshotPath, isNum, readJson,
} from '../lib/config.mjs';
import { readUsage, capStatus } from '../lib/usage.mjs';
import { clean } from '../lib/sanitize.mjs';
import {
  loadRun, saveRun, newRun, heartbeat, setTicket, loadHistory, recordCost, affordable,
  writeJsonAtomic, isoDate, runFileName, TICKET_STATUSES,
} from '../lib/run-state.mjs';

const estimatesBlocked = (teams) =>
  `Turn on T-shirt estimates: Linear → Settings → Teams → ${teams.join(', ')} → Estimates`;
const TICKET_ID = /^[A-Z]+-[0-9]+$/;
const SIZES = ['S', 'M', 'L', 'XL'];
const OUTCOME_STATUS = { pr: 'pr', handoff: 'handoff', capped: 'capped', failed: 'handoff' };
const OUTCOMES = Object.keys(OUTCOME_STATUS);
// Statuses a ticket can be (re)started from: a fresh one, or a resumable one.
const BEGINNABLE = ['queued', 'capped', 'handoff'];
// A PR url lands in a markdown link in the debrief, so it may not contain link syntax.
const PR_URL = /^https:\/\/[^\s()<>[\]`|]+$/;
const WINDOW_FILE = 'window.json';
// Tickets that survive into the next run until worked or closed out.
const CARRIED = ['capped', 'handoff'];
// Tickets that keep a run unresolved, and those that get a tracker row in the debrief.
const OPEN = [...CARRIED, 'running'];
const WORKED = [...OPEN, 'pr'];
// Only a skipped or needs-repo ticket may lack a repo; every other one must name one.
const REPOLESS = ['skipped', 'needs-repo'];
const reposRoot = () => process.env.ABW_REPOS_ROOT || '/opt/Developer';

class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

// A non-negative integer given as text, or a failure with `what` as the message.
function uint(raw, what) {
  if (!/^\d+$/.test(raw)) fail(what);
  return Number(raw);
}

function now() {
  const raw = process.env.ABW_NOW;
  if (raw === undefined || raw === '') return Math.floor(Date.now() / 1000);
  return uint(raw, 'ABW_NOW must be Unix seconds');
}

// Loop interval in ms: the env override (seconds, fractions allowed) when it is a positive
// number, else the default.
function intervalMs(envVar, defaultS) {
  const s = Number(process.env[envVar]);
  return (Number.isFinite(s) && s > 0 ? s : defaultS) * 1000;
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function context() {
  const config = loadConfig();
  const t = now();
  const usage = readUsage({ path: snapshotPath(), now: t, maxAgeMin: config.snapshot_max_age_min });
  return { config, t, usage, cap: capStatus(usage, config) };
}

const pct = (win) => (win ? win.pct : null);
// A 5h reading is only trusted for cost and reset decisions when the snapshot is fresh.
const fresh5h = (usage) => (usage.state === 'ok' && usage.fiveHour ? usage.fiveHour : null);

function requireRun() {
  const run = loadRun(stateDir());
  if (!run) fail('no run: start one first');
  return run;
}

function activeRun() {
  const run = loadRun(stateDir());
  return run && run.active ? run : null;
}

function readWindowFile() {
  const w = readJson(path.join(stateDir(), WINDOW_FILE));
  return isNum(w?.resetsAt) ? w : null;
}

// The user-supplied reset, if any: the active run's, else the one stashed before `start`.
function userReset() {
  const run = activeRun();
  if (run?.window?.source === 'user' && isNum(run.window.resetsAt)) return run.window;
  return readWindowFile();
}

function resolveWindow({ usage, cap, t }) {
  const user = userReset();
  const userFuture = user && user.resetsAt > t ? user : null;
  // The snapshot's 5h window, or the user's reset time, has passed: a new window is open.
  const afterReset = !usage.fiveHour && (usage.fiveHourReset || (user && user.resetsAt <= t));
  const open = usage.state === 'ok' && !cap.capped && Boolean(usage.fiveHour || afterReset);
  let window = null;
  const five = fresh5h(usage);
  if (five) window = { open, resetsAt: five.resetsAt, source: 'snapshot' };
  else if (userFuture) window = { open, resetsAt: userFuture.resetsAt, source: 'user' };
  else if (open) window = { open, resetsAt: null, source: 'snapshot' };
  return { window, userFuture };
}

// --- commands --------------------------------------------------------------------------------

function preflight(opts) {
  const estimates = opts['linear-estimates'];
  if (estimates !== undefined && !['enabled', 'disabled', 'unknown'].includes(estimates)) {
    fail('--linear-estimates must be enabled, disabled or unknown');
  }
  const ctx = context();
  const { window, userFuture } = resolveWindow(ctx);
  const run = loadRun(stateDir());
  const counts = {};
  for (const tk of run?.tickets ?? []) counts[tk.status] = (counts[tk.status] ?? 0) + 1;
  return {
    usage: ctx.usage,
    capped: ctx.cap.capped,
    cappedReason: ctx.cap.reason,
    // null = unknown: a missing or stale reading can't say either way (needsResetTime handles it).
    sevenDayBlocked: ctx.usage.state === 'ok'
      ? Boolean(ctx.usage.sevenDay && ctx.usage.sevenDay.pct >= ctx.config.usage_cap_7d)
      : null,
    window,
    needsResetTime: ['missing', 'stale'].includes(ctx.usage.state) && !userFuture,
    estimatesBlocked: estimates === 'disabled' ? estimatesBlocked(ctx.config.teams) : null,
    run: run && { id: run.id, active: run.active, heartbeatAt: run.heartbeatAt, counts },
    config: ctx.config,
  };
}

function parseReset(raw) {
  if (raw === undefined) fail('usage: set-reset <ISO-8601 | epoch seconds>');
  // Anything not shaped like ISO-8601 must be epoch seconds.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return uint(raw, `not an ISO-8601 time: ${raw}`);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) fail(`not an ISO-8601 time: ${raw}`);
  return Math.floor(ms / 1000);
}

function setReset(raw) {
  const resetsAt = parseReset(raw);
  if (resetsAt <= now()) fail('reset time is in the past');
  const window = { resetsAt, source: 'user' };
  // Only an active run keeps it: `start` replaces an inactive run and adopts window.json.
  const run = activeRun();
  if (run) {
    run.window = window;
    saveRun(stateDir(), run);
    return { ...window, stored: 'run' };
  }
  writeJsonAtomic(stateDir(), WINDOW_FILE, window);
  return { ...window, stored: 'window' };
}

// Without a usage reading and with no future reset, waiting can never end, so it is an error; so
// is still being closed at or past the deadline.
function checkWindow(deadline) {
  const ctx = context();
  const { window } = resolveWindow(ctx);
  const open = Boolean(window?.open);
  if (!open && ctx.usage.state !== 'ok' && !(window?.resetsAt > ctx.t)) {
    fail('no usage reading and no future reset known');
  }
  if (!open && deadline !== null && ctx.t >= deadline) fail('window did not open');
  const reason = open ? '' : ctx.cap.reason || 'no open 5h window yet';
  return { t: ctx.t, out: { open, reason, resetsAt: window?.resetsAt ?? null } };
}

// One-shot: exit 0 when open, 3 (with the deadline) while there is something to wait for.
// --wait re-checks every
// 60s until the window opens (exit 0) or the deadline passes (exit 1). Without --deadline, it
// waits until 15 minutes after the known reset, or 5h15m from the first check when none is known.
async function windowCmd(opts) {
  let deadline = opts.deadline === undefined
    ? null
    : uint(opts.deadline, '--deadline must be Unix seconds');
  for (;;) {
    const { t, out } = checkWindow(deadline);
    if (out.open) return out;
    deadline ??= (out.resetsAt ?? t + 18000) + 900;
    if (!opts.wait) {
      // The deadline to pass to `window --wait`, so a re-armed wait keeps the same one.
      process.exitCode = 3;
      return { ...out, deadline };
    }
    await sleep(intervalMs('ABW_POLL_S', 60));
  }
}

// The repo is where a ticket agent will create worktrees and run code, and the triage that names
// it read untrusted ticket text. So it must resolve (symlinks and `..` included) to a git repo
// under the repos root. Returns the resolved path.
function checkRepo(id, repo, status) {
  if (repo === null && REPOLESS.includes(status)) return null;
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) {
    fail(`${id}: repo must be an absolute path (null only when ${REPOLESS.join(' or ')})`);
  }
  let real;
  let root;
  try {
    real = realpathSync(repo);
    root = realpathSync(reposRoot());
  } catch {
    fail(`${id}: repo does not exist: ${repo}`);
  }
  if (!real.startsWith(root + path.sep)) fail(`${id}: repo is not under ${reposRoot()}`);
  // A directory, not just present: a linked worktree's .git is a file, and the ticket agent
  // would nest its own worktree inside it.
  let gitDir = false;
  try { gitDir = statSync(path.join(real, '.git')).isDirectory(); } catch { /* no .git */ }
  if (!gitDir) fail(`${id}: repo is not a git repo checkout (.git must be a directory): ${repo}`);
  return real;
}

// Unacknowledged capped and handed-off tickets of an inactive previous run come first. A triage
// entry for the same id replaces one only when triage re-queued it (for a hand-off, that means
// the decision was made); a skip or needs-repo verdict never buries resumable work.
function carryForward(prev, tickets) {
  if (!prev || prev.active) return tickets;
  const byId = new Map(tickets.map((tk) => [tk.id, tk]));
  const carried = prev.tickets
    .filter((tk) => CARRIED.includes(tk.status) && !tk.acknowledged)
    .filter((tk) => byId.get(tk.id)?.status !== 'queued')
    // Usage figures belong to the previous run's window; keep the work pointers only.
    .map(({ start5h, end5h, delta5h, startResetsAt, shared, tokens, ...tk }) =>
      ({ ...tk, carriedFrom: prev.id }));
  const carriedIds = new Set(carried.map((tk) => tk.id));
  return [...carried, ...tickets.filter((tk) => !carriedIds.has(tk.id))];
}

function validateTickets(list) {
  if (!Array.isArray(list)) fail('tickets file must hold a JSON array');
  const seen = new Set();
  return list.map((tk, i) => {
    if (!tk || typeof tk !== 'object') fail(`ticket ${i} is not an object`);
    const { id, title, size, repo, status, theme, reason } = tk;
    if (typeof id !== 'string' || !TICKET_ID.test(id)) fail(`ticket ${i}: id must look like ABC-123`);
    if (seen.has(id)) fail(`duplicate ticket id: ${id}`);
    seen.add(id);
    if (typeof title !== 'string') fail(`${id}: title must be a string`);
    if (!SIZES.includes(size)) fail(`${id}: size must be one of ${SIZES}`);
    if (!TICKET_STATUSES.includes(status)) fail(`${id}: status must be one of ${TICKET_STATUSES}`);
    const out = { id, title, size, repo: checkRepo(id, repo, status), status };
    if (theme !== undefined) out.theme = String(theme);
    if (reason !== undefined) out.reason = String(reason);
    return out;
  });
}

function start(opts) {
  if (!opts.tickets) fail('usage: start --tickets <file.json>');
  const prev = loadRun(stateDir());
  if (prev?.active) fail('a run is already active: resume it, or stop it first');
  let list;
  try {
    list = JSON.parse(readFileSync(opts.tickets, 'utf8'));
  } catch (err) {
    fail(`cannot read tickets: ${err.message}`);
  }
  const tickets = carryForward(prev, validateTickets(list));
  const { t, usage } = context();
  const stashed = readWindowFile();
  const five = fresh5h(usage);
  let window = null;
  if (stashed && stashed.resetsAt > t) window = { resetsAt: stashed.resetsAt, source: 'user' };
  else if (five) window = { resetsAt: five.resetsAt, source: 'snapshot' };
  const run = newRun({ now: t, window });
  run.tickets = tickets;
  run.usageStart = { fiveHour: pct(usage.fiveHour), sevenDay: pct(usage.sevenDay) };
  saveRun(stateDir(), run);
  try { unlinkSync(path.join(stateDir(), WINDOW_FILE)); } catch { /* none stashed */ }
  return { id: run.id, tickets: tickets.length, window };
}

function findTicket(run, id) {
  if (!id) fail('a ticket id is required');
  const ticket = run.tickets.find((tk) => tk.id === id);
  if (!ticket) fail(`unknown ticket: ${id}`);
  return ticket;
}

const running = (run, exceptId) =>
  run.tickets.filter((tk) => tk.status === 'running' && tk.id !== exceptId);

function afford(id) {
  const run = requireRun();
  const ticket = findTicket(run, id);
  const { config, usage, cap } = context();
  const inFlight = running(run, id).length;
  const base = { id, size: ticket.size, inFlight };
  if (cap.capped) return { ...base, ok: false, reason: cap.reason };
  // State is 'ok' here; no 5h window means it has reset and nothing is used yet.
  const current5h = pct(usage.fiveHour) ?? 0;
  const { ok, projected } = affordable({
    current5h, size: ticket.size, inFlight, history: loadHistory(stateDir()), config,
  });
  return { ...base, ok, projected, current5h };
}

function begin(id) {
  const run = requireRun();
  if (!run.active) fail('the run is not active');
  const ticket = findTicket(run, id);
  if (!BEGINNABLE.includes(ticket.status)) fail(`${id} is ${ticket.status}, cannot begin`);
  const { t, usage } = context();
  const five = fresh5h(usage);
  // A delta measured while another ticket ran is not this ticket's alone. Mark both sides:
  // the newcomer, and every ticket already in flight, whose delta now includes this one.
  const others = running(run, id);
  for (const tk of others) tk.shared = true;
  setTicket(run, id, {
    status: 'running',
    startedAt: t,
    start5h: five ? five.pct : null,
    startResetsAt: five ? five.resetsAt : null,
    shared: others.length > 0,
  });
  heartbeat(run, t);
  saveRun(stateDir(), run);
  return { id, status: 'running', start5h: ticket.start5h, shared: ticket.shared };
}

function parseResult(raw) {
  if (raw === undefined) fail('--result is required');
  let result;
  try {
    result = JSON.parse(raw.replace(/^\s*RESULT\s+/, ''));
  } catch {
    fail('--result is not valid JSON');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('RESULT must be an object');
  if (!OUTCOMES.includes(result.outcome)) fail(`RESULT outcome must be one of ${OUTCOMES}`);
  for (const key of ['pr', 'branch', 'reason']) {
    if (result[key] !== undefined && typeof result[key] !== 'string') fail(`RESULT ${key} must be a string`);
  }
  if (result.outcome === 'pr' && !PR_URL.test(result.pr ?? '')) fail('RESULT pr must be an https url');
  return result;
}

function finish(id, opts) {
  const run = requireRun();
  const ticket = findTicket(run, id);
  if (ticket.status !== 'running') fail(`${id} is ${ticket.status}, not running`);
  const result = parseResult(opts.result);
  const tokens = opts.tokens === undefined
    ? null
    : uint(opts.tokens, '--tokens must be a non-negative integer');
  const { t, usage } = context();
  const five = fresh5h(usage);
  const end5h = five ? five.pct : null;
  // A window that reset mid-ticket makes the delta meaningless, so it is not recorded.
  const sameWindow = five && ticket.startResetsAt === five.resetsAt;
  const measurable = ticket.start5h !== null && end5h !== null && sameWindow;
  const delta5h = measurable ? Math.max(0, end5h - ticket.start5h) : null;
  const reason = result.outcome === 'failed' ? `failed: ${result.reason ?? ''}`.trim() : result.reason;
  const patch = {
    status: OUTCOME_STATUS[result.outcome], end5h, delta5h, tokens, finishedAt: t,
  };
  if (result.pr !== undefined) patch.pr = result.pr;
  if (result.branch !== undefined) patch.branch = result.branch;
  if (reason !== undefined) patch.reason = reason;
  setTicket(run, id, patch);
  heartbeat(run, t);
  saveRun(stateDir(), run);
  if (measurable) {
    recordCost(stateDir(), { size: ticket.size, delta5h, tokens, shared: Boolean(ticket.shared) });
  }
  return { id, status: patch.status, delta5h, recorded: measurable };
}

// Takes a not-yet-running ticket out of the queue without pretending it was worked: e.g. a
// carried ticket that was closed in Linear meanwhile. `skipped` is never carried forward.
function skip(id, opts) {
  if (!opts.reason) fail('usage: skip <ID> --reason <text>');
  const run = requireRun();
  const ticket = findTicket(run, id);
  if (!BEGINNABLE.includes(ticket.status)) fail(`${id} is ${ticket.status}, cannot skip`);
  setTicket(run, id, { status: 'skipped', reason: opts.reason });
  saveRun(stateDir(), run);
  return { id, status: 'skipped' };
}

// Reads the clock first, then reads run.json and writes that fresh copy back straight away with
// only heartbeatAt changed. That keeps the read-to-write gap to one save, but does not close it:
// a `stop` or `finish` landing inside that gap is still overwritten. A stopped run is left alone.
function heartbeatCmd() {
  const t = now();
  const run = requireRun();
  if (!run.active) return { skipped: 'inactive' };
  saveRun(stateDir(), heartbeat(run, t));
  return { heartbeatAt: run.heartbeatAt };
}

// --loop: a heartbeat every 5 minutes until the run is no longer active, then exit 0.
async function heartbeatLoop() {
  for (;;) {
    const out = heartbeatCmd();
    if (out.skipped) return out;
    await sleep(intervalMs('ABW_HEARTBEAT_S', 300));
  }
}

function stop(opts) {
  if (!opts.reason) fail('usage: stop --reason <text>');
  const run = requireRun();
  const { t, usage } = context();
  // A ticket still running was cut off with the run (or the orchestrator crashed). No cost is
  // recorded: its usage delta mixes in whatever else was running. `capped` carries it into the next run.
  for (const tk of run.tickets) {
    if (tk.status === 'running') Object.assign(tk, { status: 'capped', reason: 'run stopped mid-ticket' });
  }
  run.active = false;
  run.stopReason = opts.reason;
  run.stoppedAt = t;
  run.usageEnd = { fiveHour: pct(usage.fiveHour), sevenDay: pct(usage.sevenDay) };
  heartbeat(run, t);
  saveRun(stateDir(), run);
  return { id: run.id, active: false, stopReason: run.stopReason };
}

// The user has seen the capped and handed-off tickets and doesn't want them resumed. They keep
// their status (the record stays true) but stop being surfaced or carried into the next run.
function closeOut() {
  const run = requireRun();
  if (run.active) fail('the run is still active: stop it first');
  const acknowledged = [];
  for (const tk of run.tickets) {
    if (CARRIED.includes(tk.status) && !tk.acknowledged) {
      tk.acknowledged = true;
      acknowledged.push(tk.id);
    }
  }
  saveRun(stateDir(), run);
  return { id: run.id, acknowledged };
}

// --- debrief ---------------------------------------------------------------------------------

// RUN_<date>.md, or -2, -3 … when another run of the same day already wrote that file. The choice
// is stored on the run so every later debrief of it rewrites the same file.
function debriefPath(run) {
  if (run.debriefPath) return run.debriefPath;
  for (let n = 1; ; n += 1) {
    const file = path.join(runsDir(), runFileName(run, n));
    if (!existsSync(file)) return file;
  }
}

const cell = (s) => clean(s) || '—';
const pctText = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);

const SUMMARY_LABELS = [
  ['pr', 'draft PR'], ['handoff', 'handed off'], ['capped', 'capped'], ['running', 'running'],
  ['queued', 'queued'], ['skipped', 'skipped'], ['needs-repo', 'needs repo'],
];

function trackerRow(tk) {
  const box = tk.status === 'pr' ? '[x]' : '[ ]';
  let what;
  if (tk.status === 'pr') what = `[draft PR](${tk.pr})`;
  else if (tk.status === 'running') what = 'running, no result recorded';
  else what = `${tk.status === 'capped' ? 'capped' : 'hand-off'}: ${clean(tk.reason) || 'no reason given'}`;
  if (tk.branch) what += ` · branch ${clean(tk.branch)}`;
  if (tk.acknowledged) what += ' · closed out';
  const delta = isNum(tk.delta5h) ? `+${tk.delta5h}%` : 'n/a';
  return `- ${box} **${clean(tk.id)}** ${clean(tk.title)} — ${what} · 5h ${delta}`;
}

function debrief() {
  const run = requireRun();
  const date = isoDate(run.startedAt);
  // Closed-out tickets no longer hold the run open.
  const unresolved = run.tickets.some((tk) => OPEN.includes(tk.status) && !tk.acknowledged);
  const status = !run.active && !unresolved
    ? `RESOLVED (${isoDate(run.stoppedAt ?? now())})`
    : 'IN PROGRESS';
  const parts = SUMMARY_LABELS.flatMap(([s, label]) => {
    const n = run.tickets.filter((tk) => tk.status === s).length;
    return n > 0 ? [`${n} ${label}`] : [];
  });
  const summary = `${run.tickets.length} tickets triaged`
    + (parts.length ? `: ${parts.join(', ')}.` : '.')
    + (run.active ? ' The run is still active.' : ` Stopped: ${clean(run.stopReason)}.`);

  const win = run.window
    ? `Window resets at ${new Date(run.window.resetsAt * 1000).toISOString()} (source: ${run.window.source}).`
    : 'No window reset time was recorded.';
  const table = [
    '| Ticket | Title | Size | Repo | Theme | Status | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...run.tickets.map((tk) => `| ${[tk.id, tk.title, tk.size, tk.repo, tk.theme, tk.status, tk.reason]
      .map(cell).join(' | ')} |`),
  ];
  const worked = run.tickets.filter((tk) => WORKED.includes(tk.status));
  const tracker = worked.length ? worked.map(trackerRow) : ['No tickets were worked.'];
  const start = run.usageStart ?? {};
  const end = run.usageEnd ?? {};
  const lines = [
    `# Backlog worker run ${date}`,
    '',
    `## Status: ${status}`,
    '',
    summary,
    '',
    '## Context',
    '',
    `Run ${clean(run.id)}. ${win} Triage:`,
    '',
    ...table,
    '',
    '## Tracker',
    '',
    ...tracker,
    '',
    '## Stop',
    '',
    `- Reason: ${run.active ? 'still running' : clean(run.stopReason) || 'none given'}`,
    `- 5h usage: ${pctText(start.fiveHour)} at start, ${pctText(end.fiveHour)} at end`,
    `- 7d usage: ${pctText(start.sevenDay)} at start, ${pctText(end.sevenDay)} at end`,
  ];
  mkdirSync(runsDir(), { recursive: true });
  const file = debriefPath(run);
  writeFileSync(file, `${lines.join('\n')}\n`);
  if (run.debriefPath !== file) {
    run.debriefPath = file;
    saveRun(stateDir(), run);
  }
  return { path: file, status };
}

// --- dispatch --------------------------------------------------------------------------------

async function main(argv) {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tickets: { type: 'string' },
      result: { type: 'string' },
      tokens: { type: 'string' },
      reason: { type: 'string' },
      'linear-estimates': { type: 'string' },
      deadline: { type: 'string' },
      wait: { type: 'boolean' },
      loop: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  switch (cmd) {
    case 'preflight': return preflight(opts);
    case 'set-reset': return setReset(arg);
    case 'window': return windowCmd(opts);
    case 'start': return start(opts);
    case 'afford': return afford(arg);
    case 'begin': return begin(arg);
    case 'finish': return finish(arg, opts);
    case 'skip': return skip(arg, opts);
    case 'heartbeat': return opts.loop ? heartbeatLoop() : heartbeatCmd();
    case 'stop': return stop(opts);
    case 'close-out': return closeOut();
    case 'debrief': return debrief();
    default: return fail(`unknown command: ${cmd ?? '(none)'}`);
  }
}

try {
  const out = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exitCode = 1;
}
