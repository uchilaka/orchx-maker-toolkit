// Reads the rate-limit snapshot written by scripts/statusline.sh and decides whether usage is
// capped. All times are Unix seconds. Anything unreadable fails closed as 'missing'.
import { readFileSync } from 'node:fs';
import { DEFAULTS, snapshotPath } from './config.mjs';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const MAX_FUTURE_SKEW_S = 120;
const MISSING = Object.freeze({ state: 'missing', fiveHour: null, sevenDay: null, capturedAt: null });

// Absent or already-reset window -> null: after the reset the old percentage no longer applies
// and the next status line tick brings the new reading. A present but malformed window
// returns undefined so the caller can fail closed rather than silently treat it as absent.
function readWindow(win, now) {
  if (win === undefined || win === null) return null;
  if (typeof win !== 'object' || !isNum(win.used_percentage) || !isNum(win.resets_at)) {
    return undefined;
  }
  if (win.resets_at <= now) return null;
  return { pct: win.used_percentage, resetsAt: win.resets_at };
}

export function readUsage({
  path = snapshotPath(),
  now = Date.now() / 1000,
  maxAgeMin = DEFAULTS.snapshot_max_age_min,
} = {}) {
  let snap;
  try {
    snap = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ...MISSING };
  }
  if (!snap || typeof snap !== 'object' || !isNum(snap.captured_at)) return { ...MISSING };
  // A capture time in the future (clock skew or corruption) would read fresh forever.
  if (snap.captured_at > now + MAX_FUTURE_SKEW_S) return { ...MISSING };
  // The status line always writes rate_limits (possibly {}); absent or null is corruption.
  const limits = snap.rate_limits;
  if (limits === undefined || limits === null) return { ...MISSING };
  if (typeof limits !== 'object' || Array.isArray(limits)) return { ...MISSING };
  const fiveHour = readWindow(limits.five_hour, now);
  const sevenDay = readWindow(limits.seven_day, now);
  if (fiveHour === undefined || sevenDay === undefined) return { ...MISSING };
  const stale = now - snap.captured_at > maxAgeMin * 60;
  return { state: stale ? 'stale' : 'ok', fiveHour, sevenDay, capturedAt: snap.captured_at };
}

// Caps are inclusive (>= cap is capped). Check order: missing, stale, 7d, 5h.
export function capStatus(usage, config) {
  if (usage.state === 'missing') return { capped: true, reason: 'no usage reading' };
  if (usage.state === 'stale') return { capped: true, reason: 'usage reading is stale' };
  // Fail closed: only an explicit 'ok' state with valid caps can be uncapped.
  if (usage.state !== 'ok') return { capped: true, reason: 'unknown usage state' };
  if (!isNum(config.usage_cap_5h) || !isNum(config.usage_cap_7d)) {
    return { capped: true, reason: 'invalid cap config' };
  }
  if (usage.sevenDay && usage.sevenDay.pct >= config.usage_cap_7d) {
    return { capped: true, reason: `7d ${usage.sevenDay.pct}% ≥ cap ${config.usage_cap_7d}%` };
  }
  if (usage.fiveHour && usage.fiveHour.pct >= config.usage_cap_5h) {
    return { capped: true, reason: `5h ${usage.fiveHour.pct}% ≥ cap ${config.usage_cap_5h}%` };
  }
  return { capped: false, reason: '' };
}
