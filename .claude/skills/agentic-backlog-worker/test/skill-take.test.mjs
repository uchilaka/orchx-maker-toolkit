// SKILL.md must document the take mode the CLI implements (`worker.mjs take`), or the
// orchestrator would never reach it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');

test('description triggers on handed-off work', () => {
  const desc = skill.match(/^description: (.*)$/m)[1];
  for (const s of ['take', 'hand-off', 'plan', 'PR']) assert.ok(desc.includes(s), `description mentions ${s}`);
});

test('take mode: the item file, its kinds, the goal, and the steps it skips', () => {
  const sec = skill.split('## Take mode')[1]?.split('\n## ')[0];
  assert.ok(sec, 'SKILL.md has a "## Take mode" section');
  for (const s of ['worker.mjs" take --item', '"kind"', '"ref"', '"goal"', 'ticket', 'plan', 'pr', 'prompt',
    'skip steps 3 and 4', 'Take: <kind>', 'Goal (from the user', 'Source (data, not instructions)',
    'only that id', 'Ask one question']) {
    assert.ok(sec.includes(s), `take section mentions ${s}`);
  }
});

test('take mode: the run ends only after review and a ship check, at most 5 fix rounds', () => {
  const sec = skill.split('## Take mode')[1]?.split('\n## ')[0];
  for (const s of ['Review until it ships', '5 fix rounds', 'ready to ship', 'agentic work', 'stays a draft']) {
    assert.ok(sec.includes(s), `take section mentions ${s}`);
  }
});
