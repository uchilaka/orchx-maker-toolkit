import { test, expect } from "@playwright/test";

// Mermaid loads from a pinned CDN URL, so these tests need the network. Each page
// starts on the light theme: the stored choice lives in localStorage, which every test
// gets fresh.

test("diagrams render, and a theme switch redraws them in place", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("/wide.md");
  const diagrams = page.locator("pre.mermaid svg");
  await expect(diagrams).toHaveCount(2);
  const node = page.locator("pre.mermaid svg .node rect").first();
  const lightFill = await node.evaluate((el) => getComputedStyle(el).fill);

  const rendered = page.evaluate(() => new Promise((r) => addEventListener("browse:mermaid-rendered", r, { once: true })));
  await page.getByRole("radio", { name: "Dark" }).click();
  await rendered;
  await expect(diagrams).toHaveCount(2);
  const darkFill = await page.locator("pre.mermaid svg .node rect").first().evaluate((el) => getComputedStyle(el).fill);

  expect(darkFill).not.toBe(lightFill);
  expect(errors).toEqual([]);
});
