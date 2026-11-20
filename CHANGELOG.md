# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0-alpha] - 2026-11-20

### Added
- **`pr-ship-check`:** once a PR's reviews have landed and every fix-now finding is fixed, says whether it ships, whether part of it can ship ahead, and any high-confidence separation-of-concerns or simplification changes, each backed by named files or commits. It adds a missing `[Unreleased]` entry, recommends the next release version, and on a Ship verdict for your own PR adds a `ready to ship` label and moves a draft to ready for review. Runs in a background subagent; `/live-code-review` and `/pr-triage` start it when they finish.
- **`/agentic-backlog-worker`** keeps a triage baseline, so each invocation classifies only Linear tickets that are new or changed since the last one, with a full re-check every 14 days or on `--full`. Repo answers become lasting rules (`repo-rules.yml`), estimates are filled in only where Linear has none, never overwritten, and `TRIAGE.md` is the hand-off: what changed, what's waiting on review, and what's next. New `worker.mjs` commands: `brief`, `delta`, `merge`, `touched`, `rule`. ([LAR-504](https://linear.app/larcity-and-affiliates/issue/LAR-504))

### Changed
- **`/release`** commits the release on a `release/vX.Y.Z` branch and merges it through a PR, since `main` only accepts changes through one. The tag is pushed last, on the release commit, after the merge.

### Fixed
- **`/browse` diagrams follow the theme:** switching light or dark, or an OS change under System, now redraws mermaid diagrams in place. Before, they kept the theme they loaded with until the next page load. ([LAR-477](https://linear.app/larcity-and-affiliates/issue/LAR-477))

## [0.8.0-alpha] - 2026-11-19

### Added
- **Claude Code plugin marketplace** (`orchx-maker-toolkit`), with four plugins: `orchx-maker` (the skills below), `check-mermaid-artifact`, `hot-reload-preview` (starts the `/browse` server at session start) and `openv`.
- **`openv`:** loads Proton Pass secrets into a command's environment on demand (`openv run <env> -- <cmd>`), so the values never enter an AI session. Ships as its own plugin, with `install:openv` / `uninstall:openv` for the CLI.
- **`pick-model`:** picks the model to keep for a whole session in Claude Code or OpenCode, balancing cost against how hard the work is. Its estimator (`scripts/session-cost.mjs`) prices a session from live OpenRouter rates and, with `OPENROUTER_API_KEY` set, shortlists only the models that key's guardrails allow. Recommends only; never switches.
- **`hand-off`:** writes a copy-pasteable prompt for continuing a session in another harness (Claude Code, OpenCode, Gemini CLI) or a fresh session, covering live git, PR and plan state and what the target harness lacks. The prompt is treated as shareable: no secrets, no identity, and gathered text is data, not instructions.
- **`check-mermaid-artifact`:** flags ASCII diagrams that should be mermaid, and exports mermaid to PNG for destinations not verified to render it.
- **`browse`:** serves markdown with live reload, one server per path tracked in a registry, and renders mermaid fences as diagrams.
- **`llm-wikify`:** sets up an LLM-maintained wiki inside a repository.
- **`browser-test-assist`:** browser test sessions through the chrome-devtools MCP in an isolated profile.
- **`patch-my-hosts`:** syncs `/etc/hosts` with the upstream blocklist while keeping custom edits.
- **`/publish-prep`:** checks everything that ships for secrets, personal paths, frontmatter and undeclared dependencies; `/release` is gated on it.
- **`install:claude-global`:** symlinks a repo skill into `~/.claude/skills/`, and offers to install a skill's optional hooks.
- **`agentic-backlog-worker`:** spends open 5-hour rate-limit windows turning sized LAR backlog tickets into draft PRs, under usage caps enforced by a PreToolUse guard, and never merges. Globally mounted but not in `marketplace.json`. Ships the `agentic-ticket-worker` agent, a SessionStart hook that reports unfinished runs, and a status line, all through `install/hooks.json`.
- **Installer agents and `statusLine`:** `install:claude-global` always links a skill's `agents/*.md` into `~/.claude/agents/`. Hooks and an optional `statusLine` from `install/hooks.json` go in behind the prompt; the `statusLine` is set only when `settings.json` has none or already has the skill's own, and a foreign one is kept and reported. Uninstall reverses all of it.
- **Gemini skills as Claude Code skills:** `mount:claude` / `unmount:claude`, with a validator and test harness.
- **CI** runs the Gemini and Claude test suites; **gitleaks** scans commits before they're made; a PR template with AI-provenance, validation and review-label sections; a playbook on how environment variables reach a `Brewfile` (`docs/brewfile.md`).

### Changed
- **Renamed the project** to OrchX Maker Toolkit.
- **Tooling:** mise tasks replace asdf and yarn; Gemini skill sources moved to `.gemini/skills/`; shared development defaults are committed (`.env.development`).
- **`Brewfile`:** adds `opencode` and `open-codesign`.
- **`/pr-triage`** moved into the repo, with fetch and post scripts behind fixture tests. It is globally mounted but not shipped in the plugin yet.

### Security
- **`browse`:** raw HTML in rendered markdown shows as text, and links keep only `http`, `https`, `mailto` and relative targets. Requests with a foreign `Host` header get a 403, against DNS rebinding.

### Fixed
- **`Brewfile` dev-only casks:** `antigravity-cli` and `open-codesign` now install when `MISE_ENV=development`. The old `RAILS_ENV` gate never fired, because Homebrew only passes `HOMEBREW_*` variables into a `Brewfile`; `mise run bundle` now passes `MISE_ENV` in as `HOMEBREW_MISE_ENV`.
- **`browse` restarts a server on old code:** `ensure` now restarts a server still running code from before an update, on the same port, and open tabs reload when they reconnect. Tabs opened before this release don't have the reload script, so reload them by hand once.
- **`patch-my-hosts`** works from a plugin install.
- **`install:claude-global`** re-points links that reach the checkout through an alias.
- **`build:claude`** keeps passing on Claude Code 2.1.291 and later.

## [0.7.0-alpha] - 2026-04-27

### Added
- **Path to GA:** Introduced the `/path-to-ga` skill to analyze and optimize the toolkit for general availability and public distribution.

### Changed
- **Security Hardening:** Refactored `import-profile/check-updates.sh` and `summon-profile/summon.sh` to use configurable environment variables (`GEMINI_DIR`, `CLAUDE_DIR`) and secure `scp` paths, removing hardcoded personal infrastructure details.
- **De-personalized Configuration:** Abstracted personal homelab details into a distinct "Personal Context" section in the global `gemini.md`.


## [0.6.1-alpha] - 2026-04-10

### Added
- **Compatibility Reviewer:** Introduced a new specialized reviewer persona to the `/specialist` skill focused on cross-platform compatibility across macOS, WSL2 (Unix LTS), and `mise`.
- **Unified Testing:** Updated `specialist` skill to explicitly include compatibility as a core review domain.

## [0.6.0-alpha] - 2026-04-10

### Added
- **Robust MD5 Tracking:** Improved `import-profile` with cross-platform (macOS/Linux) hash detection for configuration drift analysis.
- **Cross-Platform Tests:** Updated `validate_skills.test.cjs` to dynamically locate `gemini-cli` via Homebrew (`brew --prefix`) for compatibility across environments.

### Changed
- **Secure Git Crypt:** Refactored `start-worktree` to safely manage the `git-crypt` unlock process using secure temporary files (`mktemp`) and trap-based deletion, mitigating plaintext key exposure risks on disk.
- **Framework Agnostic Setup:** Decoupled `start-worktree` from specific frameworks (Rails, Yarn) by introducing conditional environment setup logic, improving reusability for open-source distribution.
- **Storage Standards:** Updated `start-worktree` to store draft PRs in project-local `.gemini/draft-prs/` instead of legacy `~/.claude/` paths.
- **Documentation:** Updated `docs/` for `start-worktree` and `import-profile` to reflect new feature sets.

## [0.5.1-alpha] - 2026-04-10

### Fixed
- Corrected emoji skin tone modifiers to prevent broken rendering (using full sequences like 👨🏾‍💻).
- Reverted skin tone modifiers on emojis that do not support them (🏗, 🚀).

### Changed
- Enhanced the `specialist` skill (Design Reviewer) with explicit warnings about emoji rendering and sequence standards.

## [0.5.0-alpha] - 2026-04-10

### Added
- Established `STYLE_GUIDE.md` mandating "medium dark" skin tone (🏾) for all emojis.
- Integrated `markdownlint` configuration (.markdownlint.json) for consistent documentation quality.
- Added VS Code workspace settings (.vscode/settings.json) to automate formatting on save and paste.

### Changed
- Enhanced the `specialist` skill (Design Reviewer) to explicitly enforce project style rules.

## [0.4.1-alpha] - 2026-04-10

### Changed
- Aligned project branding to "Gemini Coder Toolkit" across all documentation and configuration files.
- Updated `CONTRIBUTING.md` with Yarn Berry setup instructions and new development workflows.
- Polished `README.md` with updated build and test commands.

## [0.4.0-alpha] - 2026-04-10

### Added
- Mandatory `/specialist` review pass to the release workflow to identify risks before release.
- User interview stage to the release process for informed decision-making based on review findings.

### Changed
- Updated documentation for the `release` skill to include new quality gates.

## [0.3.0-alpha] - 2026-04-10

### Added
- New `/release` skill to automate versioning, changelog, and git workflow.
- New `/specialist` skill for delegated expert reviews across 7 domains.
- Automated testing suite for skill validation.
- Version recommendation logic based on git history.

### Changed
- Migrated repository to Yarn Berry (v4.13.0) for improved package management.
- Updated global preferences to prioritize Yarn.

## [0.2.0-alpha] - 2026-04-10

### Added
- Created the new `specialist` skill: a router that delegates code, architecture, security, design, documentation, testing, and devops reviews to specialized sub-agent personas.
- Added 7 specialized reviewer personas in `skills/specialist/references/`.

## [0.1.0-alpha] - 2026-04-10

### Added
- Initial extraction of legacy skills into uncompressed source folders (`skills/`).
  - `finish-worktree`
  - `import-profile`
  - `markdown-manager`
  - `start-worktree`
- Established new project structure with `skills/`, `dist/`, and `docs/`.
- Selected and added the GPL-3.0 LICENSE file.
- Created human-friendly documentation for all core skills in `docs/`.
