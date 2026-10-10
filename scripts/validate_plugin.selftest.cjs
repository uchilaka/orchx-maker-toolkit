const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'validate_plugin.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'plugin-validate');

// --report feeds a saved `claude plugin validate --json` report, so these run
// without the claude CLI and against a known validator output.
function check(fixture) {
  return spawnSync('node', [SCRIPT, '--report', path.join(FIXTURES, `${fixture}.json`)], { encoding: 'utf8' });
}

test('passes when the only warning is the known CLAUDE.md-at-plugin-root one', () => {
  const r = check('known-warning-only');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tolerated/i);
});

test('fails on any other plugin warning, as --strict would', () => {
  const r = check('extra-warning');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Default skills\/ folder is ignored/);
});

test('fails on a plugin error', () => {
  const r = check('plugin-error');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /path escapes plugin directory/);
});

test('fails on a marketplace manifest warning', () => {
  const r = check('manifest-warning');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no description/);
});

// --- Regression tests from the PR #16 review: each of these printed "passed"
// and exited 0 before the fix.

test('fails when the validator reports failure, whatever the JSON shape', () => {
  const r = check('success-false');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Invalid JSON in marketplace\.json|success/);
});

test('fails on a report with no manifest, rather than counting zero problems', () => {
  const r = check('no-manifest');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /manifest/);
});

test('tolerates CLAUDE.md only at the marketplace root, not in another plugin', () => {
  const r = check('nested-claude-md');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /plugins\/other\/CLAUDE\.md/);
});

test('--report without a value is a usage error, not a stack trace', () => {
  const r = spawnSync('node', [SCRIPT, '--report'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.doesNotMatch(r.stderr, /at Object\.|node:internal/);
});
