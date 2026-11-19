// The triage baseline for /agentic-backlog-worker: every verdict from earlier invocations, keyed
// by ticket id and the Linear `updatedAt` it was made against, so a run classifies only tickets
// that are new or changed. `baseline.json` lives in the state dir and only the CLI writes it.
// Times are Unix seconds, except `updatedAt`, which is Linear's ISO string compared verbatim.
// Ticket text in it came from Linear: untrusted, stored as data, rendered only through clean().
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RunStateError, writeJsonAtomic } from './run-state.mjs';

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
    } else if (prev.worked || prev.updatedAt === t.updatedAt) {
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

export const reconcileDue = (baseline, now, days) =>
  baseline.reconciledAt === null || now - baseline.reconciledAt > days * 86400;

export const fetchSince = (baseline) => (baseline.triagedAt === null
  ? null
  : new Date((baseline.triagedAt - OVERLAP_S) * 1000).toISOString());
