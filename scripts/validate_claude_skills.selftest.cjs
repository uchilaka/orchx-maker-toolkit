const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const VALIDATOR = path.join(__dirname, 'validate_claude_skills.test.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'claude-skills');

function validate(fixture) {
  return spawnSync('node', [VALIDATOR, path.join(FIXTURES, fixture)], { encoding: 'utf8' });
}

test('passes a well-formed skill', () => {
  const run = validate('valid');
  assert.strictEqual(run.status, 0, run.stderr);
});

test('fails a skill with no description', () => {
  const run = validate('missing-description');
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /no-desc: missing `description`/);
});

test('fails a skill whose name does not match its directory', () => {
  const run = validate('name-mismatch');
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /frontmatter name "some-other-name" does not match directory "actual-dir"/);
});
