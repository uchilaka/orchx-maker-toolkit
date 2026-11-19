#!/usr/bin/env node
// SessionStart hook: reports unfinished /agentic-backlog-worker runs. stdout is plain markdown
// and nothing else, silent when there is nothing to report, and the exit code is always 0 so a
// broken hook can never block a session. Unreadable state is reported rather than hidden.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRun, RunStateError } from '../lib/run-state.mjs';
import { clean } from '../lib/sanitize.mjs';
import { stateDir, runsDir as defaultRunsDir } from '../lib/config.mjs';

// A heartbeat this old or newer means the worker is alive. Exactly 600s is still live; 601s is
// stopped. Ten minutes comfortably covers one long tool call between heartbeats.
const LIVE_HEARTBEAT_S = 600;
const MAX_LINES = 5;
const RESUME = 'Resume with /agentic-backlog-worker';

// Display order of the ticket groups.
const GROUPS = [
  ['running', '**Running**'],
  ['capped', '**Capped (resumable)**'],
  ['handoff', '**Handed off**'],
  ['queued', '**Queued**'],
];

// Ticket fields are untrusted (Linear, agents), and this text lands in the session context.
const ticketLine = (t) =>
  `- ${clean(t.id)} ${clean(t.title)} — ${clean(t.pr || t.branch) || '(no branch)'}`;

// The run file the debrief recorded, else the default name: the UTC day the run started.
const runFile = (run, runsDir) => run.debriefPath
  || path.join(runsDir, `RUN_${new Date(run.startedAt * 1000).toISOString().slice(0, 10)}.md`);

// Pure: all inputs (clock, state dir, runs dir) are injected. Returns markdown or null.
export function report({ now, dir, runsDir = defaultRunsDir() }) {
  let run;
  try {
    run = loadRun(dir);
  } catch (err) {
    if (!(err instanceof RunStateError)) throw err;
    return `Backlog worker: couldn't read ${path.join(dir, 'run.json')} (${err.message})`;
  }
  if (!run) return null;

  // Queued tickets only count as open while the run is still meant to be working on them.
  // Acknowledged tickets were closed out by the user (worker.mjs close-out) and stay quiet.
  const isOpen = (t) => !t.acknowledged
    && (['running', 'capped', 'handoff'].includes(t.status) || (run.active && t.status === 'queued'));
  const open = run.tickets.filter(isOpen);
  const resumable = open.some((t) => t.status === 'capped' || t.status === 'handoff');
  if (!run.active && !resumable) return null;

  const live = run.active && now - run.heartbeatAt <= LIVE_HEARTBEAT_S;
  const header = live
    ? '## Backlog worker: run in progress'
    : run.active
      ? '## Backlog worker: run stopped unexpectedly'
      : '## Backlog worker: unfinished tickets';

  // The 5-line cap is shared across every label.
  const out = [header];
  let shown = 0;
  for (const [status, label] of GROUPS) {
    const lines = open.filter((t) => t.status === status).map(ticketLine);
    const take = lines.slice(0, Math.max(0, MAX_LINES - shown));
    if (take.length === 0) continue;
    out.push('', label, ...take);
    shown += take.length;
  }
  const hidden = open.length - shown;
  if (hidden > 0) out.push('', `_…and ${hidden} more — see ${runFile(run, runsDir)}._`);
  if (!live) out.push('', `${RESUME}.`);
  return out.join('\n');
}

export function main() {
  try {
    const out = report({ now: Math.floor(Date.now() / 1000), dir: stateDir() });
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stdout.write(`Backlog worker: couldn't read ${stateDir()} (${err.message})\n`);
  }
}

// Run only as the entry point so tests can import `report` without side effects.
let direct = false;
try {
  direct = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch { /* not the entry point */ }
if (direct) main();
