#!/usr/bin/env node
/**
 * Markdown preview server with live reload.
 *
 * Usage:
 *   node serve-md.mjs <path>          # file or directory
 *   node serve-md.mjs <path> --port 0 # auto-assign port
 *
 * When <path> is a directory, renders an index page listing all .md files
 * with links to their rendered previews. When <path> is a single .md file,
 * renders it directly.
 *
 * Live reload: uses Server-Sent Events (SSE) + fs.watch to push updates
 * whenever any .md file in scope changes on disk.
 *
 * Registry: once listening, writes ~/.claude/state/browse/<port>.json (pid,
 * path, url, owner) and removes it on exit, so launchers can find live servers.
 * See registry.mjs.
 *
 * Styling: Tailwind 3 Play CDN + @tailwindcss/typography, utilities only — no
 * inline CSS. Dark mode uses Tailwind's `class` strategy so the header switch can
 * force light or dark; "system" (the default) follows the OS and tracks changes.
 * The choice persists in localStorage, shared by every folder served on this port.
 * Needs network: offline, pages render unstyled but still work.
 */

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { watch, realpathSync } from "node:fs";
import { join, resolve, relative, extname, basename, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { writeEntry, removeEntry, ownerFromEnv } from "./registry.mjs";

// ---------------------------------------------------------------------------
// Components — each returns an HTML string styled with Tailwind utilities
// ---------------------------------------------------------------------------
const STATUS_STYLES = {
  "IN PROGRESS": "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-400 dark:ring-sky-400/30",
  RESOLVED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:ring-emerald-400/20",
  DONE: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:ring-emerald-400/20",
  PARKED: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-400 dark:ring-amber-400/20",
  PROPOSED: "bg-zinc-50 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-400/10 dark:text-zinc-400 dark:ring-zinc-400/20",
};

function statusBadge(status) {
  const cls = STATUS_STYLES[status.toUpperCase()] || STATUS_STYLES.PROPOSED;
  return `<span class="inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${cls}">${escapeHtml(status)}</span>`;
}

function codeBlock(lang, code) {
  return `<div data-code class="not-prose my-6 overflow-hidden rounded-xl bg-zinc-900 shadow-md ring-1 ring-zinc-900/10 dark:bg-zinc-900/70 dark:shadow-none dark:ring-white/10">
<div class="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-1.5">
<span class="font-mono text-xs text-zinc-400">${escapeHtml(lang || "text")}</span>
<button type="button" data-copy class="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white">Copy</button>
</div>
<pre class="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-zinc-100"><code>${escapeHtml(code.trimEnd())}</code></pre>
</div>`;
}

function inlineCode(code) {
  return `<code class="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.85em] font-medium text-zinc-900 dark:bg-white/10 dark:text-zinc-100">${escapeHtml(code)}</code>`;
}

function checkbox(done) {
  return done
    ? `<span class="mt-1.5 flex size-4 shrink-0 items-center justify-center rounded bg-emerald-500 text-white"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" class="size-3"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
    : `<span class="mt-1.5 size-4 shrink-0 rounded border border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-900"></span>`;
}

function table(headers, rows) {
  const th = headers
    .map((h) => `<th scope="col" class="whitespace-nowrap px-4 py-3 font-semibold text-zinc-900 dark:text-white">${h}</th>`)
    .join("");
  const trs = rows
    .map((r) => `<tr>${r.map((c) => `<td class="px-4 py-3 align-top text-zinc-600 dark:text-zinc-300">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="not-prose my-8 overflow-x-auto rounded-xl ring-1 ring-zinc-900/10 dark:ring-white/10">
<table class="min-w-full divide-y divide-zinc-900/10 text-left text-sm dark:divide-white/10">
<thead class="bg-zinc-50 dark:bg-white/5"><tr>${th}</tr></thead>
<tbody class="divide-y divide-zinc-900/5 dark:divide-white/5">${trs}</tbody>
</table></div>`;
}

const LINK = "font-medium text-sky-600 no-underline hover:underline dark:text-sky-400";

// ---------------------------------------------------------------------------
// Markdown rendering (lightweight, zero-dependency)
// ---------------------------------------------------------------------------
// Code is stashed behind \u0000 placeholders first, so no later rule (bold,
// lists, links) can rewrite what's inside a code span or fence.
function renderMarkdown(md) {
  const blocks = [];
  const spans = [];
  const toc = [];
  const usedIds = new Set();

  let html = md.replace(/\r\n/g, "\n");

  html = html.replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(codeBlock(lang, code));
    return `\n\n\u0000B${blocks.length - 1}\u0000\n\n`;
  });
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    spans.push(code);
    return `\u0000C${spans.length - 1}\u0000`;
  });

  // Plain text of a line, for heading ids and TOC labels
  const plain = (s) =>
    s.replace(/[*_]|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\u0000C(\d+)\u0000/g, (_m, i) => spans[i]);

  // `## Status: IN PROGRESS (2026-09-19)` from the project plan template → badge
  html = html.replace(/^##\s+Status:\s*([A-Z][A-Z ]*?)\s*(\(.*\))?\s*$/gm, (_m, status, rest) => {
    const note = rest ? `<span class="text-sm text-zinc-500 dark:text-zinc-400">${escapeHtml(rest.slice(1, -1))}</span>` : "";
    return `\n\n<div class="not-prose my-6 flex items-center gap-3">${statusBadge(status)}${note}</div>\n\n`;
  });

  html = html.replace(/^(#{1,6})\s+(.+?)\s*#*$/gm, (_m, hashes, text) => {
    const level = hashes.length;
    const label = plain(text);
    const base = label.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "section";
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    if (level === 2 || level === 3) toc.push({ level, id, label });
    const anchor = level > 1
      ? `<a href="#${id}" aria-hidden="true" class="ml-2 font-normal text-zinc-300 no-underline opacity-0 transition group-hover:opacity-100 dark:text-zinc-600">#</a>`
      : "";
    return `\n\n<h${level} id="${id}" class="group scroll-mt-24">${text}${anchor}</h${level}>\n\n`;
  });

  html = html.replace(/^---+$/gm, "\n\n<hr>\n\n");

  html = html.replace(/^(?:>\s?(.*)(?:\n|$))+/gm, (match) => {
    const inner = match
      .split("\n")
      .map((line) => line.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    return `\n\n<blockquote>${inner.replace(/\n/g, "<br>")}</blockquote>\n\n`;
  });

  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, headerRow, _sep, bodyRows) => {
    const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());
    return "\n\n" + table(cells(headerRow), bodyRows.trim().split("\n").map(cells)) + "\n\n";
  });

  html = renderLists(html);

  // Inline formatting
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" class="${LINK}">$1</a>`);

  // Paragraphs: loose lines join with a space, as in any markdown renderer, so
  // hard-wrapped source reads as flowing text.
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^(<|\u0000B)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\s*\n\s*/g, " ")}</p>`;
    })
    .join("\n");

  html = html
    .replace(/\u0000C(\d+)\u0000/g, (_m, i) => inlineCode(spans[i]))
    .replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[i]);

  return { html, toc };
}

// Line-based so a hard-wrapped item (continuation indented 2+ spaces) stays one
// item. Nested markers flatten into the parent list — enough for plans and notes.
function renderLists(src) {
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(listHtml(list));
    list = null;
  };
  for (const line of src.split("\n")) {
    const m = line.match(/^(\s*)(?:([-*])|\d+\.)\s+(.*)$/);
    if (m) {
      const type = m[2] ? "ul" : "ol";
      if (list && list.type !== type && !m[1]) flush();
      if (!list) list = { type, items: [] };
      list.items.push(m[3]);
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

function listHtml({ type, items }) {
  const TASK = /^\[([ xX])\]\s+(.*)$/;
  const allTasks = items.every((t) => TASK.test(t));
  const lis = items
    .map((t) => {
      const m = t.match(TASK);
      if (!m) return `<li>${t}</li>`;
      const done = m[1] !== " ";
      return `<li class="flex items-start gap-3 pl-0${done ? " text-zinc-500 dark:text-zinc-400" : ""}">${checkbox(done)}<span>${m[2]}</span></li>`;
    })
    .join("");
  return `\n\n<${type}${allTasks ? ' class="list-none pl-0"' : ""}>${lis}</${type}>\n\n`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  const units = [[2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];
  for (const [n, label] of units) if (s >= n) return `${Math.floor(s / n)}${label} ago`;
  return "just now";
}

// ---------------------------------------------------------------------------
// Page shell: sticky header with breadcrumbs + live pill, SSE client
// ---------------------------------------------------------------------------
const PROSE = [
  "prose prose-zinc max-w-none dark:prose-invert",
  "prose-headings:scroll-mt-24 prose-headings:font-semibold prose-headings:tracking-tight",
  "prose-h1:text-3xl prose-h2:mt-12 prose-h2:border-b prose-h2:border-zinc-900/5 prose-h2:pb-2 dark:prose-h2:border-white/10",
  "prose-code:before:content-none prose-code:after:content-none",
  "prose-blockquote:rounded-r-lg prose-blockquote:border-l-sky-500 prose-blockquote:bg-zinc-50 prose-blockquote:px-4",
  "prose-blockquote:py-2 prose-blockquote:font-normal prose-blockquote:not-italic dark:prose-blockquote:bg-white/5",
  "prose-li:my-1 prose-hr:border-zinc-900/10 dark:prose-hr:border-white/10",
].join(" ");

function crumbsHtml(crumbs) {
  return crumbs
    .map((c, i) => {
      const sep = i ? `<svg viewBox="0 0 16 16" fill="currentColor" class="size-4 shrink-0 text-zinc-300 dark:text-zinc-600"><path d="M6.2 3.2a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06L7.26 12.8a.75.75 0 1 1-1.06-1.06L9.94 8 6.2 4.26a.75.75 0 0 1 0-1.06Z"/></svg>` : "";
      const label = escapeHtml(c.label);
      const item = c.href
        ? `<a href="${c.href}" class="truncate text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white">${label}</a>`
        : `<span class="truncate font-medium text-zinc-900 dark:text-white" aria-current="page">${label}</span>`;
      return sep + item;
    })
    .join("");
}

const THEME_OPTIONS = [
  ["light", "Light", `<circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>`],
  ["system", "System", `<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>`],
  ["dark", "Dark", `<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/>`],
];

function htmlPage(title, main, crumbs = []) {
  return `<!DOCTYPE html>
<html lang="en" class="h-full scroll-smooth antialiased">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.tailwindcss.com/3.4.17?plugins=typography"></script>
<script>
tailwind.config = { darkMode: "class" };
// Runs before first paint so a forced theme never flashes the system one.
(function () {
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  function stored() {
    try { return localStorage.getItem("browse-theme") || "system"; } catch (e) { return "system"; }
  }
  // color-scheme is set here, not as a dark: class — those compile to
  // :is(.dark *) and can't match <html> itself. It themes scrollbars and inputs.
  function apply(choice) {
    var dark = choice === "dark" || (choice === "system" && media.matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.dataset.theme = choice;
  }
  apply(stored());
  media.addEventListener("change", function () { if (stored() === "system") apply("system"); });
  window.browseTheme = function (choice) {
    try { localStorage.setItem("browse-theme", choice); } catch (e) {}
    apply(choice);
  };
})();
</script>
</head>
<body class="min-h-full bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
<header class="sticky top-0 z-30 border-b border-zinc-900/10 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 dark:border-white/10 dark:bg-zinc-950/80 dark:supports-[backdrop-filter]:bg-zinc-950/60">
<div class="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
<a href="/" class="flex shrink-0 items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-white">
<span class="flex size-7 items-center justify-center rounded-lg bg-sky-500 text-white shadow-sm shadow-sky-500/30">
<svg viewBox="0 0 20 20" fill="currentColor" class="size-4"><path d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.62a1.5 1.5 0 0 0-.44-1.06l-4.12-4.12A1.5 1.5 0 0 0 11.38 2H4.5Zm2.25 8.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0 3a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z"/></svg>
</span>
<span class="hidden sm:inline">browse</span>
</a>
<nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-2 text-sm">${crumbsHtml(crumbs)}</nav>
<span id="live" data-state="on" class="group ml-auto inline-flex shrink-0 items-center gap-2 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 data-[state=off]:bg-rose-50 data-[state=off]:text-rose-700 data-[state=off]:ring-rose-600/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:ring-emerald-400/20 dark:data-[state=off]:bg-rose-400/10 dark:data-[state=off]:text-rose-400 dark:data-[state=off]:ring-rose-400/20">
<span class="relative flex size-2">
<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75 group-data-[state=off]:hidden"></span>
<span class="relative inline-flex size-2 rounded-full bg-emerald-500 group-data-[state=off]:bg-rose-500"></span>
</span>
<span id="live-label">Live</span>
</span>
<div role="radiogroup" aria-label="Theme" class="flex shrink-0 items-center gap-0.5 rounded-full p-0.5 ring-1 ring-inset ring-zinc-900/10 dark:ring-white/10">
${THEME_OPTIONS.map(([value, label, icon]) => `<button type="button" role="radio" aria-checked="false" data-theme-choice="${value}" title="${label}" aria-label="${label}" class="rounded-full p-1.5 text-zinc-400 transition hover:text-zinc-900 aria-checked:bg-zinc-900/5 aria-checked:text-zinc-900 dark:text-zinc-500 dark:hover:text-white dark:aria-checked:bg-white/10 dark:aria-checked:text-white"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="size-4">${icon}</svg></button>`).join("")}
</div>
</div>
</header>
<main class="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
${main}
</main>
<script>
(function () {
  var choices = [].slice.call(document.querySelectorAll("[data-theme-choice]"));
  function markTheme() {
    choices.forEach(function (b) {
      b.setAttribute("aria-checked", String(b.dataset.themeChoice === document.documentElement.dataset.theme));
    });
  }
  choices.forEach(function (b) {
    b.addEventListener("click", function () { window.browseTheme(b.dataset.themeChoice); markTheme(); });
  });
  markTheme();

  var pill = document.getElementById("live");
  var label = document.getElementById("live-label");
  var es = new EventSource("/__sse");
  es.onmessage = function (e) { if (e.data === "reload") location.reload(); };
  es.onopen = function () { pill.dataset.state = "on"; label.textContent = "Live"; };
  es.onerror = function () { pill.dataset.state = "off"; label.textContent = "Disconnected"; };

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.closest("[data-code]").querySelector("code").innerText;
      navigator.clipboard.writeText(code).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
  });

  var links = [].slice.call(document.querySelectorAll("[data-toc]"));
  if (links.length && "IntersectionObserver" in window) {
    var byId = {};
    links.forEach(function (a) { byId[decodeURIComponent(a.hash.slice(1))] = a; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.removeAttribute("aria-current"); });
        var active = byId[entry.target.id];
        if (active) active.setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    Object.keys(byId).forEach(function (id) {
      var h = document.getElementById(id);
      if (h) observer.observe(h);
    });
  }

  var filter = document.getElementById("filter");
  if (filter) {
    filter.addEventListener("input", function () {
      var q = filter.value.toLowerCase().trim();
      var shown = 0;
      document.querySelectorAll("[data-search]").forEach(function (li) {
        var hit = li.dataset.search.indexOf(q) !== -1;
        li.hidden = !hit;
        if (hit) shown++;
      });
      document.querySelectorAll("[data-group]").forEach(function (g) {
        g.hidden = !g.querySelector("[data-search]:not([hidden])");
      });
      document.getElementById("empty").hidden = shown > 0;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== filter) { e.preventDefault(); filter.focus(); }
      if (e.key === "Escape" && document.activeElement === filter) { filter.value = ""; filter.dispatchEvent(new Event("input")); filter.blur(); }
    });
  }
})();
</script>
</body>
</html>`;
}

function docPage(title, md, crumbs) {
  const { html, toc } = renderMarkdown(md);
  const article = `<article class="${PROSE}">${html}</article>`;
  if (toc.length < 2) return htmlPage(title, `<div class="mx-auto max-w-3xl">${article}</div>`, crumbs);

  const items = toc
    .map((t) => `<li><a data-toc href="#${t.id}" class="-ml-px block border-l border-transparent py-0.5 ${t.level === 3 ? "pl-7" : "pl-4"} text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-900 aria-[current=true]:border-sky-500 aria-[current=true]:font-medium aria-[current=true]:text-sky-600 dark:text-zinc-400 dark:hover:text-white dark:aria-[current=true]:text-sky-400">${escapeHtml(t.label)}</a></li>`)
    .join("");
  const aside = `<aside class="hidden lg:block">
<nav aria-label="On this page" class="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto text-sm">
<p class="font-semibold text-zinc-900 dark:text-white">On this page</p>
<ul class="mt-3 space-y-1 border-l border-zinc-900/10 dark:border-white/10">${items}</ul>
</nav></aside>`;
  return htmlPage(
    title,
    `<div class="mx-auto max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-16"><div class="min-w-0 max-w-3xl">${article}</div>${aside}</div>`,
    crumbs
  );
}

function notFoundPage() {
  return htmlPage(
    "Not Found",
    `<div class="py-24 text-center">
<p class="text-sm font-semibold text-sky-600 dark:text-sky-400">404</p>
<h1 class="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
<p class="mt-4 text-zinc-500 dark:text-zinc-400">Nothing markdown-shaped lives at this path.</p>
<a href="/" class="mt-8 inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">← Back to index</a>
</div>`
  );
}

// ---------------------------------------------------------------------------
// Directory index
// ---------------------------------------------------------------------------
async function collectMdFiles(dir, base) {
  base = base || dir;
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files = files.concat(await collectMdFiles(full, base));
    } else if (e.name.endsWith(".md")) {
      files.push({ abs: full, rel: relative(base, full) });
    }
  }
  return files;
}

// Title and plan status come from the file itself, so the card says what the
// document is rather than only what it's named.
async function describe(file) {
  const [text, info] = await Promise.all([readFile(file.abs, "utf-8"), stat(file.abs)]);
  const title = text.match(/^#\s+(.+)$/m)?.[1].replace(/[*`_]/g, "") || basename(file.rel, ".md");
  const status = text.match(/^##\s+Status:\s*([A-Z][A-Z ]*?)\s*(?:\(|$)/m)?.[1];
  return { ...file, title, status, mtime: info.mtimeMs };
}

async function renderIndex(dir, crumbs, urlPrefix) {
  const files = await Promise.all((await collectMdFiles(dir)).map(describe));
  const title = crumbs[crumbs.length - 1].label;

  const groups = new Map();
  for (const f of files) {
    const key = dirname(f.rel) === "." ? "" : dirname(f.rel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const sections = [...groups.keys()]
    .sort()
    .map((key) => {
      const cards = groups
        .get(key)
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => {
          const search = escapeHtml(`${f.rel} ${f.title} ${f.status || ""}`.toLowerCase());
          return `<li data-search="${search}">
<a href="${urlPrefix}${encodeURI(f.rel)}" class="group flex h-full flex-col rounded-xl bg-white p-5 shadow-sm ring-1 ring-zinc-900/5 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-zinc-900/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10 dark:hover:bg-zinc-800/80 dark:hover:ring-white/20">
<div class="flex items-start justify-between gap-3">
<h3 class="text-sm font-semibold leading-6 text-zinc-900 transition group-hover:text-sky-600 dark:text-white dark:group-hover:text-sky-400">${escapeHtml(f.title)}</h3>
${f.status ? statusBadge(f.status) : ""}
</div>
<p class="mt-1 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">${escapeHtml(basename(f.rel))}</p>
<p class="mt-auto flex items-center gap-1.5 pt-4 text-xs text-zinc-400 dark:text-zinc-500">
<svg viewBox="0 0 16 16" fill="currentColor" class="size-3.5"><path fill-rule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .41.34.75.75.75h3a.75.75 0 0 0 0-1.5H8.75V3.75Z" clip-rule="evenodd"/></svg>
Updated ${timeAgo(f.mtime)}</p>
</a></li>`;
        })
        .join("");
      const heading = key
        ? `<a href="${urlPrefix}${encodeURI(key)}/" class="hover:text-zinc-900 dark:hover:text-white">${escapeHtml(key)}</a>`
        : "Top level";
      return `<section data-group class="mt-10 first:mt-0">
<h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">${heading}<span class="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-zinc-600 dark:bg-white/10 dark:text-zinc-300">${groups.get(key).length}</span></h2>
<ul class="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">${cards}</ul>
</section>`;
    })
    .join("");

  const body = files.length
    ? `<div id="empty" hidden class="rounded-xl border border-dashed border-zinc-300 py-16 text-center text-sm text-zinc-500 dark:border-white/15 dark:text-zinc-400">No documents match that filter.</div>${sections}`
    : `<div class="rounded-xl border border-dashed border-zinc-300 py-16 text-center text-sm text-zinc-500 dark:border-white/15 dark:text-zinc-400">No markdown files found.</div>`;

  const header = `<div class="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
<div>
<h1 class="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">${escapeHtml(title)}</h1>
<p class="mt-2 text-sm text-zinc-500 dark:text-zinc-400">${files.length} document${files.length === 1 ? "" : "s"}</p>
</div>
${files.length ? `<div class="relative w-full sm:w-72">
<svg viewBox="0 0 20 20" fill="currentColor" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.45 4.39l3.08 3.08a.75.75 0 1 1-1.06 1.06l-3.08-3.08A7 7 0 0 1 2 9Z" clip-rule="evenodd"/></svg>
<input id="filter" type="text" placeholder="Filter documents" autocomplete="off" class="block w-full rounded-lg border-0 bg-white py-2 pl-9 pr-10 text-sm text-zinc-900 shadow-sm ring-1 ring-inset ring-zinc-900/10 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-500 dark:bg-white/5 dark:text-white dark:ring-white/10 dark:focus:ring-sky-400">
<kbd class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-zinc-200 px-1.5 font-sans text-[11px] text-zinc-400 dark:border-white/15">/</kbd>
</div>` : ""}
</div>`;

  return htmlPage(title, `<div class="mx-auto max-w-6xl">${header}${body}</div>`, crumbs);
}

// Breadcrumbs for a path relative to the served directory; every segment but
// the last links to its folder index.
function dirCrumbs(rel, baseDir) {
  const root = { label: basename(baseDir), href: "/" };
  if (!rel) return [{ label: root.label }];
  const parts = rel.split("/").filter(Boolean);
  return [
    root,
    ...parts.map((p, i) => ({
      label: p,
      href: i < parts.length - 1 ? "/" + parts.slice(0, i + 1).map(encodeURIComponent).join("/") + "/" : null,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Server — only when run directly, so tests can import the renderer
// ---------------------------------------------------------------------------
export async function main(args = process.argv.slice(2)) {
  let targetPath = args[0] || ".";
  let requestedPort = 3200;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    requestedPort = Number(args[portIdx + 1]);
  }
  targetPath = resolve(targetPath);

  const sseClients = new Set();

  function broadcastReload() {
    for (const res of sseClients) {
      res.write("data: reload\n\n");
    }
  }

  // Debounce watcher
  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(broadcastReload, 200);
  }

  // Watch target path
  const WATCHABLE_EXTENSIONS = new Set([".md", ".html", ".htm"]);
  try {
    watch(targetPath, { recursive: true }, (eventType, filename) => {
      if (filename && WATCHABLE_EXTENSIONS.has(extname(filename))) {
        scheduleReload();
      }
    });
  } catch {
    // fs.watch recursive may not be supported everywhere; non-fatal
  }

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------
  const targetStat = await stat(targetPath);
  const isDir = targetStat.isDirectory();
  const baseDir = isDir ? targetPath : resolve(targetPath, "..");
  const singleFile = isDir ? null : targetPath;

  function send(res, status, html) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // SSE endpoint
    if (pathname === "/__sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // What this server is serving — ensure-server.sh uses it to decide whether an
    // existing server can be kept or must be replaced.
    if (pathname === "/__health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(targetPath);
      return;
    }

    try {
      // Single-file mode: always render the one file
      if (singleFile && (pathname === "/" || pathname === "/" + basename(singleFile))) {
        const content = await readFile(singleFile, "utf-8");
        // Serve HTML files as-is (they have their own styling/scripts)
        if (extname(singleFile) === ".html" || extname(singleFile) === ".htm") {
          return send(res, 200, content);
        }
        const crumbs = [{ label: basename(dirname(singleFile)) }, { label: basename(singleFile) }];
        return send(res, 200, docPage(basename(singleFile), content, crumbs));
      }

      // Directory mode
      if (isDir) {
        if (pathname === "/") {
          return send(res, 200, await renderIndex(baseDir, dirCrumbs("", baseDir), "/"));
        }

        // Try to resolve as a .md file under baseDir
        const filePath = join(baseDir, pathname);
        // baseDir + sep, not baseDir: "/x/plans-evil" also starts with "/x/plans".
        if (filePath !== baseDir && !filePath.startsWith(baseDir + sep)) return send(res, 404, notFoundPage());
        const fileStat = await stat(filePath).catch(() => null);
        const rel = relative(baseDir, filePath);

        if (fileStat && fileStat.isFile() && filePath.endsWith(".md")) {
          const md = await readFile(filePath, "utf-8");
          return send(res, 200, docPage(basename(filePath), md, dirCrumbs(rel, baseDir)));
        }

        // Subdirectory → render sub-index; links resolve under its own path
        if (fileStat && fileStat.isDirectory()) {
          const prefix = "/" + rel.split("/").map(encodeURIComponent).join("/") + "/";
          return send(res, 200, await renderIndex(filePath, dirCrumbs(rel, baseDir), prefix));
        }
      }

      send(res, 404, notFoundPage());
    } catch (err) {
      send(res, 500, htmlPage("Error", `<div class="mx-auto max-w-3xl"><h1 class="text-2xl font-semibold">Error</h1>${codeBlock("text", String(err))}</div>`));
    }
  });

  server.listen(requestedPort, "127.0.0.1", () => {
    const addr = server.address();
    // Display name only; the server always binds to 127.0.0.1. A vanity name
    // (e.g. plans.localhost) needs a matching /etc/hosts entry — see SKILL.md.
    const url = `http://${process.env.BROWSE_HOST || "localhost"}:${addr.port}`;
    // Registered before the URL is printed, so anything waiting on that line
    // can rely on the entry being there.
    writeEntry({
      pid: process.pid, port: addr.port, path: targetPath, url,
      owner: ownerFromEnv(), started: new Date().toISOString(),
    });
    const unregister = () => removeEntry(addr.port, process.pid);
    process.on("exit", unregister);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));
    console.log(`Serving: ${targetPath}`);
    console.log(`URL: ${url}`);
    console.log(`PID: ${process.pid}`);
  });
  return server;
}

export {
  renderMarkdown, htmlPage, docPage, notFoundPage, renderIndex, dirCrumbs,
  escapeHtml, timeAgo, STATUS_STYLES, THEME_OPTIONS,
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
