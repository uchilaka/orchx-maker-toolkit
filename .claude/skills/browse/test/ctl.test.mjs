// browse-ctl.mjs: ensure / list / stop over the registry. Every test gets its
// own state dir and a port range far from 3200, so the real server is never
// touched. `open` is shimmed so no tab appears.
// TODO(LAR-400): usage-error table, SIGINT/SIGHUP, ancestor sort, stub harness.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_DIR, fixtureTree, startServer, rawGet } from "./helpers.mjs";

const CTL = join(SKILL_DIR, "browse-ctl.mjs");
const SPAN = 6;

const listen = (port, host = "127.0.0.1") => new Promise((resolve, reject) => {
  const s = createServer().once("error", reject).listen(port, host, () => resolve(s));
});

// A stand-in browse server: answers /__health like serve-md.mjs, under a script
// name of our choosing, and can be told to ignore SIGTERM.
function stub(dir, name, port, path, { ignoreTerm = false, args = [] } = {}) {
  const script = join(dir, name);
  writeFileSync(script, `
    ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
    import { createServer } from "node:http";
    createServer((req, res) => res.end(JSON.stringify({ path: ${JSON.stringify(path)}, pid: process.pid })))
      .listen(${port}, "127.0.0.1", () => console.log("up"));
  `);
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve) => child.stdout.once("data", () => resolve(child)));
}

// A run of SPAN free ports, so the scan has room and nothing else is in it.
async function freeRange() {
  for (let tries = 0; tries < 50; tries++) {
    // Below 49152, where macOS starts handing out ephemeral ports.
    const base = 41000 + Math.floor(Math.random() * 8000);
    const held = [];
    try {
      for (let p = base; p < base + SPAN; p++) held.push(await listen(p));
      await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
      return base;
    } catch {
      await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
    }
  }
  throw new Error("no free port range");
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("browse-ctl.mjs", { timeout: 60_000 }, () => {
  let tree, state, base, opened, env, spawned;

  const ctl = (args, extra = {}) =>
    spawnSync(process.execPath, [CTL, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const ctlAsync = (args, extra = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CTL, ...args], { env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const entries = () => readdirSync(state).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(state, f), "utf8")));
  const entryAt = (port) => entries().find((e) => e.port === port);
  const health = async (port) => {
    const r = await rawGet(`http://127.0.0.1:${port}`, "/__health").catch(() => null);
    return r && JSON.parse(r.body).path;
  };
  const openCalls = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n").filter(Boolean) : []);

  beforeEach(async () => {
    tree = fixtureTree();
    mkdirSync(join(tree.root, "other"));
    writeFileSync(join(tree.root, "other", "x.md"), "# Other\n");
    state = mkdtempSync(join(tmpdir(), "browse-state-"));
    base = await freeRange();
    const bin = join(tree.root, "bin");
    mkdirSync(bin);
    opened = join(tree.root, "opened.log");
    writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`);
    chmodSync(join(bin, "open"), 0o755);
    const hosts = join(tree.root, "hosts");
    writeFileSync(hosts, "127.0.0.1 localhost\n");
    env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSE_HOSTS_FILE: hosts,
      BROWSE_STATE_DIR: state, BROWSE_PORT_MIN: String(base), BROWSE_PORT_MAX: String(base + SPAN - 1),
      BROWSE_OWNER: "", BROWSE_HOST: "", CLAUDE_CODE_SESSION_ID: "sess-a",
    };
    spawned = [];
  });

  afterEach(() => {
    for (const e of entries()) if (alive(e.pid)) process.kill(e.pid, "SIGKILL");
    for (const c of spawned) c.kill("SIGKILL");
  });

  describe("ensure", () => {
    test("starts a server on the first port, owned by the session, and opens it once", async () => {
      const r = ctl(["ensure", tree.plans, "--open"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), `http://localhost:${base} (started)`);
      assert.equal(await health(base), tree.plans);
      assert.equal(entryAt(base).owner, "sess-a");
      assert.deepEqual(openCalls(), [`http://localhost:${base}`]);
    });

    test("reuses the server for the same path, without a second tab", async () => {
      ctl(["ensure", tree.plans, "--open"]);
      const pid = entryAt(base).pid;
      const r = ctl(["ensure", tree.plans, "--open"]);
      assert.equal(r.stdout.trim(), `http://localhost:${base} (already running)`);
      assert.equal(entryAt(base).pid, pid);
      assert.equal(openCalls().length, 1);
    });

    test("a second path gets the next port and leaves the first running", async () => {
      ctl(["ensure", tree.plans]);
      const first = entryAt(base).pid;
      const r = ctl(["ensure", join(tree.root, "other")]);
      assert.equal(r.stdout.trim(), `http://localhost:${base + 1} (started)`);
      assert.ok(alive(first), "first server was stopped");
      assert.equal(await health(base), tree.plans);
      assert.equal(await health(base + 1), join(tree.root, "other"));
    });

    test("a path under a served folder reuses that server, with a deep link", async () => {
      ctl(["ensure", tree.plans]);
      assert.equal(ctl(["ensure", join(tree.plans, "global")]).stdout.trim(),
        `http://localhost:${base}/global/ (already running)`);
      assert.equal(ctl(["ensure", join(tree.plans, "global", "PLAN.md")]).stdout.trim(),
        `http://localhost:${base}/global/PLAN.md (already running)`);
      assert.equal(entries().length, 1);
    });

    test("a file with no server for its folder serves the folder and links the file", async () => {
      const r = ctl(["ensure", join(tree.root, "other", "x.md")]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), `http://localhost:${base}/x.md (started)`);
      assert.equal(await health(base), join(tree.root, "other"));
    });

    test("skips a port held by something else, and leaves it running", async () => {
      const foreign = await listen(base);
      try {
        const r = ctl(["ensure", tree.plans]);
        assert.equal(r.stdout.trim(), `http://localhost:${base + 1} (started)`);
        assert.ok(foreign.listening);
      } finally {
        foreign.close();
      }
    });

    for (const host of ["::", "::1", "0.0.0.0"]) {
      test(`skips a port another app holds on ${host}, which a 127.0.0.1 bind alone misses`, async () => {
        const foreign = await listen(base, host);
        try {
          const r = ctl(["ensure", tree.plans]);
          assert.equal(r.stdout.trim(), `http://localhost:${base + 1} (started)`);
          assert.ok(foreign.listening);
        } finally {
          foreign.close();
        }
      });
    }

    test("an explicit --port another app holds on :: is refused", async () => {
      const foreign = await listen(base + 2, "::");
      try {
        const r = ctl(["ensure", tree.plans, "--port", String(base + 2)]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, new RegExp(`port ${base + 2} is in use`));
      } finally {
        foreign.close();
      }
    });

    test("parallel runs for one path start one server", async () => {
      const runs = await Promise.all([1, 2, 3].map(() => ctlAsync(["ensure", tree.plans, "--shared"])));
      assert.ok(runs.every((r) => r.status === 0), runs.map((r) => r.stderr).join(""));
      assert.equal(entries().length, 1);
      assert.equal(runs.filter((r) => r.stdout.includes("(started)")).length, 1);
    });

    test("a lock left by a dead run doesn't block", () => {
      const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
      writeFileSync(join(state, ".lock"), String(dead));
      const r = ctl(["ensure", tree.plans]);
      assert.equal(r.stdout.trim(), `http://localhost:${base} (started)`);
      assert.ok(!existsSync(join(state, ".lock")), "lock released");
    });

    test("creates the state dir private to the user", () => {
      const fresh = join(state, "nested", "browse");
      ctl(["ensure", tree.plans], { BROWSE_STATE_DIR: fresh });
      assert.equal(statSync(fresh).mode & 0o777, 0o700);
      for (const f of readdirSync(fresh).filter((f) => f.endsWith(".json"))) {
        process.kill(JSON.parse(readFileSync(join(fresh, f), "utf8")).pid, "SIGKILL");
      }
    });

    test("a file name with ' ( ) is fully escaped in the URL, and the link works", async () => {
      writeFileSync(join(tree.root, "other", "it's (draft).md"), "# Draft\n");
      const r = ctl(["ensure", join(tree.root, "other", "it's (draft).md")]);
      assert.equal(r.stdout.trim(), `http://localhost:${base}/it%27s%20%28draft%29.md (started)`);
      assert.equal((await rawGet(`http://127.0.0.1:${base}`, "/it%27s%20%28draft%29.md")).status, 200);
    });

    test("the URL comes from the port, never from the entry's url field", () => {
      ctl(["ensure", tree.plans]);
      const file = join(state, `${base}.json`);
      writeFileSync(file, JSON.stringify({ ...entryAt(base), url: "https://phish.example" }));
      assert.equal(ctl(["ensure", tree.plans]).stdout.trim(), `http://localhost:${base} (already running)`);
    });

    test("an explicit --port held by something else is refused", async () => {
      const foreign = await listen(base + 2);
      try {
        const r = ctl(["ensure", tree.plans, "--port", String(base + 2)]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, new RegExp(`port ${base + 2} is in use`));
        assert.equal(entries().length, 0);
      } finally {
        foreign.close();
      }
    });

    test("an already-served path is reused even when --port names another port", async () => {
      ctl(["ensure", tree.plans]);
      const r = ctl(["ensure", tree.plans, "--port", String(base + 4)]);
      assert.equal(r.stdout.trim(), `http://localhost:${base} (already running)`);
      assert.equal(entries().length, 1);
    });

    test("an explicit --port is used when free", async () => {
      const r = ctl(["ensure", tree.plans, "--port", String(base + 3)]);
      assert.equal(r.stdout.trim(), `http://localhost:${base + 3} (started)`);
    });

    test("fails clearly when every port in the range is taken", async () => {
      const held = [];
      for (let p = base; p < base + SPAN; p++) held.push(await listen(p));
      try {
        const r = ctl(["ensure", tree.plans]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, new RegExp(`no free port in ${base}–${base + SPAN - 1}`));
      } finally {
        held.forEach((s) => s.close());
      }
    });

    test("--shared marks the server shared", async () => {
      ctl(["ensure", tree.plans, "--shared"]);
      assert.equal(entryAt(base).owner, "shared");
    });

    describe("vanity host lookup", () => {
      for (const [label, file, host, want] of [
        ["name mapped to 127.0.0.1", "127.0.0.1 plans.localhost   # /browse preview server\n", undefined, "plans.localhost"],
        ["partial name doesn't match", "127.0.0.1 plans.localhost   # /browse preview server\n", "plans", "localhost"],
        ["a word in the trailing comment doesn't match", "127.0.0.1 plans.localhost   # /browse preview server\n", "browse", "localhost"],
        ["a commented-out entry doesn't match", "#127.0.0.1 plans.localhost\n", undefined, "localhost"],
        ["tab-separated entry among aliases matches", "127.0.0.1\tfoo plans.localhost bar\n", undefined, "plans.localhost"],
      ]) {
        test(label, () => {
          const hosts = join(tree.root, "hosts-vanity");
          writeFileSync(hosts, file);
          const r = ctl(["ensure", tree.plans], { BROWSE_HOSTS_FILE: hosts, ...(host ? { BROWSE_HOST: host } : {}) });
          assert.equal(r.stdout.trim(), `http://${want}:${base} (started)`);
        });
      }
    });

    test("--shared never reuses a session's server, so that session's stop leaves it", async () => {
      ctl(["ensure", tree.plans]);
      const r = ctl(["ensure", tree.plans, "--shared"], { CLAUDE_CODE_SESSION_ID: "sess-b" });
      assert.equal(r.stdout.trim(), `http://localhost:${base + 1} (started)`);
      ctl(["stop", "--mine"]);
      assert.equal(await health(base + 1), tree.plans, "the shared server was stopped");
    });

    test("another session's server isn't reused either; a shared one is", async () => {
      ctl(["ensure", tree.plans]);
      assert.equal(ctl(["ensure", tree.plans], { CLAUDE_CODE_SESSION_ID: "sess-b" }).stdout.trim(),
        `http://localhost:${base + 1} (started)`);
      ctl(["ensure", join(tree.root, "other")], { CLAUDE_CODE_SESSION_ID: "" });
      assert.equal(ctl(["ensure", join(tree.root, "other")], { CLAUDE_CODE_SESSION_ID: "sess-b" }).stdout.trim(),
        `http://localhost:${base + 2} (already running)`);
    });

    test("a missing path is a usage error", () => {
      const r = ctl(["ensure", join(tree.root, "nope")]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /no such file or directory/);
    });
  });

  describe("stale entries are pruned, never trusted", () => {
    const fake = (port, extra) => writeFileSync(join(state, `${port}.json`), JSON.stringify({
      port, path: "/nowhere", url: `http://localhost:${port}`, owner: "sess-a", started: new Date().toISOString(), ...extra,
    }));

    test("a dead pid", () => {
      const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
      fake(base, { pid: dead, path: tree.plans });
      const r = ctl(["ensure", tree.plans]);
      assert.equal(r.stdout.trim(), `http://localhost:${base} (started)`);
      assert.notEqual(entryAt(base).pid, dead);
    });

    test("a live pid that isn't a browse server is pruned and not signalled", () => {
      const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      spawned.push(other);
      fake(base, { pid: other.pid, path: tree.plans });
      assert.doesNotMatch(ctl(["list"]).stdout, new RegExp(`${base}`));
      assert.ok(!existsSync(join(state, `${base}.json`)));
      assert.equal(ctl(["stop", "--all"]).status, 0);
      assert.ok(alive(other.pid), "a non-browse process was signalled");
    });

    test("a reused pid: the port's server matches, but the entry names another process", async () => {
      const srv = await startServer(tree.plans);
      spawned.push(srv.child);
      const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      spawned.push(other);
      const port = Number(srv.url.split(":").pop());
      fake(port, { pid: other.pid, path: tree.plans });
      assert.equal(ctl(["list"]).stdout.trim(), "no browse servers running");
      assert.equal(ctl(["stop", "--all"]).status, 0);
      assert.ok(alive(other.pid), "a non-browse process was signalled");
    });

    test("a browse server on the port whose pid isn't the entry's", async () => {
      const a = await startServer(tree.plans);
      const b = await startServer(tree.plans);
      spawned.push(a.child, b.child);
      const port = Number(a.url.split(":").pop());
      fake(port, { pid: b.child.pid, path: tree.plans });
      assert.equal(ctl(["list"]).stdout.trim(), "no browse servers running");
      assert.equal(ctl(["stop", "--all"]).status, 0);
      assert.ok(alive(b.child.pid), "the other browse server was signalled");
    });

    test("a process that merely mentions serve-md.mjs in its arguments", async () => {
      const other = await stub(tree.root, "stub.mjs", base, tree.plans, { args: ["vim-serve-md.mjs"] });
      spawned.push(other);
      fake(base, { pid: other.pid, path: tree.plans });
      assert.equal(ctl(["list"]).stdout.trim(), "no browse servers running");
      assert.ok(alive(other.pid), "a non-browse process was signalled");
    });

    test("a browse server pid with nothing listening on the entry's port", async () => {
      const srv = await startServer(tree.plans);
      spawned.push(srv.child);
      fake(base, { pid: srv.child.pid, path: tree.plans });
      assert.equal(ctl(["list"]).stdout.trim(), "no browse servers running");
      assert.ok(!existsSync(join(state, `${base}.json`)), "entry kept although its port refused");
    });

    test("a server too busy to answer keeps its entry, and is reused once it answers", async () => {
      ctl(["ensure", tree.plans]);
      const { pid } = entryAt(base);
      process.kill(pid, "SIGSTOP");
      try {
        ctl(["list"]);
        assert.ok(existsSync(join(state, `${base}.json`)), "entry pruned while the server was only paused");
      } finally {
        process.kill(pid, "SIGCONT");
      }
      assert.equal(ctl(["ensure", tree.plans]).stdout.trim(), `http://localhost:${base} (already running)`);
    });

    test("unreadable or mismatched entries are pruned; other files are left alone", async () => {
      ctl(["ensure", tree.plans]);
      const real = entryAt(base);
      writeFileSync(join(state, `${base + 1}.json`), "{not json");
      writeFileSync(join(state, `${base + 2}.json`), JSON.stringify(real));
      writeFileSync(join(state, "junk.json"), "{}");
      writeFileSync(join(state, `${base}.json.123.tmp`), "{}");
      const out = ctl(["list"]).stdout.trim().split("\n");
      assert.equal(out.length, 1);
      assert.match(out[0], new RegExp(`^${base}\\s`));
      assert.deepEqual(readdirSync(state).filter((f) => f.includes("json")).sort(),
        [`${base}.json`, `${base}.json.123.tmp`, "junk.json"].sort());
    });

    test("a browse server whose health doesn't match the entry's path", async () => {
      const srv = await startServer(join(tree.root, "other"));
      spawned.push(srv.child);
      const port = Number(srv.url.split(":").pop());
      fake(port, { pid: srv.child.pid, path: tree.plans });
      assert.equal(ctl(["list"]).stdout.trim(), "no browse servers running");
      assert.ok(!existsSync(join(state, `${port}.json`)));
    });
  });

  describe("list and stop", () => {
    async function three() {
      ctl(["ensure", tree.plans], { CLAUDE_CODE_SESSION_ID: "sess-a" });
      ctl(["ensure", join(tree.root, "other")], { CLAUDE_CODE_SESSION_ID: "sess-b" });
      ctl(["ensure", join(tree.root, "plans-evil")], { CLAUDE_CODE_SESSION_ID: "" });
      const all = entries().sort((a, b) => a.port - b.port);
      assert.equal(all.length, 3, "precondition: three servers registered");
      return all;
    }

    test("list shows port, owner and path, marking this session's", async () => {
      await three();
      const out = ctl(["list"]).stdout;
      assert.match(out, new RegExp(`${base}\\s+sess-a \\(this session\\)\\s+\\S+\\s+${tree.plans}`));
      assert.match(out, new RegExp(`${base + 1}\\s+sess-b\\s`));
      assert.match(out, new RegExp(`${base + 2}\\s+shared\\s`));
    });

    test("stop --mine stops only this session's servers", async () => {
      const [a, b, shared] = await three();
      const r = ctl(["stop", "--mine"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`stopped ${base} `));
      assert.ok(!alive(a.pid), "own server still running");
      assert.ok(alive(b.pid), "another session's server was stopped");
      assert.ok(alive(shared.pid), "the shared server was stopped");
      assert.equal(entryAt(base), undefined);
    });

    test("stop --mine with no session id is a usage error", () => {
      const r = ctl(["stop", "--mine"], { CLAUDE_CODE_SESSION_ID: "" });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /no Claude session id/);
    });

    test("stop --port stops that server, shared or not", async () => {
      const [, , shared] = await three();
      ctl(["stop", "--port", String(shared.port)]);
      assert.ok(!alive(shared.pid));
      assert.equal(entries().length, 2);
    });

    test("stop --port with no live server there exits 1", () => {
      const r = ctl(["stop", "--port", String(base + 5)]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`no browse server on port ${base + 5}`));
    });

    test("stop --all stops every registered server", async () => {
      const all = await three();
      ctl(["stop", "--all"]);
      assert.ok(all.every((e) => !alive(e.pid)));
      assert.equal(entries().length, 0);
    });

    test("stop reports a server that ignores SIGTERM, and keeps its entry", async () => {
      const dir = mkdtempSync(join(tmpdir(), "browse-stub-"));
      const stubborn = await stub(dir, "serve-md.mjs", base, tree.plans, { ignoreTerm: true });
      spawned.push(stubborn);
      writeFileSync(join(state, `${base}.json`), JSON.stringify({
        pid: stubborn.pid, port: base, path: tree.plans, owner: "shared", started: new Date().toISOString(),
      }));
      const r = ctl(["stop", "--port", String(base)]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`${base} \\(pid ${stubborn.pid}\\) did not exit`));
      assert.doesNotMatch(r.stdout, /stopped/);
      assert.ok(existsSync(join(state, `${base}.json`)), "entry of a running server deleted");
    });

    test("stop --mine honours BROWSE_OWNER, as ensure does", async () => {
      ctl(["ensure", tree.plans], { BROWSE_OWNER: "agent-x" });
      const { pid } = entryAt(base);
      assert.match(ctl(["list"], { BROWSE_OWNER: "agent-x" }).stdout, /agent-x \(this session\)/);
      assert.equal(ctl(["stop", "--mine"]).stdout.trim(), "nothing to stop");
      ctl(["stop", "--mine"], { BROWSE_OWNER: "agent-x" });
      assert.ok(!alive(pid));
    });

    test("stop with no selector is a usage error", () => {
      assert.equal(ctl(["stop"]).status, 2);
    });
  });
});
