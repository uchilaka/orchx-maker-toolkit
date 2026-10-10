// ensure-server.sh stops every browse server started from its own path. These
// tests run a COPY of the skill from a temp dir, so the real server (e.g. on
// plans.localhost:3200) is never touched. `open` is shimmed so no tab appears.
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
  let tree, skill, server, ensure, env, opened, hosts, port;

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
    copyFileSync(join(SKILL_DIR, "registry.mjs"), join(skill, "registry.mjs"));

    const home = join(tree.root, "home");
    mkdirSync(join(home, ".claude", "state"), { recursive: true });
    const bin = join(tree.root, "bin");
    mkdirSync(bin);
    opened = join(tree.root, "opened.log");
    writeFileSync(join(bin, "open"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`);
    chmodSync(join(bin, "open"), 0o755);

    hosts = join(tree.root, "hosts");
    writeFileSync(hosts, "127.0.0.1\tlocalhost\n127.0.0.1 plans.localhost   # /browse preview server\n");
    env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, BROWSE_HOSTS_FILE: hosts };
    port = String(await freePort());
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

  test("stops a stray browse server on another port", async () => {
    const stray = await startServer(join(tree.plans, "global"), { server });
    assert.equal(serverPids().length, 2);
    run([tree.plans, port]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stray browse server still running after 3s")), 3000);
      stray.child.once("exit", () => { clearTimeout(timer); resolve(); });
    }).finally(() => stray.child.kill());
    assert.equal(serverPids().length, 1);
    assert.equal(await health(), tree.plans);
  });

  test("replaces the server when a different path is asked for", async () => {
    const other = join(tree.plans, "global");
    assert.match(run([other, port]).stdout, /\(started\)/);
    assert.equal(await health(), other);
    run([tree.plans, port]);
    assert.equal(await health(), tree.plans);
  });

  test("never kills a non-browse process on the port, and stops nothing else first", async () => {
    const foreign = createServer().listen(Number(await freePort()), "127.0.0.1");
    await new Promise((r) => foreign.once("listening", r));
    const fport = String(foreign.address().port);
    try {
      const r = run([tree.plans, fport]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /held by a non-browse process .*not touching it/);
      assert.ok(foreign.listening, "foreign listener still up");
      assert.equal(await health(), tree.plans, "existing browse server left running");
    } finally {
      foreign.close();
    }
  });

  test("a missing directory fails without touching the running server", async () => {
    const r = run([join(tree.root, "nope"), port]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such directory/);
    assert.equal(await health(), tree.plans);
  });

  describe("vanity host lookup", () => {
    for (const [label, file, host, want] of [
      ["name mapped to 127.0.0.1", null, undefined, "plans.localhost"],
      ["partial name doesn't match", null, "plans", "localhost"],
      ["a word in the trailing comment doesn't match", null, "browse", "localhost"],
      ["a commented-out entry doesn't match", "#127.0.0.1 plans.localhost\n", undefined, "localhost"],
      ["tab-separated entry among aliases matches", "127.0.0.1\tfoo plans.localhost bar\n", undefined, "plans.localhost"],
    ]) {
      test(label, () => {
        const hostsFile = file === null ? hosts : join(tree.root, `hosts-${want}-${label.length}`);
        if (file !== null) writeFileSync(hostsFile, file);
        const r = run([tree.plans, port], { BROWSE_HOSTS_FILE: hostsFile, ...(host ? { BROWSE_HOST: host } : {}) });
        assert.equal(r.stdout.trim(), `http://${want}:${port} (already running)`);
      });
    }
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
