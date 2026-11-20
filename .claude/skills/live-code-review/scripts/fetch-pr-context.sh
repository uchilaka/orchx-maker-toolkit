#!/usr/bin/env bash
# Fetch PR/MR metadata + diff for /live-code-review.
# Auto-detects GitHub (gh) vs GitLab (glab) from the origin remote.
# Usage: fetch-pr-context.sh [pr-or-mr-number]
#
# Exit codes:
#   0  - found metadata + diff, printed to stdout
#   2  - no open PR/MR found for the current branch (and none given)
#   3  - required CLI (gh/glab) not installed or not authenticated
#   4  - could not determine host (remote isn't github.com or gitlab.*)

set -euo pipefail

NUMBER="${1:-}"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$REMOTE_URL" ]]; then
  echo "ERROR: no 'origin' remote found in this repo" >&2
  exit 4
fi

if [[ "$REMOTE_URL" == *github.com* ]]; then
  HOST="github"
elif [[ "$REMOTE_URL" == *gitlab* ]]; then
  HOST="gitlab"
else
  echo "ERROR: origin remote ($REMOTE_URL) is neither GitHub nor GitLab" >&2
  exit 4
fi

if [[ "$HOST" == "github" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: gh CLI not installed (required for GitHub remotes)" >&2
    exit 3
  fi

  JSON_FIELDS="number,title,url,headRefName,baseRefName,body,state,isDraft"

  if [[ -n "$NUMBER" ]]; then
    METADATA="$(gh pr view "$NUMBER" --json "$JSON_FIELDS" 2>/dev/null || true)"
  else
    METADATA="$(gh pr view --json "$JSON_FIELDS" 2>/dev/null || true)"
  fi

  if [[ -z "$METADATA" ]]; then
    echo "ERROR: no open PR found for the current branch (or number given)" >&2
    exit 2
  fi

  PR_NUMBER="$(echo "$METADATA" | grep -o '"number":[0-9]*' | grep -o '[0-9]*')"
  DIFF="$(gh pr diff "$PR_NUMBER")"
else
  if ! command -v glab >/dev/null 2>&1; then
    echo "ERROR: glab CLI not installed (required for GitLab remotes)" >&2
    exit 3
  fi

  if [[ -n "$NUMBER" ]]; then
    METADATA="$(glab mr view "$NUMBER" -F json 2>/dev/null || true)"
    DIFF="$(glab mr diff "$NUMBER" 2>/dev/null || true)"
  else
    METADATA="$(glab mr view -F json 2>/dev/null || true)"
    DIFF="$(glab mr diff 2>/dev/null || true)"
  fi

  if [[ -z "$METADATA" ]]; then
    echo "ERROR: no open MR found for the current branch (or number given)" >&2
    exit 2
  fi
fi

echo "=== METADATA (host: $HOST) ==="
echo "$METADATA"
echo "=== DIFF ==="
echo "$DIFF"
