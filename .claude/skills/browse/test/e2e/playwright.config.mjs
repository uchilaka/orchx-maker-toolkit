import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// serve-md writes a registry entry under $HOME/.claude/state/browse/ once it's
// listening. A throwaway HOME keeps test runs out of the real registry, where they'd
// show up as a server for the user's /browse to find.
const home = mkdtempSync(join(tmpdir(), "browse-e2e-home-"));
const PORT = 4790;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ${resolve(import.meta.dirname, "../../serve-md.mjs")} ${resolve(import.meta.dirname, "fixtures")} --port ${PORT}`,
    url: `http://localhost:${PORT}/wide.md`,
    env: { HOME: home },
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
