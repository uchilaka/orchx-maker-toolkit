#!/usr/bin/env node
// PreToolUse hook for the agentic-ticket-worker subagent. Under the usage cap it returns null
// (normal permissions apply); at or over the cap it denies every tool call except the ones that
// checkpoint work. This is a security boundary: anything it cannot positively verify is denied.
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, stateDir, runsDir } from '../lib/config.mjs';
import { readUsage, capStatus } from '../lib/usage.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const LINEAR_TOOLS = new Set(['mcp__linear__save_comment', 'mcp__linear__save_issue']);
const BRANCH = /^[A-Z]+-[0-9]+\//;

const denyReason = (why) =>
  `Usage cap reached (${why}). Write your checkpoint to the run state and ticket plan, commit and ` +
  'push the WIP branch, then return RESULT {"outcome":"capped"}. No other tool calls are allowed.';

// --- Paths -----------------------------------------------------------------------------------

// Resolves symlinks on the closest existing ancestor and re-appends the missing tail. Returns
// null when the path cannot be resolved with certainty (dangling symlink, `..` in the missing
// tail, unreadable component), which callers treat as a denial.
function resolveClosest(absPath) {
  const tail = [];
  let cur = absPath;
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    // ENOENT on a path that lstat can see is a dangling symlink: its target is unknowable.
    try {
      lstatSync(cur);
      return null;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    const base = path.basename(cur);
    if (base === '..') return null;
    if (base !== '.') tail.push(base);
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Joined by string, not path.resolve, and resolved with realpath.native (the JS realpath collapses
// `..` lexically): `link/../x` must be resolved by the OS through the real symlink, not collapsed
// first.
function absolutize(file, cwd, home) {
  if (file === '~') return home;
  if (file.startsWith('~/')) return `${home}/${file.slice(2)}`;
  if (path.isAbsolute(file)) return file;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return `${cwd}/${file}`;
}

function writeAllowed(toolInput, cwd, home) {
  const file = toolInput?.file_path;
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return false;
  const abs = absolutize(file, cwd, home);
  if (!abs) return false;
  const target = resolveClosest(abs);
  if (!target) return false;
  return [stateDir(), runsDir()].some((dir) => {
    const base = resolveClosest(path.resolve(dir));
    return base !== null && target.startsWith(base + path.sep);
  });
}

// --- Bash ------------------------------------------------------------------------------------

// Any shell metacharacter, control character or expansion trigger anywhere in the command
// (quotes included) is rejected: `\` escapes, `{}` brace expansion, `#` comments (which would
// hide what the shell really runs from our tokenizer) and `!` history all change tokenization.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[;&|$`><()\\{}#!\x00-\x08\x0a-\x1f\x7f]/;

// Splits on spaces/tabs, honouring '...' and "..." the way the shell does (adjacent quoted and
// bare parts join into one word). Returns null on an unterminated quote.
function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) tokens.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) tokens.push(cur);
  return tokens;
}

// Flags that cannot run code or widen the push beyond one named branch.
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '--no-verify', '-q', '--quiet', '-v']);
const FORCE_FLAG = /^(-f|--force(-with-lease)?(=.*)?)$/;

function pushAllowed(args) {
  const positional = [];
  for (const a of args) {
    if (FORCE_FLAG.test(a)) return false;
    if (a.startsWith('-')) {
      if (!PUSH_FLAGS.has(a)) return false;
    } else positional.push(a);
  }
  // Exactly `<remote> <refspec>`: a bare push can't be verified, and a URL as the remote would
  // send the branch somewhere else.
  if (positional.length !== 2) return false;
  const [remote, refspec] = positional;
  if (!/^[A-Za-z0-9_.-]+$/.test(remote)) return false;
  if (refspec.startsWith('+')) return false;
  const colon = refspec.indexOf(':');
  const dst = colon < 0 ? refspec : refspec.slice(colon + 1);
  return BRANCH.test(dst);
}

function bashAllowed(command) {
  if (typeof command !== 'string' || UNSAFE.test(command)) return false;
  const m = command.match(/^git (add|commit|push)( |$)/);
  if (!m) return false;
  const tokens = tokenize(command);
  if (!tokens) return false;
  return m[1] === 'push' ? pushAllowed(tokens.slice(2)) : true;
}

// --- Decision --------------------------------------------------------------------------------

export function decide(hookInput, { usage, config, home = process.env.HOME } = {}) {
  const status = capStatus(usage, config);
  if (!status.capped) return null;
  const deny = { deny: denyReason(status.reason) };
  const tool = hookInput?.tool_name;
  const input = hookInput?.tool_input;
  if (typeof tool !== 'string') return deny;
  if (LINEAR_TOOLS.has(tool)) return null;
  if (WRITE_TOOLS.has(tool)) return writeAllowed(input, hookInput.cwd, home) ? null : deny;
  if (tool === 'Bash') return bashAllowed(input?.command) ? null : deny;
  return deny;
}

// --- CLI -------------------------------------------------------------------------------------

const emit = (reason) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );

export function main() {
  try {
    const hookInput = JSON.parse(readFileSync(0, 'utf8'));
    if (!hookInput || typeof hookInput !== 'object') throw new Error('hook input is not an object');
    const config = loadConfig();
    const usage = readUsage({ maxAgeMin: config.snapshot_max_age_min });
    const result = decide(hookInput, { usage, config });
    if (result) emit(result.deny);
  } catch (err) {
    emit(`Usage guard error (${err.message}) — denying to stay safe.`);
  }
}

// Direct run only (not on import by tests); realpath so a symlinked hook path still matches.
const entry = process.argv[1] && realpathSync(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) main();
