# Contributing to Gemini Coder Toolkit

We'd love to accept your patches and contributions to this project!

## 🚀 Getting Started

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** locally:
    ```bash
    git clone https://github.com/google/gemini-coder-toolkit.git
    ```
3.  **Install tooling**:
    ```bash
    mise install
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

## ⚖️ License

By contributing, you agree that your contributions will be licensed under the project's **GPL-3.0** license.
