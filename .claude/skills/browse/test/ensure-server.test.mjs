// ensure-server.sh is now a wrapper over browse-ctl.mjs (see ctl.test.mjs). These
// tests run a COPY of the skill from a temp dir with its own HOME, so the real
// registry and servers are never touched. `open` is shimmed so no tab appears.
// TODO(LAR-400): run in place instead of copying the skill; test the default path.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { SKILL_DIR, SERVER, ENSURE, fixtureTree, freePort, startServer, rawGet } from "./helpers.mjs";

// A suite-level timeout, so a regression fails instead of hanging the run.
describe("ensure-server.sh", { timeout: 60_000 }, () => {
  let tree, skill, server, ensure, env, opened, hosts, port, home;

  const run = (args, extraEnv = {}) =>
    spawnSync("sh", [ensure, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const health = async (p = port) => {
    const r = await rawGet(`http://127.0.0.1:${p}`, "/__health").catch(() => null);
    return r && JSON.parse(r.body).path;
  };
  // No shell: Linux's sh (dash) forks pgrep rather than exec'ing it, and the
  // `sh -c` wrapper's own command line matches the pattern, adding a new PID per call.
  const serverPids = () => {
    try { return execFileSync("pgrep", ["-f", server], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
    catch { return []; }
  };
  const openCalls = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n").filter(Boolean) : []);

  before(async () => {
    tree = fixtureTree();
    skill = join(tree.root, "skill");
    mkdirSync(skill);
    server = join(skill, "serve-md.mjs");
    ensure = join(skill, "ensure-server.sh");
    copyFileSync(SERVER, server);
    copyFileSync(ENSURE, ensure);
    for (const f of ["registry.mjs", "browse-ctl.mjs"]) copyFileSync(join(SKILL_DIR, f), join(skill, f));

    home = join(tree.root, "home");
    mkdirSync(join(home, ".claude", "state"), { recursive: true });
    const bin = join(tree.root, "bin");
    mkdirSync(bin);
    opened = join(tree.root, "opened.log");
    writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`);
    chmodSync(join(bin, "open"), 0o755);

    hosts = join(tree.root, "hosts");
    writeFileSync(hosts, "127.0.0.1\tlocalhost\n127.0.0.1 plans.localhost   # /browse preview server\n");
    port = String(await freePort());
    // Cleared, so a value set in the shell running the tests can't change the outcome.
    const ambient = ["BROWSE_STATE_DIR", "BROWSE_OWNER", "BROWSE_HOST", "CLAUDE_CODE_SESSION_ID",
      "BROWSE_NODE", "SSH_CONNECTION", "SSH_TTY", "WAYLAND_DISPLAY"];
    // Keep the port scan off the real 3200 range; ports already held are skipped.
    env = {
      ...process.env, ...Object.fromEntries(ambient.map((k) => [k, ""])),
      // DISPLAY set, so Linux CI counts as a desktop and --open isn't dropped.
      HOME: home, PATH: `${bin}:${process.env.PATH}`, BROWSE_HOSTS_FILE: hosts, DISPLAY: ":0",
      BROWSE_PORT_MIN: port, BROWSE_PORT_MAX: String(Number(port) + 15),
    };
  });

  after(() => spawnSync("pkill", ["-f", server]));

  test("starts a server and opens the browser once", async () => {
    const r = run([tree.plans, port, "--open"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `http://plans.localhost:${port} (started)`);
    assert.equal(await health(), tree.plans);
    assert.deepEqual(openCalls(), [`http://plans.localhost:${port}`]);
  });

  test("keeps a server already serving the path, and opens no second tab", async () => {
    const before = serverPids();
    const r = run([tree.plans, port, "--open"]);
    assert.equal(r.stdout.trim(), `http://plans.localhost:${port} (already running)`);
    assert.deepEqual(serverPids(), before, "same process, so open tabs keep live reload");
    assert.equal(openCalls().length, 1);
  });

  test("servers it starts are shared, so a session's stop --mine leaves them", () => {
    const entry = JSON.parse(readFileSync(join(home, ".claude", "state", "browse", `${port}.json`), "utf8"));
    assert.equal(entry.owner, "shared");
  });

  test("a different path starts a second server and leaves the first running", async () => {
    const other = join(tree.root, "plans-evil");
    const r = run([other]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(started\)/);
    assert.equal(await health(), tree.plans, "first server was replaced");
    assert.equal(serverPids().length, 2);
  });

  test("never kills a non-browse process on the port", async () => {
    const foreign = createServer().listen(Number(await freePort()), "127.0.0.1");
    await new Promise((r) => foreign.once("listening", r));
    const fport = String(foreign.address().port);
    try {
      // A path nothing serves yet: an already-served path is reused, whatever port is asked for.
      const fresh = join(tree.root, "fresh");
      mkdirSync(fresh);
      const r = run([fresh, fport]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`port ${fport} is in use`));
      assert.ok(foreign.listening, "foreign listener still up");
      assert.equal(await health(), tree.plans, "existing browse server left running");
    } finally {
      foreign.close();
    }
  });

  test("a missing directory fails without touching the running server", async () => {
    const r = run([join(tree.root, "nope"), port]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no such file or directory/);
    assert.equal(await health(), tree.plans);
  });

  // With no path, the wrapper is the session-start hook: it serves the autostart
  // folder, exits 0 whatever happens, and logs why it didn't start anything.
  const state = () => join(home, ".claude", "state", "browse");
  const log = () => (existsSync(join(state(), "autostart.log")) ? readFileSync(join(state(), "autostart.log"), "utf8") : "");
  const folder = (name) => {
    const dir = join(tree.root, name);
    mkdirSync(dir);
    return dir;
  };
  // A PATH entry whose `uname` reports another OS.
  const fakeUname = (os) => {
    const dir = mkdtempSync(join(tree.root, "uname-"));
    writeFileSync(join(dir, "uname"), `#!/bin/sh\necho ${os}\n`);
    chmodSync(join(dir, "uname"), 0o755);
    return `${dir}:${env.PATH}`;
  };

  test("no path, nothing to autostart: exits 0, starts nothing, logs why with a timestamp", () => {
    const before = serverPids().length;
    const r = run(["--open"]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(log(), /^\d{4}-\d\d-\d\dT\S+ browse: nothing to autostart/m);
    assert.equal(serverPids().length, before);
  });

  test("no path serves the saved autostart folder", async () => {
    const dir = folder("auto");
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), "autostart"), dir + "\n");
    try {
      const r = run(["--open"]);
      assert.equal(r.status, 0, log());
      assert.match(r.stdout, /\(started\)/);
      const p = r.stdout.match(/:(\d+)/)[1];
      assert.equal(await health(p), dir);
    } finally {
      rmSync(join(state(), "autostart"));
    }
  });

  test("an explicit ~/ path expands to HOME", async () => {
    mkdirSync(join(home, "docs"));
    const r = run(["~/docs"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await health(r.stdout.match(/:(\d+)/)[1]), join(home, "docs"));
  });

  test("on an unsupported OS, the hook exits 0 and logs; an explicit call fails", () => {
    const PATH = fakeUname("MINGW64_NT-10.0");
    assert.equal(run([], { PATH }).status, 0);
    assert.match(log(), /unsupported/);
    const r = run([tree.plans], { PATH });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unsupported/);
  });

  test("with no node, the hook exits 0 and logs; an explicit call fails", () => {
    assert.equal(run([], { BROWSE_NODE: "/no/such/node" }).status, 0);
    assert.match(log(), /no node/);
    const r = run([tree.plans], { BROWSE_NODE: "/no/such/node" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no node/);
  });

  test("finds node outside PATH, as a hook's PATH may lack it", (t) => {
    const minimal = `${dirname(env.PATH.split(":")[0])}/bin:/usr/bin:/bin`;
    const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
    if (["/usr/bin/node", "/bin/node"].some(existsSync)) return t.skip("node is on the minimal PATH");
    if (!candidates.some(existsSync)) return t.skip("no node in a fallback location");
    const r = run([tree.plans], { PATH: minimal });
    assert.equal(r.status, 0, r.stderr);
  });

  test("over SSH, --open is dropped", async () => {
    const calls = openCalls().length;
    const r = run([folder("ssh"), "--open"], { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" });
    assert.match(r.stdout, /\(started\)/);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(openCalls().length, calls);
  });

  test("on Linux, --open needs a display", async () => {
    const PATH = fakeUname("Linux");
    const calls = openCalls().length;
    assert.match(run([folder("headless"), "--open"], { PATH, DISPLAY: "" }).stdout, /\(started\)/);
    const desktop = run([folder("desktop"), "--open"], { PATH }).stdout;
    assert.match(desktop, /\(started\)/);
    // `open` is spawned without waiting, so give the control run's call time to land.
    for (let i = 0; i < 40 && openCalls().length === calls; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(openCalls().slice(calls), [desktop.split(" ")[0]], "only the run with DISPLAY opened a tab");
  });
});

// The hook is optional per-machine setup (SKILL.md → Autostart), so this checks
// the one in the user's settings only when there is one. A browse hook that's
// there must be well-formed.
describe("SessionStart autostart hook", () => {
  const settings = join(homedir(), ".claude", "settings.json");

  test("runs ensure-server.sh on startup only, with --open, output discarded", (t) => {
    if (!existsSync(settings)) return t.skip(`no ${settings}`);
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks?.SessionStart ?? [];
    const isBrowse = (h) => h.command?.includes("browse/ensure-server.sh");
    const entry = hooks.find((m) => m.hooks?.some(isBrowse));
    if (!entry) return t.skip("no browse autostart hook in settings.json");
    assert.equal(entry.matcher, "startup");
    const cmd = entry.hooks.find(isBrowse).command;
    assert.match(cmd, /ensure-server\.sh( \S+)? --open/);
    assert.match(cmd, />\/dev\/null 2>&1$/, "silent: costs no context");
    assert.ok(existsSync(cmd.split(" ")[0]), "script path exists");
  });
});
