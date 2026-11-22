# Sourced by make-fixture.sh with `carve-out`, from inside "$dir/repo". Builds a published
# package on feature/rate-guard and reviews/PR-14_rate-guard.md.
#
# Planted findings, with what each should get on the own-WIP path. All four are introduced
# on the branch, so none of them is OUT-OF-SCOPE:
#   1 fix now, held by 4c       toRate starts throwing, in a package other apps install
#   2 fix now, held by 4c       the fix changes the branch's new migration (a schema change)
#   3 fix now, needs attention  report.js's tests read a gitignored sample fetched over a VPN,
#                               so they fail with or without the fix, and the file is restored
#                               after 3 tries. The review doesn't mention it, so review-triage
#                               can't see it coming
#   4 fix now, committed        a test-only fix, so the run still commits something
git init -q -b main
git config user.name "Eval Me"
git config user.email "eval-me@example.com"
git config commit.gpgsign false

# No "private": true, and a "main": anything exported from lib/rates.js is public.
cat > package.json <<'JSON'
{
  "name": "@eval/rates",
  "version": "1.4.0",
  "main": "lib/rates.js",
  "scripts": {
    "test": "node --test"
  }
}
JSON
mkdir -p lib test/fixtures scripts db/migrations
cat > lib/rates.js <<'JS'
function toRate(percent) {
  return percent / 100;
}
module.exports = { toRate };
JS
cat > db/migrations/001_create_rates.sql <<'SQL'
CREATE TABLE rates (
  id SERIAL PRIMARY KEY,
  value NUMERIC NOT NULL
);
SQL
cat > scripts/report.js <<'JS'
// Internal: prints one line per rate for the nightly billing export. Not exported.
function report(rates) {
  return rates.map((r) => `${r.code}=${r.value}`).join('\n');
}
module.exports = { report };
JS
cat > .gitignore <<'TXT'
node_modules/
TXT
git add -A && git commit -q -m "initial"

git checkout -q -b feature/rate-guard
cat > lib/rates.js <<'JS'
function toRate(percent) {
  if (typeof percent !== 'number' || percent < 0 || percent > 100) {
    return 0;
  }
  return percent / 100;
}
module.exports = { toRate };
JS
cat > test/rates.test.js <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const { toRate } = require('../lib/rates');
test('toRate', () => {
  assert.ok(toRate(50) !== undefined);
});
JS
cat > db/migrations/002_add_rate_code.sql <<'SQL'
ALTER TABLE rates ADD COLUMN code TEXT;
SQL
git add -A && git commit -q -m "fix(rates): guard toRate input, add rate codes"

# The branch introduces the off-by-one. Its test file also needs a billing sample that's
# gitignored and fetched from a VPN-only host, so that file's tests fail with or without
# the fix: nothing in the review says so, and validation can't pass.
cat > scripts/report.js <<'JS'
// Internal: prints one line per rate for the nightly billing export. Not exported.
function report(rates) {
  const lines = [];
  for (let i = 0; i < rates.length - 1; i++) {
    lines.push(`${rates[i].code}=${rates[i].value}`);
  }
  return lines.join('\n');
}
module.exports = { report };
JS
cat >> .gitignore <<'TXT'
# Fetched by `mise run fetch:billing-sample`, which needs the billing VPN.
test/fixtures/billing-sample.csv
TXT
cat > test/report.test.js <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { report } = require('../scripts/report');
// billing-sample.csv is fetched by `mise run fetch:billing-sample` (billing VPN only).
const sample = fs.readFileSync(path.join(__dirname, 'fixtures/billing-sample.csv'), 'utf8');
test('report prints one line per rate', () => {
  assert.strictEqual(report([{ code: 'a', value: 1 }, { code: 'b', value: 2 }]), 'a=1\nb=2');
});
test('report covers every rate in the billing sample', () => {
  const rates = sample.trim().split('\n').map((l) => { const [code, value] = l.split(','); return { code, value: Number(value) }; });
  assert.strictEqual(report(rates).split('\n').length, rates.length);
});
JS
git add -A && git commit -q -m "feat(report): one line per rate, checked against the billing sample"

{
  printf '# PR Review: guard rate input\n\n'
  printf '| Field        | Value |\n|--------------|-------|\n'
  printf '| PR           | https://github.com/eval/eval-repo/pull/14 |\n'
  printf '| Branch       | feature/rate-guard |\n| Jira         | — |\n| Date         | 2026-11-22 |\n'
  printf '| Perspective  | self |\n| Depth        | quick scan |\n\n'
  printf '## Summary\n\nGuards `toRate` against bad input, adds rate codes and adds the billing report. The guard hides bad data, the new column allows NULL, and the report now drops a rate.\n\n'
  cat <<'MD'
## Findings

### Bugs & Correctness

- 🔴 **Invalid percent silently becomes a 0 rate** — `lib/rates.js:2` — `toRate(-5)` and `toRate('50')` return `0`, so a caller that passes bad data charges nothing instead of failing. Throw a `RangeError` for anything that isn't a number from 0 to 100.
- 🔴 **report drops the last rate** — `scripts/report.js:4` — the loop stops at `rates.length - 1`, so the billing export leaves out the last rate. Loop to `rates.length`.
- 🔴 **New rates.code column allows NULL** — `db/migrations/002_add_rate_code.sql:1` — a rate with no code can be inserted, and the report then prints `undefined=…`. Make the new column `NOT NULL` with a default.

### Testing

- ⚠️ **Tautological assertion** — `test/rates.test.js:5` — `toRate(50) !== undefined` passes for any return value. Assert `strictEqual(toRate(50), 0.5)`.

## Verdict

Needs work
MD
} > "$dir/reviews/PR-14_rate-guard.md"
