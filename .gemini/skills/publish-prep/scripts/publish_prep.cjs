#!/usr/bin/env node
// publish-prep: checks a skill, agent or script before it's shared, and reports
// what would break or leak on someone else's machine. Read-only by design: the
// /publish-prep skill proposes fixes, and this script only finds problems, so
// the /release gate gets the same answer every run.
//
//   node <skill-dir>/scripts/publish_prep.cjs [--json] [--config <file>] [--root <dir>]
//                                 [--no-gitleaks] [--all | <path>...]
//
// With no paths it checks everything a release publishes (--all), which is
// what `mise run publish-prep` does. --root defaults to the git repo containing
// the current directory, so run it from the repo you're preparing.
//
// Exit codes: 0 = nothing blocking, 1 = at least one un-allowed `high` finding,
// 2 = usage error.
//
// Silence a finding by putting this on the line above it, or on the same line:
//   publish-prep: allow <check>[,<check>] — <reason>
// The reason is required. An allow with no reason is ignored, so every
// exception says why it exists.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFrontmatter } = require('./lib/frontmatter.cjs');

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

// Present on any machine that can run these skills, so a skill doesn't need to
// declare them. Extend per repo with `assumedCommands` in .publish-prep.json.
const DEFAULT_ASSUMED_COMMANDS = [
  // shell keywords and builtins
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly',
  'set', 'unset', 'shift', 'source', 'eval', 'exec', 'trap', 'wait', 'read',
  'cd', 'pwd', 'echo', 'printf', 'test', 'true', 'false', 'command', 'type',
  'alias', 'builtin', 'declare', 'let', 'time', 'sudo', 'then',
  // POSIX and near-universal tools
  'awk', 'basename', 'cat', 'chmod', 'cp', 'curl', 'cut', 'date', 'diff',
  'dirname', 'env', 'file', 'find', 'git', 'grep', 'head', 'kill', 'ln', 'ls',
  'mkdir', 'mktemp', 'mv', 'open', 'rm', 'rmdir', 'sed', 'sleep', 'sort', 'stat',
  'tail', 'tar', 'tee', 'touch', 'tr', 'uname', 'uniq', 'unzip', 'wc', 'which',
  'xargs', 'zip',
  // shells, and builtins/tools every POSIX box ships
  'bash', 'sh', 'zsh', 'cmp', 'comm', 'du', 'df', 'expr', 'getopts', 'hash',
  'hostname', 'id', 'mapfile', 'nohup', 'od', 'paste', 'popd', 'printenv', 'ps',
  'pushd', 'readarray', 'readlink', 'realpath', 'seq', 'ulimit', 'umask',
  'whoami', 'yes',
];

// Set by the shell or the harness itself, never by the person installing.
const DEFAULT_ASSUMED_ENV_PREFIXES = ['BASH_', 'CLAUDE_', 'GEMINI_', 'XDG_', 'LC_'];

// Slash commands that ship with Claude Code or Gemini CLI, so a reference to
// one isn't a dangling skill name.
const DEFAULT_KNOWN_COMMANDS = [
  'add-dir', 'agents', 'bug', 'chat', 'clear', 'code-review', 'compact', 'config',
  'context', 'cost', 'doctor', 'exit', 'export', 'extensions', 'fast', 'help',
  'hooks', 'ide', 'init', 'login', 'logout', 'loop', 'mcp', 'memory', 'model',
  'permissions', 'plugin', 'quit', 'resume', 'review', 'rewind', 'schedule',
  'security-review', 'settings', 'simplify', 'skills', 'stats', 'status',
  'theme', 'tools', 'vim',
  // Claude Code's bundled skills
  'keybindings-help', 'update-config',
];

// Top-level directories: a backticked `/tmp` is a path, not a skill.
const ROOT_DIRS = new Set([
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'dev', 'etc',
  'home', 'opt', 'private', 'proc', 'root', 'sbin', 'tmp', 'usr', 'var',
]);

// Token shapes for when gitleaks isn't installed. Deliberately narrow: this is
// the degraded path, and gitleaks is the real check.
const FALLBACK_TOKEN_PATTERNS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function parseArgs(argv) {
  const opts = { json: false, all: false, gitleaks: true, config: null, root: null, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--no-gitleaks') opts.gitleaks = false;
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (opts.paths.length === 0) opts.all = true;
  if (opts.all && opts.paths.length) usage('pass --all or paths, not both');
  opts.root = path.resolve(opts.root || gitRoot() || process.cwd());
  return opts;
}

function gitRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function usage(msg) {
  console.error(`publish-prep: ${msg}`);
  console.error('usage: publish_prep.cjs [--json] [--config <file>] [--root <dir>] [--no-gitleaks] [--all | <path>...]');
  process.exit(2);
}

function loadConfig(opts) {
  const file = opts.config || path.join(opts.root, '.publish-prep.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    internalDomains: user.internalDomains || [],
    personalPaths: user.personalPaths || [],
    personalConventions: user.personalConventions || [],
    assumedCommands: new Set([...DEFAULT_ASSUMED_COMMANDS, ...(user.assumedCommands || [])]),
    knownCommands: new Set([...DEFAULT_KNOWN_COMMANDS, ...(user.knownCommands || [])]),
  };
}

// --- Item discovery ---------------------------------------------------------

// What a release publishes: Gemini skills, real (non-symlinked) Claude skills,
// Claude agents, and scripts marked shareable. Mounted symlinks are skipped
// because their source is already covered under .gemini/skills/.
function discoverItems(root) {
  const items = [];
  const dirsIn = (rel, { skipSymlinks = false } = {}) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs)
      .map(n => path.join(abs, n))
      .filter(p => !(skipSymlinks && fs.lstatSync(p).isSymbolicLink()) && fs.statSync(p).isDirectory());
  };
  const filesIn = (rel, pred) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs).map(n => path.join(abs, n)).filter(p => fs.statSync(p).isFile() && pred(p));
  };
  items.push(...dirsIn('.gemini/skills'));
  items.push(...dirsIn('.claude/skills', { skipSymlinks: true }));
  items.push(...filesIn('.claude/agents', p => p.endsWith('.md')));
  items.push(...filesIn('scripts/shareable', () => true));
  return items;
}

function itemName(item) {
  return path.basename(item).replace(/\.md$/, '');
}

function listFiles(item) {
  if (fs.statSync(item).isFile()) return [item];
  const out = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && !isBinary(p)) out.push(p);
    }
  };
  walk(item);
  return out.sort();
}

function isBinary(file) {
  const buf = fs.readFileSync(file).subarray(0, 8000);
  return buf.includes(0);
}

function kindOf(item) {
  if (fs.statSync(item).isDirectory()) {
    return fs.existsSync(path.join(item, 'SKILL.md')) ? 'skill' : 'directory';
  }
  if (item.endsWith('.md')) return 'agent';
  return 'script';
}

// --- Allow comments ---------------------------------------------------------

// `--(?!>)` keeps the `--` of an HTML comment's closing `-->` from reading as
// the separator before a reason.
const ALLOW_RE = /publish-prep:\s*allow\s+([a-z,]+)(?:\s*(?:—|--(?!>)|:)\s*(.*?))?\s*(?:-->|\*\/)?\s*$/;

// Maps line number -> { checks, reason }. A comment covers its own line and
// the one after it, so it can sit above the line it excuses.
function allowances(lines, notes, file) {
  const map = new Map();
  lines.forEach((line, i) => {
    const m = line.match(ALLOW_RE);
    if (!m) return;
    const reason = (m[2] || '').trim();
    if (!/\w/.test(reason)) {
      notes.push(`${file}:${i + 1}: allow comment has no reason, so it was ignored`);
      return;
    }
    const entry = { checks: m[1].split(','), reason };
    map.set(i + 1, entry);
    map.set(i + 2, entry);
  });
  return map;
}

// --- Checks -----------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkSecretsRegex(ctx, useTokenFallback) {
  const { lines, add, config } = ctx;
  const internal = config.internalDomains.map(d => [d, new RegExp(`\\b(?:[\\w-]+\\.)*${escapeRe(d)}\\b`, 'i')]);
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g)) {
      const email = m[0];
      const [local, domain] = email.toLowerCase().split('@');
      if (/^no-?reply$/.test(local) || /(^|\.)example\.(com|org|net)$/.test(domain) || domain.endsWith('users.noreply.github.com')) continue;
      add('secrets', 'high', n, `email address ${email}`, 'replace with a placeholder such as <you@example.com>');
    }
    for (const m of line.matchAll(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/g)) {
      add('secrets', 'high', n, `Tailscale tailnet hostname ${m[0]}`, 'replace with a placeholder such as <host>.<tailnet>.ts.net');
    }
    for (const [domain, re] of internal) {
      const m = line.match(re);
      if (m) add('secrets', 'high', n, `internal domain ${m[0]} (${domain})`, 'replace with a placeholder domain');
    }
    // Private IPs are medium, not high: docs often show a home router's
    // default address, which leaks nothing.
    const ip = line.match(/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
    if (ip) add('secrets', 'medium', n, `private IP address ${ip[0]}`, 'use a placeholder unless it is a well-known default');
    if (useTokenFallback) {
      for (const [label, re] of FALLBACK_TOKEN_PATTERNS) {
        // The match itself is never written to the report.
        if (re.test(line)) add('secrets', 'high', n, `possible ${label} (regex fallback)`, 'remove it and rotate the credential');
      }
    }
  });
}

function runGitleaks(item) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-prep-gl-')), 'report.json');
  const res = spawnSync('gitleaks', [
    'dir', item, '--no-banner', '--redact', '--exit-code', '0',
    '--report-format', 'json', '--report-path', report,
  ], { encoding: 'utf8' });
  if (res.status !== 0) return { error: (res.stderr || '').trim().split('\n').pop() };
  const results = JSON.parse(fs.readFileSync(report, 'utf8') || '[]');
  // Only rule, file and line survive: never Secret or Match, even redacted.
  return { results: results.map(r => ({ rule: r.RuleID, description: r.Description, file: r.File, line: r.StartLine })) };
}

function checkPortability(ctx) {
  const { lines, add, config, bundle, self } = ctx;
  // An item that points at its own install location breaks everywhere it's
  // installed some other way: a plugin lives under a versioned cache path, and
  // a Gemini extension under ~/.gemini/extensions/.
  const ownPath = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\})/\\.(?:claude|gemini)/(?:skills|extensions|agents)/${escapeRe(self)}(?=/|\\.md\\b|\\s|$)`);
  const personalPaths = config.personalPaths.map(p => [p, new RegExp(`${escapeRe(p)}(?=/|\\b|$)`)]);
  const conventions = config.personalConventions.map(p => [p, new RegExp(`${escapeRe(p)}(?=/|\\b|$)`)]);
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(/(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g)) {
      add('portability', 'high', n, `absolute home path ${m[0]}`, 'use ~ or $HOME, or a <placeholder> the reader fills in');
    }
    const own = line.match(ownPath);
    if (own) add('portability', 'high', n, `${own[0]} references this item's own install path, which differs for plugin and extension installs`, 'use ${CLAUDE_SKILL_DIR} in SKILL.md, or a path relative to the script (dirname of BASH_SOURCE)');
    for (const [p, re] of personalPaths) {
      if (re.test(line)) add('portability', 'high', n, `machine-specific path ${p}`, 'use a path relative to the repo, or a <placeholder>');
    }
    for (const [p, re] of conventions) {
      if (re.test(line)) add('portability', 'medium', n, `personal convention ${p}`, 'make the location configurable, or explain it as an example');
    }
    for (const m of line.matchAll(/`\/([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)`/g)) {
      const name = m[1];
      if (ROOT_DIRS.has(name) || config.knownCommands.has(name) || bundle.has(name) || bundle.has(name.split(':').pop())) continue;
      add('portability', 'medium', n, `reference to /${name}, which ships neither with this item nor in the bundle`, 'ship it alongside, declare it under Requirements, or drop the reference');
    }
  });
}

const TRIGGER_RE = /\buse (this|it|when)\b|\btrigger|\bwhen the user\b|\bwhen (you|i) (say|ask)/i;

function checkFrontmatter(ctx, kind, item) {
  const { add } = ctx;
  const expected = itemName(item);
  const fm = parseFrontmatter(ctx.content);
  const label = kind === 'agent' ? 'agent file' : 'SKILL.md';
  if (!fm) {
    add('frontmatter', 'high', 1, `${label} has no YAML frontmatter block`, 'add --- name/description --- at the top');
    return;
  }
  const lineOf = key => Math.max(1, ctx.lines.findIndex(l => l.startsWith(`${key}:`)) + 1);
  if (!fm.name) add('frontmatter', 'high', 1, 'missing `name` in frontmatter', `add name: ${expected}`);
  else if (fm.name !== expected) add('frontmatter', 'high', lineOf('name'), `frontmatter name "${fm.name}" does not match "${expected}"`, `rename one so both say the same thing`);
  if (!fm.description) {
    add('frontmatter', 'high', 1, 'missing `description` in frontmatter', 'add a description that says what it does and when to use it');
    return;
  }
  const n = lineOf('description');
  if (fm.description.length > 1024) add('frontmatter', 'high', n, '`description` exceeds 1024 chars', 'trim it; the harness truncates or rejects it');
  if (fm.description.length < 80) add('frontmatter', 'low', n, `description is short (${fm.description.length} chars), so it may not trigger reliably`, 'say what it does and when to reach for it');
  if (!TRIGGER_RE.test(fm.description)) add('frontmatter', 'low', n, 'description names no trigger ("Use when …")', 'add the phrases a user would actually type');
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

// Returns [{ line, text }] for every line that runs as shell: fenced shell
// blocks in markdown, or the whole file for a shell script. Heredoc bodies are
// dropped, since they're data, not commands.
function shellLines(file, lines) {
  const out = [];
  const isShellScript = /\.(sh|bash|zsh)$/.test(file) || /^#!.*\b(ba|z)?sh\b/.test(lines[0] || '');
  let inFence = !!isShellScript && !file.endsWith('.md');
  let fenceIsShell = inFence;
  let heredoc = null;
  lines.forEach((line, i) => {
    if (!isShellScript || file.endsWith('.md')) {
      const fence = line.match(/^\s*```+\s*([A-Za-z]*)/);
      if (fence) {
        if (inFence) { inFence = false; fenceIsShell = false; } else { inFence = true; fenceIsShell = SHELL_LANGS.has(fence[1].toLowerCase()); }
        return;
      }
    }
    if (!inFence || !fenceIsShell) return;
    if (heredoc) { if (line.trim() === heredoc) heredoc = null; return; }
    // Match on the unquoted code, so a "<<" inside a string isn't a heredoc.
    const hd = shellCode(line)[0].match(/<<-?\s*(?:''|"")?([A-Za-z_][A-Za-z0-9_]*)/);
    out.push({ line: i + 1, text: line });
    if (hd) heredoc = hd[1];
  });
  return out;
}

// Splits one shell line into the pieces that actually run. Quoted text is
// data, so it's blanked out, except for command substitutions inside double
// quotes ("$(dirname ...)"), which run and come back as pieces of their own.
// Arithmetic $((...)) is dropped first, since its words are variables.
function shellCode(text) {
  const src = text.replace(/\$\(\([^)]*\)\)/g, '0');
  const subs = [];
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j === -1 ? src.length : j;
      out += "''";
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') {
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth) {
            if (src[k] === '(') depth++;
            else if (src[k] === ')') depth--;
            k++;
          }
          subs.push(src.slice(j + 2, k - 1));
          j = k;
          continue;
        }
        j++;
      }
      i = j;
      out += '""';
      continue;
    }
    out += c;
  }
  return [out, ...subs.flatMap(shellCode)];
}

function commandsIn(text) {
  const cmds = [];
  for (let code of shellCode(text)) {
    code = code.replace(/(^|\s)#.*$/, '');
    // A case arm's pattern (`yes|YES)`, `"BEGIN "*)`) isn't a command.
    code = code.replace(/^\s*[^\s()]+\)\s*/, '');
    for (let seg of code.split(/\|\||&&|[|;]|\$\(|`/)) {
      seg = seg.trim().replace(/^[({!]\s*/, '');
      const words = seg.split(/\s+/).filter(Boolean);
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      while (words.length && ['sudo', 'exec', 'time', 'command', 'env', 'then', 'do', 'else'].includes(words[0])) words.shift();
      const w = words[0];
      if (w && /^[a-z][a-z0-9._-]*$/.test(w)) cmds.push(w);
    }
  }
  return cmds;
}

// Functions and variables defined anywhere in the item. A script that sources
// a sibling (`source _lib.sh`) uses what the sibling defines, so these are
// collected across every file before any file is checked.
function shellDefinitions(files) {
  const defined = new Set();
  const assigned = new Set();
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const { text } of shellLines(file, lines)) {
      const fn = text.match(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)/);
      if (fn) defined.add(fn[1]);
      for (const m of text.matchAll(/(?:^|[\s;(])([A-Z][A-Z0-9_]*)=/g)) assigned.add(m[1]);
      for (const m of text.matchAll(/\b(?:for|read(?:\s+-\w+)*)\s+([A-Z][A-Z0-9_]*)\b/g)) assigned.add(m[1]);
    }
  }
  return { defined, assigned };
}

function requirementsText(lines) {
  const out = [];
  let level = 0;
  lines.forEach(line => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (level && h[1].length <= level) level = 0;
      if (/^(requirements|prerequisites|dependencies)\b/i.test(h[2])) { level = h[1].length; return; }
    }
    if (level) out.push(line);
    // Script headers declare with a comment: `# Requires: jq, gh`.
    if (/^\s*(#|\/\/)\s*(requires|requirements|depends on)\b/i.test(line)) out.push(line);
  });
  return out.join('\n');
}

function checkDependencies(ctx, declared, defs) {
  const { file, lines, add, config } = ctx;
  const seen = new Set();
  const declaredHas = name => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}([^A-Za-z0-9_-]|$)`, 'i').test(declared);
  const flag = (dep, n, what, fix) => {
    if (seen.has(dep)) return;
    seen.add(dep);
    const bare = dep.replace(/^mcp:/, '');
    if (declaredHas(bare)) return;
    add('dependencies', 'medium', n, `${what} is used but not listed under Requirements`, fix, { dependency: dep });
  };

  const shell = shellLines(file, lines);
  const { defined, assigned } = defs;
  for (const { line, text } of shell) {
    for (const cmd of commandsIn(text)) {
      if (config.assumedCommands.has(cmd) || defined.has(cmd)) continue;
      flag(cmd, line, `command \`${cmd}\``, `add \`${cmd}\` to a ## Requirements section`);
    }
    // Only NAMES_WITH_UNDERSCORES count as env dependencies: a bare $PR or $1
    // is a shell variable the snippet sets up itself.
    // ${VAR:-default}, ${VAR=...} and ${VAR:+...} are optional overrides with a
    // fallback, not requirements. ${VAR:?msg} is required, so it still counts.
    for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9]*_[A-Z0-9_]+)(:?[-=+])?/g)) {
      const v = m[1];
      if (m[2] || assigned.has(v) || DEFAULT_ASSUMED_ENV_PREFIXES.some(p => v.startsWith(p))) continue;
      flag(v, line, `environment variable \`${v}\``, `add \`${v}\` to Requirements, with what it holds`);
    }
  }
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/mcp__([A-Za-z0-9_-]+?)__[A-Za-z]/g)) {
      flag(`mcp:${m[1]}`, i + 1, `MCP server \`${m[1]}\``, `add the \`${m[1]}\` MCP server to Requirements`);
    }
  });
}

// --- Driver -----------------------------------------------------------------

function checkItem(item, opts, config, bundle, notes, gitleaksState) {
  const findings = [];
  const kind = kindOf(item);
  const files = listFiles(item);
  const skillMd = kind === 'skill' ? path.join(item, 'SKILL.md') : null;
  const itemDeclared = skillMd ? requirementsText(fs.readFileSync(skillMd, 'utf8').split('\n')) : '';
  const display = p => (p.startsWith(opts.root + path.sep) ? path.relative(opts.root, p) : p);
  const allowByFile = new Map();
  const defs = shellDefinitions(files);

  const makeAdd = (file, allowMap) => (check, severity, line, message, suggestedFix, extra = {}) => {
    const finding = { item: display(item), check, severity, file: display(file), line, message, suggestedFix, ...extra };
    const allow = allowMap.get(line);
    if (allow && allow.checks.includes(check)) Object.assign(finding, { allowed: true, reason: allow.reason });
    findings.push(finding);
  };

  let gitleaksResults = null;
  if (gitleaksState.available) {
    const gl = runGitleaks(item);
    if (gl.error) notes.push(`gitleaks failed on ${display(item)} (${gl.error}); fell back to regex token checks`);
    else gitleaksResults = gl.results;
  }

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const allowMap = allowances(lines, notes, display(file));
    allowByFile.set(path.resolve(file), allowMap);
    const ctx = { file, content, lines, config, bundle, self: itemName(item), add: makeAdd(file, allowMap) };
    checkSecretsRegex(ctx, gitleaksResults === null);
    checkPortability(ctx);
    if (file === skillMd) checkFrontmatter(ctx, 'skill', item);
    if (kind === 'agent' && file === item) checkFrontmatter(ctx, 'agent', item);
    checkDependencies(ctx, [itemDeclared, requirementsText(lines)].join('\n'), defs);
  }

  for (const r of gitleaksResults || []) {
    const abs = path.resolve(fs.statSync(item).isFile() ? path.dirname(item) : item, r.file);
    const file = fs.existsSync(abs) ? abs : path.resolve(r.file);
    const allowMap = allowByFile.get(file) || new Map();
    makeAdd(file, allowMap)('secrets', 'high', r.line, `gitleaks ${r.rule}: ${r.description}`, 'remove it and rotate the credential');
  }
  return findings;
}

function toMarkdown(report) {
  const out = [];
  const open = report.findings.filter(f => !f.allowed);
  const allowed = report.findings.filter(f => f.allowed);
  const blocking = open.filter(f => f.severity === 'high').length;
  out.push(`# publish-prep: ${blocking ? `BLOCKED (${blocking} high)` : 'OK'}`, '');
  out.push(`${report.items.length} item(s) checked, ${open.length} open finding(s), ${allowed.length} allowed.`, '');
  const byItem = new Map();
  for (const f of open) byItem.set(f.item, [...(byItem.get(f.item) || []), f]);
  for (const [item, fs_] of byItem) {
    out.push(`## ${item}`, '', '| Severity | Check | Where | Finding | Suggested fix |', '| --- | --- | --- | --- | --- |');
    fs_.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.line - b.line)
      .forEach(f => out.push(`| ${f.severity} | ${f.check} | \`${f.file}:${f.line}\` | ${f.message.replace(/\|/g, '\\|')} | ${f.suggestedFix} |`));
    out.push('');
  }
  if (allowed.length) {
    out.push('## Allowed', '');
    allowed.forEach(f => out.push(`- \`${f.file}:${f.line}\` ${f.check}: ${f.message}, because ${f.reason}`));
    out.push('');
  }
  if (report.notes.length) {
    out.push('## Notes', '');
    report.notes.forEach(n => out.push(`- ${n}`));
  }
  return out.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig(opts);
  const discovered = discoverItems(opts.root);
  const items = opts.all ? discovered : opts.paths.map(p => path.resolve(p));
  for (const item of items) if (!fs.existsSync(item)) usage(`no such item: ${item}`);
  const bundle = new Set([...discovered, ...items].map(itemName));

  const notes = [];
  const gitleaksState = { available: opts.gitleaks && spawnSync('gitleaks', ['version']).status === 0 };
  if (!gitleaksState.available) {
    notes.push(opts.gitleaks
      ? 'gitleaks is not installed, so secrets were checked with the regex fallback only (install: mise run bundle)'
      : 'gitleaks was skipped (--no-gitleaks), so secrets were checked with the regex fallback only');
  }

  const findings = items.flatMap(item => checkItem(item, opts, config, bundle, notes, gitleaksState));
  const report = { items, findings, notes };
  console.log(opts.json ? JSON.stringify(report, null, 2) : toMarkdown(report));
  process.exit(findings.some(f => !f.allowed && f.severity === 'high') ? 1 : 0);
}

main();
