// `claude plugin validate --strict`, minus one known warning.
//
// The plugin's source is the repo root (so it can publish .claude/skills/ in
// place), and since Claude Code 2.1.291 validating the marketplace also
// validates that root plugin. It warns that CLAUDE.md at the plugin root isn't
// loaded for plugin users. That's intended: CLAUDE.md is context for working
// on this repo, not something the plugin ships. Every other warning still
// fails, exactly as --strict would.
//
//   node scripts/validate_plugin.cjs [--report <saved validate --json output>]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOLERATED = [
  {
    file: 'CLAUDE.md',
    message: /^CLAUDE\.md at the plugin root is not loaded as project context\b/,
    reason: 'CLAUDE.md is repo context and was never meant to ship with the plugin',
  },
];

function loadReport(argv) {
  const i = argv.indexOf('--report');
  if (i !== -1) return JSON.parse(fs.readFileSync(argv[i + 1], 'utf8'));
  const root = path.join(__dirname, '..');
  const res = spawnSync('claude', ['plugin', 'validate', '--json', root], { encoding: 'utf8' });
  if (res.error || !res.stdout.trim()) {
    console.error(`validate_plugin: could not run claude plugin validate: ${res.error ? res.error.message : res.stderr.trim()}`);
    process.exit(1);
  }
  return JSON.parse(res.stdout);
}

function tolerated(entry, warning) {
  return TOLERATED.find(t => path.basename(entry.file) === t.file && t.message.test(warning.message));
}

const report = loadReport(process.argv.slice(2));
const failures = [];
const allowed = [];
for (const entry of [report.manifest, ...(report.contents || [])].filter(Boolean)) {
  for (const e of entry.errors || []) failures.push(`error   ${entry.file} ${e.path}: ${e.message}`);
  for (const w of entry.warnings || []) {
    const t = tolerated(entry, w);
    if (t) allowed.push(`${entry.file}: ${w.message.replace(/\. .*$/, '')} (${t.reason})`);
    else failures.push(`warning ${entry.file} ${w.path}: ${w.message}`);
  }
}

allowed.forEach(a => console.log(`tolerated: ${a}`));
if (failures.length) {
  failures.forEach(f => console.error(f));
  console.error(`✘ plugin validation failed (${failures.length})`);
  process.exit(1);
}
console.log('✔ plugin validation passed');
