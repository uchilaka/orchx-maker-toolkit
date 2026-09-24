const fs = require('fs');
const path = require('path');

const SKILLS_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '.claude', 'skills');

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

console.log('🔍 Validating .claude/skills/* as Claude Code skills...\n');

if (!fs.existsSync(SKILLS_DIR)) {
  console.error(`❌ ${SKILLS_DIR} does not exist — run 'mise run mount:claude' first.`);
  process.exit(1);
}

const entries = fs.readdirSync(SKILLS_DIR).filter(name =>
  fs.statSync(path.join(SKILLS_DIR, name)).isDirectory()
);

if (entries.length === 0) {
  console.error('❌ No skills found under .claude/skills/ — was mount:claude a no-op?');
  process.exit(1);
}

let failed = false;

entries.forEach(name => {
  const skillMdPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  console.log(`Testing [.claude/skills/${name}]...`);

  if (!fs.existsSync(skillMdPath)) {
    console.error(`❌ ${name}: missing SKILL.md\n`);
    failed = true;
    return;
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content);

  if (!fm) {
    console.error(`❌ ${name}: SKILL.md has no YAML frontmatter block\n`);
    failed = true;
    return;
  }

  const errors = [];
  if (!fm.name) {
    errors.push('missing `name` in frontmatter');
  } else if (fm.name !== name) {
    errors.push(`frontmatter name "${fm.name}" does not match directory "${name}"`);
  }
  if (!fm.description) {
    errors.push('missing `description` in frontmatter');
  } else if (fm.description.length > 1024) {
    errors.push('`description` exceeds 1024 chars');
  }

  if (errors.length) {
    errors.forEach(e => console.error(`❌ ${name}: ${e}`));
    console.error('');
    failed = true;
  } else {
    console.log(`✅ ${name} passed.\n`);
  }
});

if (failed) {
  console.error('🚨 One or more mounted skills failed Claude Code validation.');
  process.exit(1);
} else {
  console.log('🎉 All mounted skills are valid Claude Code skills!');
  process.exit(0);
}
