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
//   session. Only a server owned by "shared" or by the same owner is reused, so
//   another session's "done" can't take it away.
// list: live servers, after pruning stale entries.
// stop: signals only verified, live browse servers. --mine stops this Claude
//   session's; shared ones need --port or --all.
//
// Exit codes: 0 ok, 1 failed, 2 usage error.
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, openSync, mkdirSync } from "node:fs";
import { createServer, connect } from "node:net";
import { request } from "node:http";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, readEntry, removeEntry, ownerFromEnv } from "./registry.mjs";

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

// Is <pid> node running a serve-md.mjs script? The pid could have been reused
// since the entry was written, so check what it is before trusting or
// signalling it. A whole argument must name the script: `vim serve-md.mjs`
// isn't a server.
function isBrowseServer(pid) {
  let args;
  try {
    args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
  } catch {
    return false;
  }
  return basename(args[0]).startsWith("node") && args.slice(1).some((a) => a.endsWith("/serve-md.mjs"));
}

// What the server on <port> says it is: { path, pid } from /__health, {} when
// something answered that isn't a browse server (or nothing is listening), and
// null when there was no answer in time. null is no evidence the entry is
// stale (the server may just be busy), so callers must not prune on it.
function health(port) {
  return new Promise((done) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(v);
    };
    const req = request({ host: "127.0.0.1", port, path: "/__health", agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
        if (body.length > 4096) {
          settle({});
          req.destroy();
        }
      });
      res.on("end", () => {
        try {
          settle(res.statusCode === 200 ? JSON.parse(body) : {});
        } catch {
          settle({});
        }
      });
      res.on("close", () => settle(null));
    });
    // A total deadline: the socket timeout only measures idle time.
    const timer = setTimeout(() => req.destroy(), 1500);
    req.on("error", (e) => settle(e.code === "ECONNREFUSED" ? {} : null));
    req.end();
  });
}

function connects(port, host) {
  return new Promise((done) => {
    const sock = connect({ port, host, timeout: 500 });
    sock.once("connect", () => (sock.destroy(), done(true)));
    sock.once("timeout", () => (sock.destroy(), done(true))); // something's there, just slow
    sock.once("error", () => done(false)); // refused, or no IPv6 loopback at all
  });
}

// Free means nothing answers on either loopback address, and 127.0.0.1 binds.
// A bind alone isn't enough: on macOS, binding 127.0.0.1 succeeds while another
// app holds the port on ::, ::1 or 0.0.0.0, and browsers try ::1 first for
// localhost, so they'd open that app instead.
async function portFree(port) {
  if ((await connects(port, "127.0.0.1")) || (await connects(port, "::1"))) return false;
  return new Promise((done) => {
    const s = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

function validEntry(e, port) {
  return !!e && Number.isInteger(e.pid) && e.pid > 1 && e.port === port
    && typeof e.path === "string" && isAbsolute(e.path) && typeof e.owner === "string";
}

// Every entry whose server is alive, a browse server, and answering on its port
// with the entry's pid and path. An entry is pruned only on evidence that it's
// stale: unreadable, its pid isn't a browse server, or the port answered as
// something else. One that's merely slow to answer is skipped but kept, or the
// server would run on unregistered.
async function liveEntries() {
  let ports;
  try {
    ports = readdirSync(stateDir()).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5)));
  } catch {
    return [];
  }
  const live = [];
  for (const port of ports) {
    const e = readEntry(port);
    if (!validEntry(e, port) || !isBrowseServer(e.pid)) {
      removeEntry(port, e?.pid);
      continue;
    }
    const h = await health(port);
    if (h === null) continue;
    if (h.pid !== e.pid || h.path !== e.path) {
      removeEntry(port, e.pid);
      continue;
    }
    live.push(e);
  }
  return live.sort((a, b) => a.port - b.port);
}

// ensure runs under this lock, so parallel runs (several sessions starting at
// once) can't each find a path unserved and each start a server for it. The
// file holds the holder's pid; a lock whose holder is dead is taken over.
async function withLock(fn) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const lock = join(stateDir(), ".lock");
  const holder = () => {
    try {
      return readFileSync(lock, "utf8");
    } catch {
      return "";
    }
  };
  for (let tries = 0; ; tries++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const pid = holder();
    // "" is a lock still being written; wait for it like a live one.
    if (Number(pid) > 0 && !alive(Number(pid))) {
      try {
        if (holder() === pid) unlinkSync(lock);
      } catch {
        // another run took it over first
      }
      continue;
    }
    if (tries >= 300) throw new Failure(`another browse-ctl (pid ${pid}) has held ${lock} for 15s`);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    if (holder() === String(process.pid)) unlinkSync(lock);
  }
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

// encodeURIComponent leaves ! ' ( ) * as they are; a URL that gets pasted into
// a shell command (`open <url>`) is safer without them.
const encodeSegment = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// A path relative to a served folder, as a URL suffix ("" for the folder itself).
function urlSuffix(rel, isDir) {
  if (!rel) return "";
  return "/" + rel.split(sep).map(encodeSegment).join("/") + (isDir ? "/" : "");
}

// TODO(LAR-401): one usage constant per command, and braces on every branch.
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
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
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
    const h = await health(port);
    if (h?.pid === child.pid && h.path === dir) return true;
    await sleep(100);
  }
  child.kill();
  throw new Failure(`server didn't come up on port ${port}; see ${join(stateDir(), `${port}.log`)}`);
}

async function ensure(opts) {
  if (opts._.length !== 1) throw new UsageError("usage: browse-ctl.mjs ensure <path> [--open] [--shared] [--port N]");
  // TODO(LAR-398): realpath both sides, so /tmp vs /private/tmp or a symlinked
  // folder is recognised as already served.
  const target = resolve(opts._[0]);
  let isDir;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    throw new UsageError(`no such file or directory: ${target}`);
  }
  const dir = isDir ? target : dirname(target);
  const owner = opts.shared ? "shared" : ownerFromEnv();
  const display = displayHost();
  // Built from the port, never from the entry's url field.
  const link = (port, path) => `http://${display}:${port}${urlSuffix(relative(path, target), isDir)}`;

  await withLock(async () => {
    // Reuse the closest live server whose folder is this one or an ancestor.
    const covering = (await liveEntries())
      .filter((e) => (e.owner === "shared" || e.owner === owner) && (dir === e.path || dir.startsWith(e.path + sep)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (covering) {
      console.log(`${link(covering.port, covering.path)} (already running)`);
      return;
    }

    const min = Number(process.env.BROWSE_PORT_MIN || 3200);
    const max = Number(process.env.BROWSE_PORT_MAX || 3220);
    const candidates = opts.port ? [opts.port] : Array.from({ length: max - min + 1 }, (_, i) => min + i);
    for (const port of candidates) {
      if (!(await portFree(port))) {
        if (opts.port) throw new Failure(`port ${port} is in use by something else; omit --port to pick a free one`);
        continue;
      }
      if (await start(dir, port, owner, display)) {
        const url = link(port, dir);
        console.log(`${url} (started)`);
        if (opts.open) spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
        return;
      }
    }
    throw new Failure(`no free port in ${min}–${max}`);
  });
}

// The owner this session's servers are recorded under, or null outside Claude
// Code (no session id, no BROWSE_OWNER), where everything is "shared".
function sessionOwner() {
  const owner = ownerFromEnv();
  return owner === "shared" ? null : owner;
}

async function list() {
  const live = await liveEntries();
  if (!live.length) return console.log("no browse servers running");
  const me = sessionOwner();
  for (const e of live) {
    const owner = e.owner + (e.owner === me ? " (this session)" : "");
    console.log(`${e.port}  ${owner}  ${age(e.started)}  ${e.path}`);
  }
}

function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "?";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

async function stop(opts) {
  const selectors = [opts.mine, opts.port !== undefined, opts.all].filter(Boolean).length;
  if (selectors !== 1) throw new UsageError("usage: browse-ctl.mjs stop (--mine | --port N | --all)");
  const me = sessionOwner();
  if (opts.mine && !me) throw new UsageError("stop --mine: no Claude session id in the environment; use --port N");

  const live = await liveEntries();
  const targets = live.filter((e) => opts.all || (opts.mine && e.owner === me) || e.port === opts.port);
  if (opts.port !== undefined && !targets.length) throw new Failure(`no browse server on port ${opts.port}`);
  let stuck = 0;
  for (const e of targets) {
    // Checked again: the verification in liveEntries can be seconds old, and
    // another stop may already have ended this server.
    if (isBrowseServer(e.pid)) {
      try {
        process.kill(e.pid, "SIGTERM");
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
      for (let i = 0; i < 30 && alive(e.pid); i++) await sleep(100);
    }
    if (alive(e.pid) && isBrowseServer(e.pid)) {
      console.error(`browse: ${e.port} (pid ${e.pid}) did not exit; its entry is kept`);
      stuck++;
      continue;
    }
    removeEntry(e.port, e.pid);
    console.log(`stopped ${e.port} ${e.path}`);
  }
  if (stuck) throw new Failure(`${stuck} server(s) still running; kill -9 the pid above`);
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
