# Pull Request: [Title]

<!-- Guidance lives in comments like this one: visible while you write, hidden once the PR is published. Delete any section that genuinely doesn't apply, and say why in one line rather than leaving it blank. -->

## 1. AI Provenance & Generation Context

* **How was this code written?**
  * [ ] Written 100% by hand
  * [ ] Human-led + AI-assisted (Cursor, Copilot, etc. for boilerplate/snippets)
  * [ ] AI-generated from prompt/spec (Claude Code, v0, etc.)
* **Prompt / Spec Reference:** [Link to prompt, ticket, or spec doc]
* **Comprehension Check:** [ ] I have read, stepped through, and fully understand every single line of this diff.

---

## 2. Intent & Scope Check (Product vs. Engineering)

* **Acceptance Criteria Match:** Does this directly map to the story/ticket requirements?
* **Scope Boundary:** Did the AI or author touch *only* what was requested, or did it introduce "drive-by" refactoring, unrequested helpers, or ghost features?
  * [ ] Clean scope (only target files changed)
  * [ ] Unrequested changes included (explain why or revert)

---

## 3. Respect for the Reviewer's Time

<!--
A reviewer's attention is the scarcest resource in this process. Generating a large diff is now cheap; reviewing one is not. Hand over something a person can hold in their head.

~400 changed lines is the guide because defect detection drops sharply past that point (SmartBear/Cisco code review study). It's a guide, not a gate.
-->

* [ ] I reviewed my own diff, top to bottom, before requesting review.
* [ ] This PR is ~400 changed lines or fewer, **or** I've explained below why it's larger and suggested an order to review it in.
* [ ] Generated, vendored, or lockfile changes are called out so reviewers can skip them.

**Suggested review order** *(only if large)*:

---

## 4. Verification & Evidence (Non-Negotiable for AI Code)

* **Tests Added / Updated:** [ ] Unit tests [ ] Integration tests [ ] E2E tests
* **Proof of Execution:**
  <!-- Paste command output or logs, or drop screenshots/recordings. Give every image alt text. -->
  * `[Command run, e.g., npm test -- --coverage]`
  * `[UI state / flow verified]`
* **Edge Cases & State Handling:**
  * [ ] Loading, empty, and error states handled
  * [ ] Null / undefined / boundary inputs tested

---

## 5. How to Validate

<!-- Write for someone new to this codebase who has never run it. Assume nothing is installed or configured; every command should be copy-pasteable, and every step should say what they should see when it works. -->

**Steps:**

1. `git checkout <branch>`
2. <!-- Install / setup -->
3. <!-- Run / navigate / click -->
4. **Expected:** <!-- What success looks like -->

**Scenarios & sample data:**

<!-- Cover the happy path and the edge cases from section 4. Link fixtures or seed data where they exist. -->

| Scenario | Input / sample data | Expected result |
| -------- | ------------------- | --------------- |
|          |                     |                 |

**Rollback:** <!-- How to undo this if it misbehaves after merge: revert, flip a flag, run a down migration. -->

---

## 6. Security & Architecture Risk Assessment

* **Security Surface Check:**
  * [ ] No hardcoded secrets, API keys, or tokens
  * [ ] Auth/permissions verified (no bypassed access controls)
* **Maintainability & Tech Debt:** Will this code still make sense to a human engineer in 3 to 6 months?
  * [ ] Low complexity / high readability
  * [ ] No hallucinated libraries or deprecated APIs used

---

## 7. Reviewer Focus Areas

* **Callouts for Human Reviewer:**
  <!-- e.g., "Pay special attention to the async state machine in `service.ts`. AI generated this loop and I verified it with mock streams." -->

---

## 8. For Reviewers: How We Review

Review is collaboration, not a gate. You and the author are on the same side, trying to ship something you're both confident in.

* **Lead with curiosity.** Assume there's context you don't have yet. Ask before you conclude: "What led you to...?" lands better than "This is wrong."
* **Comment on the code, not the person.** "This function does X" rather than "You did X."
* **Make the stakes clear.** Label every comment (below) so the author knows what blocks the merge and what's optional.
* **Show, don't only tell.** For anything non-trivial, suggest an alternative or point to an example.
* **Name what's good.** A review that only finds fault teaches people to dread review.
* **Take long threads offline.** After two rounds of back-and-forth, a short call is usually faster and kinder.

### Comment labels

<!-- Labels follow Conventional Comments (https://conventionalcomments.org). The spec defines no icons; the emoji are our addition. Each one always travels with its written label: screen readers announce emoji names inconsistently, so the word carries the meaning and the icon only helps scanning. Hand emoji use the medium-dark skin tone modifier (U+1F3FE). -->

Start each comment with one of these labels:

| Label | Meaning |
| --- | --- |
| 🛑 **issue (blocking):** | Must be resolved before merge. |
| 💡 **suggestion (non-blocking):** | An improvement worth considering; author's call. |
| 🤏🏾 **nitpick:** | Trivial or stylistic. Take it or leave it. |
| 🙋🏾 **question:** | Seeking understanding; not a request to change. |
| 🎊 **praise:** | Something done well. Say so. |

Any label can take a `(blocking)` or `(non-blocking)` decoration to override its default. Spec: [conventionalcomments.org](https://conventionalcomments.org).
