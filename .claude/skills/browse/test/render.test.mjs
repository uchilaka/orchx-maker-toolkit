import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderMarkdown, htmlPage, docPage, STATUS_STYLES } from "../serve-md.mjs";
import { PLAN } from "./helpers.mjs";

const { html, toc } = renderMarkdown(PLAN);

describe("markdown renderer", () => {
  test("fenced code stays literal: no bold, list or link rules run inside it", () => {
    const block = html.match(/<div data-code[\s\S]*?<\/pre>/)[0];
    assert.match(block, />sh</, "language label");
    assert.match(block, /data-copy/, "copy button");
    assert.match(block, /echo \*\*not bold\*\* - not a list \[not\]\(a-link\)/);
    assert.doesNotMatch(block, /<strong>|<li>|<a href/);
  });

  test("inline code is protected from emphasis", () => {
    const out = renderMarkdown("see `~/plans/**/*.md` and `a*b*c`").html;
    assert.match(out, /~\/plans\/\*\*\/\*\.md/);
    assert.match(out, /a\*b\*c/);
    assert.doesNotMatch(out, /<em>|<strong>/);
  });

  test("a spaced asterisk is multiplication, not emphasis", () => {
    assert.doesNotMatch(renderMarkdown("a * b * c").html, /<em>/);
  });

  test("hard-wrapped lines join into one paragraph", () => {
    assert.match(html, /<p>This paragraph is hard-wrapped across two lines\.<\/p>/);
    assert.doesNotMatch(html, /hard-wrapped<br>/);
  });

  test("`## Status:` becomes a badge colored by status, and stays out of the TOC", () => {
    assert.match(html, new RegExp(`${STATUS_STYLES["IN PROGRESS"].split(" ")[0]}[^"]*">IN PROGRESS</span>`));
    assert.match(html, />2026-09-19</);
    assert.ok(!toc.some((t) => /status/i.test(t.label)));
    const resolved = renderMarkdown("## Status: RESOLVED (2026-09-20)").html;
    assert.match(resolved, /bg-emerald-50/);
  });

  test("a lowercase status stays an ordinary heading", () => {
    assert.match(renderMarkdown("## Status: see below").html, /<h2 id="status-see-below"/);
  });

  test("headings get ids, duplicates are numbered, and the TOC holds h2/h3", () => {
    assert.deepEqual(toc.map((t) => t.id), ["context", "steps", "steps-2"]);
    const dup = renderMarkdown("## Phase 2\n\n## Phase 2\n\n## Phase 2").toc.map((t) => t.id);
    assert.deepEqual(dup, ["phase-2", "phase-2-2", "phase-2-3"], "ids ending in a digit dedupe cleanly");
    assert.equal(renderMarkdown("# Title\n\n#### Deep").toc.length, 0);
  });

  test("TOC labels keep underscores inside inline code", () => {
    assert.equal(renderMarkdown("## Rename `session_type`").toc[0].label, "Rename session_type");
  });

  test("task lists render checkboxes; wrapped items stay one item", () => {
    assert.match(html, /<ul class="list-none pl-0">/);
    assert.match(html, /text-zinc-500[^"]*">.*?rounded bg-emerald-500[\s\S]*?Done step/, "done item muted, checked");
    assert.match(html, /Open step that wraps onto a second line/);
    assert.equal((html.match(/size-4 shrink-0/g) || []).length, 2);
  });

  test("numbered lists render as <ol>", () => {
    assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  });

  test("tables get a framed wrapper; inline code and links in cells are styled", () => {
    const t = html.match(/<table[\s\S]*?<\/table>/)[0];
    assert.match(t, /<th scope="col"[^>]*>Name<\/th>/);
    assert.match(t, /<code class="rounded-md[^>]*>snake_case<\/code>/);
    assert.match(t, /<a href="https:\/\/example.com" class="font-medium text-sky-600/);
  });

  test("blockquotes render", () => {
    assert.match(html, /<blockquote>quoted<\/blockquote>/);
  });
});

describe("page shell", () => {
  const page = htmlPage("T", "<p>x</p>", [{ label: "plans", href: "/" }, { label: "doc.md" }]);

  test("no inline CSS: Tailwind CDN with typography, dark mode by class", () => {
    assert.doesNotMatch(page, /<style/);
    assert.match(page, /cdn\.tailwindcss\.com\/3\.4\.17\?plugins=typography/);
    assert.match(page, /tailwind\.config = \{ darkMode: "class" \}/);
  });

  test("<html> carries no dark: classes — they compile to :is(.dark *) and can't match it", () => {
    assert.doesNotMatch(page.match(/<html[^>]*>/)[0], /dark:/);
  });

  test("the hover underline is scoped to links, not <main>", () => {
    // In Tailwind 3, prose-a:hover:x puts :hover on the prose element itself.
    assert.doesNotMatch(page + html, /prose-a:hover:/);
  });

  test("breadcrumbs link every level but the current page", () => {
    assert.match(page, /<a href="\/"[^>]*>plans<\/a>/);
    assert.match(page, /<span[^>]*aria-current="page">doc\.md<\/span>/);
  });

  test("theme switch offers light, system and dark; live pill starts connected", () => {
    const choices = [...page.matchAll(/data-theme-choice="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(choices, ["light", "system", "dark"]);
    assert.match(page, /id="live" data-state="on"/);
  });

  test("docPage adds the On-this-page sidebar only with 2+ entries", () => {
    assert.match(docPage("d", PLAN, []), /aria-label="On this page"/);
    assert.doesNotMatch(docPage("d", "# One\n\n## Only", []), /aria-label="On this page"/);
  });
});

// The head script runs in a stub DOM: OS preference × saved choice.
describe("theme script", () => {
  const src = htmlPage("T", "", []).match(/<script>\ntailwind\.config[\s\S]*?<\/script>/)[0].replace(/<\/?script>/g, "");

  function boot({ osDark, saved, storageThrows = false }) {
    const classes = new Set();
    const store = saved ? { "browse-theme": saved } : {};
    let onOsChange;
    const root = {
      dataset: {},
      style: {},
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    };
    const media = { matches: osDark, addEventListener: (_e, f) => (onOsChange = f) };
    const localStorage = storageThrows
      ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
      : { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) };
    const window = { matchMedia: () => media };
    vm.runInNewContext(src, { window, document: { documentElement: root }, localStorage, tailwind: {} });
    return {
      dark: () => classes.has("dark"),
      root,
      store,
      window,
      osChange(isDark) { media.matches = isDark; onOsChange(); },
    };
  }

  for (const [osDark, saved, want] of [
    [false, null, "light"], [true, null, "dark"], [false, "dark", "dark"],
    [true, "light", "light"], [true, "system", "dark"],
  ]) {
    test(`OS ${osDark ? "dark" : "light"} + saved ${saved ?? "nothing"} → ${want}`, () => {
      const t = boot({ osDark, saved });
      assert.equal(t.dark(), want === "dark");
      assert.equal(t.root.style.colorScheme, want, "color-scheme follows, for scrollbars and inputs");
      assert.equal(t.root.dataset.theme, saved ?? "system");
    });
  }

  test("choosing a theme saves it and applies at once", () => {
    const t = boot({ osDark: false });
    t.window.browseTheme("dark");
    assert.equal(t.dark(), true);
    assert.equal(t.store["browse-theme"], "dark");
  });

  test("on System, an OS change is followed live; a forced theme ignores it", () => {
    const sys = boot({ osDark: false });
    sys.osChange(true);
    assert.equal(sys.dark(), true);
    const forced = boot({ osDark: false, saved: "light" });
    forced.osChange(true);
    assert.equal(forced.dark(), false);
  });

  test("blocked localStorage falls back to System instead of throwing", () => {
    const t = boot({ osDark: true, storageThrows: true });
    assert.equal(t.dark(), true);
    assert.doesNotThrow(() => t.window.browseTheme("light"));
  });
});
