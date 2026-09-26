---
name: undeclared-skill
description: A fixture skill that uses tools its Requirements section doesn't list. Use when the self-test needs the dependency check to fire.
---

# Undeclared skill

```bash
gh pr view "$PR" --json title | jq -r .title
curl -H "Authorization: Bearer $LINEAR_API_KEY" https://api.linear.app/graphql
```

Then call `mcp__linear__get_issue` with the ticket ID.

## Requirements

- `gh`
