# Gemini Coder Toolkit

A collection of specialized task-automation skills designed explicitly for the **Gemini CLI** ecosystem. 

This toolkit provides high-leverage workflows for software engineers, helping automate the repetitive parts of the development lifecycle—from starting a feature in an isolated worktree to drafting the final pull request.

## 🎯 Project Mission

The **Gemini Coder Toolkit** aims to provide a canonical, open-source distribution of skills that empower developers to work more efficiently within the Gemini CLI. Each skill is designed to be surgical, predictable, and highly integrated with standard engineering tools (Git, Jira, etc.).

## 🏗 Project Structure

- `.gemini/skills/`: **The Source of Truth.** Uncompressed source folders for each skill. Modify code here.
- `dist/`: **Distribution.** Versioned `.skill` files (ZIP archives) ready for installation.
- `docs/`: **Documentation.** Human-friendly guides and references for each skill.
- `.claude/skills/`: Claude Code skills scoped to this repo only, independent of the Gemini `.gemini/skills/` catalog above (see `CLAUDE.md`).
- `LICENSE`: The project is licensed under **GPL-3.0**.

## 🛠 Available Skills

| Skill | Description | Documentation |
| :--- | :--- | :--- |
| `finish-worktree` | Exits Git worktrees, prepares draft PRs, and applies templates. | [Docs](./docs/finish-worktree.md) |
| `import-profile` | Syncs global preferences and memory from external profiles. | [Docs](./docs/import-profile.md) |
| `markdown-manager` | Enforces documentation standards and manages planning artifacts. | [Docs](./docs/markdown-manager.md) |
| `release` | Automates the version bump, changelog, build, and git release process. | [Docs](./docs/release.md) |
| `specialist` | Orchestrates expert code, architecture, security, design, and devops reviews. | [Docs](./docs/specialist.md) |
| `start-worktree` | Scaffolds isolated work environments for new Jira tickets. | [Docs](./docs/start-worktree.md) |
| `summon-profile` | Synchronizes local profile with remote machines via scp. | [Docs](./docs/summon-profile.md) |

## 🚀 Installation & Usage

### Prerequisites
<!-- TODO(LAR-371): `mise run bundle` also fires postinstall, so the ordering rationale below is not quite accurate. -->
Requires Gemini CLI `>=0.37.0`. Tooling is managed via [mise](https://mise.jdx.dev/) and Homebrew. Run these in order — the second step depends on binaries the first one installs:
```bash
mise run bundle   # Homebrew dependencies from the Brewfile: gemini-cli, gitleaks, git-crypt, …
mise install      # pinned node/direnv, then the postinstall hook
```
The `postinstall` hook runs two tasks, each of which can be re-run on its own:
- `mise run install:extensions` installs the external Gemini CLI extensions this toolkit depends on *(or run `gemini extensions install https://github.com/gemini-cli-extensions/ralph --auto-update --consent` directly)*.
- `mise run install:hooks` turns on the repo's shared git hooks (see below).

### Git Hooks
Hooks live in the tracked `.githooks/` directory, so everyone gets the same ones from a normal clone or pull. `mise run install:hooks` sets `core.hooksPath` to `.githooks`. The setting is shared by every worktree of the checkout and the path is relative, so each worktree runs the hooks from its own branch — a branch cut before `.githooks/` existed has no hooks, and git skips them silently. To add a hook, commit an executable file named after the git hook (e.g. `.githooks/commit-msg`).

| Hook         | What it does                                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| `pre-commit` | Scans staged changes with `gitleaks` and blocks the commit if it finds a secret (redacted). |

The `pre-commit` hook fails closed: if `gitleaks` isn't installed, the commit is refused until you run `mise run bundle`. To get past a false positive, use `git commit --no-verify` for one commit, or add a `gitleaks:allow` comment to the offending line.

<!-- TODO(LAR-374): deduplicate with Future Work and compress the migration steps there. -->
*Why not husky?* Husky installs from npm, and this repo has no `package.json` (it was removed in `3d533dd` because there were no npm dependencies). A tracked hooks directory plus a mise task gives the same auto-install with no extra dependency. See [Future Work](#future-work) for when that changes.

### Installing Skills
You can install these skills into your Gemini CLI environment using the built `.skill` files in the `dist/` directory.

**Install a single skill:**
```bash
gemini skills install dist/<skill-name>.skill
```

**Install all skills at once:**
(Gemini CLI currently accepts one source at a time, so use a shell loop to install all artifacts in `dist/`):
```bash
for f in dist/*.skill; do gemini skills install "$f" --consent; done
```

**Link source skills (For Developers):**
To link the uncompressed source directories directly (useful for local development without building):
```bash
gemini skills link ./.gemini/skills
```

### Activating Skills
Once installed, activate a skill within a Gemini CLI session:

```javascript
activate_skill({ name: "start-worktree" })
```

## 👩🏾‍💻 Development

If you want to modify a skill or add a new one:

1.  Modify the source files in `.gemini/skills/<skill-name>/`.
2.  **Validate** your changes using the test suite:
    ```bash
    mise run test
    ```
3.  **Build** the distribution archives:
    ```bash
    mise run build:gemini
    ```
4.  The updated `.skill` files will be available in the `dist/` folder.

### Future Work

- **Revisit husky if `package.json` comes back.** Once the repo has npm dependencies again, husky costs nothing extra: its `prepare` script installs the hooks on `npm install`, and it fits with npm-based hook tooling like `lint-staged` (checking only staged files) or `commitlint` (enforcing the semantic commit format in `CONTRIBUTING.md`). Wanting either of those is the signal. Migrating means moving `.githooks/*` into `.husky/`, removing the `install:hooks` mise task and its `postinstall` call, and rewriting the [Git Hooks](#git-hooks) section. Until then, `.githooks/` does the same job without npm.

## ⚖️ License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](./LICENSE) file for details.

---
**Note:** These skills are purpose-built for the Gemini CLI and its underlying context-injection mechanics. They are **not** generic agents compatible with other local LLM runners without modification.
