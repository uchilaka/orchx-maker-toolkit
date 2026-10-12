import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fixtureTree, startServer } from "./helpers.mjs";

const entryPath = (dir, url) => join(dir, `${url.split(":").pop()}.json`);

describe("registry entry written by the server", { timeout: 30_000 }, () => {
  test("appears on listen with pid, port, path, url, owner and start time", async () => {
    const tree = fixtureTree();
    const state = mkdtempSync(join(tmpdir(), "browse-state-"));
    const srv = await startServer(tree.plans, { env: { BROWSE_STATE_DIR: state, BROWSE_OWNER: "sess-a" } });
    try {
      const entry = JSON.parse(readFileSync(entryPath(state, srv.url), "utf8"));
      assert.equal(entry.pid, srv.child.pid);
      assert.equal(entry.port, Number(srv.url.split(":").pop()));
      assert.equal(entry.path, tree.plans);
      assert.equal(entry.url, srv.url);
      assert.equal(entry.owner, "sess-a");
      assert.ok(!Number.isNaN(Date.parse(entry.started)), "started is an ISO date");
    } finally {
      srv.child.kill();
    }
  });

  test("owner defaults to the Claude session, then to shared", async () => {
    const tree = fixtureTree();
    for (const [env, want] of [[{ CLAUDE_CODE_SESSION_ID: "sess-b" }, "sess-b"], [{}, "shared"]]) {
      const state = mkdtempSync(join(tmpdir(), "browse-state-"));
      const base = { BROWSE_STATE_DIR: state, BROWSE_OWNER: "", CLAUDE_CODE_SESSION_ID: "" };
      const srv = await startServer(tree.plans, { env: { ...base, ...env } });
      try {
        assert.equal(JSON.parse(readFileSync(entryPath(state, srv.url), "utf8")).owner, want);
      } finally {
        srv.child.kill();
      }
    }
  });

  test("SIGTERM removes the entry", async () => {
    const state = mkdtempSync(join(tmpdir(), "browse-state-"));
    const srv = await startServer(fixtureTree().plans, { env: { BROWSE_STATE_DIR: state } });
    const file = entryPath(state, srv.url);
    const exited = once(srv.child, "exit");
    try {
      assert.ok(existsSync(file), "precondition: entry written");
    } finally {
      srv.child.kill("SIGTERM");
    }
    await exited;
    assert.ok(!existsSync(file), "entry left behind");
  });

  test("an entry that another server has since claimed is left alone", async () => {
    const state = mkdtempSync(join(tmpdir(), "browse-state-"));
    const srv = await startServer(fixtureTree().plans, { env: { BROWSE_STATE_DIR: state } });
    const file = entryPath(state, srv.url);
    try {
      const other = { ...JSON.parse(readFileSync(file, "utf8")), pid: 999999 };
      writeFileSync(file, JSON.stringify(other));
    } finally {
      srv.child.kill("SIGTERM");
    }
    await once(srv.child, "exit");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 999999);
  });
});
