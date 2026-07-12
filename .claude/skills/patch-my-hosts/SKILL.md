---
name: patch-my-hosts
aliases: ["patch-hosts", "hosts-update"]
description: Sync /etc/hosts with the latest upstream from someonewhocares.org while preserving your custom edits. Use when the user says "/patch-my-hosts", "update my hosts file", "refresh hosts blocklist", or when a session-start notice says a hosts update is pending.
---

# /patch-my-hosts — Sync /etc/hosts with the someonewhocares.org blocklist

Refresh the upstream hosts blocklist from https://someonewhocares.org/hosts/ into a sentinel-bracketed managed block inside `/etc/hosts`, preserving every custom entry outside that block. Never auto-writes to `/etc/hosts` — you copy/paste a `sudo` one-liner after reviewing the diff.

## Prerequisites

- macOS (uses `launchd` for the weekly refresh)
- `curl` available
- Custom entries (LarCity dev hostnames, app aliases, etc.) live OUTSIDE the managed block; the managed block contains only upstream content

## Workflow

Run the main script. It will fetch the upstream into a weekly archive, build a patched candidate, show you a diff, and print the apply command:

```bash
~/.claude/skills/patch-my-hosts/scripts/patch-my-hosts.sh
```

Common flags:

- `--dry-run` — fetch + reconcile + diff, but never prompt and never print the apply command
- `--verbose` — show the full diff instead of just the summary
- `--force-fetch` — re-download the upstream even if the weekly archive already exists

## What it does

1. **Fetch** the upstream into `~/.local/share/patch-my-hosts/archive/<YYYY-WNN>.hosts` (idempotent — only downloads if the archive for the current ISO week is missing or `--force-fetch`).
2. **Reconcile** — slice `/etc/hosts` into `head | managed | tail` by sentinel position, rebuild as `head + new-sentinels-wrapping-upstream + tail`, write to `/tmp/hosts.<YYYY-WNN>.patched`.
3. **Diff** — show summary (`+X / -Y`) or full diff with `--verbose`.
4. **Print** the apply command. You run it. We never run `sudo`.

### First-run flow (no sentinels in `/etc/hosts` yet)

Asks you to confirm before generating output. Default insertion: at end of file, separated by a blank line. The first run only *adds* sentinels and the upstream content — your existing custom entries are untouched.

### Sentinel format

```
# >>>>> BEGIN someonewhocares.org/hosts (managed by /patch-my-hosts) >>>>>
# Version: 2026-W25    Fetched: 2026-06-25T14:00:00Z
# DO NOT EDIT BETWEEN SENTINELS — changes are overwritten on next sync.
# Custom entries belong OUTSIDE this block.
<upstream content>
# <<<<< END   someonewhocares.org/hosts (managed by /patch-my-hosts) <<<<<
```

## Weekly fetch (LaunchAgent)

Install the weekly refresh job (user-level LaunchAgent, no root):

```bash
~/.claude/skills/patch-my-hosts/scripts/install-launchd.sh
```

This:
- Schedules `fetch-upstream.sh` weekly (Sunday 03:30 local by default)
- Writes a `pending` marker on successful fetch so `check-stale.sh` knows to nag

Uninstall mirror:

```bash
~/.claude/skills/patch-my-hosts/scripts/uninstall-launchd.sh
```

The LaunchAgent never touches `/etc/hosts` — it only refreshes the archive. The split (launchd fetches, you apply) is deliberate: no background daemon needs write access to `/etc/hosts`.

## SessionStart hook (optional)

Surface a pending refresh in new Claude sessions. Add to `~/.claude/settings.json` via `/update-config`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "~/.claude/skills/patch-my-hosts/scripts/check-stale.sh"
      }
    ]
  }
}
```

`check-stale.sh` exits silently in the steady state. It prints a one-line nudge when:
- The `pending` marker exists, OR
- The last successful fetch is older than 7 days

## Data layout

```
~/.local/share/patch-my-hosts/
├── archive/
│   ├── 2026-W25.hosts          # weekly snapshot
│   ├── 2026-W25.hosts.sha256   # integrity sidecar
│   └── …
├── latest -> archive/2026-W25.hosts   # symlink to newest
├── last-fetched                # ISO-8601 timestamp of last successful fetch
├── pending                     # marker; cleared after a successful apply
└── logs/
    ├── launchd.stdout.log
    └── launchd.stderr.log
```

## Safety rails

- Never auto-writes `/etc/hosts` — you copy/paste the `sudo` command after reviewing the diff
- Always shows the apply command with a backup step: `sudo cp /etc/hosts /etc/hosts.<date>.bak && sudo cp <patched> /etc/hosts`
- Idempotent: re-running with the same upstream produces a zero-diff result
- First run asks for explicit `yes` before generating output

## Verification

```bash
# 1. Dry-run reconciliation
~/.claude/skills/patch-my-hosts/scripts/patch-my-hosts.sh --dry-run

# 2. Inspect the candidate
diff -u /etc/hosts /tmp/hosts.*.patched | head -40

# 3. (Real apply, when ready — you run this yourself)
sudo cp /etc/hosts /etc/hosts.$(date +%Y-%m-%d).bak \
  && sudo cp /tmp/hosts.<wk>.patched /etc/hosts \
  && dscacheutil -flushcache \
  && sudo killall -HUP mDNSResponder

# 4. Sanity-check a known custom entry is preserved
grep your-custom-host /etc/hosts
```

## Out of scope (v1)

- Multi-source aggregation (StevenBlack, etc.) — single upstream only
- Auto-applying via privileged helper — sudo stays manual
- Linux/Windows equivalents — macOS launchd only
