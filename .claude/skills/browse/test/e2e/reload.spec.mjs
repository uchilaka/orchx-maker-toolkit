import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// S9: an expanded diagram stays expanded across live reload. Saving the file reloads the
// whole page, so the overlay reopens from sessionStorage: on the diagram with the same
// source if there is one (it moved), else on the one at the same position (it was
// edited), else it stays closed.

const FILE = resolve(import.meta.dirname, "fixtures/reload.md");
const ORIGINAL = readFileSync(FILE, "utf8");
test.afterEach(() => writeFileSync(FILE, ORIGINAL));

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
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await page.waitForTimeout(300); // give a wrong reopen the chance to happen
  await expect(dialog(page)).toBeHidden();
});

test("navigating back to the page doesn't reopen it; only a reload does", async ({ page }) => {
  await expand(page, 0);
  await page.goto("/wide.md");
  await page.goto("/reload.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(dialog(page)).toBeHidden();
});
