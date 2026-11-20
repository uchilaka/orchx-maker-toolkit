---
name: triage-findings
description: Triage the findings in a saved ~/pr-reviews review doc — the review-triage agent recommends fix now / defer / dismiss for each, then on the user's own work in progress the verified fix-now findings are applied and committed one per fix, and on anyone else's PR the user decides in one batch. The shared last step of /pr-review and /live-code-review. Use when the user says "/triage-findings", "triage these findings", "triage the review", or hands over a ~/pr-reviews doc to act on. Not a review itself (that's /pr-review or /live-code-review), and not for comments other people left on a PR (that's /pr-triage).
---

# /triage-findings

Work in progress ([LAR-522](https://linear.app/larcity-and-affiliates/issue/LAR-522/triage-findings-shared-review-triage-that-auto-applies-fix-now)). This skill exists so the `review-triage` agent can ship with it, in `agents/`. Its workflow lands in the next step. Until then, tell the user it isn't ready, and that `/live-code-review` still runs its own triage (Steps 4–6).
