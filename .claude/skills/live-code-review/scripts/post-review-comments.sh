#!/usr/bin/env bash
# Post a line-anchored review to a GitHub PR or GitLab MR for /live-code-review.
# Claude prepares the payload (deciding which findings can be line-anchored vs.
# folded into the summary body) — this script's only job is the mechanical POST.
#
# Usage:
#   GitHub: post-review-comments.sh github <owner/repo> <pr-number> <payload.json>
#   GitLab: post-review-comments.sh gitlab <project-path-or-id> <mr-number> <payload.json>
#
# GitHub payload.json shape (GitHub Pull Request Reviews API):
#   {
#     "body": "<overall summary, e.g. findings that couldn't be line-anchored>",
#     "event": "COMMENT",
#     "comments": [
#       {"path": "discount.rb", "line": 9, "side": "RIGHT", "body": "..."}
#     ]
#   }
#
# GitLab payload.json shape (one discussion per finding — GitLab has no batch-review
# endpoint, so this script loops and POSTs each discussion individually):
#   {
#     "body": "<overall summary comment posted first, via glab mr note>",
#     "discussions": [
#       {"path": "discount.rb", "line": 9, "body": "..."}
#     ]
#   }
#
# Exit codes:
#   0 - posted successfully
#   1 - bad arguments
#   2 - required CLI (gh/glab) not installed or not authenticated
#   3 - API call failed (see stderr for the CLI's own error output)

set -euo pipefail

HOST="${1:-}"
REPO_OR_PROJECT="${2:-}"
NUMBER="${3:-}"
PAYLOAD="${4:-}"

if [[ -z "$HOST" || -z "$REPO_OR_PROJECT" || -z "$NUMBER" || -z "$PAYLOAD" ]]; then
  echo "Usage: post-review-comments.sh <github|gitlab> <repo-or-project> <number> <payload.json>" >&2
  exit 1
fi

if [[ ! -f "$PAYLOAD" ]]; then
  echo "ERROR: payload file not found: $PAYLOAD" >&2
  exit 1
fi

if [[ "$HOST" == "github" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: gh CLI not installed" >&2
    exit 2
  fi

  gh api "repos/${REPO_OR_PROJECT}/pulls/${NUMBER}/reviews" \
    --method POST \
    --input "$PAYLOAD" || { echo "ERROR: GitHub review POST failed" >&2; exit 3; }

elif [[ "$HOST" == "gitlab" ]]; then
  if ! command -v glab >/dev/null 2>&1; then
    echo "ERROR: glab CLI not installed" >&2
    exit 2
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required to post GitLab discussions" >&2
    exit 2
  fi

  BODY="$(jq -r '.body // empty' "$PAYLOAD")"
  if [[ -n "$BODY" ]]; then
    glab api "projects/${REPO_OR_PROJECT}/merge_requests/${NUMBER}/notes" \
      --method POST -f "body=${BODY}" >/dev/null \
      || { echo "ERROR: GitLab summary note POST failed" >&2; exit 3; }
  fi

  # GitLab line-anchored discussions require diff_refs from the MR itself.
  DIFF_REFS="$(glab api "projects/${REPO_OR_PROJECT}/merge_requests/${NUMBER}" \
    | jq -c '.diff_refs')"
  BASE_SHA="$(echo "$DIFF_REFS" | jq -r '.base_sha')"
  START_SHA="$(echo "$DIFF_REFS" | jq -r '.start_sha')"
  HEAD_SHA="$(echo "$DIFF_REFS" | jq -r '.head_sha')"

  COUNT="$(jq '.discussions | length' "$PAYLOAD")"
  for i in $(seq 0 $((COUNT - 1))); do
    PATH_VAL="$(jq -r ".discussions[$i].path" "$PAYLOAD")"
    LINE_VAL="$(jq -r ".discussions[$i].line" "$PAYLOAD")"
    COMMENT_BODY="$(jq -r ".discussions[$i].body" "$PAYLOAD")"

    glab api "projects/${REPO_OR_PROJECT}/merge_requests/${NUMBER}/discussions" \
      --method POST \
      -f "body=${COMMENT_BODY}" \
      -f "position[position_type]=text" \
      -f "position[base_sha]=${BASE_SHA}" \
      -f "position[start_sha]=${START_SHA}" \
      -f "position[head_sha]=${HEAD_SHA}" \
      -f "position[new_path]=${PATH_VAL}" \
      -f "position[new_line]=${LINE_VAL}" \
      >/dev/null || { echo "ERROR: GitLab discussion POST failed for ${PATH_VAL}:${LINE_VAL}" >&2; exit 3; }
  done
else
  echo "ERROR: unknown host '$HOST' (expected 'github' or 'gitlab')" >&2
  exit 1
fi

echo "Posted successfully."
