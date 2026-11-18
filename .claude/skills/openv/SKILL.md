---
name: openv
description: Load secrets from Proton Pass into a command's environment on demand, without the values ever entering the agent session. Works in Claude Code, OpenCode and any terminal. Shows which openv profiles and vaults apply to the current directory (`openv status`), and runs commands with `openv run <env> -- <cmd>`. Use when the user says "/openv", "show my openv config", "which secrets are set up here", "load secrets for this command", "run this with my dev secrets", or when a command needs credentials that live in Proton Pass.
---

# /openv: secrets on demand, never in the session

The script is `${CLAUDE_SKILL_DIR}/bin/openv`, also linked onto PATH as `openv`. In
OpenCode, replace `${CLAUDE_SKILL_DIR}` with the skill's base directory, given when the
skill loads.

> In progress (plan `OPENV_PLUGIN.md`). `status` works now. `run`, `export` and the
> `mise run install:openv` link come next, then `items` and the template builder.

## The rule this skill exists for

Never read, print, or echo a secret value. In an agent session, secrets reach a command
only through `openv run <env> -- <cmd>`, which passes them to the child process and masks
them in its output. `openv export` is for the user's own terminal, and refuses to run
under an agent.

## Requirements

- `bash` (3.2, the macOS default, or later) and `git`.
- `pass-cli` (Proton Pass CLI), logged in: `brew install protonpass/tap/pass-cli`, then
  `pass-cli login`. Only `--check`, `run` and `export` call it.
- `jq`, but only for `items` (not built yet).

## Where profiles live

A profile is a dotenv file of variable names and `pass://` references. It holds no
secret values, so it's safe to read and show.

```text
~/.config/openv/
├── vaults                 # vault allowlist, one name per line (# comments allowed)
├── global/
│   └── openrouter.env     # usable from any directory
└── <project>/
    ├── vaults             # optional: replaces the global allowlist for this project
    └── dev.env            # usable inside that git project and all its worktrees
```

- `<project>` is the main checkout's directory name, so every worktree of a repo shares
  one set of profiles.
- A project profile wins over a global profile with the same name.
- Outside a git repo, only global profiles apply.

A profile looks like this:

```dotenv
OPENROUTER_API_KEY=pass://<share-id>/<item-id>/API Key
LOG_LEVEL=debug
```

Lines whose value starts with `pass://` are references. Any other value is a literal,
passed through as written. Use share and item IDs rather than names, so renaming a vault
or item can't silently break a reference.

## Show the current setup

```bash
openv status            # local files only: no network, no pass-cli call
openv status --check    # also checks Proton Pass login (one metadata call, output discarded)
openv status --json     # the same, machine-readable
```

It lists the project, the vault allowlist in force, each profile with its variables,
dependencies, and whether `~/.local/bin/openv` links to this script.

- A reference is printed in full, because it says where a secret lives, not what it is.
- A literal prints as `(literal)`, never its value, in case a secret was pasted in by
  mistake.

When showing this to the user, present the profiles as a short table, one row per
variable.
