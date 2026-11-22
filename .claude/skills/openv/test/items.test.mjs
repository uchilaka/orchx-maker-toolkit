// openv items (plan S4). Run from the repo root:
//   node --test '.claude/skills/openv/test/*.test.mjs'
//
// The stub pass-cli returns value-bearing JSON with a canary in every value
// (note, password, a hidden custom field, an extra field, and a `content` key on
// the listing that the real pass-cli leaves null). openv must print names and
// types only: no canary on stdout or stderr, whatever pass-cli or jq does.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'openv');
// Short, because jq cuts a quoted string to about 10 characters in its error
// messages; a longer canary would hide that its first characters leaked.
const CANARY = 'cnry91';

const LISTING = {
  items: [
    { id: 'i1', share_id: 's', vault_id: 'v', title: 'Stripe', item_type: 'login', state: 'active', content: { note: `${CANARY}-list` } },
    { id: 'i2', share_id: 's', vault_id: 'v', title: 'Deploy key', item_type: 'custom', state: 'active' },
  ],
  folders: [],
};

const ITEM = {
  item: {
    id: 'i1',
    content: {
      title: 'Stripe',
      note: `${CANARY}-note`,
      content: {
        Login: { username: `${CANARY}-user`, email: '', password: `${CANARY}-password`, totp_uri: '', urls: [`https://${CANARY}.example`] },
      },
      extra_fields: [{ name: 'API_KEY', content: { Hidden: `${CANARY}-extra` } }],
    },
  },
};

const CUSTOM = {
  item: {
    content: {
      note: '',
      content: {
        Custom: { sections: [{ section_name: 'Prod', section_fields: [{ name: 'TOKEN', content: { Hidden: `${CANARY}-hidden` } }, { name: 'REGION', content: { Text: `${CANARY}-text` } }] }] },
      },
    },
  },
};

// Mimics `pass-cli item list <vault> --output json` and
// `pass-cli item view --vault-name V --item-title T --output json`.
// PASS_MODE picks a failure: `fail` (exit 1, canary on stderr), `garbage`
// (a bare JSON string holding the canary, so the jq filter errors on it), or
// `shape` (an item whose content is a string, which jq's error message quotes).
const STUB = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['PASS_CALLS'], 'a') as f:
  f.write(' '.join(args) + '\\n')
mode = os.environ.get('PASS_MODE', '')
if mode == 'fail':
  sys.stderr.write('error near ${CANARY}-stderr\\n'); sys.exit(1)
if mode == 'garbage':
  print(json.dumps('${CANARY}-garbage')); sys.exit(0)
if mode == 'shape':
  print(json.dumps({'items': '${CANARY}-shape', 'item': {'content': {'content': '${CANARY}-shape'}}})); sys.exit(0)
if args[:2] == ['item', 'list']:
  print(json.dumps(${JSON.stringify(LISTING)})); sys.exit(0)
if args[:2] == ['item', 'view']:
  title = args[args.index('--item-title') + 1]
  print(json.dumps(${JSON.stringify(CUSTOM)} if title == 'Deploy key' else ${JSON.stringify(ITEM)})); sys.exit(0)
sys.stderr.write('unexpected: ' + ' '.join(args) + '\\n'); sys.exit(2)
`;

function sandbox(t, { vaults = 'Work\nPersonal\n' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'openv-s4-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'pass-cli.calls');
  for (const d of [config, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, 'pass-cli'), STUB);
  chmodSync(path.join(bin, 'pass-cli'), 0o755);
  if (vaults !== null) writeFileSync(path.join(config, 'vaults'), vaults);
  const run = (args, env = {}) => spawnSync('bash', [SCRIPT, 'items', ...args], {
    cwd: root, encoding: 'utf8',
    env: { HOME: root, PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin`, OPENV_CONFIG_DIR: config, PASS_CALLS: calls, ...env },
  });
  const passCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { run, passCalls };
}

const noCanary = (r) => {
  assert.ok(!r.stdout.includes(CANARY), `stdout leaked: ${r.stdout}`);
  assert.ok(!r.stderr.includes(CANARY), `stderr leaked: ${r.stderr}`);
};

test('items lists titles and types in every allowed vault, and nothing else', (t) => {
  const s = sandbox(t);
  const r = s.run([]);
  assert.strictEqual(r.status, 0, r.stderr);
  noCanary(r);
  assert.strictEqual(r.stdout, 'Work\tlogin\tStripe\nWork\tcustom\tDeploy key\nPersonal\tlogin\tStripe\nPersonal\tcustom\tDeploy key\n');
  assert.deepStrictEqual(s.passCalls(), ['item list Work --output json', 'item list Personal --output json']);
});

test('items --vault lists one allowed vault, and refuses one outside the allowlist without calling pass-cli', (t) => {
  const s = sandbox(t);
  const r = s.run(['--vault', 'Personal']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(s.passCalls(), ['item list Personal --output json']);

  const s2 = sandbox(t);
  const denied = s2.run(['--vault', 'Secrets']);
  assert.strictEqual(denied.status, 1);
  assert.match(denied.stderr, /"Secrets" isn't in the vault allowlist/);
  assert.deepStrictEqual(s2.passCalls(), []);
});

test('items refuses when no vaults are allowed', (t) => {
  const s = sandbox(t, { vaults: null });
  const r = s.run([]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no vaults allowed/);
  assert.deepStrictEqual(s.passCalls(), []);
});

test('items --fields prints a login item\'s field names and types, never values', (t) => {
  const s = sandbox(t);
  const r = s.run(['--fields', 'Work/Stripe']);
  assert.strictEqual(r.status, 0, r.stderr);
  noCanary(r);
  // Empty login fields (email, totp_uri) are left out.
  assert.strictEqual(r.stdout, 'note\tnote\nusername\tlogin\npassword\tlogin\nurls\tlogin\nAPI_KEY\tHidden\n');
  assert.deepStrictEqual(s.passCalls(), ['item view --vault-name Work --item-title Stripe --output json']);
});

test('items --fields prints custom section fields by name and type', (t) => {
  const s = sandbox(t);
  const r = s.run(['--fields', 'Work/Deploy key']);
  assert.strictEqual(r.status, 0, r.stderr);
  noCanary(r);
  assert.strictEqual(r.stdout, 'TOKEN\tHidden\nREGION\tText\n');
});

test('items --fields refuses a vault outside the allowlist, and a malformed ref, without calling pass-cli', (t) => {
  const s = sandbox(t);
  for (const ref of ['Secrets/Stripe', 'Stripe', 'Work/', '/Stripe']) {
    const r = s.run(['--fields', ref]);
    assert.strictEqual(r.status, 1, ref);
  }
  assert.deepStrictEqual(s.passCalls(), []);
});

test('items shows nothing from pass-cli or jq when either fails', (t) => {
  const s = sandbox(t);
  for (const mode of ['fail', 'garbage', 'shape']) for (const args of [[], ['--fields', 'Work/Stripe']]) {
    const r = s.run(args, { PASS_MODE: mode });
    assert.strictEqual(r.status, 1, `${mode} ${args}`);
    noCanary(r);
    assert.match(r.stderr, /openv: couldn't/);
  }
});

test('items rejects unknown options and --vault with --fields', (t) => {
  const s = sandbox(t);
  assert.strictEqual(s.run(['--json']).status, 1);
  assert.strictEqual(s.run(['--vault']).status, 1);
  assert.strictEqual(s.run(['--vault', 'Work', '--fields', 'Work/Stripe']).status, 1);
  assert.deepStrictEqual(s.passCalls(), []);
});
