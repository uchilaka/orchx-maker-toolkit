#!/usr/bin/env node
// Fetch a PR's review threads and top-level comments for /pr-triage, normalize
// them into one list of threads, and split that into what needs triage and what
// to skip (with a reason). Behavior is pinned by scripts/pr_triage.test.cjs.
//
// Usage: threads.cjs [pr-number] [--route-only | --fix]
//   Prints {repo, pr, url, viewer, prAuthor, mode, toTriage[], skipped[]} as JSON.
//   mode is 'fix' or 'route-only'; see chooseMode.
//
// Exit codes:
//   0 - JSON printed to stdout
//   1 - both --route-only and --fix given
//   2 - no open PR for the current branch (and none given)
//   3 - gh or jq missing, gh unauthenticated, or a GitHub API call failed
//   4 - no 'origin' remote, or it isn't a github.com remote

const { spawnSync } = require('child_process');

const MARKER = '<!-- pr-triage:handled -->';
// Any pr-triage marker (plain or issue=<id>), plus the one /pr-comment-triage
// left before it was folded into this skill, so already-handled threads stay
// skipped across the switch.
const HANDLED = /<!-- (pr-triage:handled(?: issue=\d+)?|pr-comment-triage:handled) -->/;

function issueMarker(commentId) {
  return `<!-- pr-triage:handled issue=${commentId} -->`;
}

// GitHub reports bot authors as __typename "Bot" (GraphQL) or type "Bot" (REST);
// some apps only show it in the "[bot]" login suffix.
function isBotAuthor(author) {
  if (!author) return false;
  return author.__typename === 'Bot' || author.type === 'Bot' || /\[bot\]$/.test(author.login || '');
}

function normalize(graphql, issueComments = []) {
  const pr = graphql.data.repository.pullRequest;
  const review = pr.reviewThreads.nodes.map((t) => {
    const comments = t.comments.nodes.map((c) => ({
      id: c.databaseId,
      author: c.author ? c.author.login : 'ghost',
      isBot: isBotAuthor(c.author),
      body: c.body,
      url: c.url,
      createdAt: c.createdAt,
    }));
    return {
      id: t.id,
      kind: 'review',
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      rootCommentId: comments[0] ? comments[0].id : null,
      url: comments[0] ? comments[0].url : null,
      author: comments[0] ? comments[0].author : null,
      isBot: comments[0] ? comments[0].isBot : false,
      comments,
    };
  });
  // Top-level comments have no threading, so each one is its own thread.
  const issue = issueComments.map((c) => {
    const comment = {
      id: c.id,
      author: c.user ? c.user.login : 'ghost',
      isBot: isBotAuthor(c.user),
      body: c.body,
      url: c.html_url,
      createdAt: c.created_at,
    };
    return {
      id: `IC_${c.id}`,
      kind: 'issue',
      path: null,
      line: null,
      isResolved: false,
      isOutdated: false,
      rootCommentId: c.id,
      url: c.html_url,
      author: comment.author,
      isBot: comment.isBot,
      comments: [comment],
    };
  });
  return [...review, ...issue];
}

// A CI or app status message is not review feedback. Judged by content, never by
// author alone: a bot that reviews code gets triaged like a human.
function isCiStatus(thread) {
  if (thread.kind !== 'issue' || !thread.isBot) return false;
  const body = thread.comments[0].body || '';
  return /\/actions\/runs\/\d+/.test(body) || /^\W*(claude )?encountered an error/i.test(body);
}

function filter(threads) {
  const answeredIssues = new Set();
  for (const t of threads) {
    for (const c of t.comments) {
      for (const m of (c.body || '').matchAll(/<!-- pr-triage:handled issue=(\d+) -->/g)) {
        answeredIssues.add(Number(m[1]));
      }
    }
  }
  const toTriage = [];
  const skipped = [];
  for (const t of threads) {
    let reason = null;
    if (t.isResolved) reason = 'resolved';
    else if (t.comments.some((c) => HANDLED.test(c.body || ''))) reason = 'handled';
    else if (t.kind === 'issue' && answeredIssues.has(t.rootCommentId)) reason = 'handled';
    else if (isCiStatus(t)) reason = 'ci-status';
    if (reason) skipped.push({ id: t.id, url: t.url, reason });
    else toTriage.push(t);
  }
  return { toTriage, skipped };
}

// Whether this run may edit code. On my own PR it fixes; on anyone else's it only
// routes (tickets, plans, replies), because pushing to a teammate's branch is
// their call. --route-only and --fix override the default.
function chooseMode({ prAuthor, viewer, flags = [] }) {
  const routeOnly = flags.includes('--route-only');
  const fix = flags.includes('--fix');
  if (routeOnly && fix) throw new Error('pass --route-only or --fix, not both');
  if (routeOnly) return 'route-only';
  if (fix) return 'fix';
  return prAuthor === viewer ? 'fix' : 'route-only';
}

// --- CLI -----------------------------------------------------------------------

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) {
            nodes { databaseId author { __typename login } body url createdAt }
          }
        }
      }
    }
  }
}`;

function die(code, message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function gh(args, failCode = 3) {
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) die(3, 'gh CLI not installed');
  if (res.status !== 0) die(failCode, `gh ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const given = args.find((a) => !a.startsWith('--'));
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) die(4, "no 'origin' remote found in this repo");
  if (!remote.stdout.includes('github.com')) die(4, `origin remote (${remote.stdout.trim()}) is not a GitHub remote`);
  if (spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status !== 0) {
    die(3, "gh CLI not installed or not authenticated (run 'gh auth login')");
  }

  const view = given ? ['pr', 'view', given] : ['pr', 'view'];
  const meta = JSON.parse(gh([...view, '--json', 'number,author'], 2));
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  const [owner, name] = repo.split('/');
  const viewer = gh(['api', 'user', '-q', '.login']).trim();

  // Page through review threads; merge the pages into one response shape.
  let after = null;
  let merged = null;
  do {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`,
      '-F', `number=${meta.number}`];
    if (after) args.push('-F', `after=${after}`);
    const page = JSON.parse(gh(args));
    const pr = page.data.repository.pullRequest;
    if (!merged) merged = page;
    else merged.data.repository.pullRequest.reviewThreads.nodes.push(...pr.reviewThreads.nodes);
    after = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (after);

  const issueComments = JSON.parse(gh(['api', `repos/${repo}/issues/${meta.number}/comments`, '--paginate',
    '--slurp'])).flat();

  const prAuthor = meta.author.login;
  let mode;
  try {
    mode = chooseMode({ prAuthor, viewer, flags });
  } catch (e) {
    die(1, e.message);
  }
  const { toTriage, skipped } = filter(normalize(merged, issueComments));
  const pr = merged.data.repository.pullRequest;
  process.stdout.write(`${JSON.stringify({ repo, pr: pr.number, url: pr.url, viewer, prAuthor, mode, toTriage, skipped }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { MARKER, issueMarker, normalize, filter, chooseMode };
