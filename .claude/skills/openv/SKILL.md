---
name: openv
description: Load secrets from Proton Pass into a command's environment on demand, without the values ever entering the Claude session. Shows the current project's openv profiles and vault allowlist, builds new profile templates by interviewing over vault item metadata (names and types, never values), and runs commands with `openv run <env> -- <cmd>`. Use when the user says "/openv", "show my openv config", "build an env template", "load secrets for this command", "run this with my dev secrets", or when a command needs credentials that live in Proton Pass.
---

# /openv — secrets on demand, never in the session

> Skeleton. Commands and the template-builder interview arrive in later steps of
> the plan (`OPENV_PLUGIN.md`); until then `openv` only prints its usage.

The script is `${CLAUDE_SKILL_DIR}/bin/openv`, also linked onto PATH as `openv`.

## The rule this skill exists for

Never read, print, or echo a secret value. In a Claude session, secrets reach a
command only through `openv run <env> -- <cmd>`, which passes them to the child
process and masks them in its output. `openv export` is for the user's own
terminal and refuses to run inside Claude.
