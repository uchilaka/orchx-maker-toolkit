// browse-ctl.mjs: ensure / list / stop over the registry. Every test gets its
// own state dir and a port range far from 3200, so the real server is never
// touched. `open` is shimmed so no tab appears.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_DIR, fixtureTree, startServer, rawGet } from "./helpers.mjs";

const CTL = join(SKILL_DIR, "browse-ctl.mjs");
const SPAN = 6;

const listen = (port) => new Promise((resolve, reject) => {
  const s = createServer().once("error", reject).listen(port, "127.0.0.1", () => resolve(s));
});

// A run of SPAN free ports, so the scan has room and nothing else is in it.
async function freeRange() {
  for (let tries = 0; tries < 50; tries++) {
    const base = 41000 + Math.floor(Math.random() * 18000);
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
  const entries = () => readdirSync(state).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(state, f), "utf8")));
  const entryAt = (port) => entries().find((e) => e.port === port);
  const health = async (port) => (await rawGet(`http://127.0.0.1:${port}`, "/__health").catch(() => ({}))).body;
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
      BROWSE_OWNER: "", CLAUDE_CODE_SESSION_ID: "sess-a",
    };
    spawned = [];
  });

  afterEach(() => {
    for (const e of entries()) if (alive(e.pid)) process.kill(e.pid);
    for (const c of spawned) c.kill();
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

    test("uses the vanity host once the hosts file maps it", async () => {
      const hosts = join(tree.root, "hosts2");
      writeFileSync(hosts, "127.0.0.1 plans.localhost   # /browse\n");
      const r = ctl(["ensure", tree.plans], { BROWSE_HOSTS_FILE: hosts });
      assert.equal(r.stdout.trim(), `http://plans.localhost:${base} (started)`);
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
      ctl(["ensure", join(tree.plans, "global", "..", "..", "plans-evil")], { CLAUDE_CODE_SESSION_ID: "" });
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

    test("stop with no selector is a usage error", () => {
      assert.equal(ctl(["stop"]).status, 2);
    });
  });
});
