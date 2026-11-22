// close-test-browser.sh must stop only the Chrome running the test profile.
// A leftover test browser is the oldest Chrome instance, so macOS sends every
// link opened from the terminal to it. Real Chrome is never launched here:
// stand-in processes carry the same command-line flags pgrep matches on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'close-test-browser.sh');

// A long-lived process whose command line holds `flags`, like a Chrome process.
function fakeChrome(flags) {
  const child = spawn('perl', ['-e', 'sleep 60', '--', ...flags], { stdio: 'ignore' });
  return child;
}

const alive = (child) => child.exitCode === null && child.signalCode === null;
const settle = () => new Promise((r) => setTimeout(r, 300));

function run(profile) {
  return spawnSync('bash', [SCRIPT], { env: { ...process.env, BTA_PROFILE_DIR: profile }, encoding: 'utf8' });
}

test('stops the test-profile browser and leaves other Chrome alone', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'bta-profile-'));
  const other = mkdtempSync(join(tmpdir(), 'bta-other-'));
  const testMain = fakeChrome([`--user-data-dir=${profile}`, '--enable-automation']);
  const personal = fakeChrome([`--user-data-dir=${other}`]);
  // A profile whose path only starts with the test profile's path is a different profile.
  const lookalike = fakeChrome([`--user-data-dir=${profile}-personal`]);
  t.after(() => [testMain, personal, lookalike].forEach((c) => alive(c) && c.kill('SIGKILL')));
  await settle();

  const res = run(profile);
  await settle();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /closed 1 test browser process/);
  assert.equal(alive(testMain), false, 'test-profile browser should be stopped');
  assert.equal(alive(personal), true, 'other profile must not be touched');
  assert.equal(alive(lookalike), true, 'a profile with a longer path must not be touched');
});

test('signals only the main process, not Chrome helper processes', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'bta-profile-'));
  const helper = fakeChrome(['--type=renderer', `--user-data-dir=${profile}`]);
  t.after(() => alive(helper) && helper.kill('SIGKILL'));
  await settle();

  const res = run(profile);
  await settle();

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no test browser running/);
  assert.equal(alive(helper), true, 'helpers exit with their main process; never signal them directly');
});

test('reports nothing to close and exits 0 when no test browser runs', () => {
  const res = run(mkdtempSync(join(tmpdir(), 'bta-profile-')));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no test browser running/);
});
