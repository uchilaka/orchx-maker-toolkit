// Lasting answers to "which repo is this ticket in?", so triage never asks the same question
// twice. One rule per line, `project/<Linear project name>: <abs path>` or
// `ticket/<ID>: <abs path>`; a ticket rule beats a project rule. Uche may edit the file, and
// `worker.mjs rule` writes it after validating the repo.
// Not parsed by config.mjs's reader: project names can contain `:` and `#`, so a line splits at
// its last `: /` (paths are absolute) and only a line that starts with `#` is a comment.
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const TICKET_ID = /^[A-Z]+-[0-9]+$/;
const SEP = ': /';

// Why `key` can't be a rule key, or null when it can. A project name may hold anything but a
// line break or the separator itself, which would make the line ambiguous to parse back.
export function keyProblem(key) {
  if (typeof key !== 'string') return 'rule key must be a string';
  const slash = key.indexOf('/');
  const kind = slash < 0 ? key : key.slice(0, slash);
  const name = slash < 0 ? '' : key.slice(slash + 1);
  if (kind !== 'project' && kind !== 'ticket') return `unknown rule prefix: ${kind}`;
  if (name.trim() === '' || /[\r\n]/.test(name) || name.includes(SEP)) {
    return `invalid rule key: ${kind}/<name>`;
  }
  if (kind === 'ticket' && !TICKET_ID.test(name)) return 'ticket rule needs an id like LAR-123';
  return null;
}

export function parseRules(text) {
  const projects = new Map();
  const tickets = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const at = line.lastIndexOf(SEP);
    if (at < 0) throw new Error(`invalid rule line: ${line}`);
    const key = line.slice(0, at).trim();
    const repo = line.slice(at + 2).trim();
    const problem = keyProblem(key);
    if (problem) throw new Error(problem);
    const name = key.slice(key.indexOf('/') + 1);
    (key.startsWith('ticket/') ? tickets : projects).set(name, repo);
  }
  return { projects, tickets };
}

export function loadRules(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return parseRules('');
    throw err;
  }
  return parseRules(text);
}

export const resolveRepo = (rules, { id, project }) =>
  rules.tickets.get(id) ?? (project ? rules.projects.get(project) : undefined) ?? null;

// Adds `key: repo`, replacing an existing line for the same key, through a temp file and a
// rename so a crash never leaves half a file. Callers validate the repo; the key is checked here.
export function appendRule(file, key, repo) {
  const problem = keyProblem(key);
  if (problem) throw new Error(problem);
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new Error('repo must be an absolute path');
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const kept = lines.filter((l) => l.trimStart().startsWith('#')
    || l.lastIndexOf(SEP) < 0 || l.slice(0, l.lastIndexOf(SEP)).trim() !== key);
  kept.push(`${key}: ${repo}`);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${kept.join('\n')}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    throw err;
  }
}
