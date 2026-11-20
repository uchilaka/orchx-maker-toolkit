import { test, expect, devices } from "@playwright/test";

// S6: the expand button. It stays out of the way until you reach for the diagram: shown
// on hover and on keyboard focus, and always shown where there is no hover (touch).

const expandButtons = (page) => page.getByRole("button", { name: "Expand diagram" });

test("every diagram has one expand button, hidden until the diagram is hovered", async ({ page }) => {
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  const buttons = expandButtons(page);
  await expect(buttons).toHaveCount(2);
  await expect(buttons.first()).toHaveCSS("opacity", "0");
  await page.locator("[data-diagram]").first().hover();
  await expect(buttons.first()).toHaveCSS("opacity", "1");
  await expect(buttons.nth(1)).toHaveCSS("opacity", "0");
});

test("the button is reachable by keyboard and shows while it has focus", async ({ page }) => {
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  const first = expandButtons(page).first();
  for (let i = 0; i < 30 && !(await first.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("opacity", "1");
});

test.describe("on a touch screen", () => {
  // The preset's browser type can't change inside a describe; Chromium is what we run.
  const { defaultBrowserType, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("the button is always visible, since there's no hover to reveal it", async ({ page }) => {
    await page.goto("/wide.md");
    await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await expect(expandButtons(page).first()).toHaveCSS("opacity", "1");
  });
});

// Mermaid sizes an SVG to width 100% with a max-width, so a wide diagram shrinks to the
// column instead of scrolling. That shrinking is what makes it unreadable, and what
// the overlay exists to undo. The inner scroll box only matters for a diagram type
// that opts out of max-width.
test("the wide fixture is shrunk to the column, with the button in the frame's corner", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  const svg = page.locator("pre.mermaid svg").first();
  const { natural, rendered } = await svg.evaluate((el) => ({
    natural: el.viewBox.baseVal.width,
    rendered: el.getBoundingClientRect().width,
  }));
  expect(rendered, "the fixture must be too wide for the column, or it tests nothing").toBeLessThan(natural);

  const frame = await page.locator("[data-diagram]").first().boundingBox();
  const button = await expandButtons(page).first().boundingBox();
  expect(frame.x + frame.width - (button.x + button.width)).toBeLessThan(16);
  expect(button.y - frame.y).toBeLessThan(16);
});
