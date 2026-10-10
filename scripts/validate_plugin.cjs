// `claude plugin validate --strict`, minus one known warning.
//
// The plugin's source is the repo root (so it can publish .claude/skills/ in
// place), and since Claude Code 2.1.291 validating the marketplace also
// validates that root plugin. It warns that CLAUDE.md at the plugin root isn't
// loaded for plugin users. That's intended: CLAUDE.md is context for working
// on this repo, not something the plugin ships. Every other warning still
// fails, exactly as --strict would.
//
// It fails closed: a report it doesn't recognise (no manifest, success: false
// with nothing it can list) is a failure, never a pass.
//
//   node scripts/validate_plugin.cjs [--report <saved validate --json output>]
//
// Exit codes: 0 = valid, 1 = invalid or unreadable, 2 = usage error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOLERATED = [
  {
    // Relative to the marketplace root, so only the repo's own CLAUDE.md
    // matches, not one inside some other plugin directory.
    file: 'CLAUDE.md',
    message: /^CLAUDE\.md at the plugin root is not loaded as project context\b/,
    reason: 'CLAUDE.md is repo context and was never meant to ship with the plugin',
  },
];

function fail(lines) {
  [].concat(lines).forEach(l => console.error(l));
  console.error('✘ plugin validation failed');
  process.exit(1);
}

function loadReport(argv) {
  const i = argv.indexOf('--report');
  if (i !== -1) {
    if (!argv[i + 1]) {
      console.error('usage: validate_plugin.cjs [--report <saved claude plugin validate --json output>]');
      process.exit(2);
    }
    return JSON.parse(fs.readFileSync(argv[i + 1], 'utf8'));
  }
  const root = path.join(__dirname, '..');
  const res = spawnSync('claude', ['plugin', 'validate', '--json', root], { encoding: 'utf8' });
  if (res.error || !res.stdout.trim()) {
    fail(`could not run claude plugin validate: ${res.error ? res.error.message : res.stderr.trim()}`);
  }
  return JSON.parse(res.stdout);
}

// The marketplace root is the directory holding .claude-plugin/.
function marketplaceRoot(report) {
  return path.dirname(path.dirname(report.target || report.manifest.file));
}

function tolerated(root, entry, warning) {
  const rel = path.relative(root, entry.file);
  return TOLERATED.find(t => rel === t.file && t.message.test(warning.message));
}

function main() {
  let report;
  try {
    report = loadReport(process.argv.slice(2));
  } catch (e) {
    fail(`could not read the validation report: ${e.message}`);
  }
  if (!report || !report.manifest) {
    const listed = (report && report.errors || []).map(e => `error   ${e.path || ''}: ${e.message || e}`);
    fail([...listed, 'report has no manifest section, so it can\'t be checked; treating as a failure']);
  }

  const root = marketplaceRoot(report);
  const failures = [];
  const allowed = [];
  for (const entry of [report.manifest, ...(report.contents || [])]) {
    for (const e of entry.errors || []) failures.push(`error   ${entry.file} ${e.path}: ${e.message}`);
    for (const w of entry.warnings || []) {
      const t = tolerated(root, entry, w);
      if (t) allowed.push(`${entry.file}: ${w.message.replace(/\. .*$/, '')} (${t.reason})`);
      else failures.push(`warning ${entry.file} ${w.path}: ${w.message}`);
    }
  }
  if (report.success !== true && failures.length === 0) {
    failures.push('validator reported success: false without listing a problem');
  }

  allowed.forEach(a => console.log(`tolerated: ${a}`));
  if (failures.length) fail(failures);
  console.log('✔ plugin validation passed');
}

main();
