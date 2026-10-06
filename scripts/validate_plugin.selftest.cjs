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
