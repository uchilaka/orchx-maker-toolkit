# 🛠 Project Context: Gemini Coder Toolkit

> **Status:** Refactoring for Open Source / Distribution
> **Current Version:** v0.7.0-alpha
> **Last Sync:** 2026-04-10

---

## 🎯 Current Mission

- **Objective:** Transform the former `x-agent-toolkit` into a canonical, open-source distribution project for Gemini CLI skills.
- **Current Sprint:** Refactor directory structure, extract skill sources, and establish versioning/documentation standards.

---

## 🏗 Planned Structure

- `.gemini/skills/`: Uncompressed source folders (The Source of Truth), sitting alongside this repo's `.claude/skills/` — one dot-directory per harness.
- `dist/`: Versioned `.skill` files for distribution.
- `docs/`: Human-friendly markdown documentation for each skill.
- `CHANGELOG.md`: Root-level history of iterations.
- `mise.toml`: Automated packaging & tooling via mise tasks.

---

## 📋 Progress Tracker

- [x] Rename project to `gemini-coder-toolkit`
- [x] Initialize directory structure (`skills/`, `dist/`, `docs/`)
- [x] Interview user for Open Source License (Selected: GPL-3.0)
- [x] Extract existing `.skill` files into `skills/` source folders
- [x] Establish initial CHANGELOG at v0.1.0
- [x] Create documentation for existing skills
- [x] Add GPL-3.0 LICENSE file to root
- [x] Overhaul README.md for open-source distribution
- [x] Add CONTRIBUTING.md with community standards
- [x] Verify build script and refresh distribution artifacts
- [x] **Backport Latest Improvements:** Integrated Git Crypt support in `start-worktree` and robust MD5 tracking in `import-profile`.
- [x] **GA Transition:** Created `/path-to-ga` skill, refactored core scripts for security and portability, and de-personalized global configurations.
- [x] **Compatibility Reviewer:** Added a new `/specialist` sub-agent for macOS/WSL2/mise compatibility audits.

---

## 🧠 Shared Memory (Hand-off Log)

### Context Summary for Next Session

- Refactored `x-agent-toolkit` into `gemini-for-coding-toolkit`.
- All skills extracted, documented, and packaged in `dist/`.
- Project is GPL-3.0 licensed and versioned at `0.6.1-alpha`.
- Added Compatibility Reviewer for macOS, WSL2, and mise.
- Ready for initial distribution and user feedback.
- **Tuning Session (2026-04-10):** Elevated memory preferences and workflow logic to global `~/.gemini/GEMINI.md`. Moved Rails-specific rules of engagement to the global `session-start.sh` hook for conditional injection. Added `install:extensions` package.json script for installing the `ralph` dependency.


**AI Context Hint:** When instructed to install skills from this repository, run `for f in dist/*.skill; do gemini skills install "$f" --consent; done`. If developing/testing skills locally, run `gemini skills link ./.gemini/skills`.

---

## 🚀 Session Startup Routine (Mandatory)

1. **Review Project Context:** Read the local `GEMINI.md` to understand the current mission and technical stack.
2. **Review Recent Changes:** Check `CHANGELOG.md` to see the latest updates (e.g., Git Crypt support).

