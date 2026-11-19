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

test('no tools or model key, so the agent inherits everything including Agent', () => {
  assert.ok(!('tools' in fm));
  assert.ok(!('model' in fm));
});

test('PreToolUse hook runs the usage guard on every tool', () => {
  const entry = fm.hooks.PreToolUse[0];
  assert.strictEqual(entry.matcher, '*');
  const hook = entry.hooks[0];
  assert.strictEqual(hook.type, 'command');
  assert.strictEqual(hook.command,
    '"$HOME/.claude/skills/agentic-backlog-worker/scripts/usage-guard.mjs"');
});

test('hook command resolves to an existing executable file in this skill', () => {
  const cmd = fm.hooks.PreToolUse[0].hooks[0].command.replace(/^"|"$/g, '');
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
