#!/usr/bin/env node
// PreToolUse hook for the agentic-ticket-worker subagent. Under the usage cap it returns null
// (normal permissions apply); at or over the cap it denies every tool call except the ones that
// checkpoint work. This is a security boundary: anything it cannot positively verify is denied.
// Threat model is capped-only: a below-cap agent could pre-plant git config in the main repo, and
// that is out of scope here.
import { readFileSync, realpathSync, lstatSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// `settled` becomes true once the CLI has emitted a deny or reached its normal allow exit. The
// exit backstop below treats anything else as a failure to decide and denies.
let settled = false;
// Synchronous so the JSON is out before any process.exit.
const emit = (reason) => {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
  settled = true;
};


// Direct run only (not on import by tests); realpath so a symlinked hook path still matches.
// Any failure deciding whether we are the entry point is treated as direct, which denies.
let direct = true;
try {
  const entry = process.argv[1] && realpathSync(process.argv[1]);
  direct = Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
} catch {
  direct = true;
}
// Backstops are registered before the libs load: every other way out of this process (uncaught
// exception, or an import that never settles, which node ends with exit 13 and no output) is
// non-blocking to Claude Code, i.e. fail OPEN.
const lastResort = (reason) => {
  try {
    emit(reason);
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`${reason} (could not write deny JSON: ${err?.message})\n`);
    process.exitCode = 2;
  }
};
if (direct) {
  process.on('uncaughtException', (err) => {
    lastResort(`Usage guard error (${err?.message}) — denying to stay safe.`);
    process.exit();
  });
  process.on('exit', () => {
    if (!settled) lastResort('Usage guard error (no decision reached) — denying to stay safe.');
  });
}

// The libs load dynamically so a missing or broken lib cannot fail the import: an uncaught
// import error exits 1 with no JSON, which Claude Code treats as non-blocking (fail OPEN).
// Instead the error is kept and rethrown from decide()/main(), where it becomes a denial.
let lib = null;
let libError = null;
try {
  const [config, usage] = await Promise.all([import('../lib/config.mjs'), import('../lib/usage.mjs')]);
  lib = { ...config, ...usage };
} catch (err) {
  libError = err;
}
const needLib = () => {
  if (!lib) throw libError ?? new Error('guard libs unavailable');
  return lib;
};

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const LINEAR_TOOLS = new Set(['mcp__linear__save_comment', 'mcp__linear__save_issue']);
const BRANCH = /^[A-Z]+-[0-9]+\//;

const denyReason = (why) =>
  `Usage cap reached (${why}). Write your checkpoint to the ticket plan, commit and push the WIP ` +
  'branch, then return RESULT {"outcome":"capped"}. No other tool calls are allowed.';

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

// The state and runs dirs, in that order, each resolved by resolveClosest (null when
// unresolvable). Both stay off-limits to `git -C`; only the runs dir holds writable files.
// Computed once per process: a hook run makes one decision, and nothing it does moves these
// dirs. Each caller applies its own null handling.
let guardedBases = null;
function guardBases() {
  if (!guardedBases) {
    const { stateDir, runsDir } = needLib();
    guardedBases = [stateDir(), runsDir()].map((dir) => resolveClosest(path.resolve(dir)));
  }
  return guardedBases;
}

// Joined by string, not path.resolve, and resolved with realpath.native (the JS realpath collapses
// `..` lexically): `link/../x` must be resolved by the OS through the real symlink, not collapsed
// first.
function absolutize(file, cwd, home) {
  if (file === '~' || file.startsWith('~/')) {
    // An unset HOME would otherwise expand to the literal path `undefined/...`.
    if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
    return file === '~' ? home : `${home}/${file.slice(2)}`;
  }
  if (path.isAbsolute(file)) return file;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return `${cwd}/${file}`;
}

// The only files a capped agent may write, relative to the resolved runs dir: its ticket plan and
// its PR body. The state dir is not writable at all: run.json, history.json, window.json and
// result-*.json are orchestrator state, and a forged run.json once let a capped write redirect
// the debrief onto ~/.zshenv (live review SEC1). Matched on the resolved path, so `..` and
// symlinks are already gone.
const CHECKPOINT_FILE = /^tickets\/[A-Z]+-[0-9]+(-pr)?\.md$/;

function writeAllowed(toolInput, cwd, home) {
  const file = toolInput?.file_path;
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return false;
  const abs = absolutize(file, cwd, home);
  if (!abs) return false;
  const target = resolveClosest(abs);
  if (!target) return false;
  // A hard link inside the runs dir can point at a file outside it, and realpath can't see
  // that. No legitimate checkpoint file is hard-linked, so any multi-link target is denied.
  try {
    const st = lstatSync(target);
    if (st.isFile() && st.nlink > 1) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
  }
  const runs = guardBases()[1];
  if (runs === null) return false;
  const rel = path.relative(runs, target);
  return CHECKPOINT_FILE.test(rel.split(path.sep).join('/'));
}

// --- Bash ------------------------------------------------------------------------------------

// Any shell metacharacter, control character or expansion trigger anywhere in the command
// (quotes included) is rejected: `\` escapes, `{}` brace expansion, `#` comments (which would
// hide what the shell really runs from our tokenizer) and `!` history all change tokenization.
// Glob characters and `~` are rejected too: the shell expands them after we tokenize, so a
// planted file named `LAR-1/x:main` would turn `LAR-1/*` into a push to main.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[;&|$`><()\\{}#!*?[\]~\x00-\x08\x0a-\x1f\x7f]/;

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

// `ticket` is the ticket id of the `-C` worktree (null without `-C`): the push must then land on
// that ticket's own branch, so one agent can't overwrite another's (live review SEC6).
function pushAllowed(args, ticket) {
  const positional = [];
  let noVerify = false;
  for (const a of args) {
    if (FORCE_FLAG.test(a)) return false;
    if (a === '--no-verify') noVerify = true;
    if (a.startsWith('-')) {
      if (!PUSH_FLAGS.has(a)) return false;
    } else positional.push(a);
  }
  // A pre-push hook in the worktree is agent-editable code (live review SEC7).
  if (!noVerify) return false;
  // Exactly `<remote> <refspec>`: a bare push can't be verified, and a URL as the remote would
  // send the branch somewhere else.
  if (positional.length !== 2) return false;
  const [remote, refspec] = positional;
  // Pinned to `origin`: git treats an unconfigured bare word (or `..`) as a local path, which a
  // capped agent could have planted.
  if (remote !== 'origin') return false;
  if (refspec.startsWith('+')) return false;
  const parts = refspec.split(':');
  // `:dst` (empty src) deletes the remote branch; a second colon is not a refspec at all.
  if (parts.length > 2 || parts[0] === '') return false;
  const dst = parts[parts.length - 1];
  if (!BRANCH.test(dst)) return false;
  return ticket === null || dst.startsWith(`${ticket}/`);
}

// Closed flag sets, matched exactly: git accepts abbreviated long options (`--fil=` for
// `--file=`), so prefix matching would let `-F <file>` style reads and exfiltration through.
const COMMIT_FLAGS = new Set(['-a', '--all', '--no-verify', '-q']);

function commitAllowed(args) {
  let noVerify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-verify') noVerify = true;
    if (a === '-m') {
      // Consumes the next word as the message, even one starting with `-`.
      if (++i >= args.length) return false;
    } else if (a.startsWith('--message=')) {
      // value is the message
    } else if (!COMMIT_FLAGS.has(a)) return false;
  }
  // pre-commit and commit-msg hooks in the worktree are agent-editable code (live review SEC7).
  return noVerify;
}

const ADD_FLAGS = new Set(['-A', '--all', '-u', '--update']);

function addAllowed(args) {
  let pathspecs = false;
  for (const a of args) {
    if (pathspecs) continue;
    if (a === '--') pathspecs = true;
    else if (a.startsWith('-') && !ADD_FLAGS.has(a)) return false;
  }
  return true;
}

// `git -C <dir>` lets a capped agent reach its worktree: subagent Bash calls reset cwd between
// calls, so a bare `git commit` would run in the launch checkout. Git executes config values
// (core.fsmonitor, core.sshCommand, filters), and a capped agent can write ticket files under the
// runs dir, so the directory must be a genuine linked worktree whose config lives in a
// main repo the capped agent cannot write to. All of these must hold:
//   (a) not inside the state or runs dirs;
//   (b) named like a ticket id (LAR-123) directly under a `*-worktrees` dir that is not itself
//       nested under another one;
//   (c) `<dir>/.git` is a regular file (not a symlink) holding one `gitdir: <path>` line;
//   (d) that path resolves to `<X>/.git/worktrees/<name>`, with `<X>/.git` a real directory and
//       `<X>` neither inside state/runs nor under any `*-worktrees` component.
function insideGuardedDirs(real) {
  // Unresolvable guard dirs: fail closed.
  return guardBases().some((base) =>
    base === null || real === base || real.startsWith(base + path.sep));
}

// The worktree's resolved path when every check holds, else null.
function worktreeDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  try {
    const real = realpathSync.native(dir);
    if (!statSync(real).isDirectory() || insideGuardedDirs(real)) return null;
    if (!/^[A-Z]+-[0-9]+$/.test(path.basename(real))) return null;
    if (!path.basename(path.dirname(real)).endsWith('-worktrees')) return null;
    // Only the immediate parent may be a `*-worktrees` dir: nesting inside another worktree
    // (which the agent can populate) is denied.
    if (real.split(path.sep).slice(0, -2).some((c) => c.endsWith('-worktrees'))) return null;
    const dotGit = path.join(real, '.git');
    if (!lstatSync(dotGit).isFile()) return null;
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir: ([^\n]+)\n?$/);
    if (!m) return null;
    const gitdir = realpathSync.native(path.resolve(real, m[1]));
    const parts = gitdir.split(path.sep);
    const n = parts.length;
    if (n < 4 || parts[n - 2] !== 'worktrees' || parts[n - 3] !== '.git') return null;
    const main = path.dirname(path.dirname(path.dirname(gitdir)));
    if (!lstatSync(path.join(main, '.git')).isDirectory()) return null;
    if (insideGuardedDirs(main)) return null;
    return main.split(path.sep).some((c) => c.endsWith('-worktrees')) ? null : real;
  } catch {
    return null;
  }
}

function bashAllowed(command) {
  if (typeof command !== 'string' || UNSAFE.test(command)) return false;
  // Single spaces and a bare subcommand word, as before: no doubled spaces or quoted subcommands.
  if (!/^git (-C ("[^"]*"|'[^']*'|\S+) )?(add|commit|push)( |$)/.test(command)) return false;
  const tokens = tokenize(command);
  if (!tokens) return false;
  let at = 1;
  let ticket = null;
  // Only a single leading `-C <dir>`; a second one, or any other git option, fails the
  // subcommand check below.
  if (tokens[at] === '-C') {
    const real = worktreeDir(tokens[at + 1]);
    if (!real) return false;
    ticket = path.basename(real);
    at += 2;
  }
  const sub = tokens[at];
  const args = tokens.slice(at + 1);
  if (sub === 'push') return pushAllowed(args, ticket);
  if (sub === 'commit') return commitAllowed(args);
  if (sub === 'add') return addAllowed(args);
  return false;
}

// --- Decision --------------------------------------------------------------------------------

export function decide(hookInput, { usage, config, home = process.env.HOME } = {}) {
  const status = needLib().capStatus(usage, config);
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

export function main() {
  try {
    const hookInput = JSON.parse(readFileSync(0, 'utf8'));
    if (!hookInput || typeof hookInput !== 'object') throw new Error('hook input is not an object');
    const { loadConfig, readUsage } = needLib();
    const config = loadConfig();
    const usage = readUsage({ maxAgeMin: config.snapshot_max_age_min });
    const result = decide(hookInput, { usage, config });
    if (result) emit(result.deny);
    else settled = true;
  } catch (err) {
    emit(`Usage guard error (${err.message}) — denying to stay safe.`);
  }
}

if (direct) main();
