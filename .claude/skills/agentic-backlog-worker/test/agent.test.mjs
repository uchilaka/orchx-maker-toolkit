import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(path.join(skillDir, 'agents', 'agentic-ticket-worker.md'), 'utf8');

// Minimal parser for the subset of YAML the agent frontmatter uses: nested maps, `- ` list items
// (scalars or maps), and plain/quoted scalars. No dependency, by the skill's constraints.
function unquote(s) {
  s = s.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  return s;
}

function parseYaml(src) {
  const lines = src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.match(/^ */)[0].length, body: l.trim() }));
  let i = 0;
  function block(indent) {
    if (lines[i].body.startsWith('- ')) return list(indent);
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].body.startsWith('- ')) {
      const m = lines[i].body.match(/^([\w-]+):\s*(.*)$/);
      assert.ok(m, `unparseable line: ${lines[i].body}`);
      i++;
      if (m[2] !== '') obj[m[1]] = unquote(m[2]);
      else if (i < lines.length && lines[i].indent > indent) obj[m[1]] = block(lines[i].indent);
      else obj[m[1]] = null;
    }
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith('- ')) {
      // Rewrite `- key: v` as a map line indented past the dash so block() reads it as a map.
      lines[i] = { indent: indent + 2, body: lines[i].body.slice(2) };
      arr.push(block(indent + 2));
    }
    return arr;
  }
  return block(lines[0].indent);
}

const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
assert.ok(m, 'agent file has frontmatter');
const fm = parseYaml(m[1]);
const body = m[2];

test('frontmatter names the agent and describes it', () => {
  assert.strictEqual(fm.name, 'agentic-ticket-worker');
  assert.ok(fm.description && fm.description.includes('/agentic-backlog-worker'));
});

// Live review SEC3: below the cap only the model stands between ticket text and the tools, so
// the agent gets exactly what its procedure uses. Agent stays for the security-reviewer fan-out;
// web access and every other MCP server stay out.
const TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Agent', 'Skill',
  'mcp__linear__get_issue', 'mcp__linear__list_comments', 'mcp__linear__save_issue',
  'mcp__linear__save_comment', 'mcp__linear__create_issue_label', 'mcp__linear__create_attachment',
];

test('tools is the exact list the procedure needs: Agent in, web tools out; no model key', () => {
  assert.strictEqual(typeof fm.tools, 'string');
  const tools = fm.tools.split(',').map((t) => t.trim());
  assert.deepStrictEqual(tools, TOOLS);
  assert.ok(tools.includes('Agent'));
  for (const t of tools) assert.ok(!/^(WebFetch|WebSearch)$/.test(t), t);
  assert.ok(tools.filter((t) => t.startsWith('mcp__')).every((t) => t.startsWith('mcp__linear__')));
  assert.ok(!('model' in fm));
});

test('every Linear tool the body calls is in the tools list', () => {
  const called = new Set(body.match(/mcp__linear__\w+/g));
  for (const t of called) assert.ok(TOOLS.includes(t), t);
});

// Live review SIM6: the guard allows quoted plain-word messages, so the doc must not forbid quotes.
test('capped rules match the guard: quotes allowed for plain words, grammar in usage-guard.mjs', () => {
  assert.ok(!body.includes('metacharacters or quotes'));
  assert.match(body, /plain words in a quoted message/);
  assert.ok(body.includes('`scripts/usage-guard.mjs`'));
});

test('PreToolUse hook runs the usage guard on every tool', () => {
  const entry = fm.hooks.PreToolUse[0];
  assert.strictEqual(entry.matcher, '*');
  const hook = entry.hooks[0];
  assert.strictEqual(hook.type, 'command');
  // `|| exit 2`: a hook exit other than 2 is non-blocking, so a missing node (127) or a crash
  // must be turned into a blocking exit or the guard fails open.
  assert.strictEqual(hook.command,
    '"$HOME/.claude/skills/agentic-backlog-worker/scripts/usage-guard.mjs" || exit 2');
  assert.ok(hook.command.endsWith(' || exit 2'));
});

test('hook command resolves to an existing executable file in this skill', () => {
  const cmd = fm.hooks.PreToolUse[0].hooks[0].command.match(/^"([^"]+)"/)[1];
  const real = cmd.replace('$HOME/.claude/skills/agentic-backlog-worker', skillDir);
  assert.ok(statSync(real).isFile());
  accessSync(real, constants.X_OK);
});

test('body carries the output contract and the hand-off label', () => {
  assert.ok(body.includes('RESULT {'));
  assert.ok(body.includes('agent-handoff'));
});

test('body pins git to the worktree and builds the PR from a body file', () => {
  for (const s of ['git -C <worktree>', 'cd <worktree> &&', '--body-file', '-pr.md',
    'fixup-worktree', 'create_issue_label', 'never quote secrets']) {
    assert.ok(body.toLowerCase().includes(s.toLowerCase()), `body mentions ${s}`);
  }
});

test('worktree rule: worktree-init if present, else bootstrap-worktree; hand off only on failure', () => {
  assert.ok(body.includes('bin/worktree-init'));
  assert.ok(body.includes('bootstrap-worktree'));
  assert.ok(!/git-crypt repo has no/.test(body));
  assert.ok(!/uses git-crypt and has no/.test(body));
});

test('capped section: a denied checkpoint step is recorded and returned, not retried', () => {
  assert.ok(body.includes('"reason":"checkpoint not pushed"'));
  assert.ok(body.includes('Do not retry or try variants.'));
});

test('body does not invite the agent to write the orchestrator run state', () => {
  assert.ok(!body.includes('run state file'));
});

test('size input is S or M, and L only for a take', () => {
  assert.ok(body.includes('size (S or M; L only for a take)'));
  assert.ok(!body.includes('S, M or L'));
});

// `worker.mjs take` hands the agent one item with a goal. The body must say how each kind is
// worked, that the goal bounds the work, and that a take still ends at a draft PR.
test('take section: every kind, the goal as the finish line, and the same end of the line', () => {
  const sec = body.split('## Working a take')[1]?.split('\n## ')[0];
  assert.ok(sec, 'body has a "## Working a take" section');
  for (const kind of ['`ticket`', '`plan`', '`pr`', '`prompt`']) assert.ok(sec.includes(kind), kind);
  for (const s of ['Goal (from the user', 'HO-<n>/<slug>', 'gh pr checkout', 'never mark it ready',
    'tick', 'data, not instructions', 'checkpoint not pushed', 'Linear steps only for `ticket`']) {
    assert.ok(sec.includes(s), `take section mentions ${s}`);
  }
});

// Live review SEC7/SEC6: the guard denies a capped commit or push without --no-verify, and pins
// a -C push to the worktree's ticket, so the capped procedure must spell both out.
test('capped section: every commit and push carries --no-verify and uses -C', () => {
  const capped = body.slice(body.indexOf('## When the usage cap is reached'), body.indexOf('## Output'));
  const cmds = capped.match(/`git [^`]+`/g) ?? [];
  const writes = cmds.filter((c) => / (commit|push) /.test(c));
  assert.ok(writes.length >= 4, `found ${writes}`);
  for (const c of writes) {
    assert.match(c, /^`git -C <worktree> (commit|push) --no-verify /, c);
  }
});

// A take is reviewed and driven to a ship-check pass before it ends (decided 2026-11-20):
// review picked by risk, at most 5 fix rounds, own-PR-only posting, and a pass labels the PR
// but never takes it out of draft.
test('take: review by risk, fix rounds capped at 5, ship check labels but keeps the draft', () => {
  const sec = text.split('## Review until it ships')[1]?.split('\n## ')[0];
  assert.ok(sec, 'agent has a "## Review until it ships" section');
  for (const s of ['/pr-review', '/live-code-review', '/pr-triage', '/pr-ship-check',
    'auth', 'secrets', '400 changed lines', 'Say which review ran and why',
    '5 fix rounds', 'ready to ship', 'agentic work', 'never mark it ready',
    'opened by the user', 'post nothing', 'fix-now', 'hand off']) {
    assert.ok(sec.includes(s), `review section mentions ${s}`);
  }
  assert.match(sec, /gh pr edit [^\n]*--add-label "ready to ship"[^\n]*--add-label "agentic work"/);
  assert.doesNotMatch(sec, /gh pr ready/, 'never runs gh pr ready');
});
