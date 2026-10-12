#!/usr/bin/env node
// Post one /pr-triage reply to a GitHub PR, after checking its shape. Claude
// writes the body; this script refuses a body that would break the skill's
// rules, then does the mechanical POST. Behavior is pinned by
// scripts/pr_triage.test.cjs.
//
// Usage:
//   post-reply.cjs review <owner/repo> <pr> <root-comment-id> <body-file> [--dry-run]
//     Reply inside a review thread.
//   post-reply.cjs issue <owner/repo> <pr> <reply-to-comment-id> <author> <body-file> [--dry-run]
//     Answer a top-level comment: the one top-level post the skill may make. The
//     body must quote the original, @-mention its author, and carry
//     issueMarker(<reply-to-comment-id>).
//   Every body must end with footer(<viewer>, <marker>) from threads.cjs; the
//   viewer is the authenticated gh account.
//   --dry-run prints the request instead of sending it.
//
// Exit codes:
//   0 - posted (prints the new comment's URL), or the dry-run request
//   1 - bad arguments, or the body was refused (reasons on stderr)
//   2 - gh missing or unauthenticated (checked before the body, even on --dry-run)
//   3 - the API call failed

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MARKER, issueMarker, footer } = require(path.join(__dirname, 'threads.cjs'));

// The body must end with footer(viewer, <marker>): that covers both the handled
// marker and the attribution, so neither can drift from the one definition.
function checkFooter(errors, body, viewer, marker) {
  if (!viewer) {
    errors.push('the viewer (the gh account posting) is unknown, so the footer cannot be checked');
  } else if (!body.trimEnd().endsWith(footer(viewer, marker))) {
    errors.push(`the reply must end with the footer (handled marker, then attribution):\n${footer(viewer, marker)}`);
  }
}

function validate(kind, body, opts = {}) {
  const errors = [];
  const { viewer } = opts;
  if (kind === 'review') {
    checkFooter(errors, body, viewer, MARKER);
  } else if (kind === 'issue') {
    const { replyTo, author } = opts;
    checkFooter(errors, body, viewer, issueMarker(replyTo));
    if (!/^> \S/m.test(body)) errors.push('a top-level reply must quote the comment it answers');
    if (!new RegExp(`@${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) {
      errors.push(`a top-level reply must @-mention the original author, @${author}`);
    }
  } else {
    errors.push(`unknown reply kind: ${kind}`);
  }
  return { ok: errors.length === 0, errors };
}

function usage() {
  process.stderr.write([
    'Usage:',
    '  post-reply.cjs review <owner/repo> <pr> <root-comment-id> <body-file> [--dry-run]',
    '  post-reply.cjs issue <owner/repo> <pr> <reply-to-comment-id> <author> <body-file> [--dry-run]',
    '',
  ].join('\n'));
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [kind, repo, pr, id, ...rest] = args.filter((a) => a !== '--dry-run');
  if (!['review', 'issue'].includes(kind) || !/^[\w.-]+\/[\w.-]+$/.test(repo || '') ||
      !/^\d+$/.test(pr || '') || !/^\d+$/.test(id || '')) usage();
  const author = kind === 'issue' ? rest[0] : null;
  const bodyFile = kind === 'issue' ? rest[1] : rest[0];
  if (!bodyFile || (kind === 'issue' && !author)) usage();
  if (!fs.existsSync(bodyFile)) {
    process.stderr.write(`ERROR: body file not found: ${bodyFile}\n`);
    process.exit(1);
  }
  const body = fs.readFileSync(bodyFile, 'utf8');

  // Checked before validation, even on --dry-run: the footer must name the
  // account that will actually post.
  if (spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status !== 0) {
    process.stderr.write('ERROR: gh CLI not installed or not authenticated\n');
    process.exit(2);
  }
  const viewer = spawnSync('gh', ['api', 'user', '-q', '.login'], { encoding: 'utf8' }).stdout.trim();

  const res = validate(kind, body, { replyTo: Number(id), author, viewer });
  if (!res.ok) {
    process.stderr.write(`REFUSED:\n${res.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }

  const endpoint = kind === 'review'
    ? `repos/${repo}/pulls/${pr}/comments/${id}/replies`
    : `repos/${repo}/issues/${pr}/comments`;
  const payload = JSON.stringify({ body });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ method: 'POST', endpoint, body }, null, 2)}\n`);
    return;
  }

  // The body goes in on stdin as JSON, never through a shell.
  const post = spawnSync('gh', ['api', endpoint, '--method', 'POST', '--input', '-'],
    { input: payload, encoding: 'utf8' });
  if (post.status !== 0) {
    process.stderr.write(`ERROR: GitHub ${kind} reply failed:\n${post.stderr}`);
    process.exit(3);
  }
  process.stdout.write(`${JSON.parse(post.stdout).html_url}\n`);
}

if (require.main === module) main();

module.exports = { validate };
