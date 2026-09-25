---
name: summon-profile
description: Synchronizes the local Gemini profile (~/.gemini) with a remote machine via scp.
---

# 🪄 Summon Profile Skill

## Description
This skill automates the process of pulling your latest Gemini CLI profile (skills, hooks, global instructions, and setup) from a remote machine on your network to your local environment.

## Usage
Activate the skill, and it will guide you through the process, prompting for the remote machine's IP address and SSH username if necessary.

## Instructions
<instructions>
1. **Gather Information:** 
   - Ask the user for the IP address or hostname of the remote machine if not already provided.
   - Ask the user for their SSH username on the remote machine (fallback to the local user if left blank).
2. **Execute Synchronization:** 
   - Run the included `scripts/summon.sh` script, passing the target host and username.
   - The script will automatically backup the local state before pulling the remote files.
3. **Verify:** Confirm with the user that the synchronization was successful and briefly summarize the changes.
4. **Import Profile:** As the final step, immediately activate the `import-profile` skill to review the newly summoned `~/.claude` state and extract any applicable updates into the local Gemini environment.
</instructions>

## Resources
<available_resources>
  <resource>
    <name>scripts/summon.sh</name>
    <description>The Bash script that executes the scp merge logic and local backup.</description>
    <type>executable</type>
  </resource>
</available_resources>
