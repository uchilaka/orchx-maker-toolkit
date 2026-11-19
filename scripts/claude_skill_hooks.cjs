#!/usr/bin/env node
// Add or remove the optional hooks a repo skill ships in install/hooks.json, in
// the user's ~/.claude/settings.json. claude-global-skill.sh calls this; it
// decides whether to, this does the editing.
//
//   node claude_skill_hooks.cjs describe <hooks.json>
//   node claude_skill_hooks.cjs has      <hooks.json> <installed skill dir>
//   node claude_skill_hooks.cjs add      <hooks.json> <installed skill dir>
//   node claude_skill_hooks.cjs remove   <hooks.json> <installed skill dir>
//
// install/hooks.json:
//   { "description": "...", "mkdir": ["~/dir", ...],
//     "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
// `{{SKILL_DIR}}` in a command becomes the installed skill dir
// (~/.claude/skills/<name>, absolute), so the hook survives the checkout moving.
//
// The optional statusLine is a single setting, not a list. `add` sets it only when
// settings.json has none or the one it has is ours: the same command, or a plain path
// that resolves to the same file (the user's own script later symlinked to the skill's).
// A foreign statusLine is kept and reported. `remove` deletes it only when it's ours.
//
// A hook is identified by its event, matcher and exact command. `add` appends a
// group for each one that's missing and never edits the user's own groups;
// `remove` takes out only those commands, then any group or event they leave
// empty. settings.json is backed up to ~/.claude/skill-backups/ before every
// write, written in place through a symlink, and never touched if it isn't
// valid JSON.
//
// Exit codes: 0 = done (`has`: every hook is present), 1 = `has`: not all
// present, 2 = could not run (usage, unreadable or invalid JSON).

const fs = require('fs');
const path = require('path');
const os = require('os');

class InputError extends Error {}

const home = os.homedir();
const settingsPath = path.join(home, '.claude', 'settings.json');
const backups = path.join(home, '.claude', 'skill-backups');
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new InputError(`${what} ${file} isn't valid JSON (${e.message}); left untouched`);
  }
}

function loadFragment(file, skillDir) {
  const frag = readJson(file, 'hooks file');
  if (!frag || typeof frag.hooks !== 'object') throw new InputError(`${file} has no "hooks" object`);
  const wanted = [];
  for (const [event, groups] of Object.entries(frag.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (typeof h.command !== 'string') throw new InputError(`${file}: a ${event} hook has no command`);
        wanted.push({ event, matcher: g.matcher, hook: { ...h, command: h.command.split('{{SKILL_DIR}}').join(skillDir) } });
      }
    }
  }
  let statusLine = null;
  if (frag.statusLine !== undefined) {
    if (typeof frag.statusLine?.command !== 'string') throw new InputError(`${file}: statusLine has no command`);
    statusLine = { ...frag.statusLine, command: frag.statusLine.command.split('{{SKILL_DIR}}').join(skillDir) };
  }
  return { description: frag.description || '', mkdir: frag.mkdir || [], wanted, statusLine };
}

// Only a command that is nothing but a path can be compared by file; anything with
// arguments or shell syntax is compared as text.
const isPlainPath = (c) => /^[\w./@+-]+$/.test(c) || /^~\/[\w./@+-]+$/.test(c);
const realOf = (c) => {
  try {
    return fs.realpathSync(expandHome(c));
  } catch {
    return null;
  }
};
function statusLineIsOurs(current, ours) {
  const a = current?.command;
  if (typeof a !== 'string') return false;
  if (a === ours.command) return true;
  if (!isPlainPath(a) || !isPlainPath(ours.command)) return false;
  const ra = realOf(a);
  return ra !== null && ra === realOf(ours.command);
}

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const s = readJson(settingsPath, 'settings');
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new InputError(`${settingsPath} isn't a JSON object; left untouched`);
  return s;
}

const sameGroup = (g, w) => (g.matcher ?? '') === (w.matcher ?? '');
const present = (settings, w) =>
  (settings.hooks?.[w.event] || []).some((g) => sameGroup(g, w) && (g.hooks || []).some((h) => h.command === w.hook.command));

function save(settings) {
  const target = fs.existsSync(settingsPath) ? fs.realpathSync(settingsPath) : settingsPath;
  if (fs.existsSync(target)) {
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const backup = path.join(backups, `settings.json-${stamp}`);
    fs.copyFileSync(target, backup);
    console.log(`  backed up settings.json to ${backup}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
  fs.renameSync(tmp, target);
}

function add(frag) {
  const settings = loadSettings();
  const missing = frag.wanted.filter((w) => !present(settings, w));
  const sl = frag.statusLine;
  // Absent, or ours under another spelling (re-pointed to the exact command): set it.
  // Anyone else's stays.
  const hasStatusLine = settings.statusLine !== undefined;
  const ours = hasStatusLine && sl && statusLineIsOurs(settings.statusLine, sl);
  const setStatusLine = sl && (!hasStatusLine || (ours && settings.statusLine.command !== sl.command));
  if (sl && hasStatusLine && !ours) console.log(`  statusLine: kept yours (${settings.statusLine?.command})`);
  for (const d of frag.mkdir.map(expandHome)) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      console.log(`  created ${d}`);
    }
  }
  if (!missing.length && !setStatusLine) {
    console.log('  hooks already in settings.json');
    return;
  }
  if (missing.length) settings.hooks = settings.hooks || {};
  for (const w of missing) {
    const group = { hooks: [w.hook] };
    if (w.matcher !== undefined) group.matcher = w.matcher;
    (settings.hooks[w.event] = settings.hooks[w.event] || []).push(group);
    console.log(`  added ${w.event} hook: ${w.hook.command}`);
  }
  if (setStatusLine) {
    // Merge, so a user's own extra fields (padding...) survive a re-point.
    settings.statusLine = { ...settings.statusLine, ...sl };
    console.log(`  set statusLine: ${sl.command}`);
  }
  save(settings);
}

function remove(frag) {
  if (!fs.existsSync(settingsPath)) return;
  const settings = loadSettings();
  let removed = 0;
  for (const w of frag.wanted) {
    const groups = settings.hooks?.[w.event];
    if (!groups) continue;
    for (const g of groups) {
      if (!sameGroup(g, w) || !g.hooks) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => h.command !== w.hook.command);
      if (g.hooks.length < before) console.log(`  removed ${w.event} hook: ${w.hook.command}`);
      removed += before - g.hooks.length;
    }
    settings.hooks[w.event] = groups.filter((g) => !g.hooks || g.hooks.length);
    if (!settings.hooks[w.event].length) delete settings.hooks[w.event];
  }
  if (frag.statusLine && settings.statusLine !== undefined && statusLineIsOurs(settings.statusLine, frag.statusLine)) {
    console.log(`  removed statusLine: ${settings.statusLine.command}`);
    delete settings.statusLine;
    removed++;
  }
  if (!removed) return;
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  save(settings);
}

function main(argv) {
  const [action, hooksFile, skillDir] = argv;
  const usage = 'usage: claude_skill_hooks.cjs describe <hooks.json> | has|add|remove <hooks.json> <installed skill dir>';
  if (!['describe', 'has', 'add', 'remove'].includes(action) || !hooksFile || (action !== 'describe' && !skillDir)) {
    throw new InputError(usage);
  }
  const frag = loadFragment(hooksFile, skillDir || '{{SKILL_DIR}}');
  if (action === 'describe') {
    console.log(frag.description);
  } else if (action === 'has') {
    const settings = loadSettings();
    // A foreign statusLine is the user's to keep, so it doesn't make the skill "not installed".
    // Ours under another spelling is not done: `add` must re-point it to the exact command.
    const cur = settings.statusLine;
    const slDone = !frag.statusLine || (cur !== undefined
      && (cur?.command === frag.statusLine.command || !statusLineIsOurs(cur, frag.statusLine)));
    return slDone && frag.wanted.every((w) => present(settings, w)) ? 0 : 1;
  } else if (action === 'add') {
    add(frag);
  } else {
    remove(frag);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof InputError ? e.message : e.stack);
  process.exitCode = 2;
}
