---
name: task-lifecycle-reporting
description: "Defines the protocol for reading task context and managing an assigned item's execution lifecycle using task_read, task_start, and the two-step task_checkout + task_submit_report report flow."
---

# Task Lifecycle Reporting

As an agent executing a dispatched item, you interact with the task dependence graph through reading your assigned node and submitting lifecycle updates.

Your execution workflow consists of four core operations: reading task requirements, declaring execution start, and submitting final or blocked reports in two steps (draft, then commit).

## 1. Inspecting Task Context (`task_read`)

For the task id dispatched to you, read the task instructions with `task_read`.

## 2. Declaring Start (`task_start`)

Once you are going to start working on it, you declare you start exeusion with tool `task_start(id="<task_id>")`.
It confirms that work is underway and let other agents know.

---

## 3. Submitting Reports

When execution completes, or when reality prevents full completion, submit a detailed report to close your active work on the task, in two steps:

1. **Draft** — `task_checkout(id="<task_id>", scope="report")` creates YOUR report draft (an empty file you own; the old report is never copied).
2. **Write** — fill the draft with `write`/`edit`: what you did, how you verified it, and every deviation from the plan (brief when it matches, detailed when it deviates — per the `reality-beats-plan` skill).
3. **Commit** — `task_submit_report(id="<task_id>", expected_version=<n>)`, where `<n>` is the description version you read (task_read returns it; the dispatch header carries it). The tool verifies you are the dispatched agent, commits the report anchored to that exact version, consumes the draft, and automatically replies to the dispatcher.
* **Purpose**: Records your execution findings permanently on the task node and automatically replies to the dispatcher.
**When to call**:
- **On Completion**: When all task deliverables and acceptance criteria are satisfied.
- **On Blocker / Reality Gap**: Immediately when an assumption fails, execution hits an unforeseen barrier, or a dependency is missing (per the `reality-beats-plan` skill). Do not hold off or wait for full completion when blocked.

**If `expected_version` is behind the current version** (the description advanced while you worked): that is *not* an error — you legitimately executed the contract you read. The report is **accepted** and anchored to the version you actually worked against (`for_version`), and flagged `⚠ stale` so the **manager** judges whether executing the older contract still satisfies the new description. Only a version *ahead* of the current one (never readable) is rejected. Don't discard your work; record it against the version you read and let the reader decide.
