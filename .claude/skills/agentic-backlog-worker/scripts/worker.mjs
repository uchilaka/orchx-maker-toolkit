#!/usr/bin/env node
// Deterministic CLI the /agentic-backlog-worker orchestrator calls between its judgment steps.
// Every command prints one JSON object on stdout. Exit 0 on success, 1 with {"error"} on a
// failure, and `window` exits 3 when the 5h window is not open (for the Monitor until-loop).
// Times are Unix seconds; ABW_NOW overrides the clock for tests.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, stateDir, runsDir, snapshotPath } from '../lib/config.mjs';
import { readUsage, capStatus } from '../lib/usage.mjs';
import {
  loadRun, saveRun, newRun, heartbeat, setTicket, loadHistory, recordCost, affordable,
  TICKET_STATUSES,
} from '../lib/run-state.mjs';

const ESTIMATES_BLOCKED =
  'Turn on T-shirt estimates: Linear → Settings → Teams → LarCity Engineering → Estimates';
const OUTCOMES = ['pr', 'handoff', 'capped', 'failed'];
const OUTCOME_STATUS = { pr: 'pr', handoff: 'handoff', capped: 'capped', failed: 'handoff' };
// Statuses a ticket can be (re)started from: a fresh one, or a resumable one.
const BEGINNABLE = ['queued', 'capped', 'handoff'];
// A PR url lands in a markdown link in the debrief, so it may not contain link syntax.
const PR_URL = /^https:\/\/[^\s()<>[\]`|]+$/;
const WINDOW_FILE = 'window.json';

class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

function now() {
  const raw = process.env.ABW_NOW;
  if (raw === undefined || raw === '') return Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(raw)) fail('ABW_NOW must be Unix seconds');
  return Number(raw);
}

const isoDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);

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
  try {
    const w = JSON.parse(readFileSync(path.join(stateDir(), WINDOW_FILE), 'utf8'));
    return Number.isFinite(w?.resetsAt) ? w : null;
  } catch {
    return null;
  }
}

// The user-supplied reset, if any: the active run's, else the one stashed before `start`.
function userReset() {
  const run = activeRun();
  if (run?.window?.source === 'user' && Number.isFinite(run.window.resetsAt)) return run.window;
  return readWindowFile();
}

// Did the snapshot itself carry a 5h window that has already reset? readUsage folds that into
// fiveHour:null, the same as "no 5h window at all", so the raw file decides.
function snapshot5hReset(t) {
  try {
    const resets = JSON.parse(readFileSync(snapshotPath(), 'utf8'))?.rate_limits?.five_hour?.resets_at;
    return Number.isFinite(resets) && resets <= t;
  } catch {
    return false;
  }
}

function resolveWindow({ usage, cap, t }) {
  const user = userReset();
  const userFuture = user && user.resetsAt > t ? user : null;
  const afterReset = !usage.fiveHour && (snapshot5hReset(t) || (user && user.resetsAt <= t));
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
    sevenDayBlocked: Boolean(ctx.usage.sevenDay && ctx.usage.sevenDay.pct >= ctx.config.usage_cap_7d),
    window,
    needsResetTime: ['missing', 'stale'].includes(ctx.usage.state) && !userFuture,
    estimatesBlocked: estimates === 'disabled' ? ESTIMATES_BLOCKED : null,
    run: run && { id: run.id, active: run.active, heartbeatAt: run.heartbeatAt, counts },
    config: ctx.config,
  };
}

function parseReset(raw) {
  if (raw === undefined) fail('usage: set-reset <ISO-8601 | epoch seconds>');
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) fail(`not an ISO-8601 time: ${raw}`);
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
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir(), WINDOW_FILE), `${JSON.stringify(window)}\n`);
  return { ...window, stored: 'window' };
}

function windowCmd() {
  const ctx = context();
  const { window } = resolveWindow(ctx);
  const open = Boolean(window?.open);
  const reason = open ? '' : ctx.cap.reason || 'no open 5h window yet';
  return { out: { open, reason, resetsAt: window?.resetsAt ?? null }, code: open ? 0 : 3 };
}

function validateTickets(list) {
  if (!Array.isArray(list)) fail('tickets file must hold a JSON array');
  const seen = new Set();
  return list.map((tk, i) => {
    if (!tk || typeof tk !== 'object') fail(`ticket ${i} is not an object`);
    const { id, title, size, repo, status, theme, reason } = tk;
    if (typeof id !== 'string' || id === '') fail(`ticket ${i}: id must be a non-empty string`);
    if (seen.has(id)) fail(`duplicate ticket id: ${id}`);
    seen.add(id);
    if (typeof title !== 'string') fail(`${id}: title must be a string`);
    if (typeof size !== 'string') fail(`${id}: size must be a string`);
    if (repo !== null && typeof repo !== 'string') fail(`${id}: repo must be a string or null`);
    if (!TICKET_STATUSES.includes(status)) fail(`${id}: status must be one of ${TICKET_STATUSES}`);
    const out = { id, title, size, repo, status };
    if (theme !== undefined) out.theme = String(theme);
    if (reason !== undefined) out.reason = String(reason);
    return out;
  });
}

function start(opts) {
  if (!opts.tickets) fail('usage: start --tickets <file.json>');
  if (activeRun()) fail('a run is already active: resume it, or stop it first');
  let list;
  try {
    list = JSON.parse(readFileSync(opts.tickets, 'utf8'));
  } catch (err) {
    fail(`cannot read tickets: ${err.message}`);
  }
  const tickets = validateTickets(list);
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
  const res = affordable({
    current5h, size: ticket.size, inFlight, history: loadHistory(stateDir()), config,
  });
  return { id, ok: res.ok, projected: res.projected, current5h, size: ticket.size, inFlight };
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
  let tokens = null;
  if (opts.tokens !== undefined) {
    if (!/^\d+$/.test(opts.tokens)) fail('--tokens must be a non-negative integer');
    tokens = Number(opts.tokens);
  }
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

function heartbeatCmd() {
  const run = requireRun();
  heartbeat(run, now());
  saveRun(stateDir(), run);
  return { heartbeatAt: run.heartbeatAt };
}

function stop(opts) {
  if (!opts.reason) fail('usage: stop --reason <text>');
  const run = requireRun();
  const { t, usage } = context();
  run.active = false;
  run.stopReason = opts.reason;
  run.stoppedAt = t;
  run.usageEnd = { fiveHour: pct(usage.fiveHour), sevenDay: pct(usage.sevenDay) };
  heartbeat(run, t);
  saveRun(stateDir(), run);
  return { id: run.id, active: false, stopReason: run.stopReason };
}

// --- debrief ---------------------------------------------------------------------------------

// Ticket ids, titles, reasons and branches come from Linear or an agent: untrusted. One line,
// no HTML, no code spans, and nothing that can split a table cell or open a link.
const clean = (s) => String(s ?? '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/`/g, "'")
  .replace(/([|[\]])/g, '\\$1')
  .trim();
const cell = (s) => clean(s) || '—';
const pctText = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);

const WORKED = ['running', 'pr', 'handoff', 'capped'];
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
  const delta = Number.isFinite(tk.delta5h) ? `+${tk.delta5h}%` : 'n/a';
  return `- ${box} **${clean(tk.id)}** ${clean(tk.title)} — ${what} · 5h ${delta}`;
}

function debrief() {
  const run = requireRun();
  const date = isoDate(run.startedAt);
  const unresolved = run.tickets.some((tk) => ['capped', 'handoff', 'running'].includes(tk.status));
  const status = !run.active && !unresolved
    ? `RESOLVED (${isoDate(run.stoppedAt ?? now())})`
    : 'IN PROGRESS';
  const parts = SUMMARY_LABELS
    .map(([s, label]) => [run.tickets.filter((tk) => tk.status === s).length, label])
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
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
  const file = path.join(runsDir(), `RUN_${date}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { path: file, status };
}

// --- dispatch --------------------------------------------------------------------------------

function main(argv) {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tickets: { type: 'string' },
      result: { type: 'string' },
      tokens: { type: 'string' },
      reason: { type: 'string' },
      'linear-estimates': { type: 'string' },
    },
  });
  const [cmd, arg] = positionals;
  switch (cmd) {
    case 'preflight': return { out: preflight(opts) };
    case 'set-reset': return { out: setReset(arg) };
    case 'window': return windowCmd();
    case 'start': return { out: start(opts) };
    case 'afford': return { out: afford(arg) };
    case 'begin': return { out: begin(arg) };
    case 'finish': return { out: finish(arg, opts) };
    case 'heartbeat': return { out: heartbeatCmd() };
    case 'stop': return { out: stop(opts) };
    case 'debrief': return { out: debrief() };
    default: return fail(`unknown command: ${cmd ?? '(none)'}`);
  }
}

try {
  const { out, code = 0 } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
  process.exitCode = 1;
}
