---
name: tidy-skill
description: A fixture skill with nothing to fix. Use when the self-test needs an item that every publish-prep check passes.
---

# Tidy skill

Reads a JSON file and prints its keys.

```bash
jq 'keys' "$1"
```

## Requirements

- `jq`
