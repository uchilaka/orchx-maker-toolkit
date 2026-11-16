---
name: shell-idioms-skill
description: A fixture skill whose scripts use ordinary shell idioms that are not dependencies. Use when the self-test guards the dependency check against false positives.
---

# Shell idioms skill

```bash
bash "$SKILL_DIR/scripts/run.sh"
```

## Requirements

- `SKILL_DIR`, the directory this skill is installed in
