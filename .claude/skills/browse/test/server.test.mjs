import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "node:http";
import { fixtureTree, startServer, rawGet } from "./helpers.mjs";

describe("server, directory mode", { timeout: 30_000 }, () => {
  let tree, srv;
  before(async () => {
    tree = fixtureTree();
    srv = await startServer(tree.plans, { env: { BROWSE_HOST: "plans.localhost" } });
  });
  after(() => srv.child.kill());

  test("prints the vanity URL when BROWSE_HOST is set", () => {
    assert.match(srv.url, /^http:\/\/plans\.localhost:\d+$/);
  });

  test("/__health returns the served path", async () => {
    const r = await rawGet(srv.base, "/__health");
    assert.equal(r.status, 200);
    assert.equal(r.body, tree.plans);
  });

  test("index: a card per file with its title and status, grouped by folder", async () => {
    const { body } = await rawGet(srv.base, "/");
    assert.equal((body.match(/<li data-search=/g) || []).length, 3);
    assert.match(body, />Fix the thing<\/h3>/);
    assert.match(body, />IN PROGRESS<\/span>/);
    assert.match(body, />RESOLVED<\/span>/);
    assert.match(body, /Top level/);
    assert.match(body, /<a href="\/global\/"/);
    assert.match(body, /id="filter"/);
  });

  test("sub-index links resolve under the subfolder", async () => {
    const { body } = await rawGet(srv.base, "/global/");
    assert.match(body, /href="\/global\/PLAN\.md"/);
    assert.doesNotMatch(body, /href="\/PLAN\.md"/);
  });

  test("a document renders with breadcrumbs back to its folder", async () => {
    const { status, body } = await rawGet(srv.base, "/global/PLAN.md");
    assert.equal(status, 200);
    assert.match(body, /<a href="\/global\/"[^>]*>global<\/a>/);
    assert.match(body, /aria-current="page">PLAN\.md</);
  });

  test("unknown paths get the 404 page", async () => {
    const r = await rawGet(srv.base, "/nope.md");
    assert.equal(r.status, 404);
    assert.match(r.body, /Page not found/);
  });

  for (const [label, path] of [
    ["parent directory", "/..%2Foutside.md"],
    ["sibling sharing the folder's name prefix", "/..%2Fplans-evil%2Fleak.md"],
  ]) {
    test(`path traversal into a ${label} is refused`, async () => {
      const r = await rawGet(srv.base, path);
      assert.equal(r.status, 404);
      assert.doesNotMatch(r.body, /SECRET/);
    });
  }

  test("saving a .md file pushes a reload over SSE", async () => {
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reload within 3s")), 3000);
      get(`${srv.base}/__sse`, (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          if (buf.includes("data: connected")) writeFileSync(join(tree.plans, "top.md"), "# Edited\n");
          if (buf.includes("data: reload")) {
            clearTimeout(timer);
            res.destroy();
            resolve(true);
          }
        });
      }).on("error", reject);
    });
    assert.equal(got, true);
  });
});

describe("server, single-file mode", { timeout: 30_000 }, () => {
  let tree, srv;
  before(async () => {
    tree = fixtureTree();
    srv = await startServer(join(tree.plans, "global", "PLAN.md"));
  });
  after(() => srv.child.kill());

  test("serves the one file at / and falls back to localhost in the URL", async () => {
    assert.match(srv.url, /^http:\/\/localhost:\d+$/);
    const { status, body } = await rawGet(srv.base, "/");
    assert.equal(status, 200);
    assert.match(body, /Fix the thing/);
  });
});
