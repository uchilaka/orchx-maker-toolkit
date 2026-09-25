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
| `llm-wikify` | Claude Code: scaffolds a Karpathy-style LLM-maintained wiki (sources, wiki, schema) in any repo. | [Docs](./docs/llm-wikify.md) |
| `markdown-manager` | Enforces documentation standards and manages planning artifacts. | [Docs](./docs/markdown-manager.md) |
| `release` | Automates the version bump, changelog, build, and git release process. | [Docs](./docs/release.md) |
| `specialist` | Orchestrates expert code, architecture, security, design, and devops reviews. | [Docs](./docs/specialist.md) |
| `start-worktree` | Scaffolds isolated work environments for new Jira tickets. | [Docs](./docs/start-worktree.md) |
| `summon-profile` | Synchronizes local profile with remote machines via scp. | [Docs](./docs/summon-profile.md) |

## 🚀 Installation & Usage

### Prerequisites
Requires Gemini CLI `>=0.37.0`. Tooling is managed via [mise](https://mise.jdx.dev/):
```bash
mise install
```
This provisions the pinned `node`/`direnv` versions and, via a `postinstall` hook, installs the external Gemini CLI extensions this toolkit depends on. To (re)run that extension install explicitly:
```bash
mise run install:extensions
```
*(Or run `gemini extensions install https://github.com/gemini-cli-extensions/ralph --auto-update --consent` directly)*

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

### Testing skills as Claude Code skills

Every skill's `SKILL.md` is also valid Claude Code skill format. To check a skill mounts
and validates cleanly as one (without permanently duplicating it into `.claude/skills/`):
```bash
mise run test:claude
```
This symlinks `.gemini/skills/*` into `.claude/skills/`, validates each one's frontmatter,
then unmounts — `.claude/skills/` is left exactly as it started. Run `mise run mount:claude`
/ `mise run unmount:claude` directly if you want to inspect a mounted skill by hand.

## ⚖️ License

This project is licensed under the **GNU General Public License v3.0**. See the [LICENSE](./LICENSE) file for details.

---
**Note:** These skills are purpose-built for the Gemini CLI and its underlying context-injection mechanics. They are **not** generic agents compatible with other local LLM runners without modification.
