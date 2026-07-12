const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKILLS_DIRS = [
  path.join(__dirname, '..', 'skills'),
  path.join(__dirname, '..', '.claude', 'skills'),
];
let VALIDATOR_PATH;
try {
  const brewPrefix = execSync('brew --prefix gemini-cli', { encoding: 'utf8' }).trim();
  VALIDATOR_PATH = path.join(brewPrefix, 'libexec/lib/node_modules/@google/gemini-cli/bundle/builtin/skill-creator/scripts/validate_skill.cjs');
} catch (error) {
  console.error('❌ Could not locate gemini-cli via Homebrew. Is it installed?');
  process.exit(1);
}

console.log('🔍 Starting Skill Validation Suite...\n');

const skills = SKILLS_DIRS.flatMap(skillsDir => {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir)
    .filter(file => fs.statSync(path.join(skillsDir, file)).isDirectory())
    .map(file => path.join(skillsDir, file));
});

let failed = false;

skills.forEach(skillPath => {
  const skill = path.relative(path.join(__dirname, '..'), skillPath);
  console.log(`Testing [${skill}]...`);
  
  try {
    execSync(`node ${VALIDATOR_PATH} ${skillPath}`, { stdio: 'inherit' });
    console.log(`✅ ${skill} passed validation.\n`);
  } catch (error) {
    console.error(`❌ ${skill} failed validation.\n`);
    failed = true;
  }
});

if (failed) {
  console.error('🚨 Validation failed for one or more skills.');
  process.exit(1);
} else {
  console.log('🎉 All skills are valid!');
  process.exit(0);
}
