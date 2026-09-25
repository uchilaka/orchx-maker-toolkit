---
name: import-profile
description: Weekly review script to check for updates in ~/.claude setup (settings.json, memory, goals, skills) and sync them into the Gemini environment. Use this when the user asks to "import profile" or run the weekly ~/.claude sync.
---

# Import Profile

This skill compares the current state of the user's `~/.claude` configuration (specifically memory, goals, skills, and settings.json) against the baseline saved in `~/.gemini/claude_baseline_hashes.txt`.

If changes are detected, it prompts you (the agent) to review them, determine if new Gemini hooks, skills, or global memories are needed, and ultimately update the baseline.

## 1. Check for Updates

Execute the following script to see what changed since the last review:

```bash
bash ${extensionPath}/scripts/check-updates.sh
```
*(Note: Replace `${extensionPath}` with the path to this skill's directory if you are running it manually, e.g., `bash ~/.gemini/extensions/import-profile/scripts/check-updates.sh` or `bash <path-to-skill>/scripts/check-updates.sh`)*

## 2. Review Changes

If the script detects changes:
1. Review the output diff.
2. Read the specific files that changed using the `read_file` tool to understand what's new.
3. Based on the changes:
   - Should a new hook be created in `~/.gemini/extensions/ralph/hooks/hooks.json` or another location?
   - Do we need to build a new custom skill using `activate_skill{name: "skill-creator"}`?
   - Do we need to update global instructions using `save_memory`?

## 3. Update Baseline

Once you have successfully ported the new Claude configurations into Gemini, update the baseline file so the changes aren't flagged again next week:

```bash
cp ~/.gemini/claude_new_hashes.tmp ~/.gemini/claude_baseline_hashes.txt
```
