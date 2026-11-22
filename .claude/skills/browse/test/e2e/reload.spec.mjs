import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// S9: an expanded diagram stays expanded across live reload. Saving the file reloads the
// whole page, so the overlay reopens from sessionStorage: on the diagram with the same
// source if there is one (it moved), else on the one at the same position (it was
// edited), else it stays closed.

const FILE = resolve(import.meta.dirname, "fixtures/reload.md");
// Written out rather than read from the file, so a run stopped mid-test (which leaves
// the file edited) doesn't make the edit the next run's original.
const ORIGINAL = `# Reload

reload.spec.mjs rewrites this file while a diagram is expanded, and puts it back after
each test.

\`\`\`mermaid
flowchart LR
  A[Alpha] --> B[Bravo]
\`\`\`

\`\`\`mermaid
flowchart LR
  C[Charlie] --> D[Delta]
\`\`\`
`;
test.beforeAll(() => {
  if (readFileSync(FILE, "utf8") !== ORIGINAL) writeFileSync(FILE, ORIGINAL);
});
// Putting the file back reloads the page too; wait for that here, or it lands in the
// next test.
test.afterEach(async ({ page }) => {
  if (readFileSync(FILE, "utf8") !== ORIGINAL) await save(page, ORIGINAL);
});

// Counts browse:mermaid-rendered. The overlay decides whether to reopen inside that
// event's handler, so once a render has been counted the decision has been made.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__renders = 0;
    addEventListener("browse:mermaid-rendered", () => window.__renders++);
  });
});
const rendered = (page) => page.waitForFunction(() => window.__renders > 0);

const dialog = (page) => page.getByRole("dialog", { name: "Diagram" });
const shown = (page) => page.locator("[data-zoom] svg .nodeLabel");

async function expand(page, nth) {
  await page.goto("/reload.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await page.getByRole("button", { name: "Expand diagram" }).nth(nth).click();
  await expect(dialog(page)).toBeVisible();
}

// Saves the fixture and waits for the reload it triggers.
async function save(page, text) {
  const reloaded = page.waitForEvent("load");
  writeFileSync(FILE, text);
  await reloaded;
}

test("saving an edit reopens the overlay on the edited diagram", async ({ page }) => {
  await expand(page, 0);
  await save(page, ORIGINAL.replace("A[Alpha] --> B[Bravo]", "A[Alpha] --> B[Bravo] --> E[Echo]"));
  await expect(dialog(page)).toBeVisible();
  await expect(shown(page)).toHaveText(["Alpha", "Bravo", "Echo"]);
});

test("a diagram pushed down by a new one above it is still the one shown", async ({ page }) => {
  await expand(page, 1);
  await save(page, ORIGINAL.replace("```mermaid", "```mermaid\nflowchart LR\n  N[New] --> M[More]\n```\n\n```mermaid"));
  await expect(page.locator("pre.mermaid svg")).toHaveCount(3);
  await expect(dialog(page)).toBeVisible();
  await expect(shown(page)).toHaveText(["Charlie", "Delta"]);
});

test("stays closed when the expanded diagram is gone", async ({ page }) => {
  await expand(page, 1);
  await save(page, ORIGINAL.slice(0, ORIGINAL.lastIndexOf("```mermaid")));
  await expect(page.locator("pre.mermaid svg")).toHaveCount(1);
  await expect(dialog(page)).toBeHidden();
  // Nothing left behind to reopen it on a later reload.
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test("a closed overlay stays closed across a reload", async ({ page }) => {
  await expand(page, 0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await save(page, ORIGINAL.replace("Bravo", "Bravo2"));
  await rendered(page);
  await expect(dialog(page)).toBeHidden();
});

test("navigating back to the page doesn't reopen it; only a reload does", async ({ page }) => {
  await expand(page, 0);
  await page.goto("/wide.md");
  await page.goto("/reload.md");
  await rendered(page);
  await expect(dialog(page)).toBeHidden();
});

test("stays closed when another diagram takes the expanded one's place", async ({ page }) => {
  // The first of two is deleted: the second now sits at its position, but it's a
  // different diagram, not an edit of the same one.
  await expand(page, 0);
  await save(page, ORIGINAL.replace("```mermaid\nflowchart LR\n  A[Alpha] --> B[Bravo]\n```\n\n", ""));
  await expect(page.locator("pre.mermaid svg")).toHaveCount(1);
  await rendered(page);
  await expect(dialog(page)).toBeHidden();
});

test("a second reload before the diagrams render still restores", async ({ page }) => {
  await expand(page, 1);
  // The first reload never renders (mermaid is blocked), so it never gets to restore.
  await page.route(/cdn\.jsdelivr\.net\/npm\/mermaid/, (route) => route.abort());
  await page.reload();
  await page.unroute(/cdn\.jsdelivr\.net\/npm\/mermaid/);
  await page.reload();
  await expect(dialog(page)).toBeVisible();
  await expect(shown(page)).toHaveText(["Charlie", "Delta"]);
});

test("blocked storage skips the restore without breaking the page", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err));
  await page.addInitScript(() => {
    for (const name of ["getItem", "setItem", "removeItem"]) {
      Storage.prototype[name] = () => { throw new DOMException("blocked", "SecurityError"); };
    }
  });
  await expand(page, 0);
  await save(page, ORIGINAL.replace("Bravo", "Bravo2"));
  await rendered(page);
  await expect(dialog(page)).toBeHidden();
  await page.getByRole("button", { name: "Expand diagram" }).first().click();
  await expect(dialog(page)).toBeVisible();
  expect(errors).toEqual([]);
});
