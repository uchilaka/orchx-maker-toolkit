// Self-test for validate_skills.test.cjs. A stub `brew` on PATH points the
// script at a gemini-cli prefix, so no real Homebrew or gemini-cli is needed.
//
//   node --test scripts/validate_skills.selftest.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'validate_skills.test.cjs');

// Runs the script with a `brew` that answers `--prefix gemini-cli` with prefix.
function runWithPrefix(prefix) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-skills-'));
  fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/sh\necho ${JSON.stringify(prefix)}\n`, { mode: 0o755 });
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
}

test('a gemini-cli that moved its skill validator fails once, naming the missing file', () => {
  const r = runWithPrefix(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skill validator not found at .*validate_skill\.cjs/);
  assert.doesNotMatch(r.stderr, /failed validation/, 'not blamed on each skill');
});
