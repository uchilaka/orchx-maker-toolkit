import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// S8: the overlay's "Download SVG" and "Copy source" buttons, for the expanded diagram.

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const dialog = (page) => page.getByRole("dialog", { name: "Diagram" });

// The fence bodies of fixtures/wide.md, as written. The page renders each with
// trimEnd(), so that's the exact source the copy should hand back.
const fences = [...readFileSync(resolve(import.meta.dirname, "fixtures/wide.md"), "utf8")
  .matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trimEnd());

async function open(page, nth = 0) {
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await page.getByRole("button", { name: "Expand diagram" }).nth(nth).click();
  await expect(dialog(page)).toBeVisible();
}

// TODO(LAR-566): dark-theme background, height, file name variants, clipboard failure.
test("Download SVG saves the expanded diagram as a standalone SVG", async ({ page }) => {
  await open(page);
  const inline = await page.locator("pre.mermaid svg").first().evaluate((el) => ({
    viewBox: el.getAttribute("viewBox"),
    labels: [...el.querySelectorAll(".nodeLabel")].map((n) => n.textContent),
  }));
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog(page).getByRole("button", { name: "Download SVG" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("wide-diagram-1.svg");
  const text = readFileSync(await download.path(), "utf8");

  // It parses as SVG, matches what's on screen, and renders on its own as an image:
  // a file that only works inside the page (missing namespaces, say) fails to load.
  const saved = await page.evaluate(async (text) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    const img = new Image();
    const loaded = await new Promise((done) => {
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    });
    return {
      error: !!doc.querySelector("parsererror"),
      root: root.localName,
      viewBox: root.getAttribute("viewBox"),
      width: root.getAttribute("width"),
      labels: [...doc.querySelectorAll(".nodeLabel")].map((n) => n.textContent),
      loaded,
      naturalWidth: img.naturalWidth,
    };
  }, text);
  expect(saved.error).toBe(false);
  expect(saved.root).toBe("svg");
  expect(saved.viewBox).toBe(inline.viewBox);
  expect(saved.labels).toEqual(inline.labels);
  expect(saved.labels.length).toBeGreaterThan(0);
  // Sized to the drawing, not the page's width="100%", so it opens at full size.
  expect(saved.width).toBe(inline.viewBox.split(/\s+/)[2]);
  expect(saved.loaded).toBe(true);
  expect(saved.naturalWidth).toBeGreaterThan(0);
});

test("Copy source puts the exact fence source on the clipboard", async ({ page }) => {
  // The second diagram, so the copy follows whichever one was expanded.
  for (const nth of [1, 0]) {
    await open(page, nth);
    await dialog(page).getByRole("button", { name: "Copy source" }).click();
    await expect(dialog(page).getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fences[nth]);
    // The confirmation goes back, and the overlay stays open.
    await expect(dialog(page).getByRole("button", { name: "Copy source" })).toBeVisible();
    await expect(dialog(page)).toBeVisible();
  }
  // The first fence holds <br/>, quotes and arrows: anything escaped on the way into
  // the page has to come back as written.
  expect(fences[0]).toContain('["Design System artifact<br/>project/*"]');
});

test("closing clears the Copied confirmation", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await dialog(page).getByRole("button", { name: "Copy source" }).click();
  await expect(dialog(page).getByRole("button", { name: "Copied" })).toBeVisible();
  // Stop the clock, so the confirmation's own 1.5s timer can't be what clears it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand diagram" }).first().click();
  await expect(dialog(page).getByRole("button", { name: "Copy source" })).toBeVisible();
});
