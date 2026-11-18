---
name: pick-model
description: Pick the model to keep for a whole session, balancing cost against how hard the work is. Interviews for what the session is for, shortlists only models your OpenRouter guardrails allow, estimates the session's cost on each candidate from live prices, and recommends one model plus a reasoning effort, a runner-up and how to switch. Works in Claude Code and OpenCode. Use when the user says "/pick-model", "pick a model", "which model should I use", "what model for this session", "cheapest model that can handle this", or is about to start a long session and asks about model cost. Recommends only; never switches the model itself.
---

# /pick-model: one model for the whole session

The goal is the model to **keep for the session**, not the best model for the next
message. That changes the math:

- **Switching is expensive.** A new model starts with a cold prompt cache and pays to
  write the whole context again. In a measured OpenCode session, a switch's first step
  cost $0.22, and each step after it cost about $0.02.
- **So pick for the hardest work the session is likely to hit**, not the average. A
  model that stalls on the hard part costs a switch, plus the retries before the switch.
- **Cached reads dominate a long session's bill.** Every step re-reads the context, so
  cache-read price matters more than the headline input price.

## Requirements

- `node` 18 or later, for the built-in `fetch` the estimator uses.
- Network access to `openrouter.ai`, or a saved price list passed with `--prices`.
- `OPENROUTER_API_KEY` set to **the same key the harness uses**. OpenRouter applies
  guardrails per key, and the script asks it for only the models that key may use. A
  regular API key is enough; it doesn't need to be a management key. Never read the key
  out of a harness's credential store: ask the user to export it.
<!-- publish-prep: allow portability — /models is OpenCode's built-in model picker, not a skill this bundle could ship -->
- The harness's own model picker for the switch itself (`/models` in OpenCode, `/model`
  in Claude Code). Both are built-in commands, not part of this skill.

## Steps

### 1. Interview

Ask in one batch, and skip anything the request already answers:

1. **What's the session for?** One line, such as "add a Rails endpoint with tests" or
   "triage PR comments".
2. **How hard is the hardest part?** Map the answer to a tier:

   | Tier | Looks like | Effort |
   | ---- | ---------- | ------ |
   | routine | config, docs, renames, small fixes with a known cause, scripted chores | low |
   | standard | a feature or fix across a few files, writing tests, an ordinary review | medium |
   | hard | architecture, a bug whose cause is unknown, security-sensitive code, a large refactor, a multi-agent review | high |

3. **How long will it run?** This sets the profile: `quick` (about 15 agent steps),
   `standard` (about 60), or `marathon` (about 200, or a whole day). When unsure, use
   `standard`.
4. **Any constraints beyond your OpenRouter guardrails?** Examples: images or other
   vision input, or a very large codebase that needs a long context window. Don't ask
   which models the guardrails allow. The filtered list in step 2 answers that more
   reliably than memory does.

### 2. Find the harness and the candidates

Start from the models your guardrails allow:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/session-cost.mjs" --list --since-days 90
```

In OpenCode, replace `${CLAUDE_SKILL_DIR}` with the skill's base directory, given when
the skill loads. The first line of output says which list it used:

- `models allowed by your guardrails`: OpenRouter has filtered the list by this key's
  guardrails, privacy settings (for example, excluding providers that train on your
  data) and provider preferences. **Shortlist only from this list.**
- `UNFILTERED: guardrails not applied`: `OPENROUTER_API_KEY` isn't set. Stop and ask
  the user to export it, then re-run. Don't recommend from an unfiltered list. A model
  that's on the list but blocked fails at the first request with "Model blocked by
  guardrail" (HTTP 404), and switching away costs a cold cache.

Then narrow by harness:

- **OpenCode** (`OPENCODE_SESSION_ID` is set). Keep only models that also appear in Code
  Mode's `tools.opencode.models` (provider `openrouter`), since the session can only
  switch to those. That list does **not** apply guardrails, so it never adds models back.
- **Claude Code** (`CLAUDECODE` is set). Claude Code talks to Anthropic directly, so
  OpenRouter guardrails don't limit it. The choice is the Opus, Sonnet and Haiku
  families, priced under their `anthropic/*` IDs. Those prices match Anthropic's list
  prices, and on a subscription the relative cost is what uses up your limits.

Shortlist three to five models: the newest of each family, spread across tiers. Within
one provider, price follows capability, so the most expensive current model is its
frontier model.

**Shortlist against the tier.** A routine session gets no frontier models. A hard
session gets no budget models, unless the user's priority is cost.

### 3. Estimate

```bash
node "${CLAUDE_SKILL_DIR}/scripts/session-cost.mjs" --profile <profile> --effort <effort> <model-id> ...
```

`<profile>` is `quick`, `standard` or `marathon`, and `<effort>` is `low`, `medium` or
`high`.

The script accepts OpenRouter IDs, with or without OpenCode's `openrouter/` prefix. It
prints the estimated session cost for each model, cheapest first, and flags a model that
has no cache pricing or whose context window is too small for the profile. A model the
filtered list omits fails with "not allowed for this key". Drop it rather than working
around it. If you know
the session's shape better than the profile does, override it with `--steps`,
`--start-context`, `--end-context` and `--output-per-step`. Exit 2 means a bad flag or an
unknown ID; stderr names which.

Treat the figures as a ranking, not a quote. The effort multipliers are rough, and an
idle gap of more than about five minutes lets the cache expire.

### 4. Recommend

Reply with:

- **The pick:** model ID, effort, estimated session cost, and one line explaining why it
  fits the hardest part.
- **The runner-up**, and what would make it the better choice (for example, "if the bug
  turns out to be shallow").
<!-- publish-prep: allow portability — /models is OpenCode's built-in model picker, not a skill this bundle could ship -->
- **How to switch.** In OpenCode, `/models` sets it for the current session, and
  `"model"` in `opencode.jsonc` sets the default for new sessions. In Claude Code, use
  `/model`.
- **What the cheap option risks**, when the pick isn't the cheapest. For example: "Sonnet
  saves about $1.20, but if it stalls on the migration, a switch to Opus costs the cache
  again."

Don't switch the model yourself, even if the harness allows it.

## Routers

`openrouter/auto` and `openrouter/auto-code` choose a model on each request, so the
script can't price them up front (it exits 2 if asked). Suggest a router only when the
session's difficulty truly can't be predicted. Routers try to stay on one model, but they
still switch when the task changes. `auto-code` is OpenRouter's router tuned for coding
agents. The Activity page at https://openrouter.ai/activity shows which model a router
actually ran.
