# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`pr-ship-check`:** once a PR's reviews have landed and every fix-now finding is fixed, says whether it ships, whether part of it can ship ahead, and any high-confidence separation-of-concerns or simplification changes, each backed by named files or commits. It adds a missing `[Unreleased]` entry, recommends the next release version, and on a Ship verdict for your own PR adds a `ready to ship` label and moves a draft to ready for review. Runs in a background subagent; `/live-code-review` and `/pr-triage` start it when they finish.
- **`openv`:** loads Proton Pass secrets into a command's environment on demand, so the values never enter a Claude Code or OpenCode session. Profiles in `~/.config/openv/` hold only `pass://` references; `openv status` shows them, `openv run <env> -- <cmd>` runs a command with them (output masked), and `openv export <env>` loads them into your own terminal. `mise run install:openv` puts it on `PATH`. (#34)
- **`pick-model`:** picks the model to keep for a whole session in Claude Code or OpenCode, balancing cost against how hard the work is. Its estimator (`scripts/session-cost.mjs`) prices a session from live OpenRouter rates and, with `OPENROUTER_API_KEY` set, shortlists only the models that key's guardrails allow. Recommends only; never switches.
- **`hand-off`:** generates a directional, copy-pasteable hand-off prompt between harnesses (`opencode -> claude-code`, `claude-code -> opencode`, `* -> gemini`, or same-harness reset), gathering live git/worktree/PR state, plan progress, machine side effects, and harness-specific gaps (hooks, subagents, policies, secrets).
- **`browse` in the plugin:** `/browse` now ships in `orchx-maker`, and a new `hot-reload-preview` plugin adds its session-start autostart hook. The skill sets the folder the hook serves (`browse-ctl.mjs autostart`).

### Security
- **`browse`:** raw HTML in rendered markdown shows as text, and links keep only `http`, `https`, `mailto` and relative targets. Requests with a foreign `Host` header get a 403, against DNS rebinding.

### Fixed
- **`Brewfile` dev-only casks:** `antigravity-cli` and `open-codesign` now install when `MISE_ENV=development`. The old `RAILS_ENV` gate never fired, because Homebrew only passes `HOMEBREW_*` variables into a `Brewfile`; `mise run bundle` now passes `MISE_ENV` in as `HOMEBREW_MISE_ENV`.

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
