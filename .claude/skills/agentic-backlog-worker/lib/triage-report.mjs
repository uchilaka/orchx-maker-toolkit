// TRIAGE.md: the living hand-off for /agentic-backlog-worker, rewritten by `merge` and `debrief`.
// The top answers "what changed, what's waiting on me, what's next"; the table below holds every
// ticket. It's for people: the next invocation reads `worker.mjs brief` JSON, never this file.
// Deliberately no `- [ ]` boxes, so the open-items SessionStart hook doesn't list ~300 rows.
import path from 'node:path';
import { runsDir } from './config.mjs';
import { clean } from './sanitize.mjs';
import { queueOrder } from './baseline.mjs';

export const TRIAGE_MD = 'TRIAGE.md';
export const triagePath = () => path.join(runsDir(), TRIAGE_MD);

// Ticket text is untrusted: clean() makes it one inert line, and control characters go too.
// eslint-disable-next-line no-control-regex
const cell = (s) => clean(s).replace(/[\u0000-\u001f\u007f]/g, '') || '—';
const ids = (list) => list.map(cell).join(', ');
const when = (sec) => (sec === null || sec === undefined
  ? 'never'
  : new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' '));

function since(delta) {
  if (!delta) return ['- First triage: no earlier run to compare with.'];
  const lines = [];
  if (delta.new.length) lines.push(`- New: ${ids(delta.new)}`);
  if (delta.changed.length) lines.push(`- Changed: ${ids(delta.changed)}`);
  if (delta.removed.length) lines.push(`- Gone from backlog: ${ids(delta.removed)}`);
  return lines.length ? lines : ['- Nothing changed.'];
}

function waiting(run, queue) {
  const tickets = run?.tickets ?? [];
  const of = (s) => tickets.filter((t) => t.status === s);
  const lines = [];
  const prs = of('pr');
  if (prs.length) lines.push(`- Draft PRs to review: ${prs.map((t) => `${cell(t.id)} ${cell(t.pr)}`).join(' · ')}`);
  for (const t of of('handoff')) lines.push(`- Handed off: ${cell(t.id)} — ${cell(t.reason)}`);
  const capped = of('capped');
  if (capped.length) lines.push(`- Capped, resumable: ${ids(capped.map((t) => t.id))}`);
  const groups = {};
  for (const e of queue.filter((q) => q.status === 'needs-repo')) (groups[e.theme ?? 'other'] ??= []).push(e.id);
  const repo = Object.entries(groups).map(([g, list]) => `${cell(g)} (${list.length}): ${ids(list)}`);
  if (repo.length) lines.push(`- Needs a repo: ${repo.join(' · ')}`);
  return lines.length ? lines : ['- Nothing.'];
}

export function renderTriage({ baseline, run, themeOrder, nextUp = 10 }) {
  const queue = queueOrder(baseline, themeOrder);
  const count = (s) => queue.filter((q) => q.status === s).length;
  const queued = queue.filter((q) => q.status === 'queued');
  const next = queued.slice(0, nextUp)
    .map((q) => `- ${cell(q.id)} (${cell(q.size)}) ${cell(path.basename(q.repo ?? ''))}`);
  const rows = queue.map((q) => `| ${[q.id, q.title, q.size, q.repo && path.basename(q.repo), q.theme, q.status, q.reason]
    .map(cell).join(' | ')} |`);
  return [
    '# Backlog triage',
    '',
    `Last triage ${when(baseline.triagedAt)} · last reconcile ${when(baseline.reconciledAt)}`
      + ` · ${count('queued')} queued · ${count('needs-repo')} need a repo · ${count('skipped')} skipped`,
    '',
    '## Since the last run',
    '',
    ...since(baseline.lastDelta),
    '',
    '## Waiting on you',
    '',
    ...waiting(run, queue),
    '',
    '## Next up',
    '',
    ...(next.length ? next : ['- Queue is empty.']),
    '',
    '## All tickets',
    '',
    '| Ticket | Title | Size | Repo | Theme | Status | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
