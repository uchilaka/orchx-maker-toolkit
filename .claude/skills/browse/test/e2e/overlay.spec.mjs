import { test, expect } from "@playwright/test";

// S7: the full-screen overlay. A native <dialog> holding a copy of the diagram, fitted
// to the screen, with pan and zoom from @panzoom/panzoom (loaded on first expand).

const expandFirst = (page) => page.getByRole("button", { name: "Expand diagram" }).first();
const dialog = (page) => page.getByRole("dialog", { name: "Diagram" });
// Panzoom transforms [data-zoom]; its matrix gives the scale (a) and the pan (e, f).
const transform = (page) =>
  page.locator("[data-zoom]").evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { scale: m.a, x: m.e, y: m.f };
  });

// Panzoom animates the button zooms, so a reading taken mid-animation isn't where the
// zoom ends up. Waits until two readings 100ms apart agree.
async function settled(page) {
  let last = null;
  await expect.poll(async () => {
    const now = (await transform(page)).scale;
    const same = last !== null && Math.abs(now - last) < 1e-4;
    last = now;
    return same;
  }, { intervals: [100] }).toBe(true);
  return last;
}

async function open(page) {
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await expandFirst(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator("[data-zoom] svg")).toHaveCount(1);
}

test("panzoom is fetched on the first expand, not before", async ({ page }) => {
  const fetched = [];
  page.on("request", (r) => { if (r.url().includes("@panzoom/panzoom")) fetched.push(r.url()); });
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  expect(fetched).toEqual([]);
  await expandFirst(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect.poll(() => fetched.length).toBe(1);
  expect(fetched[0]).toMatch(/@panzoom\/panzoom@\d+\.\d+\.\d+\//);
});

test("opens fitted to the screen, larger than in the column", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  const inline = await page.locator("pre.mermaid svg").first().boundingBox();
  await expandFirst(page).click();
  await expect(dialog(page)).toBeVisible();
  // The zoom box's padding keeps the fitted diagram off the screen edges, so "fitted"
  // means filling its content box, not the whole stage.
  const box = await page.locator("[data-zoom]").evaluate((el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const px = (v) => parseFloat(cs[v]);
    return {
      x: r.x + px("paddingLeft"), y: r.y + px("paddingTop"),
      width: r.width - px("paddingLeft") - px("paddingRight"),
      height: r.height - px("paddingTop") - px("paddingBottom"),
      padding: px("paddingLeft"),
    };
  });
  expect(box.padding).toBeGreaterThan(0);
  const shape = await page.locator("[data-zoom] svg").evaluate((el) => {
    // The <svg> box fills the content box; the drawing inside is letterboxed by
    // preserveAspectRatio, so measure the drawing's own aspect too.
    const vb = el.viewBox.baseVal, r = el.getBoundingClientRect();
    const scale = Math.min(r.width / vb.width, r.height / vb.height);
    return { x: r.x, y: r.y, width: r.width, height: r.height, drawnWidth: vb.width * scale, drawnHeight: vb.height * scale };
  });
  expect(shape.drawnWidth).toBeGreaterThan(inline.width * 1.2);
  // Fitted: the <svg> fills the content box, and the drawing fills it along one axis.
  expect(Math.abs(shape.x - box.x)).toBeLessThan(2);
  expect(Math.abs(shape.width - box.width)).toBeLessThan(2);
  expect(Math.abs(shape.height - box.height)).toBeLessThan(2);
  const fillsWidth = Math.abs(shape.drawnWidth - box.width) < 2;
  const fillsHeight = Math.abs(shape.drawnHeight - box.height) < 2;
  expect(fillsWidth || fillsHeight).toBe(true);
  expect((await transform(page)).scale).toBeCloseTo(1);
});

test("zoom buttons and the wheel zoom; reset returns to fit", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1);
  const zoomed = (await transform(page)).scale;
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect.poll(async () => (await transform(page)).scale).toBeLessThan(zoomed);

  const stage = await page.locator("[data-stage]").boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  const before = await settled(page);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(before);

  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(1);
  const t = await transform(page);
  expect(Math.abs(t.x) + Math.abs(t.y)).toBeLessThan(1);
});

test("dragging pans the diagram", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const stage = await page.locator("[data-stage]").boundingBox();
  const start = await transform(page);
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 150, cy - 80, { steps: 8 });
  await page.mouse.up();
  const end = await transform(page);
  expect(Math.abs(end.x - start.x) + Math.abs(end.y - start.y)).toBeGreaterThan(50);
});

test("Esc closes, and focus goes back to the expand button", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(expandFirst(page)).toBeFocused();
});

test("the close button closes, and focus goes back to the expand button", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(expandFirst(page)).toBeFocused();
  await expect(page.locator("[data-zoom] svg")).toHaveCount(0);
});

test("opens from the keyboard, with focus inside the dialog", async ({ page }) => {
  await page.goto("/wide.md");
  await expect(page.locator("pre.mermaid svg")).toHaveCount(2);
  await expandFirst(page).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement.closest("dialog"))).toBe(true);
});

test("an open overlay follows a theme switch", async ({ page }) => {
  await open(page);
  const fill = () => page.locator("[data-zoom] svg .node rect").first().evaluate((el) => getComputedStyle(el).fill);
  const light = await fill();
  // The header's switch sits under the modal, so flip the theme the way it does.
  await page.evaluate(() => window.browseTheme("dark"));
  await expect.poll(fill).not.toBe(light);
  await expect(dialog(page)).toBeVisible();
});

const zoomControls = (page) =>
  ["Zoom in", "Zoom out", "Reset zoom"].map((name) => dialog(page).getByRole("button", { name }));

test("the zoom controls stay disabled until pan and zoom has loaded", async ({ page }) => {
  // Hold panzoom's request, so the overlay is open but has nothing to zoom with yet.
  let release;
  const held = new Promise((done) => { release = done; });
  await page.route(/@panzoom\/panzoom/, async (route) => { await held; await route.continue(); });
  await open(page);
  for (const control of zoomControls(page)) await expect(control).toBeDisabled();
  release();
  for (const control of zoomControls(page)) await expect(control).toBeEnabled();
});

test("without pan and zoom, the overlay still opens fitted, its zoom controls disabled", async ({ page }) => {
  const logged = page.waitForEvent("console", (msg) => msg.type() === "error" && msg.text().includes("pan and zoom unavailable"));
  await page.route(/@panzoom\/panzoom/, (route) => route.abort());
  await open(page);
  await logged;
  for (const control of zoomControls(page)) await expect(control).toBeDisabled();
  await expect(page.locator("[data-zoom] svg")).toBeVisible();
  // Closing and reopening doesn't leave them enabled either.
  await page.keyboard.press("Escape");
  await expandFirst(page).click();
  for (const control of zoomControls(page)) await expect(control).toBeDisabled();
});
