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

  test("a mermaid fence becomes a diagram element, escaped and untouched by markdown rules", () => {
    const src = 'flowchart LR\n  A["**not bold**"] -->|"a < b"| B\n  - not a list';
    const out = renderMarkdown("```mermaid\n" + src + "\n```").html;
    const pre = out.match(/<pre class="mermaid">([\s\S]*?)<\/pre>/);
    assert.ok(pre, "diagram element");
    assert.equal(pre[1], src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
    assert.doesNotMatch(out, /data-code|<strong>|<li>/);
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

// A plan can quote a hostile PR or issue body, and the page runs on a port that
// can read every served file, so nothing in the source may become markup.
describe("markdown renderer, untrusted input", () => {
  const render = (md) => renderMarkdown(md).html;

  test("raw HTML is shown as text, not run", () => {
    const out = render("Hi <img src=x onerror=alert(1)> and <script>alert(2)</script>\n");
    assert.doesNotMatch(out, /<img|<script/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test("a quote in a link target can't open a new attribute", () => {
    const out = render('[b](x" onmouseover="alert(2))\n');
    assert.doesNotMatch(out, /" onmouseover="/);
    assert.match(out, /href="x&quot; onmouseover=&quot;alert\(2"/);
  });

  for (const target of ["javascript:alert(1)", "JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    test(`a ${JSON.stringify(target.split(":")[0])} link target is dropped`, () => {
      assert.match(render(`[b](${target})\n`), /<a href="#"/);
    });
  }

  test("http, https, mailto, relative and fragment targets are kept", () => {
    for (const target of ["https://a.example/x", "http://a.example", "mailto:you@example.com", "../other.md", "#steps"]) {
      assert.match(render(`[b](${target})\n`), new RegExp(`<a href="${target.replace(/[.?]/g, "\\$&")}"`));
    }
  });

  test("raw HTML in a heading stays out of the heading, its id and the TOC", () => {
    const { html: out, toc: t } = renderMarkdown("## A <b>bold</b> & co\n");
    assert.match(out, /<h2 id="a-bboldb-co" [^>]*>A &lt;b&gt;bold&lt;\/b&gt; &amp; co</);
    assert.equal(t[0].label, "A <b>bold</b> & co");
  });

  test("raw HTML in a table cell and a status note is escaped", () => {
    const out = render("## Status: PROPOSED (<i>x</i>)\n\n| a |\n|---|\n| <b>c</b> |\n");
    assert.doesNotMatch(out, /<i>|<b>/);
  });

  test("an entity is shown literally rather than decoded", () => {
    assert.match(render("a &lt;b&gt; &#58;\n"), /a &amp;lt;b&amp;gt; &amp;#58;/);
  });

  test("a quoted line still renders as a blockquote", () => {
    assert.match(render("> a -> b\n"), /<blockquote>a -&gt; b<\/blockquote>/);
  });
});

describe("page shell", () => {
  const page = htmlPage("T", "<p>x</p>", [{ label: "plans", href: "/" }, { label: "doc.md" }]);

  test("mermaid loads, pinned, only on pages that hold a diagram", () => {
    const withDiagram = htmlPage("T", renderMarkdown("```mermaid\nflowchart LR\n  A --> B\n```").html);
    assert.match(withDiagram, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.esm\.min\.mjs/);
    assert.doesNotMatch(page, /mermaid/);
  });

  test("the diagram overlay ships only with a diagram, and pan/zoom loads pinned and on demand", () => {
    const withDiagram = htmlPage("T", renderMarkdown("```mermaid\nflowchart LR\n  A --> B\n```").html);
    assert.equal(withDiagram.match(/<dialog data-diagram-dialog/g)?.length, 1);
    assert.doesNotMatch(page, /data-diagram-dialog|panzoom/);
    // Only a dynamic import() may name it: a static import or <script src> would fetch
    // it on every page load, before anyone expands a diagram.
    const refs = withDiagram.match(/[^\n]*@panzoom\/panzoom[^\n]*/g);
    assert.equal(refs.length, 1);
    assert.match(refs[0], /import\("https:\/\/cdn\.jsdelivr\.net\/npm\/@panzoom\/panzoom@\d+\.\d+\.\d+\/dist\/panzoom\.es\.js"\)/);
  });

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

// The diagram script runs in a stub DOM with a fake mermaid that keeps mermaid 11's
// contract for run({ nodes }): it skips nodes already marked data-processed, overwrites
// the rest with their SVG and marks them, and rejects after rendering when any node
// failed. A redraw that skipped restoring the source, or clearing the mark, shows up in
// `sawSource`.
describe("mermaid theme script", () => {
  const SOURCES = ["flowchart LR\n  A --> B", "flowchart TD\n  C --> D"];
  const diagramPage = htmlPage("T", renderMarkdown(SOURCES.map((s) => "```mermaid\n" + s + "\n```").join("\n\n")).html);
  const scriptMatch = diagramPage.match(/<script data-browse-mermaid>([\s\S]*?)<\/script>/);
  // Everything the fakes do settles in microtasks, so one macrotask drains it all.
  const tick = () => new Promise((r) => setImmediate(r));

  function boot({ dark }) {
    const classes = new Set(dark ? ["dark"] : []);
    let observed;
    const nodes = SOURCES.map((s) => ({
      textContent: s,
      dataset: {},
      attrs: {},
      removeAttribute(name) { delete this.attrs[name]; },
    }));
    const runs = [];
    const held = [];
    const fail = { reject: 0, throw: 0 };
    let hold = false;
    let inFlight = 0;
    let maxInFlight = 0;
    let theme;
    const mermaid = {
      initialize: (cfg) => { theme = cfg.theme; },
      run: ({ nodes: sandboxNodes }) => {
        if (fail.throw) { fail.throw--; throw new Error("sync failure"); }
        // The script builds this array inside the vm, so its prototype isn't this
        // realm's Array; copying keeps deepStrictEqual comparing values only.
        const fresh = [...sandboxNodes].filter((n) => !("data-processed" in n.attrs));
        runs.push({ theme, sawSource: fresh.map((n) => n.textContent) });
        fresh.forEach((n) => { n.textContent = "<svg>rendered</svg>"; n.attrs["data-processed"] = "true"; });
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const settle = (ok, err) => { inFlight--; ok(); if (err) throw err; };
        const err = fail.reject ? (fail.reject--, new Error("Parse error on line 2")) : null;
        if (!hold) return Promise.resolve().then(() => settle(() => {}, err));
        return new Promise((res) => held.push(res)).then(() => settle(() => {}, err));
      },
    };
    const events = [];
    const logged = [];
    const window = { dispatchEvent: (e) => events.push(e.type) };
    const document = {
      documentElement: { classList: { contains: (c) => classes.has(c) } },
      querySelectorAll: (sel) => (sel === "pre.mermaid" ? nodes : []),
    };
    class MutationObserver {
      constructor(cb) { this.cb = cb; }
      observe(target, opts) { observed = { target, opts, cb: this.cb }; }
    }
    class CustomEvent { constructor(type) { this.type = type; } }
    const console = { error: (...args) => logged.push(args) };
    vm.runInNewContext(scriptMatch[1], { window, document, MutationObserver, CustomEvent, console });
    return {
      runs,
      events,
      logged,
      fail,
      observed: () => observed,
      maxInFlight: () => maxInFlight,
      hold() { hold = true; },
      async release() { while (held.length) { held.shift()(); await tick(); } },
      start: () => window.browseMermaid(mermaid),
      // The observer callback is the script's schedule(), which returns the queue.
      // TODO(LAR-532): this calls the observer by hand; drive it from the real theme
      // script's class toggle instead.
      flip(on) {
        if (on) classes.add("dark"); else classes.delete("dark");
        return observed.cb([]);
      },
      async setDark(on) { await this.flip(on); },
    };
  }

  test("pages with a diagram carry the theme script; others don't", () => {
    assert.ok(scriptMatch, "diagram page has <script data-browse-mermaid>");
    assert.doesNotMatch(htmlPage("T", "<p>x</p>"), /data-browse-mermaid/);
  });

  test("the module script hands the pinned mermaid to browseMermaid instead of auto-rendering", () => {
    assert.match(diagramPage, /import mermaid from "https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/[^"]+";\s*window\.browseMermaid\(mermaid\);/);
    assert.doesNotMatch(diagramPage, /startOnLoad: true/);
  });

  for (const dark of [false, true]) {
    test(`first render uses the page theme (${dark ? "dark" : "light"}) and announces it`, async () => {
      const t = boot({ dark });
      await t.start();
      assert.equal(t.runs.length, 1);
      assert.equal(t.runs[0].theme, dark ? "dark" : "default");
      assert.deepEqual(t.runs[0].sawSource, SOURCES);
      assert.deepEqual(t.events, ["browse:mermaid-rendered"]);
    });
  }

  test("watches only <html>'s class attribute", async () => {
    const t = boot({ dark: false });
    await t.start();
    const { opts } = t.observed();
    assert.equal(opts.attributes, true);
    assert.deepEqual([...opts.attributeFilter], ["class"]);
  });

  test("each theme flip redraws every node from the original source, not the previous SVG", async () => {
    const t = boot({ dark: false });
    await t.start();
    await t.setDark(true);
    await t.setDark(false);
    await t.setDark(true);
    assert.deepEqual(t.runs.map((r) => r.theme), ["default", "dark", "default", "dark"]);
    for (const r of t.runs) assert.deepEqual(r.sawSource, SOURCES);
  });

  test("a class change that keeps the theme doesn't redraw", async () => {
    const t = boot({ dark: true });
    await t.start();
    await t.setDark(true);
    assert.equal(t.runs.length, 1);
  });

  test("every render announces browse:mermaid-rendered, for the full-screen preview to follow", async () => {
    const t = boot({ dark: false });
    await t.start();
    await t.setDark(true);
    assert.deepEqual(t.events, ["browse:mermaid-rendered", "browse:mermaid-rendered"]);
  });

  test("flips during a render wait their turn, and the last theme wins", async () => {
    const t = boot({ dark: false });
    t.hold();
    const first = t.start();
    await tick(); // let the first render start, so the flips land while it's in flight
    const flips = [t.flip(true), t.flip(false), t.flip(true)];
    await tick();
    assert.equal(t.runs.length, 1, "nothing else starts while the first render is in flight");
    await t.release();
    await Promise.all([first, ...flips]);
    assert.equal(t.maxInFlight(), 1, "never two renders at once");
    assert.deepEqual(t.runs.map((r) => r.theme), ["default", "dark"]);
    assert.equal(t.events.length, t.runs.length);
  });

  test("a diagram that fails to render is logged, still announced, and later flips still redraw", async () => {
    const t = boot({ dark: false });
    t.fail.reject = 1;
    await assert.doesNotReject(t.start(), "the failure is handled, not left as an unhandled rejection");
    assert.equal(t.logged.length, 1);
    assert.match(String(t.logged[0].at(-1)), /Parse error/);
    assert.deepEqual(t.events, ["browse:mermaid-rendered"], "the diagrams that did render are announced");
    await t.setDark(true);
    assert.deepEqual(t.runs.map((r) => r.theme), ["default", "dark"]);
    assert.deepEqual(t.runs[1].sawSource, SOURCES);
  });

  test("a render that throws synchronously doesn't stop later redraws", async () => {
    const t = boot({ dark: false });
    t.fail.throw = 1;
    await assert.doesNotReject(t.start());
    assert.equal(t.logged.length, 1);
    await t.setDark(true);
    assert.deepEqual(t.runs.map((r) => r.theme), ["dark"]);
    assert.deepEqual(t.runs[0].sawSource, SOURCES);
  });
});
