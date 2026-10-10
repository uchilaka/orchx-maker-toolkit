#!/usr/bin/env node
// Start, find and stop /browse servers. Any number can run, one per path, each
// on its own port, and each one is tracked by its registry entry (registry.mjs).
//
//   browse-ctl.mjs ensure <path> [--open] [--shared] [--port N]
//   browse-ctl.mjs list
//   browse-ctl.mjs stop (--mine | --port N | --all)
//
// ensure: reuses a live server whose folder is <path> or contains it, and prints
//   a deep link into it. Otherwise it starts one on the first free port from
//   BROWSE_PORT_MIN (3200) to BROWSE_PORT_MAX (3220). A file serves its folder.
//   A port held by anything else is skipped, never killed. --open opens the
//   browser only when a server was started, so session-start runs don't pile
//   up tabs. --shared records the owner as "shared"; otherwise it's the Claude
//   session.
// list: live servers, after pruning stale entries.
// stop: signals only verified, live browse servers. --mine stops this Claude
//   session's; shared ones need --port or --all.
//
// Exit codes: 0 ok, 1 failed, 2 usage error.
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync, openSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { join, resolve, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, entryFile, ownerFromEnv } from "./registry.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "serve-md.mjs");

class UsageError extends Error {}
class Failure extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// The pid could have been reused by an unrelated process since the entry was
// written, so check what it is before trusting or signalling it.
function isBrowseServer(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes("serve-md.mjs");
  } catch {
    return false;
  }
}

function health(port) {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/__health", agent: false, timeout: 1000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => done(res.statusCode === 200 ? body : null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });
}

function portFree(port) {
  return new Promise((done) => {
    const s = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

// Every entry whose server is alive, a browse server, and serving the path it
// claims. Anything else is a stale pidfile and gets deleted.
async function liveEntries() {
  let files = [];
  try {
    files = readdirSync(stateDir()).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const live = [];
  for (const f of files) {
    const file = join(stateDir(), f);
    let e = null;
    try {
      e = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // unreadable: stale
    }
    // isBrowseServer also covers a dead pid: ps finds nothing for it.
    if (e && isBrowseServer(e.pid) && (await health(e.port)) === e.path) {
      live.push(e);
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      // another run pruned it first
    }
  }
  return live.sort((a, b) => a.port - b.port);
}

function displayHost() {
  const host = process.env.BROWSE_HOST || "plans.localhost";
  let hosts = "";
  try {
    hosts = readFileSync(process.env.BROWSE_HOSTS_FILE || "/etc/hosts", "utf8");
  } catch {
    return "localhost";
  }
  // Whole-field match on 127.0.0.1 lines, stopping at a trailing # comment.
  const mapped = hosts.split("\n").some((line) => {
    const fields = line.split("#")[0].trim().split(/\s+/);
    return fields[0] === "127.0.0.1" && fields.slice(1).includes(host);
  });
  return mapped ? host : "localhost";
}

// A path relative to a served folder, as a URL suffix ("" for the folder itself).
function urlSuffix(rel, isDir) {
  if (!rel) return "";
  return "/" + rel.split(sep).map(encodeURIComponent).join("/") + (isDir ? "/" : "");
}

function parse(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--open" || a === "--shared" || a === "--mine" || a === "--all") opts[a.slice(2)] = true;
    else if (a === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--port needs a port number, got ${args[i]}`);
      opts.port = n;
    } else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

async function start(dir, port, owner, host) {
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(join(stateDir(), `${port}.log`), "w");
  const child = spawn(process.execPath, [SERVER, dir, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, BROWSE_OWNER: owner, BROWSE_HOST: host },
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (exited) return false; // lost a race for the port
    if ((await health(port)) === dir) return true;
    await sleep(100);
  }
  child.kill();
  throw new Failure(`server didn't come up on port ${port}; see ${join(stateDir(), `${port}.log`)}`);
}

async function ensure(opts) {
  if (opts._.length !== 1) throw new UsageError("usage: browse-ctl.mjs ensure <path> [--open] [--shared] [--port N]");
  const target = resolve(opts._[0]);
  let isDir;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    throw new UsageError(`no such file or directory: ${target}`);
  }
  const dir = isDir ? target : dirname(target);
  const fileSuffix = isDir ? "" : urlSuffix(basename(target), false);

  // Reuse the closest live server whose folder is this one or an ancestor.
  const covering = (await liveEntries())
    .filter((e) => dir === e.path || dir.startsWith(e.path + sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (covering) {
    console.log(`${covering.url}${urlSuffix(relative(covering.path, target), isDir)} (already running)`);
    return;
  }

  const owner = opts.shared ? "shared" : ownerFromEnv();
  const display = displayHost();
  const min = Number(process.env.BROWSE_PORT_MIN || 3200);
  const max = Number(process.env.BROWSE_PORT_MAX || 3220);
  const candidates = opts.port ? [opts.port] : Array.from({ length: max - min + 1 }, (_, i) => min + i);
  for (const port of candidates) {
    if (!(await portFree(port))) {
      if (opts.port) throw new Failure(`port ${port} is in use by something else; omit --port to pick a free one`);
      continue;
    }
    if (await start(dir, port, owner, display)) {
      const url = `http://${display}:${port}${fileSuffix}`;
      console.log(`${url} (started)`);
      if (opts.open) spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
      return;
    }
  }
  throw new Failure(`no free port in ${min}–${max}`);
}

async function list() {
  const live = await liveEntries();
  if (!live.length) return console.log("no browse servers running");
  const me = process.env.CLAUDE_CODE_SESSION_ID;
  for (const e of live) {
    const owner = e.owner + (me && e.owner === me ? " (this session)" : "");
    console.log(`${e.port}  ${owner}  ${age(e.started)}  ${e.path}`);
  }
}

function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

async function stop(opts) {
  const selectors = [opts.mine, opts.port !== undefined, opts.all].filter(Boolean).length;
  if (selectors !== 1) throw new UsageError("usage: browse-ctl.mjs stop (--mine | --port N | --all)");
  const me = ownerFromEnv({ CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID });
  if (opts.mine && me === "shared") throw new UsageError("stop --mine: no Claude session id in the environment; use --port N");

  const live = await liveEntries();
  const targets = live.filter((e) => opts.all || (opts.mine && e.owner === me) || e.port === opts.port);
  if (opts.port !== undefined && !targets.length) throw new Failure(`no browse server on port ${opts.port}`);
  for (const e of targets) {
    process.kill(e.pid, "SIGTERM");
    for (let i = 0; i < 30 && alive(e.pid); i++) await sleep(100);
    try {
      unlinkSync(entryFile(e.port));
    } catch {
      // the server removed its own entry
    }
    console.log(`stopped ${e.port} ${e.path}`);
  }
  if (!targets.length) console.log("nothing to stop");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parse(rest);
  if (cmd === "ensure") return ensure(opts);
  if (cmd === "list") return list();
  if (cmd === "stop") return stop(opts);
  throw new UsageError("usage: browse-ctl.mjs (ensure <path> [--open] [--shared] [--port N] | list | stop (--mine | --port N | --all))");
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`browse: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
}
