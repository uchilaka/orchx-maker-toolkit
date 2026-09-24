---
name: path-to-ga
description: Analyzes project skills, global skills, and GEMINI.md to optimize the toolkit for general availability (GA) and public distribution.
---

# 🚀 Path to GA

This skill is designed to transition the optimized consolidation of project skills, global skills and the current state of the `gemini-coder-toolkit` from a personal project to a robust, public-facing toolkit.

## Workflow

1.  **Inventory & Audit:**
    - List all skills in the project (`skills/`) and global (`~/.gemini/skills/`) environments.
    - Identify overlaps, redundancies, and missing distribution documentation.
    - Scan for personal identifiers (paths, IPs, usernames) and environment-specific logic (e.g., home-lab details).

2.  **Security Review:**
    - Perform a `/specialist` security review on the current project skills.
    - Focus on secret handling, shell execution safety, and path traversal vulnerabilities.

3.  **GA Transition Planning:**
    - Design a "GA version" of the toolkit that abstracts personal details into standard configuration patterns.
    - Plan the consolidation of useful global skills into the project repository.

4.  **Execution:**
    - Update \`GEMINI.md\` with GA-ready instructions.
    - Refactor skills to remove hardcoded paths and personal info.
    - Prepare documentation and versioning for a \`v1.0.0\` milestone.

5.  **Finalize:**
    - Trigger the \`/release\` skill to cut the GA-ready version and update unreleased changes.

## Guidelines

- **Abstraction:** Prefer `$(whoami)` or `~` over hardcoded user paths.
- **Configuration:** Move environment-specific values to `.env` files or Gemini memory rather than hardcoding them in `SKILL.md`.
- **Security:** Ensure no credentials or keys are mentioned in the source code or docs.
