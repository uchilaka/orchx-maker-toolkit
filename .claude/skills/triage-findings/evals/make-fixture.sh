#!/usr/bin/env bash
# Builds a throwaway fixture for the triage-findings evals:
#   <dir>/repo     a git repo on feature/discount-fix with five planted findings
#   <dir>/reviews  three review docs over the same findings: PR 12 (mine),
#                  PR 13 (a teammate's) and a branch-only review
#   <dir>/bin/gh   a fake gh that answers only what the skill asks. Put <dir>/bin first
#                  on PATH so no eval reaches GitHub. "Me" is eval-me.
# No remote is configured, so nothing an eval does can be pushed.
#
# With `carve-out` as the second argument it builds a different repo instead: a published
# package (no "private": true) on feature/rate-guard, with findings that step 4c must hold
# and one whose fix can't pass validation, plus reviews/PR-14_rate-guard.md (mine).
#
# Usage: make-fixture.sh <empty-or-new-dir> [carve-out]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"

dir="${1:?usage: make-fixture.sh <dir> [carve-out]}"
scenario="${2:-discount}"
case "$scenario" in discount|carve-out) ;; *) echo "make-fixture.sh: unknown scenario $scenario" >&2; exit 1 ;; esac
if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
  echo "make-fixture.sh: $dir is not empty" >&2
  exit 1
fi
mkdir -p "$dir/repo" "$dir/reviews" "$dir/bin"
dir="$(cd "$dir" && pwd -P)"

# --- fake gh ----------------------------------------------------------------------------
# Answers `gh api user` and `gh pr view 12|13`, honouring -q/--jq through jq. Anything
# else fails loudly, so an eval that reaches for another gh call shows up in its report.
cat > "$dir/bin/gh" <<'GH'
#!/usr/bin/env bash
filter=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--jq) filter="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
pr() { # $1 number, $2 author login
  printf '{"number":%s,"author":{"login":"%s"},"title":"Fix discount edge cases","body":"Tightens Discount.apply.","headRefName":"feature/discount-fix","url":"https://github.com/eval/eval-repo/pull/%s"}\n' "$1" "$2" "$1"
}
case "${args[*]}" in
  "api user"*)   out='{"login":"eval-me"}' ;;
  "pr view 12"*) out="$(pr 12 eval-me)" ;;
  "pr view 13"*) out="$(pr 13 teammate-dev)" ;;
  "pr view 14"*) out="$(pr 14 eval-me | sed 's/Fix discount edge cases/Guard rate input/; s/Tightens Discount.apply./Validates rates in the published rates package./; s#feature/discount-fix#feature/rate-guard#')" ;;
  *) echo "fake gh: unsupported in the eval fixture: gh ${args[*]}" >&2; exit 1 ;;
esac
if [ -n "$filter" ]; then printf '%s\n' "$out" | jq -r "$filter"; else printf '%s\n' "$out"; fi
GH
chmod +x "$dir/bin/gh"

# --- repo -------------------------------------------------------------------------------
cd "$dir/repo"
if [ "$scenario" = carve-out ]; then
  # shellcheck source=carve-out-fixture.sh
  . "$here/carve-out-fixture.sh"
  echo "$dir"
  exit 0
fi
git init -q -b main
git config user.name "Eval Me"
git config user.email "eval-me@example.com"
git config commit.gpgsign false

cat > package.json <<'EOF'
{
  "name": "eval-repo",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
EOF
mkdir -p lib test
cat > lib/format.js <<'EOF'
function formatPrice(n) {
  return `$${n.toFixed(2)}`;
}
module.exports = { formatPrice };
EOF
cat > lib/discount.js <<'EOF'
function apply(price, percent) {
  return price - (price * percent) / 100;
}
module.exports = { apply };
EOF
cat > lib/checkout.js <<'EOF'
const { apply } = require('./discount');
const { formatPrice } = require('./format');
function total(price, percent) {
  return formatPrice(apply(price, percent));
}
module.exports = { total };
EOF
cat > test/checkout.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const { total } = require('../lib/checkout');
test('total', () => {
  assert.strictEqual(total(100, 10), '$90.00');
});
EOF
cat > .gitignore <<'EOF'
node_modules/
EOF
git add -A && git commit -q -m "initial"

git checkout -q -b feature/discount-fix
cat > lib/discount.js <<'EOF'
function apply(price, percent) {
  if (typeof percent === 'number') {
    if (percent >= 0) {
      if (percent <= 100) {
        return price - (price * percent) / 100;
      } else {
        return price;
      }
    } else {
      return price;
    }
  } else {
    return price;
  }
}
module.exports = { apply };
EOF
cat > test/discount.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const { apply } = require('../lib/discount');
test('apply', () => {
  assert.ok(apply(100, 10));
});
EOF
git add -A && git commit -q -m "fix(discount): guard percent input"

# --- review docs ------------------------------------------------------------------------
# Planted findings, with the verdict each should get on the own-WIP path:
#   1 VALID, fix now        invalid percent silently returns the full price
#   2 VALID, fix now        the new test asserts truthiness, not the value
#   3 ALREADY-FIXED         formatPrice already rounds to 2dp
#   4 dismiss / defer       nested if pyramid
#   5 VALID but carved out  renaming apply changes a public interface
findings() {
  cat <<'EOF'
## Findings

### Bugs & Correctness

- 🔴 **Invalid percent silently returns the full price** — `lib/discount.js:2` — a negative, over-100 or non-numeric `percent` returns `price` unchanged, so a bad input looks like "no discount" instead of failing. Throw a `RangeError` instead.
- ⚠️ **formatPrice doesn't round** — `lib/format.js:2` — `formatPrice(1/3)` would print every digit. Round to two decimal places.

### Testing

- ⚠️ **Tautological assertion** — `test/discount.test.js:5` — `assert.ok(apply(100, 10))` passes for any non-zero result. Assert `strictEqual(apply(100, 10), 90)`, and cover an invalid percent.

### Architecture

- ⚠️ **`apply` is too generic a name** — `lib/discount.js:1` — rename it to `applyDiscount`, and update its callers (`lib/checkout.js`) and tests.

### Style

- 🟢 **Nested if pyramid** — `lib/discount.js:2-14` — three levels of `if`/`else` that all return `price`. One guard clause reads better.

### Praise

- 🎉 **Input guarded at all** — `lib/discount.js:2` — the old version accepted anything.
EOF
}
doc() { # $1 file, $2 PR row value
  {
    printf '# PR Review: fix discount edge cases\n\n'
    printf '| Field        | Value |\n|--------------|-------|\n'
    printf '| PR           | %s |\n' "$2"
    printf '| Branch       | feature/discount-fix |\n| Jira         | — |\n| Date         | 2026-11-20 |\n'
    printf '| Perspective  | self |\n| Depth        | quick scan |\n\n'
    printf '## Summary\n\nGuards `apply` against bad input; the guard and its test need work.\n\n'
    findings
    printf '\n## Verdict\n\nShip with fixes\n'
  } > "$dir/reviews/$1"
}
doc PR-12_discount-fix.md "https://github.com/eval/eval-repo/pull/12"
doc PR-13_discount-fix.md "https://github.com/eval/eval-repo/pull/13"
doc branch-review_discount-fix.md "branch-only"

echo "$dir"
