---
name: browse
description: Serve and view Claude artifacts (plans, reviews, goals, memory, pull-requests) in the browser with rendered markdown and live reload. Use this skill when the user says "/browse", "/view", "browse my artifacts", "browse my plans", "view my reviews", "open my goals", or wants to preview any file or directory from ~/.claude or ~/project-plans or ~/pr-reviews in a local web server. Also trigger when the user wants to serve a local directory or file for quick browser viewing.
---

# /browse — Browse Claude Artifacts in the Browser

This skill lets the user pick an artifact from their Claude ecosystem and view it in the browser as **rendered markdown** with **live reload** (changes on disk update the preview automatically).

## Server Script

The markdown preview server lives at `~/.claude/skills/browse/serve-md.mjs`. It:
- Renders `.md` files with Tailwind 3 + `@tailwindcss/typography`: sticky header with breadcrumbs, "On this page" sidebar, code blocks with copy buttons, plan checklists as checkboxes, and `## Status:` lines as badges. A Light / System / Dark switch in the header, defaulting to System and remembered per browser
- Shows a card index when serving a directory: title, status badge and last-updated per file, grouped by folder, filterable (press `/`)
- Pushes live reload via Server-Sent Events — any saved `.md` change refreshes the browser
- No npm install — runs with plain `node`; Tailwind loads from its Play CDN, so pages render unstyled offline

## Artifact Sources

Scan these locations for servable artifacts:

| Location | Label |
|---|---|
| `~/project-plans/` | Project Plans (each subdirectory is one artifact) |
| `~/pr-reviews/` | PR Reviews (each subdirectory is one artifact) |
| `~/.claude/goals/` | Goals |
| `~/.claude/memory/` | Memory |
| `~/.claude/plans/` | Plans |
| `~/.claude/pull-requests/` | Pull Requests |
| `~/.claude/guides/` | Guides |
| `~/.claude/skills/` | Skills |

Only include locations that actually exist and contain files.

## Workflow

### Step 1: Determine what to serve

If the user specified a **specific file or directory** (e.g. `/browse ~/project-plans/sapphire`), skip discovery and go straight to Step 2 with that path.

Otherwise, list the servable artifacts by scanning the locations above. For directories that contain subdirectories (like `~/project-plans/`), list each subdirectory as a separate option. For flat directories (like `~/.claude/goals/`), list the directory itself as one option.

Present a numbered list like:

```
What would you like to browse?

1. Project Plans / sapphire
2. Project Plans / sapphire-jsonb-refactor
3. PR Reviews / sapphire
4. Goals
5. Memory
6. Plans
7. Pull Requests
8. Skills
```

Ask the user to pick a number.

### Step 2: Ensure exactly one server, serving that path

```bash
~/.claude/skills/browse/ensure-server.sh <path> --open
```

One command replaces the old kill-then-start steps. It:
- keeps a browse server already serving `<path>`, so open tabs keep their live reload
- stops every other browse server, on any port
- never kills a process that isn't a browse server — if one holds port 3200 it exits 1 and names it
- starts the server detached (log: `~/.claude/state/browse-server.log`) and waits until it answers
- opens the browser only if it started a new server

It prints the URL, followed by `(started)` or `(already running)`. The URL is `http://plans.localhost:3200` once `/etc/hosts` maps that name (see **Vanity URL**), and `http://localhost:3200` until then.

### Step 3: Stand by

Tell the user:

> Serving at **<url>** with live reload. Edit any `.md` file and the browser updates automatically. Say **done** when you're finished and I'll stop the server.

### Step 4: Tear down

When the user says "done" (or any clear signal they're finished), stop it:

```bash
pkill -f skills/browse/serve-md.mjs
```

Confirm the server has been stopped. The next session start brings `~/project-plans` back (see **Autostart**).

## Notes

- Styling is Tailwind utility classes only — no inline CSS. Components (badge, code block, table, checkbox) are small functions near the top of `serve-md.mjs`.
- Live reload works via Server-Sent Events — no browser extensions needed.
- Directory mode shows a card-based index of all `.md` files with click-through to rendered previews.
- If `node` is not available, fall back to `yarn dlx serve` for raw file serving.
- Port 3200 is the default; the server will bind to localhost only.
- `GET /__health` returns the path being served, as plain text. `ensure-server.sh` relies on it.

## Autostart

A `SessionStart` hook (matcher `startup`) in `~/.claude/settings.json` runs:

```bash
ensure-server.sh ~/project-plans --open >/dev/null 2>&1
```

Output is discarded, so it costs no context. `/clear`, `/compact` and resumed sessions don't trigger it. If you've browsed something else, the next new session switches the server back to `~/project-plans`, since there's only ever one server.

## Vanity URL

`/etc/hosts` maps a name to an address, never a port, so the URL keeps `:3200`. Removing the port would need a reverse proxy on port 80.

Use `plans.localhost`, not `.local` or `.test`:
- `.local` names go through a multicast-DNS (Bonjour) lookup first on macOS, which can stall for seconds.
- Browsers treat `*.localhost` as a secure context, and the code blocks' Copy button needs one for clipboard access.

Add it outside the `/patch-my-hosts` managed block so hosts syncs keep it:

```bash
echo "127.0.0.1 plans.localhost   # /browse preview server" | sudo tee -a /etc/hosts
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
```

`tee -a` adds the line at the end of the file. `/patch-my-hosts` puts its block at the end too, so if that block is already there, move the line above its `BEGIN` marker.

## Tests

```bash
node --test ~/.claude/skills/browse/test/'*.test.mjs'
```

Built-in `node:test`, so there's still nothing to install. Pass the glob, not the folder: Node 24 treats `test/` as a single file and fails. In this repo, `mise run test:claude` runs them too. About 3 seconds.

| File | Covers |
|---|---|
| `render.test.mjs` | Markdown renderer, page shell, theme script (every OS-setting × saved-choice combination, run in a stub DOM) |
| `server.test.mjs` | `/__health`, index and sub-index links, breadcrumbs, 404, path traversal, SSE live reload |
| `ensure-server.test.mjs` | One-server policy, foreign-port refusal, vanity-host lookup, the `SessionStart` hook |
| `tailwind.test.mjs` | Compiles every class with a real Tailwind 3.4. The Play CDN skips a class it can't build without any error, so this is the only check that would catch one. Skipped unless `TAILWIND_DIR` (default: `cami-ritv`) has `tailwindcss` installed |

`ensure-server.test.mjs` runs a **copy** of the skill from a temp folder. The script stops every browse server started from its own path, so running tests never stops the real `plans.localhost` server.
