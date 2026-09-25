# Release Skill

The `/release` skill automates the complex and error-prone process of cutting a new version of the Gemini Coder Toolkit. It ensures that all metadata, changelogs, and build artifacts are updated consistently before committing and tagging the repository.

## Workflow

1.  **Specialist Review:** Conducts a mandatory full review across all 7 technical domains (Code, Security, Architecture, etc.) to identify risks or technical debt before any changes are committed.
2.  **User Interview:** Pauses the process to present review findings. The user must decide whether to fix issues, proceed as-is, or adjust the release version.
3.  **Safety First:** Runs existing tests and validations to ensure the repository is in a releasable state.
4.  **Summary:** Summarizes unreleased changes from the git history.
5.  **Coordination:** Prompts the user for the new version number and release notes, informed by the specialist review findings.
6.  **Automation:**
    *   Updates the version in `GEMINI.md` and `CHANGELOG.md`.
    *   Drafts the `CHANGELOG.md`.
    *   Regenerates all `.skill` files in `dist/`.
7.  **Finalization:** Creates a semantic commit, generates a git tag, and pushes everything to the remote.

## Usage Example

Trigger the skill using the Gemini CLI:

```javascript
"I'm ready to ship the new features. Run the /release process for v0.3.0."
```
