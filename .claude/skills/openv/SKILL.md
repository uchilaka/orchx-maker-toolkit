---
name: openv
description: Load secrets from Proton Pass into a command's environment on demand, without the values ever entering the agent session. Works in Claude Code, OpenCode and any terminal. Shows which openv profiles and vaults apply to the current directory (`openv status`), and runs commands with `openv run <env> -- <cmd>`. Use when the user says "/openv", "show my openv config", "which secrets are set up here", "load secrets for this command", "run this with my dev secrets", or when a command needs credentials that live in Proton Pass.
---

# /openv: secrets on demand, never in the session

Setting it up, or stuck on a blocked command? [PLAYBOOK.md](PLAYBOOK.md) walks a person through it; this file is the reference.

The script is `${CLAUDE_SKILL_DIR}/bin/openv`. Call it by that path: the `openv` on PATH exists only if the user ran `mise run install:openv`. In OpenCode, replace `${CLAUDE_SKILL_DIR}` with the skill's base directory, given when the skill loads.

> In progress (plan `OPENV_PLUGIN.md`). `status`, `items`, `run`, `export`, `mise run install:openv` and the command guard work now. The template builder comes next.

## The rule this skill exists for

Never read, print, or echo a secret value. In an agent session, secrets reach a command
only through `openv run <env> -- <cmd>`, which passes them to the child process and masks
them in its output. `openv export` is for the user's own terminal, and refuses to run
under an agent.

**What actually protects the secrets.** openv keeps values out of a session that
follows these rules. It is not a boundary against an agent that's trying: an agent with
a logged-in `pass-cli` can call `pass-cli item view` directly, encode a value inside
`openv run`, or get past `export`'s checks. The real boundary is the agent having no
`pass-cli` login of its own.

## The command guard

A PreToolUse hook on Bash and Monitor, `hooks/guard-secrets.sh`, blocks commands that would print a value: `openv export`, `pass-cli item view`, `pass-cli inject`, `--no-masking` and the rest of `hooks/deny.tsv`. A blocked command fails with a message that points to `openv run`; rewrite the command that way rather than working around the block. The `openv` plugin installs the hook, and so does `mise run install:claude-global openv`, which asks first. It needs `jq`: without it, every command naming `openv` or `pass-cli` is blocked. The same goes when the hook can't find its script (a moved checkout, say): the block message says the guard couldn't run, and other commands still work, so re-run the install or remove the hook from `~/.claude/settings.json`.

<!-- TODO(LAR-527): say masking covers stdout/stderr and whole values only (files, partial values). -->

## Requirements

- `bash` (3.2, the macOS default, or later) and `git`.
- `pass-cli` (Proton Pass CLI), logged in: `brew install protonpass/tap/pass-cli`, then
  `pass-cli login`. Only `--check`, `run` and `export` call it.
- `jq`, for the command guard and for `items`.

## Install onto PATH

```bash
mise run install:openv
```

Symlinks `~/.local/bin/openv` to the main checkout's script (idempotent; warns if
`~/.local/bin` isn't on `PATH`). To try an unmerged worktree copy first, run
`SKILL_SOURCE_ROOT=$PWD mise run install:openv` from that worktree, then re-run from
`main` after merge. `mise run uninstall:openv` removes the link when it points into
openv.

An existing `~/.local/bin/openv` link is replaced only when it points at an openv script. If it points anywhere else, install leaves it alone and says so; `mise run install:openv -- --force` replaces it.

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
  one set of profiles. It is the name only: two repos with the same directory name
  (say `~/work/api` and an untrusted clone at `~/oss/api`) share profiles too, and
  `openv run` in the clone hands its code the same secrets. Rename one checkout's
  directory to keep them apart.
- A project profile wins over a global profile with the same name.
- Outside a git repo, only global profiles apply.

A profile looks like this:

```dotenv
OPENROUTER_API_KEY=pass://<share-id>/<item-id>/API Key
LOG_LEVEL=debug
```

Lines whose value starts with `pass://` are references. Any other value is a literal,
passed through as written. Write `KEY=value` with no `export ` prefix (`pass-cli run`
skips lines starting with `export `, and `status` flags them as ignored). Use share and
item IDs rather than names, so renaming a vault or item can't silently break a
reference.

`export` refuses a profile that sets a variable which changes how a shell or the
dynamic loader starts: `PATH`, `IFS`, `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`,
`PS0`–`PS9`, `PROMPT_COMMAND`, `ZDOTDIR`, `CDPATH`, `LD_*`, `DYLD_*` and `BASH_FUNC_*`.
`status` flags them.

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

## Find what to reference

```bash
openv items                          # vault, type, title and pass:// ref of every item in the allowed vaults
openv items --vault <vault>          # one allowed vault
openv items --fields <vault>/<title> # one item's field names and how each is stored
```

Use these to write a profile's references: the listing's last column is `pass://<share-id>/<item-id>`, and `--fields` gives the field name to append (`pass://<share-id>/<item-id>/<field>`). Only vaults in the allowlist are read; any other vault is refused before pass-cli runs.

- The listing carries titles, types and IDs, never values.
- `--fields` is the one openv call that reads an item, and it prints field names and storage types (`login`, `note`, `Hidden`, `Text`, ...) only. An empty login field is left out. When pass-cli or jq fails, openv says so without passing their messages on, since jq quotes its input when it errors.

## Run a command with secrets

```bash
openv run <env> -- <cmd>...
```

Resolves `<env>` (project profile first, then `global/`), injects the resolved values
into `<cmd>` only, and masks secret strings on stdout and stderr (`<concealed by Proton
Pass>`). Returns `<cmd>`'s exit code.

Masking is string-match only on stdout and stderr: a command that encodes a secret (for
example with `base64`) or writes it to a file bypasses masking.

## Load secrets into your own terminal

```bash
eval "$(openv export <env>)"
```

Works in both `zsh` and `bash`, and safely quotes spaces, quotes, `$` and newlines.
Refuses to run under `CLAUDECODE`, `OPENCODE_SESSION_ID`, or without a TTY on stdin.
Those checks are advisory: they stop an agent from running it by accident, not one
that's trying, which can unset the variables and wrap the call in a pseudo-terminal.

Exported values stay in that shell, and every program started from it inherits them,
including an agent: run `claude` or `opencode` in the same terminal afterwards and its
environment holds every value, unmasked. Start agents from a different terminal, or
load into a subshell you `exit` when done:

```sh
openv-sh() { ( eval "$(openv export "$1")" && exec "${SHELL:-/bin/sh}" ); }
```

Optional shell helper for `~/.zshrc` or `~/.bashrc`:

```sh
openv-load() { eval "$(openv export "$1")"; }
```
