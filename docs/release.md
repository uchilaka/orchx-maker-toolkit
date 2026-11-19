# Release Skill

The `/release` skill automates the complex and error-prone process of cutting a new version of the OrchX Maker Toolkit. It ensures that all metadata, changelogs, and build artifacts are updated consistently before committing and tagging the repository.

## Workflow

1.  **Specialist Review:** Conducts a mandatory full review across all 7 technical domains (Code, Security, Architecture, etc.) to identify risks or technical debt before any changes are committed.
2.  **User Interview:** Pauses the process to present review findings. The user must decide whether to fix issues, proceed as-is, or adjust the release version.
3.  **Safety First:** Runs existing tests and validations to ensure the repository is in a releasable state. Then runs `mise run publish-prep`, and stops the release on any `high` finding (a secret, a machine-specific path, broken frontmatter) until `/publish-prep` fixes it.
4.  **Summary:** Summarizes unreleased changes from the git history.
5.  **Coordination:** Prompts the user for the new version number and release notes, informed by the specialist review findings.
6.  **Automation:**
    *   Updates the version in `GEMINI.md`, `.claude-plugin/plugin.json` and `CHANGELOG.md`.
    *   Drafts the `CHANGELOG.md`.
    *   Regenerates all `.skill` files in `dist/`.
7.  **Release PR:** Commits the release on a `release/vX.Y.Z` branch and opens a pull request, since `main` only accepts changes through one.
8.  **Merge & Tag:** Once CI passes, merges the PR with a merge commit (never a squash), then tags the release commit and pushes the tag. The tag goes last, so it always points at a commit on `main`.

## Usage Example

Trigger the skill using the Gemini CLI:

```javascript
"I'm ready to ship the new features. Run the /release process for v0.3.0."
```
