---
name: start-worktree
description: Creates a new isolated git worktree for a JIRA ticket, generates a draft PR checkpoint doc, and sets up the branch following user conventions. Use when starting a new task or feature.
---

# Start Git Worktree

Use this skill to set up an isolated development environment (git worktree) for a new task.

## 1. Gather Details
- Ensure you have the JIRA ticket ID and a short slug description from the user.
- If not provided, ask the user before proceeding.

## 2. Check for Git Crypt
- Check if the repository uses `git-crypt` (e.g., presence of `.git-crypt/`).
- If the repository uses `git-crypt` and `$GITCRYPT_KEY_BASE64` is available, ensure the repository is unlocked *first*. Use a secure temporary file to prevent key leakage:
  ```bash
  KEY_FILE=$(mktemp)
  trap 'rm -f "$KEY_FILE"' EXIT
  chmod 600 "$KEY_FILE"
  echo "$GITCRYPT_KEY_BASE64" | base64 -d > "$KEY_FILE"
  git crypt unlock "$KEY_FILE"
  # trap handles deletion, but we can explicitly remove it early
  rm -f "$KEY_FILE"
  ```

## 3. Create the Worktree and Setup Environment
- Identify the repository name.
- Branch name format: `<jira-ticket>/<short-slug>`
- Worktree location: `../<repo-name>-worktrees/<jira-ticket>`

  ```bash
  # 1. Create worktree (disabling git-crypt smudge filter temporarily if keys are missing)
  GIT_PAGER=cat git -c filter.git-crypt.smudge=cat worktree add -b <jira-ticket>/<short-slug> ../<repo-name>-worktrees/<jira-ticket> main
  
  # 2. Change to the new worktree
  cd ../<repo-name>-worktrees/<jira-ticket>
  
  # 3. Environment Synchronization (Framework Agnostic)
  # Replace `<main-repo-path>` with the absolute path to the original repository.
  
  # --- Rails specific (if applicable) ---
  if [ -d "<main-repo-path>/config/credentials" ]; then
    mkdir -p config/credentials
    cp -v <main-repo-path>/config/credentials/*.key config/credentials/ 2>/dev/null || true
    cp -v <main-repo-path>/config/master.key config/ 2>/dev/null || true
  fi
  
  # --- Node/Yarn specific (if applicable) ---
  if [ -f "package.json" ]; then
    # Prefer --immutable or --frozen-lockfile to avoid slow, full installs on worktree creation
    yarn install --immutable || npm ci
  fi
  
  # --- Toolchain specific (if applicable) ---
  [ -f ".mise.toml" ] && mise trust
  
  # 4. Finalize Git Crypt (if applicable)
  if [ -d ".git-crypt" ] && [ -n "$GITCRYPT_KEY_BASE64" ]; then
    KEY_FILE=$(mktemp)
    chmod 600 "$KEY_FILE"
    echo "$GITCRYPT_KEY_BASE64" | base64 -d > "$KEY_FILE"
    git crypt unlock "$KEY_FILE"
    rm -f "$KEY_FILE"
    git reset --hard HEAD
  fi
  ```
  *(Note: adjust `main` if the default branch is different).*

## 4. Create Draft PR Checkpoint
- Identify the project key (e.g., from the repo name).
- Create the directory if it doesn't exist in the project root: `mkdir -p .gemini/draft-prs/`
- Create a markdown file at `.gemini/draft-prs/<jira-ticket>_<short-slug>.md`.
- Populate it with standard PR template sections (Title, Description, Acceptance Criteria) and save it.
