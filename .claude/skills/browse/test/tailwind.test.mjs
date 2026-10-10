// Compiles the pages' classes with a real Tailwind 3.4 and checks the variants
// this UI depends on. The Play CDN fails silently on a class it can't build,
// so this is the only check that catches it. Skips without a local tailwindcss:
// set TAILWIND_DIR to a project with tailwindcss + @tailwindcss/typography.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlPage, docPage, renderIndex, notFoundPage, dirCrumbs } from "../serve-md.mjs";
import { PLAN, fixtureTree } from "./helpers.mjs";

const TW_DIR = process.env.TAILWIND_DIR || "/opt/Developer/00-larcity-llc/cami-ritv";
const cli = join(TW_DIR, "node_modules", "tailwindcss", "lib", "cli.js");
const available = existsSync(cli) && existsSync(join(TW_DIR, "node_modules", "@tailwindcss", "typography"));

describe("Tailwind 3.4 compile", { skip: !available && `no tailwindcss in ${TW_DIR}` }, () => {
  let css;
  before(async () => {
    const tree = fixtureTree();
    const dir = mkdtempSync(join(tmpdir(), "browse-tw-"));
    const pages = [
      docPage("plan", PLAN, [{ label: "plans", href: "/" }, { label: "PLAN.md" }]),
      await renderIndex(tree.plans, dirCrumbs("", tree.plans), "/"),
      notFoundPage(),
      htmlPage("x", "", []),
    ];
    writeFileSync(join(dir, "pages.html"), pages.join("\n"));
    writeFileSync(join(dir, "in.css"), "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
    writeFileSync(
      join(dir, "tailwind.config.cjs"),
      `module.exports = { darkMode: "class", content: [${JSON.stringify(join(dir, "pages.html"))}],
        plugins: [require(${JSON.stringify(join(TW_DIR, "node_modules", "@tailwindcss", "typography"))})] };`
    );
    const r = spawnSync(process.execPath, [cli, "-c", join(dir, "tailwind.config.cjs"), "-i", join(dir, "in.css"), "-o", join(dir, "out.css")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    css = readFileSync(join(dir, "out.css"), "utf8");
  });

  test("link hover underline targets the hovered link only", () => {
    // Links carry hover:underline themselves; prose-a:hover: would put :hover on <main>.
    assert.match(css, /\.hover\\:underline:hover \{/);
    assert.doesNotMatch(css, /prose-a\\:hover/);
  });

  test("dark: rules key off an ancestor .dark class", () => {
    assert.match(css, /\.dark\\:bg-zinc-950:is\(\.dark \*\)/);
    assert.doesNotMatch(css, /prefers-color-scheme/, "no media-query dark mode left");
  });

  for (const [label, selector] of [
    ["TOC active item", /aria-\\\[current\\=true\\\]\\:text-sky-600\[aria-current="true"\]/],
    ["theme switch checked state", /aria-checked\\:bg-zinc-900\\\/5\[aria-checked="true"\]/],
    ["live pill disconnected state", /data-\\\[state\\=off\\\]\\:bg-rose-50\[data-state="off"\]/],
    ["live dot, via its group", /\.group\[data-state="off"\] \.group-data-\\\[state\\=off\\\]\\:bg-rose-500/],
    ["header blur fallback", /@supports \(backdrop-filter/],
    ["prose dark inversion", /\.dark\\:prose-invert:is\(\.dark \*\)/],
    ["prose code backticks removed", /prose-code\\:before\\:content-none/],
    ["arbitrary grid columns", /grid-cols-\\\[minmax\\\(0\\2c 1fr\\\)_15rem\\\]/],
    ["size-* utilities (3.4+)", /\.size-4 \{/],
  ]) {
    test(label, () => assert.match(css, selector));
  }
});
