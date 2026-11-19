// The triage baseline for /agentic-backlog-worker: every verdict from earlier invocations, keyed
// by ticket id and the Linear `updatedAt` it was made against, so a run classifies only tickets
// that are new or changed. `baseline.json` lives in the state dir and only the CLI writes it.
// Times are Unix seconds, except `updatedAt`, which is Linear's ISO string compared verbatim.
// Ticket text in it came from Linear: untrusted, stored as data, rendered only through clean().
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RunStateError, writeJsonAtomic } from './run-state.mjs';
import { resolveRepo } from './repo-rules.mjs';

export const BASELINE_FILE = 'baseline.json';
const VERSION = 1;
// Linear state types a ticket is triaged in: Backlog and Todo. Any other means it left.
const ELIGIBLE = ['backlog', 'unstarted'];
// The incremental fetch starts this long before the last triage, to absorb clock skew between
// this machine and Linear. Re-fetching a ticket is harmless: an unchanged updatedAt is a no-op.
const OVERLAP_S = 600;

const unreadable = (why) => { throw new RunStateError(`baseline unreadable: ${why}`); };

export const emptyBaseline = () => ({
  version: VERSION, triagedAt: null, reconciledAt: null, tickets: {},
});

// null when there is no baseline yet. One that exists but can't be trusted throws: treating it
// as empty would silently re-triage everything and lose the verdicts it carries.
export function loadBaseline(dir) {
  const file = path.join(dir, BASELINE_FILE);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return unreadable('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return unreadable('not an object');
  if (raw.version !== VERSION) return unreadable(`version ${raw.version}, expected ${VERSION}`);
  if (typeof raw.tickets !== 'object' || raw.tickets === null || Array.isArray(raw.tickets)) {
    return unreadable('tickets must be an object');
  }
  return raw;
}

export function saveBaseline(dir, baseline) {
  writeJsonAtomic(dir, BASELINE_FILE, baseline);
}

// Linear returns some fields as objects (`estimate: {value, name}`, labels and project as
// `{name}`) depending on the call; the baseline stores the plain value.
const nameOf = (v) => (v && typeof v === 'object' ? v.name : v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

// The fetched tickets SKILL.md step 3 writes from list_issues. A malformed entry rejects the
// whole fetch: skipping it would make the ticket look unchanged, or removed on a reconcile.
export function validateFetched(list) {
  if (!Array.isArray(list)) throw new Error('fetched tickets must be a JSON array');
  const seen = new Set();
  return list.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`fetched[${i}] must be an object`);
    const { id } = t;
    if (typeof id !== 'string' || id === '') throw new Error(`fetched[${i}]: id must be a string`);
    if (seen.has(id)) throw new Error(`duplicate fetched ticket id: ${id}`);
    seen.add(id);
    if (typeof t.title !== 'string') throw new Error(`${id}: title must be a string`);
    if (!str(t.updatedAt)) throw new Error(`${id}: updatedAt must be a non-empty string`);
    if (!str(t.statusType)) throw new Error(`${id}: statusType must be a non-empty string`);
    const est = t.estimate;
    return {
      id,
      title: t.title,
      statusType: t.statusType,
      labels: Array.isArray(t.labels) ? t.labels.map(nameOf).filter((l) => typeof l === 'string') : [],
      project: str(nameOf(t.project)),
      parentId: str(t.parentId),
      updatedAt: t.updatedAt,
      estimate: typeof est === 'number' ? est : (typeof est?.value === 'number' ? est.value : null),
    };
  });
}

// Which fetched tickets need a verdict. `reconcile` says the fetch is a full Backlog/Todo
// listing, so a baseline ticket missing from it has left; an incremental fetch only sees what
// changed, so absence means nothing. `full` reclassifies every eligible ticket.
// A ticket a run already worked (`worked`) is never reclassified here: the ticket agent edits
// it in Linear, and those edits are not a change of scope.
export function computeDelta(baseline, fetched, { reconcile = false, full = false } = {}) {
  const known = baseline.tickets;
  const classify = [];
  const removed = [];
  let unchanged = 0;
  const seen = new Set();
  for (const t of fetched) {
    seen.add(t.id);
    const prev = known[t.id];
    if (!ELIGIBLE.includes(t.statusType)) {
      if (prev) removed.push(t.id);
    } else if (full || !prev) {
      classify.push(t.id);
    } else if (prev.worked || prev.updatedAt === t.updatedAt || seedMatch(prev, t)) {
      unchanged += 1;
    } else {
      classify.push(t.id);
    }
  }
  if (reconcile) {
    for (const id of Object.keys(known)) if (!seen.has(id)) removed.push(id);
  }
  return { classify, removed, unchanged };
}

// A seeded baseline ticket (merge --seed) has no updatedAt: the triage it came from didn't record
// one. It counts as unchanged while its title matches, the only judged field a seed carries, so
// the first run after seeding doesn't reclassify the whole backlog. The reconcile due on that
// run fills in updatedAt (mergeVerdicts refreshes unchanged tickets).
export const seedMatch = (prev, t) => prev.updatedAt === null && prev.title === t.title;

export const reconcileDue = (baseline, now, days) =>
  baseline.reconciledAt === null || now - baseline.reconciledAt > days * 86400;

export const fetchSince = (baseline) => (baseline.triagedAt === null
  ? null
  : new Date((baseline.triagedAt - OVERLAP_S) * 1000).toISOString());

// --- merge -----------------------------------------------------------------------------------

const VERDICT_STATUSES = ['queued', 'needs-repo', 'skipped'];
const SIZES = ['S', 'M', 'L', 'XL'];
export const POINTS = Object.freeze({ S: 2, M: 3, L: 5, XL: 8 });
export const TOOLKIT_REASON = "repo is the backlog worker's own toolkit";

// The ticket fields that come from Linear rather than from triage.
const fromLinear = (f) => ({
  title: f.title, project: f.project, parentId: f.parentId, labels: f.labels,
  updatedAt: f.updatedAt, estimate: f.estimate,
});

function checkVerdict(v, i) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') throw new Error(`verdicts[${i}]: id must be a string`);
  if (!SIZES.includes(v.size)) throw new Error(`${v.id}: size must be one of ${SIZES}`);
  if (!VERDICT_STATUSES.includes(v.status)) throw new Error(`${v.id}: status must be one of ${VERDICT_STATUSES}`);
}

// A new baseline: `baseline` plus this invocation's verdicts, minus tickets that left. Pure; the
// caller saves it. Unchanged fetched tickets take Linear's current updatedAt and estimate, which
// is how a seeded baseline gets its stamps. Repo rules then promote needs-repo tickets, and a
// queued ticket in the toolkit's own checkout is skipped, since `start` would refuse it.
export function mergeVerdicts(baseline, fetched, verdicts, {
  rules, now, reconcile = false, isToolkitRepo,
}) {
  const old = baseline.tickets;
  const tickets = { ...old };
  const byId = new Map(fetched.map((f) => [f.id, f]));
  const { removed } = computeDelta(baseline, fetched, { reconcile });
  const judged = new Set();
  verdicts.forEach((v, i) => {
    checkVerdict(v, i);
    judged.add(v.id);
    const meta = byId.has(v.id) ? fromLinear(byId.get(v.id)) : old[v.id];
    if (!meta) throw new Error(`${v.id}: verdict for a ticket that was neither fetched nor in the baseline`);
    const t = {
      title: meta.title, project: meta.project ?? null, parentId: meta.parentId ?? null,
      labels: meta.labels ?? [], updatedAt: meta.updatedAt ?? null, estimate: meta.estimate ?? null,
      size: v.size, status: v.status, repo: v.status === 'queued' ? v.repo : null,
    };
    if (v.theme !== undefined) t.theme = String(v.theme);
    if (v.reason !== undefined) t.reason = String(v.reason);
    tickets[v.id] = t;
  });
  for (const f of fetched) {
    if (!judged.has(f.id) && tickets[f.id]) {
      tickets[f.id] = { ...tickets[f.id], ...fromLinear(f) };
    }
  }
  for (const id of removed) delete tickets[id];
  for (const [id, t] of Object.entries(tickets)) {
    if (t.worked) continue;
    if (t.status === 'needs-repo') {
      const repo = resolveRepo(rules, { id, project: t.project });
      if (repo) tickets[id] = { ...t, status: 'queued', repo };
    }
    if (tickets[id].status === 'queued' && isToolkitRepo(tickets[id].repo)) {
      tickets[id] = { ...tickets[id], status: 'skipped', repo: null, reason: TOOLKIT_REASON };
    }
  }
  const first = baseline.triagedAt === null;
  return {
    ...baseline,
    triagedAt: now,
    reconciledAt: reconcile || first ? now : baseline.reconciledAt,
    tickets,
    lastDelta: {
      new: [...judged].filter((id) => !old[id]),
      changed: [...judged].filter((id) => old[id]),
      removed,
    },
  };
}

const entry = (id, t) => {
  const e = { id, title: t.title, size: t.size, repo: t.repo, status: t.status };
  if (t.theme !== undefined) e.theme = t.theme;
  if (t.reason !== undefined) e.reason = t.reason;
  return e;
};

// Every unworked ticket as a triage.json entry: queued by theme (themeOrder first, unknown
// themes after), keeping baseline order within a theme; then needs-repo; then skipped.
export function queueOrder(baseline, themeOrder) {
  const rank = (t) => {
    const i = themeOrder.indexOf(t.theme);
    return i < 0 ? themeOrder.length : i;
  };
  const live = Object.entries(baseline.tickets).filter(([, t]) => !t.worked);
  const queued = live.filter(([, t]) => t.status === 'queued')
    .map(([id, t], i) => ({ id, t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ id, t }) => entry(id, t));
  const rest = (s) => live.filter(([, t]) => t.status === s).map(([id, t]) => entry(id, t));
  return [...queued, ...rest('needs-repo'), ...rest('skipped')];
}

// Queued and needs-repo tickets whose Linear estimate isn't their size yet. Skipped tickets get
// none: their size was never the point of the verdict.
export const estimatesNeeded = (baseline) => Object.entries(baseline.tickets)
  .filter(([, t]) => !t.worked && (t.status === 'queued' || t.status === 'needs-repo')
    && t.estimate !== POINTS[t.size])
  .map(([id, t]) => ({ id, size: t.size, points: POINTS[t.size] }));
