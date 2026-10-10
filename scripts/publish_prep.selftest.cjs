const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PUBLISH_PREP_BIN lets a run point this suite at a deliberately broken copy of
// the script, to prove each test fails when its check is stubbed out.
const SCRIPT = process.env.PUBLISH_PREP_BIN || path.join(__dirname, '..', '.gemini', 'skills', 'publish-prep', 'scripts', 'publish_prep.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'publish-prep');
const CONFIG = path.join(FIXTURES, 'publish-prep.json');

// Built at runtime so no committed file holds a token-shaped string, which the
// gitleaks pre-commit hook would (rightly) block.
const FAKE_TOKEN = 'ghp_' + 'Z3xQ9vL2mR7tK4pW8nB1cY6hJ5sD0fG3aE2u';

// Every temp dir a test makes is removed when the suite ends.
const TMP_DIRS = [];
after(() => TMP_DIRS.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir(prefix = 'publish-prep-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

// process.execPath, not 'node', so a test can narrow PATH (e.g. to hide
// gitleaks) without losing the interpreter.
function run(args, { env } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, '--json', '--config', CONFIG, ...args], { encoding: 'utf8', env: env || process.env });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* asserted by callers */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, report };
}

function fixture(...parts) {
  return path.join(FIXTURES, ...parts);
}

function findings(report, check) {
  return report.findings.filter(f => f.check === check && !f.allowed);
}

// A minimal valid skill at <parent>/<name>, plus any extra files.
function tmpSkill(name, files = {}, parent = tmpDir()) {
  const skill = path.join(parent, name);
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: A runtime fixture skill. Use when the self-test needs an item built on the fly.',
    '---',
    '',
  ].join('\n'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(skill, rel)), { recursive: true });
    fs.writeFileSync(path.join(skill, rel), body);
  }
  return skill;
}

function tmpSkillWithToken() {
  return tmpSkill('token-skill', { 'run.sh': `export GITHUB_TOKEN=${FAKE_TOKEN}\n` });
}

// A PATH holding only the system dirs plus `extra` (e.g. a gitleaks stub), so
// a test controls whether gitleaks exists regardless of the host machine.
function envWithPath(extra) {
  return { ...process.env, PATH: [extra, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter) };
}

const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;
// In CI a missing gitleaks must fail the gitleaks tests, not skip them: the
// primary secrets path would otherwise go silently untested.
const gitleaksSkip = !hasGitleaks && !process.env.CI && 'gitleaks not installed';

test('a clean item has no findings and exits 0', () => {
  const r = run([fixture('clean', 'tidy-skill')]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.report.findings, []);
});

test('secrets: flags an email, a tailnet host and an internal domain as high', () => {
  const r = run([fixture('secrets', 'leaky-skill')]);
  assert.strictEqual(r.status, 1);
  const msgs = findings(r.report, 'secrets').map(f => `${f.severity} ${f.message}`).join('\n');
  assert.match(msgs, /high .*email/i);
  assert.match(msgs, /high .*ts\.net/i);
  assert.match(msgs, /high .*example-corp\.dev/i);
});

test('secrets: gitleaks finds a token and the report never echoes it', { skip: gitleaksSkip }, () => {
  const r = run([tmpSkillWithToken()]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'secrets').some(f => f.severity === 'high' && /gitleaks/.test(f.message)));
  assert.ok(!JSON.stringify(r.report).includes(FAKE_TOKEN), 'token leaked into the report');
});

test('secrets: without gitleaks, the regex fallback still finds the token and says it degraded', () => {
  const r = run(['--no-gitleaks', tmpSkillWithToken()]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'secrets').some(f => f.severity === 'high'));
  assert.ok(r.report.notes.some(n => /--no-gitleaks/.test(n)), 'expected the --no-gitleaks note, not the not-installed one');
  assert.ok(!JSON.stringify(r.report).includes(FAKE_TOKEN), 'token leaked into the report');
});

test('portability: a home path is high; a personal convention and an unknown skill are medium', () => {
  const r = run([fixture('portability', 'hardcoded-skill')]);
  assert.strictEqual(r.status, 1);
  const p = findings(r.report, 'portability');
  assert.ok(p.some(f => f.severity === 'high' && /\/Users\/jdoe/.test(f.message)));
  assert.ok(p.some(f => f.severity === 'medium' && /~\/project-plans/.test(f.message)));
  assert.ok(p.some(f => f.severity === 'medium' && /nonexistent-skill/.test(f.message)));
  assert.ok(p.every(f => Number.isInteger(f.line) && f.line > 0), 'every finding carries a line');
});

test('portability: a skill that references its own install path is high', () => {
  const r = run([fixture('portability', 'self-path-skill')]);
  assert.strictEqual(r.status, 1);
  const own = findings(r.report, 'portability').filter(f => /own install path/.test(f.message));
  assert.strictEqual(own.length, 2, JSON.stringify(own, null, 2));
  assert.ok(own.every(f => f.severity === 'high'));
  assert.ok(own.some(f => f.file.endsWith('SKILL.md')) && own.some(f => f.file.endsWith('run.sh')));
});

test('frontmatter: a name that does not match its directory is high', () => {
  const r = run([fixture('frontmatter', 'wrong-name')]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'frontmatter').some(f => f.severity === 'high' && /some-other-name/.test(f.message)));
});

test('frontmatter: a short description with no trigger is low and does not block', () => {
  const r = run([fixture('frontmatter', 'short-desc')]);
  assert.strictEqual(r.status, 0, r.stderr);
  const f = findings(r.report, 'frontmatter');
  assert.ok(f.length >= 2, 'expected short and no-trigger findings');
  assert.ok(f.every(x => x.severity === 'low'));
});

test('frontmatter: an agent with no description is high', () => {
  const r = run([fixture('frontmatter', 'agents', 'bad-agent.md')]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'frontmatter').some(f => f.severity === 'high' && /description/.test(f.message)));
});

test('dependencies: undeclared CLIs, env vars and MCP servers are medium; declared ones are not flagged', () => {
  const r = run([fixture('dependencies', 'undeclared-skill')]);
  assert.strictEqual(r.status, 0, 'medium findings should not block');
  const names = findings(r.report, 'dependencies').map(f => f.dependency);
  assert.ok(names.includes('jq'));
  assert.ok(names.includes('LINEAR_API_KEY'));
  assert.ok(names.includes('mcp:linear'));
  assert.ok(!names.includes('gh'), 'gh is declared');
  assert.ok(!names.includes('curl'), 'curl is assumed present');
  assert.ok(!names.includes('PR'), 'a bare shell variable is not an env dependency');
});

test('dependencies: ordinary shell idioms across sourced files are not dependencies', () => {
  const r = run([fixture('dependencies', 'shell-idioms-skill')]);
  assert.strictEqual(r.status, 0, r.stderr);
  const names = findings(r.report, 'dependencies').map(f => f.dependency);
  assert.deepStrictEqual(names, [], `false positives: ${names.join(', ')}`);
});

test('allow: a reasoned allow comment suppresses the finding and keeps it visible', () => {
  const r = run([fixture('allow', 'allowed-skill')]);
  assert.strictEqual(r.status, 0, r.stderr);
  const allowed = r.report.findings.filter(f => f.allowed);
  assert.strictEqual(allowed.length, 1);
  assert.match(allowed[0].reason, /macOS default path/);
});

test('allow: an allow comment with no reason is ignored', () => {
  const r = run([fixture('allow', 'unreasoned-skill')]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'portability').some(f => f.severity === 'high'));
});

test('--all checks only the Claude skills marketplace.json publishes, and says what it skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-prep-mkt-'));
  const mk = (p, body) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
  const skill = n => `---\nname: ${n}\ndescription: A fixture skill for the marketplace scope test. Use when the self-test needs a published skill.\n---\n`;
  mk('.claude/skills/shipped/SKILL.md', skill('shipped'));
  // Unpublished, and broken on purpose: if it were checked, the run would fail.
  mk('.claude/skills/local-only/SKILL.md', '---\nname: wrong\n---\nClone into /Users/jdoe/app.\n');
  mk('.claude-plugin/marketplace.json', JSON.stringify({
    name: 'm', owner: { name: 'o' },
    plugins: [{ name: 'p', source: './', skills: ['./.claude/skills/shipped'] }],
  }));
  const r = run(['--all', '--root', root]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.report, null, 2));
  assert.deepStrictEqual(r.report.items.map(i => path.relative(root, i)), ['.claude/skills/shipped']);
  assert.ok(r.report.notes.some(n => /local-only/.test(n) && /marketplace\.json/.test(n)), r.report.notes.join('\n'));
});

test('--all finds publishable items and skips mount symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-prep-root-'));
  const mk = (p, body) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
  const skill = n => `---\nname: ${n}\ndescription: A fixture skill for the --all test. Use when the self-test walks a whole repo layout.\n---\n`;
  mk('.gemini/skills/gem-one/SKILL.md', skill('gem-one'));
  mk('.claude/skills/claude-one/SKILL.md', skill('claude-one'));
  fs.symlinkSync('../../.gemini/skills/gem-one', path.join(root, '.claude/skills/gem-one'));
  mk('.claude/agents/helper.md', '---\nname: helper\ndescription: A fixture agent. Use when the self-test needs an agent.\n---\n');
  mk('scripts/shareable/tool.sh', '#!/usr/bin/env bash\necho hi\n');
  const r = run(['--all', '--root', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const items = r.report.items.map(i => path.relative(root, i)).sort();
  assert.deepStrictEqual(items, [
    '.claude/agents/helper.md',
    '.claude/skills/claude-one',
    '.gemini/skills/gem-one',
    'scripts/shareable/tool.sh',
  ]);
});

// --- Regression tests from the PR #16 review: each planted token got past the
// gate (exit 0) before the fix.

test('S1: a skill-local .gitleaks.toml cannot switch off the scan, and is itself flagged', { skip: gitleaksSkip }, () => {
  const skill = tmpSkill('allowlist-skill', {
    '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
    'run.sh': `x=${FAKE_TOKEN}\n`,
  });
  const r = run([skill]);
  assert.strictEqual(r.status, 1, JSON.stringify(r.report, null, 2));
  const s = findings(r.report, 'secrets');
  assert.ok(s.some(f => /gitleaks/.test(f.message) && f.file.endsWith('run.sh')), 'token not found');
  assert.ok(s.some(f => f.severity === 'high' && f.file.endsWith('.gitleaks.toml')), 'item-local config not flagged');
});

test('S2: a gitleaks:allow comment does not hide a token from the gate', () => {
  const skill = tmpSkill('inline-allow-skill', { 'run.sh': `export GH=${FAKE_TOKEN} # gitleaks:allow\n` });
  const r = run([skill]);
  assert.strictEqual(r.status, 1, JSON.stringify(r.report, null, 2));
  assert.ok(findings(r.report, 'secrets').some(f => f.severity === 'high' && f.file.endsWith('run.sh')));
});

test('S2: a reasoned publish-prep allow is still the way to excuse it', () => {
  const skill = tmpSkill('reasoned-allow-skill', {
    'run.sh': `# publish-prep: allow secrets — revoked demo token shown in the docs\nexport GH=${FAKE_TOKEN} # gitleaks:allow\n`,
  });
  const r = run([skill]);
  assert.strictEqual(r.status, 0, JSON.stringify(r.report, null, 2));
  assert.ok(r.report.findings.some(f => f.check === 'secrets' && f.allowed));
});

test('S3: a token in a symlinked file outside the item is caught, and the link is flagged', () => {
  const parent = tmpDir();
  fs.mkdirSync(path.join(parent, 'outside'));
  fs.writeFileSync(path.join(parent, 'outside', 'creds.sh'), `x=${FAKE_TOKEN}\n`);
  const skill = tmpSkill('linked-skill', {}, parent);
  fs.symlinkSync('../outside/creds.sh', path.join(skill, 'creds.sh'));
  const r = run([skill]);
  assert.strictEqual(r.status, 1, JSON.stringify(r.report, null, 2));
  const s = r.report.findings.filter(f => !f.allowed && f.severity === 'high');
  assert.ok(s.some(f => f.check === 'secrets' && f.file.endsWith('creds.sh')), 'token behind symlink missed');
  assert.ok(s.some(f => /outside the item/.test(f.message)), 'escaping symlink not flagged');
  assert.ok(!JSON.stringify(r.report).includes(FAKE_TOKEN), 'token leaked into the report');
});

test('S4: --all checks a published skill that lives outside .claude/skills/', () => {
  const root = tmpDir('publish-prep-root-');
  tmpSkill('elsewhere', { 'run.sh': `x=${FAKE_TOKEN}\n` }, path.join(root, 'extra'));
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: './', skills: ['./extra/elsewhere'] }],
  }));
  const r = run(['--all', '--root', root]);
  assert.strictEqual(r.status, 1, JSON.stringify(r.report, null, 2));
  assert.deepStrictEqual(r.report.items.map(i => path.relative(root, i)), ['extra/elsewhere']);
});

test('S4/C10: a published skill path that does not exist is an error, not a silent skip', () => {
  const root = tmpDir('publish-prep-root-');
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'm', owner: { name: 'o' }, plugins: [{ name: 'p', source: './', skills: ['./.claude/skills/typo'] }],
  }));
  const r = run(['--all', '--root', root]);
  assert.strictEqual(r.status, 2);
  // The message, not a stack trace: a crash exits 2 as well.
  assert.match(r.stderr, /marketplace\.json publishes \.\/\.claude\/skills\/typo, which has no SKILL\.md/);
});

test('S5: with gitleaks missing, the gate refuses to pass on the regex fallback', () => {
  const r = run([fixture('clean', 'tidy-skill')], { env: envWithPath() });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /gitleaks/);
});

test('S5: the regex fallback covers current token formats', () => {
  // Assembled here so no committed file holds a token-shaped string.
  const body = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  const tokens = {
    'OpenAI project key': 'sk-proj-' + body,
    'GitLab token': 'glpat-' + body.slice(0, 20),
    'Google API key': 'AIza' + body.slice(0, 35),
    'npm token': 'npm_' + body.slice(0, 36),
    'Stripe live key': 'sk_live_' + body.slice(0, 24),
    JWT: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', body.slice(0, 20)].join('.'),
  };
  for (const [label, token] of Object.entries(tokens)) {
    const r = run(['--no-gitleaks', tmpSkill('fmt-skill', { 'run.sh': `x=${token}\n` })]);
    assert.strictEqual(r.status, 1, `${label} missed`);
    assert.ok(!JSON.stringify(r.report).includes(token), `${label} leaked into the report`);
  }
});

test('S6: a symlink loop is walked once, not crashed on or repeated', () => {
  // One medium finding, so a walk that loops shows up as duplicates.
  const skill = tmpSkill('loop-skill', { 'notes.md': 'The router lives at 192.168.1.1.\n' });
  fs.mkdirSync(path.join(skill, 'l'));
  fs.symlinkSync('..', path.join(skill, 'l', 'up'));
  const r = run([skill]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.report.findings.filter(f => /private IP/.test(f.message)).length, 1, JSON.stringify(r.report.findings, null, 2));
});

test('S6/C9: config problems exit 2, never 0 or the BLOCKED code', () => {
  const clean = fixture('clean', 'tidy-skill');
  const missing = spawnSync(process.execPath, [SCRIPT, '--json', '--config', '/no/such/config.json', clean], { encoding: 'utf8' });
  assert.strictEqual(missing.status, 2, 'a missing --config must not silently use defaults');
  const dangling = spawnSync(process.execPath, [SCRIPT, '--json', clean, '--config'], { encoding: 'utf8' });
  assert.strictEqual(dangling.status, 2, '--config with no value');
  const bad = path.join(tmpDir(), 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const malformed = spawnSync(process.execPath, [SCRIPT, '--json', '--config', bad, clean], { encoding: 'utf8' });
  assert.strictEqual(malformed.status, 2, 'a malformed config must not exit 1');
  assert.match(malformed.stderr, /bad\.json/);
});

test('T8: when gitleaks itself fails, the checker falls back and says so', () => {
  const stubDir = tmpDir();
  const stub = path.join(stubDir, 'gitleaks');
  // `version` succeeds so gitleaks counts as installed; the scan then fails.
  fs.writeFileSync(stub, '#!/bin/sh\n[ "$1" = version ] && { echo 8.0.0; exit 0; }\necho boom >&2\nexit 3\n');
  fs.chmodSync(stub, 0o755);
  const r = run([tmpSkillWithToken()], { env: envWithPath(stubDir) });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.report.notes.some(n => /fell back/.test(n)), r.report.notes.join('\n'));
  assert.ok(findings(r.report, 'secrets').some(f => /regex fallback/.test(f.message)));
});
