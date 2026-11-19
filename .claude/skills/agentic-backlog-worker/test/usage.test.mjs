import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../lib/config.mjs';
import { readUsage, capStatus } from '../lib/usage.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'abw-usage-'));
let n = 0;
const NOW = 1_800_000_000;
const snap = (obj) => {
  const p = path.join(tmp, `snap-${n++}.json`);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};
const reading = ({ five, seven, age = 60 } = {}) => {
  const rate_limits = {};
  if (five !== undefined) rate_limits.five_hour = { used_percentage: five, resets_at: NOW + 3600 };
  if (seven !== undefined) rate_limits.seven_day = { used_percentage: seven, resets_at: NOW + 86400 };
  return snap({ captured_at: NOW - age, rate_limits });
};
const read = (p, extra = {}) => readUsage({ path: p, now: NOW, maxAgeMin: 15, ...extra });
const cfg = { ...DEFAULTS };

test('a missing file is state missing and capped', () => {
  const u = read(path.join(tmp, 'nope.json'));
  assert.strictEqual(u.state, 'missing');
  assert.strictEqual(u.fiveHour, null);
  const s = capStatus(u, cfg);
  assert.strictEqual(s.capped, true);
  assert.match(s.reason, /no usage reading/);
});

test('invalid JSON is missing, never a throw', () => {
  assert.strictEqual(read(snap('{not json')).state, 'missing');
});

test('a snapshot without a numeric captured_at is missing', () => {
  assert.strictEqual(read(snap({ rate_limits: {} })).state, 'missing');
});

test('16 minutes old with maxAgeMin 15 is stale and capped', () => {
  const u = read(reading({ five: 10, age: 16 * 60 }));
  assert.strictEqual(u.state, 'stale');
  assert.strictEqual(capStatus(u, cfg).capped, true);
});

test('exactly 15 minutes old is ok', () => {
  const u = read(reading({ five: 10, age: 15 * 60 }));
  assert.strictEqual(u.state, 'ok');
  assert.deepStrictEqual(capStatus(u, cfg), { capped: false, reason: '' });
});

test('maps windows to pct and resetsAt', () => {
  const u = read(reading({ five: 40, seven: 20 }));
  assert.deepStrictEqual(u.fiveHour, { pct: 40, resetsAt: NOW + 3600 });
  assert.deepStrictEqual(u.sevenDay, { pct: 20, resetsAt: NOW + 86400 });
  assert.strictEqual(u.capturedAt, NOW - 60);
});

test('5h at 75 is capped with the exact reason, 74 is not', () => {
  const s = capStatus(read(reading({ five: 75 })), cfg);
  assert.strictEqual(s.capped, true);
  assert.strictEqual(s.reason, '5h 75% ≥ cap 75%');
  assert.strictEqual(capStatus(read(reading({ five: 74 })), cfg).capped, false);
});

test('7d at 80 is capped even when 5h is 10', () => {
  const s = capStatus(read(reading({ five: 10, seven: 80 })), cfg);
  assert.strictEqual(s.capped, true);
  assert.strictEqual(s.reason, '7d 80% ≥ cap 75%');
});

test('7d is checked before 5h when both are over', () => {
  assert.match(capStatus(read(reading({ five: 90, seven: 90 })), cfg).reason, /^7d /);
});

test('caps come from config', () => {
  const s = capStatus(read(reading({ five: 50 })), { ...cfg, usage_cap_5h: 50 });
  assert.strictEqual(s.reason, '5h 50% ≥ cap 50%');
});

test('a five_hour window with resets_at <= now reads as null and is not capped by 5h', () => {
  const p = snap({
    captured_at: NOW - 60,
    rate_limits: { five_hour: { used_percentage: 99, resets_at: NOW } },
  });
  const u = read(p);
  assert.strictEqual(u.fiveHour, null);
  assert.strictEqual(u.state, 'ok');
  assert.deepStrictEqual(capStatus(u, cfg), { capped: false, reason: '' });
});

test('a seven_day window with resets_at <= now reads as null too', () => {
  const p = snap({
    captured_at: NOW - 60,
    rate_limits: { seven_day: { used_percentage: 99, resets_at: NOW - 5 } },
  });
  assert.strictEqual(read(p).sevenDay, null);
});

test('absent windows read as null and are not capped', () => {
  const u = read(reading({}));
  assert.strictEqual(u.fiveHour, null);
  assert.strictEqual(u.sevenDay, null);
  assert.strictEqual(capStatus(u, cfg).capped, false);
});

test('maxAgeMin defaults to the config default', () => {
  const p = reading({ five: 1, age: 16 * 60 });
  assert.strictEqual(readUsage({ path: p, now: NOW }).state, 'stale');
});

test('path defaults to snapshotPath() read at call time', () => {
  const saved = process.env.ABW_SNAPSHOT;
  process.env.ABW_SNAPSHOT = reading({ five: 5 });
  try {
    assert.strictEqual(readUsage({ now: NOW }).fiveHour.pct, 5);
  } finally {
    if (saved === undefined) delete process.env.ABW_SNAPSHOT; else process.env.ABW_SNAPSHOT = saved;
  }
});

test('a malformed window (used_percentage "x") is missing', () => {
  const p = snap({
    captured_at: NOW - 60,
    rate_limits: { five_hour: { used_percentage: 'x', resets_at: NOW + 60 } },
  });
  assert.strictEqual(read(p).state, 'missing');
});

test('7d boundary: 75 is capped, 74 is not', () => {
  assert.strictEqual(capStatus(read(reading({ seven: 75 })), cfg).capped, true);
  assert.strictEqual(capStatus(read(reading({ seven: 74 })), cfg).capped, false);
});

test('stale takes precedence over a 90% reading', () => {
  const s = capStatus(read(reading({ five: 90, age: 16 * 60 })), cfg);
  assert.strictEqual(s.capped, true);
  assert.match(s.reason, /stale/);
});

test('a non-object rate_limits is missing (fails closed)', () => {
  for (const bad of ['oops', 5, [1]]) {
    const p = snap({ captured_at: NOW - 60, rate_limits: bad });
    assert.strictEqual(read(p).state, 'missing', JSON.stringify(bad));
  }
});

test('a captured_at in the future is missing, small skew is ok', () => {
  assert.strictEqual(read(reading({ five: 1, age: -121 })).state, 'missing');
  assert.strictEqual(read(reading({ five: 1, age: -120 })).state, 'ok');
  assert.strictEqual(read(snap({ captured_at: '123', rate_limits: {} })).state, 'missing');
});

test('capStatus fails closed on an unknown state and on invalid cap config', () => {
  const ok = read(reading({ five: 1 }));
  const s = capStatus({ ...ok, state: 'bogus' }, cfg);
  assert.deepStrictEqual(s, { capped: true, reason: 'unknown usage state' });
  for (const bad of [{ usage_cap_5h: undefined }, { usage_cap_7d: 'x' }]) {
    assert.deepStrictEqual(capStatus(ok, { ...cfg, ...bad }),
      { capped: true, reason: 'invalid cap config' });
  }
});
