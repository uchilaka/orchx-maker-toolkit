#!/usr/bin/env node
// Gather the facts /pr-ship-check judges from: the fix-now gate, and the PR's
// shape. The judgement itself (spin-offs, simplifications, the ship verdict) lives
// in SKILL.md; this script only reports evidence. Behaviour is pinned by
// scripts/pr_ship_check.test.cjs.
//
// Usage: ship-data.cjs [pr-number]
//   Prints {repo, pr, state, url, title, viewer, author, ownWork, base, baseOid, head, headOid, draft,
//   mergeable, mergeState, size, ci[], commits[], files[], gate} as JSON.
//
// Exit codes (the same as pr-triage's threads.cjs):
//   0 - JSON printed (the gate may still have failed: read gate.pass)
//   2 - no open PR: none for the current branch, or the one given is merged or closed
//   3 - gh or git missing, gh unauthenticated, or a GitHub API call failed
//   4 - no 'origin' remote, it isn't a github.com remote, or the PR belongs to
//       another repo (a URL), since the records, threads and posts would not match

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- the gate (pure; tested) --------------------------------------------------

// The fixing commit: "Fixed in <sha>", or "Done <sha>" in a table's status column.
const SHA = /\b(?:Fixed in|Done)\s*`?([0-9a-f]{7,40})\b/i;
const TRIAGE_FIX_NOW = /^\s*[-*]\s+\*\*Triage(?:\*\*:|:\*\*)\s*Fix now\b/i;
const TABLE_SEPARATOR = /^\s*\|[\s|:-]*$/;
// "Fix in PR" as an outcome, but not "Won't fix in PR" or "not fix in PR".
const FIX_IN_PR = /(?<!n't |not )\bFix in PR\b/i;

// A bullet hard-wrapped onto indented lines is one item: the local artifacts keep
// their wrapping, so "Fixed in <sha>" often sits on the line after "Fix now".
function logicalLines(markdown) {
  const out = [];
  let inBullet = false;
  for (const line of markdown.split('\n')) {
    const continuation = inBullet && /^\s+\S/.test(line) && !/^\s*([-*+]\s|\d+\.\s|\||#)/.test(line);
    if (continuation) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
    if (!continuation) inBullet = /^\s*[-*+]\s/.test(line);
  }
  return out;
}

// Fix-now items come in two shapes, and only these count, so prose that happens
// to say "fix now" is never mistaken for an item:
//   - /live-code-review's template:  - **Triage**: Fix now — <why>[ — Fixed in `<sha>`]
//   - a findings table row with a "Fix now" cell, or whose outcome says "Fix in PR"
//     or "Fixed in <sha>". A header row (the one above |---|) is never an item.
// An item without a fixing commit is open, so an unfamiliar outcome fails closed.
function parseFixNow(markdown) {
  const items = [];
  const lines = logicalLines(markdown);
  lines.forEach((line, i) => {
    let format = null;
    if (TRIAGE_FIX_NOW.test(line)) format = 'triage';
    else if (/^\s*\|/.test(line) && !TABLE_SEPARATOR.test(line) && !TABLE_SEPARATOR.test(lines[i + 1] || 'x')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.some((c) => /^Fix now\b/i.test(c)) || FIX_IN_PR.test(line) || SHA.test(line)) format = 'table';
    }
    if (!format) return;
    const m = line.match(SHA);
    items.push({ format, text: line.trim(), sha: m ? m[1].toLowerCase() : null });
  });
  return items;
}

// A Conventional Comments label decides when it carries a decoration:
// "issue (blocking):" blocks, "suggestion (non-blocking):" doesn't, whatever the
// rest of the comment says. Without one, a leading 🛑 or the word "blocker"
// (but not "not a blocker") marks it blocking.
const LABEL = /^[\W_]*[a-z]+\s*\((blocking|non-blocking)\)/i;

function isBlocking(body) {
  const label = body.match(LABEL);
  if (label) return label[1].toLowerCase() === 'blocking';
  return /^[\s*_]*🛑/.test(body) || (/\bblocker\b/i.test(body) && !/\bnot (a )?blocker\b/i.test(body));
}

// Unresolved threads whose opening comment is marked blocking, where nobody but
// that comment's author has replied.
function blockingUnanswered(threads) {
  return threads.filter((t) => {
    if (t.isResolved || !t.comments.length) return false;
    const [first, ...rest] = t.comments;
    if (!isBlocking(first.body)) return false;
    return !rest.some((c) => c.author !== first.author);
  });
}

// A fixing commit counts only if it is one of the PR's own commits. An ancestry
// check would also accept any commit already on the base branch.
function prCommitMatcher(oids) {
  const own = oids.map((o) => o.toLowerCase());
  return (sha) => own.some((o) => o.startsWith(sha.toLowerCase()));
}

function gate({ records, items, onHead, threads, truncated = false }) {
  const reasons = [];
  if (!records.length) reasons.push('no review record in ~/pr-reviews for this PR: run a review first');
  if (truncated) reasons.push('more review threads or comments than one page holds: check the threads by hand');
  const openFixNow = [];
  for (const item of items) {
    if (!item.sha) openFixNow.push({ ...item, reason: 'no fixing commit recorded' });
    else if (!onHead(item.sha)) openFixNow.push({ ...item, reason: `commit ${item.sha} is not on the PR head` });
  }
  if (openFixNow.length) reasons.push(`${openFixNow.length} fix-now item(s) not addressed`);
  const openBlockingThreads = blockingUnanswered(threads);
  if (openBlockingThreads.length) reasons.push(`${openBlockingThreads.length} blocking thread(s) without a reply`);
  return { pass: reasons.length === 0, reasons, records, fixNowItems: items.length, openFixNow, openBlockingThreads };
}

// --- I/O ----------------------------------------------------------------------

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && !allowFail)) {
    const err = new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
    err.exitCode = 3;
    throw err;
  }
  return r;
}

const gh = (args, opts) => run('gh', args, opts);
const git = (args, opts) => run('git', args, opts);

// The main checkout's directory name: the ~/pr-reviews/<project>/ convention,
// shared by every worktree of the repo.
function projectName() {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  return path.basename(common.endsWith('/.git') ? path.dirname(common) : common).replace(/\.git$/, '');
}

function reviewRecords(project, number) {
  const dir = path.join(process.env.PR_REVIEWS_DIR || path.join(os.homedir(), 'pr-reviews'), project);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`(^|_)PR-${number}_`);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && re.test(f) && !f.endsWith('_ship-check.md'))
    .map((f) => path.join(dir, f));
}

// One page only. pr-triage's threads.cjs pages through threads; until this reuses
// it, a PR with more than one page fails the gate rather than hiding threads.
const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
  reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:100){pageInfo{hasNextPage} nodes{author{login} body}}}}}}}`;

const REPO_IN_URL = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

function main() {
  const prArg = process.argv[2];
  const origin = git(['remote', 'get-url', 'origin'], { allowFail: true });
  const originMatch = origin.status === 0 && origin.stdout.trim().match(REPO_IN_URL);
  if (!originMatch) {
    console.error('ship-data: no github.com origin remote');
    process.exit(4);
  }
  const fields = 'number,state,title,url,author,isDraft,mergeable,mergeStateStatus,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles,commits,files,statusCheckRollup';
  const view = gh(['pr', 'view', ...(prArg ? [prArg] : []), '--json', fields], { allowFail: true });
  if (view.status !== 0) {
    if (/no pull requests found|could not resolve/i.test(view.stderr)) {
      console.error(`ship-data: no open PR${prArg ? ` #${prArg}` : ' for this branch'}`);
      process.exit(2);
    }
    const err = new Error(view.stderr.trim()); err.exitCode = 3; throw err;
  }
  const pr = JSON.parse(view.stdout);
  // gh resolves a PR URL in any repo, but the records, threads and posts below
  // are this checkout's, so a PR from elsewhere is refused.
  const repo = (pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//i) || [])[1] || '';
  if (repo.toLowerCase() !== originMatch[1].toLowerCase()) {
    console.error(`ship-data: PR ${pr.url} is not in origin's repo (${originMatch[1]})`);
    process.exit(4);
  }
  if (pr.state !== 'OPEN') {
    console.error(`ship-data: PR #${pr.number} is ${pr.state.toLowerCase()}, not open`);
    process.exit(2);
  }
  const viewer = gh(['api', 'user', '-q', '.login']).stdout.trim();

  // The PR head must be local for the per-commit file lists.
  git(['fetch', '-q', 'origin', `refs/pull/${pr.number}/head`]);
  const onHead = prCommitMatcher(pr.commits.map((c) => c.oid));

  const [owner, name] = repo.split('/');
  const threadsRaw = JSON.parse(gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, '-F', `n=${pr.number}`]).stdout);
  const page = threadsRaw.data.repository.pullRequest.reviewThreads;
  const truncated = page.pageInfo.hasNextPage || page.nodes.some((t) => t.comments.pageInfo.hasNextPage);
  const threads = page.nodes.map((t) => ({
    isResolved: t.isResolved,
    comments: t.comments.nodes.map((c) => ({ author: c.author ? c.author.login : null, body: c.body })),
  }));

  const records = reviewRecords(projectName(), pr.number);
  const items = records.flatMap((f) => parseFixNow(fs.readFileSync(f, 'utf8')).map((i) => ({ ...i, record: f })));

  // A merge of the base branch brings in other PRs' files, not this PR's work, so
  // merges are listed without files.
  const commits = pr.commits.map((c) => {
    const parents = git(['rev-list', '--parents', '-n', '1', c.oid], { allowFail: true }).stdout.trim().split(' ');
    const merge = parents.length > 2;
    const files = merge ? null : git(['show', '--name-only', '--format=', c.oid], { allowFail: true });
    return {
      sha: c.oid.slice(0, 7),
      subject: c.messageHeadline,
      merge,
      files: files && files.status === 0 ? files.stdout.split('\n').filter(Boolean) : [],
    };
  });

  // One entry per check name and outcome, with a count: re-runs and per-event
  // duplicates (a skipped bot workflow per review comment) would bury the signal.
  const ci = [];
  for (const c of pr.statusCheckRollup || []) {
    const entry = { name: c.name || c.context, status: c.status || null, conclusion: c.conclusion || c.state || null };
    const same = ci.find((e) => e.name === entry.name && e.status === entry.status && e.conclusion === entry.conclusion);
    if (same) same.count += 1; else ci.push({ ...entry, count: 1 });
  }

  const out = {
    repo, pr: pr.number, state: pr.state, url: pr.url, title: pr.title, viewer,
    author: pr.author.login, ownWork: pr.author.login === viewer,
    base: pr.baseRefName, baseOid: pr.baseRefOid, head: pr.headRefName, headOid: pr.headRefOid, draft: pr.isDraft,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
    size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
    ci,
    commits,
    files: pr.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    gate: gate({ records, items, onHead, threads, truncated }),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`ship-data: ${e.message}`);
    process.exit(e.exitCode || 3);
  }
}

module.exports = { parseFixNow, blockingUnanswered, prCommitMatcher, gate };
