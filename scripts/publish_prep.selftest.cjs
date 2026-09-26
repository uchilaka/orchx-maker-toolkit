const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PUBLISH_PREP_BIN lets a run point this suite at a deliberately broken copy of
// the script, to prove each test fails when its check is stubbed out.
const SCRIPT = process.env.PUBLISH_PREP_BIN || path.join(__dirname, 'publish_prep.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'publish-prep');
const CONFIG = path.join(FIXTURES, 'publish-prep.json');

// Built at runtime so no committed file holds a token-shaped string, which the
// gitleaks pre-commit hook would (rightly) block.
const FAKE_TOKEN = 'ghp_' + 'Z3xQ9vL2mR7tK4pW8nB1cY6hJ5sD0fG3aE2u';

function run(args) {
  const res = spawnSync('node', [SCRIPT, '--json', '--config', CONFIG, ...args], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* asserted by callers */ }
  return { status: res.status, stderr: res.stderr, report };
}

function fixture(...parts) {
  return path.join(FIXTURES, ...parts);
}

function findings(report, check) {
  return report.findings.filter(f => f.check === check && !f.allowed);
}

function tmpSkillWithToken() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-prep-'));
  const skill = path.join(dir, 'token-skill');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), [
    '---',
    'name: token-skill',
    'description: A fixture with a token in it. Use when the self-test needs a secret.',
    '---',
    '',
    `export GITHUB_TOKEN=${FAKE_TOKEN}`,
    '',
  ].join('\n'));
  return skill;
}

const hasGitleaks = spawnSync('gitleaks', ['version']).status === 0;

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

test('secrets: gitleaks finds a token and the report never echoes it', { skip: !hasGitleaks && 'gitleaks not installed' }, () => {
  const r = run([tmpSkillWithToken()]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'secrets').some(f => f.severity === 'high' && /gitleaks/.test(f.message)));
  assert.ok(!JSON.stringify(r.report).includes(FAKE_TOKEN), 'token leaked into the report');
});

test('secrets: without gitleaks, the regex fallback still finds the token and says it degraded', () => {
  const r = run(['--no-gitleaks', tmpSkillWithToken()]);
  assert.strictEqual(r.status, 1);
  assert.ok(findings(r.report, 'secrets').some(f => f.severity === 'high'));
  assert.ok(r.report.notes.some(n => /gitleaks/i.test(n)), 'expected a degraded-mode note');
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
