// ensure-server.sh is now a wrapper over browse-ctl.mjs (see ctl.test.mjs). These
// tests run a COPY of the skill from a temp dir with its own HOME, so the real
// registry and servers are never touched. `open` is shimmed so no tab appears.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { SKILL_DIR, SERVER, ENSURE, fixtureTree, freePort, startServer, rawGet } from "./helpers.mjs";

// A suite-level timeout, so a regression fails instead of hanging the run.
describe("ensure-server.sh", { timeout: 60_000 }, () => {
  let tree, skill, server, ensure, env, opened, hosts, port, home;

  const run = (args, extraEnv = {}) =>
    spawnSync("sh", [ensure, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const health = async (p = port) => (await rawGet(`http://127.0.0.1:${p}`, "/__health").catch(() => ({}))).body;
  const serverPids = () => {
    try { return execSync(`pgrep -f ${JSON.stringify(server)}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
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
    // Keep the port scan off the real 3200 range; ports already held are skipped.
    env = {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BROWSE_HOSTS_FILE: hosts,
      BROWSE_PORT_MIN: port, BROWSE_PORT_MAX: String(Number(port) + 5),
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
});

describe("SessionStart autostart hook", () => {
  const settings = join(homedir(), ".claude", "settings.json");

  test("runs ensure-server.sh on startup only, with --open, output discarded", { skip: !existsSync(settings) }, () => {
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks?.SessionStart ?? [];
    const entry = hooks.find((m) => m.hooks.some((h) => h.command.includes("browse/ensure-server.sh")));
    assert.ok(entry, "hook present");
    assert.equal(entry.matcher, "startup");
    const cmd = entry.hooks[0].command;
    assert.match(cmd, /project-plans --open/);
    assert.match(cmd, />\/dev\/null 2>&1$/, "silent: costs no context");
    assert.ok(existsSync(cmd.split(" ")[0]), "script path exists");
  });
});
