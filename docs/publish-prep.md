# Publish Prep Skill

The `/publish-prep` skill gets a skill, agent or script ready for someone else's machine. A bundled checker finds what would leak or break once it's shared. The skill drafts a fix for each finding, you approve them in one batch, and it applies only what you approved.

## What it checks

| Check | Finds | Blocks a release? |
| :--- | :--- | :--- |
| `secrets` | Tokens and keys (via `gitleaks`, with a regex fallback), email addresses, Tailscale `*.ts.net` hostnames, internal domains | Yes (`high`). Private IPs are `medium` |
| `portability` | Absolute home paths, machine-specific paths, a skill pointing at its own install path | Yes (`high`) |
| | Personal conventions (e.g. a plans folder only you use), references to skills that don't ship | No (`medium`) |
| `frontmatter` | Missing or mismatched `name`, missing or oversized `description` | Yes (`high`) |
| | Short descriptions, or ones that name no trigger phrase | No (`low`) |
| `dependencies` | CLIs, env vars and MCP servers used but not listed under `## Requirements` | No (`medium`) |

## Workflow

1.  **Check:** Runs `scripts/publish_prep.cjs` (bundled in the skill) against the paths you name, or against everything a release publishes.
2.  **Report:** Leads with `BLOCKED (N high)` or `OK`, then lists the findings by item.
3.  **Draft:** Proposes an edit for each finding, or an allow comment with a reason when the finding is deliberate.
4.  **Approve:** Shows every proposed change in one numbered batch. You choose apply, allow or skip per item. Nothing is edited before you answer.
5.  **Re-check:** Applies what you approved and re-runs the checker to show the before-and-after counts.

## Usage

```bash
mise run publish-prep                      # everything a release publishes
mise run publish-prep -- .claude/skills/x  # one item
mise run publish-prep -- --json            # machine-readable
```

`/release` runs `mise run publish-prep` in its pre-flight step, and stops on any `high` finding.

## Configuration

`.publish-prep.json` at the repo root says what counts as personal in this repo:

```json
{
  "internalDomains": ["corp.example"],
  "personalPaths": ["/srv/checkouts"],
  "personalConventions": ["~/my-plans"],
  "assumedCommands": ["jq"],
  "knownCommands": ["my-team-skill"]
}
```

## Allowing a deliberate finding

Put an allow comment on the line above the finding, or on the same line. The reason is required, and an allow without one is ignored:

```markdown
<!-- publish-prep: allow portability — documents the macOS default path on purpose -->
```

Allowed findings still appear in the report, with their reasons.
