// Shared fixtures for the /browse tests. Run everything with:
//   node --test ~/.claude/skills/browse/test/'*.test.mjs'
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";

export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = join(SKILL_DIR, "serve-md.mjs");
export const ENSURE = join(SKILL_DIR, "ensure-server.sh");

export const PLAN = `# Fix the thing

## Status: IN PROGRESS (2026-09-19)

## Context

This paragraph is hard-wrapped
across two lines.

## Steps

- [x] Done step
- [ ] Open step that wraps
  onto a second line

1. First
2. Second

## Steps

| Name | Value |
|---|---|
| \`snake_case\` | [link](https://example.com) |

\`\`\`sh
echo **not bold** - not a list [not](a-link)
\`\`\`

> quoted
`;

// A throwaway tree: plans/ holds the served docs; plans-evil/ is a sibling whose
// name shares plans/'s prefix, for the path-traversal guard.
export function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "browse-test-"));
  const plans = join(root, "plans");
  mkdirSync(join(plans, "global"), { recursive: true });
  mkdirSync(join(root, "plans-evil"));
  writeFileSync(join(plans, "top.md"), "# Top level doc\n\nHello.\n");
  writeFileSync(join(plans, "global", "PLAN.md"), PLAN);
  writeFileSync(join(plans, "global", "done.md"), "# Finished\n\n## Status: RESOLVED (2026-09-20)\n");
  writeFileSync(join(root, "outside.md"), "# SECRET outside\n");
  writeFileSync(join(root, "plans-evil", "leak.md"), "# SECRET sibling\n");
  return { root, plans };
}

// Start serve-md.mjs on a free port; resolves once it prints its URL. Its
// registry entry goes to a throwaway state dir unless the test passes one, so
// tests never write into the real ~/.claude/state/browse.
export function startServer(path, { env = {}, server = SERVER } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, path, "--port", "0"], {
      env: { ...process.env, BROWSE_STATE_DIR: mkdtempSync(join(tmpdir(), "browse-state-")), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/URL: (http:\/\/[^\s]+)/);
      if (m) resolve({ child, url: m[1], base: `http://127.0.0.1:${m[1].split(":").pop()}`, out });
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

// GET with the path sent exactly as given (fetch() would normalize ../).
export function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    // agent: false → a fresh connection per request. A pooled keep-alive socket
    // outlives a server that ensure-server.sh just replaced, and fails the next GET.
    const req = request({ hostname, port, path, method: "GET", agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
