# Contributing to OrchX Maker Toolkit

We'd love to accept your patches and contributions to this project!

## 🚀 Getting Started

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** locally:
    ```bash
    git clone https://github.com/uchilaka/orchx-maker-toolkit.git
    ```
3.  **Install tooling**:
    ```bash
    mise run bundle   # Homebrew dependencies, including gemini-cli and gitleaks
    mise install      # pinned tools, extensions, and the shared git hooks
    ```

## 🛠 Development Workflow

1.  **Create a new branch** for your feature or fix.
2.  **Make your changes** in the `.gemini/skills/` directory.
3.  **Run the test suite** to ensure your skills are valid:
    ```bash
    mise run test
    ```
4.  **Commit your changes** using semantic commit messages (e.g., `feat:`, `fix:`, `docs:`).
5.  **Push your branch** and open a Pull Request.
6.  **Request a Claude review** (optional) by commenting `@claude review` on the PR. Reviews never run automatically; see [docs/claude-github-actions.md](docs/claude-github-actions.md).

## 🧩 Adding a Skill

The toolkit targets Claude Code by default. Every new skill answers these placement
questions before any files are written. Agents working in this repo must ask the
maintainer, not assume.

1.  **Which harness: Claude, Gemini, or both?** This decides where the source lives:

    | Harness          | Source                    | Packaged in `dist/` |
    | ---------------- | ------------------------- | ------------------- |
    | Claude (default) | `.claude/skills/<name>/`  | No                  |
    | Gemini           | `.gemini/skills/<name>/`  | Yes                 |
    | Both             | `.gemini/skills/<name>/`  | Yes — `mise run mount:claude` exposes it to Claude Code |

    A Claude skill in `.claude/skills/` also needs a `!.claude/skills/<name>` line in
    `.gitignore`, which ignores everything else in that directory.
2.  **User-level or repo?** A personal skill lives in `~/.claude/skills/<name>/` (or the
    Gemini equivalent) and never enters this repo. A repo skill gets a `docs/<name>.md`
    page and a row in the README's skills table.
3.  **For a repo skill: mountable or repo-specific?**
    - **Mountable** — globally mounted: symlinked from this checkout into the user's
      harness skill directory, so edits here go live in every session on the machine:
      ```bash
      ln -s "$PWD/.claude/skills/<name>" ~/.claude/skills/<name>   # Claude
      gemini skills link ./.gemini/skills                           # Gemini
      ```
      A mountable skill runs from whatever repo the session is in, so it must not use
      paths relative to this repo. Reference its own files relative to the skill
      directory.
    - **Repo-specific** — not globally mounted. It is used in sessions opened inside
      this repo, or (for Gemini) by installing it from `dist/`.

    This is separate from `mise run mount:claude`, which symlinks every Gemini skill
    into this repo's `.claude/skills/` for testing.

Record the answers to questions 1 and 3 in the skill's `docs/<name>.md` under an
`## Installation` heading, including the symlink command when it is mountable.

## ⚖️ License

By contributing, you agree that your contributions will be licensed under the project's **GPL-3.0** license.
