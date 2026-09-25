#!/bin/bash
# summon.sh - Synchronize Gemini CLI profile from a remote machine
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <remote_host> [username]"
  exit 1
fi

REMOTE_HOST="$1"
USERNAME="${2:-$USER}"

GEMINI_DIR="${GEMINI_DIR:-$HOME/.gemini}"
BACKUP_DIR="$GEMINI_DIR/backups/profile_sync_$(date +%Y%m%d_%H%M%S)"

echo "Starting profile synchronization from ${USERNAME}@${REMOTE_HOST}..."

# 1. Backup Local State
echo "Backing up local profile to $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"

for item in "skills" "hooks" "GEMINI.md" "settings.json"; do
  if [ -e "$GEMINI_DIR/$item" ]; then
    cp -R "$GEMINI_DIR/$item" "$BACKUP_DIR/"
  fi
done

# 2. Synchronize from Remote (Merge Strategy)
echo "Pulling remote profile files..."

mkdir -p "$GEMINI_DIR/skills"
mkdir -p "$GEMINI_DIR/hooks"

# Scp using explicit paths to avoid wildcard expansion issues and improve security
scp -pr "${USERNAME}@${REMOTE_HOST}:.gemini/skills/*" "$GEMINI_DIR/skills/" || echo "Warning: No remote skills found or copy failed."
scp -pr "${USERNAME}@${REMOTE_HOST}:.gemini/hooks/*" "$GEMINI_DIR/hooks/" || echo "Warning: No remote hooks found or copy failed."
scp -p "${USERNAME}@${REMOTE_HOST}:.gemini/GEMINI.md" "$GEMINI_DIR/" || echo "Warning: Remote GEMINI.md not found or copy failed."
scp -p "${USERNAME}@${REMOTE_HOST}:.gemini/settings.json" "$GEMINI_DIR/" || echo "Warning: Remote settings.json not found or copy failed."

echo "Synchronization complete!"
echo "Your profile has been updated. Backup available at $BACKUP_DIR."
