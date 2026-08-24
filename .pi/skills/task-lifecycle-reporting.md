---
name: task-lifecycle-reporting
description: "Defines the protocol for reading task context and managing an assigned item's execution lifecycle using task_read, task_start, and task_submit_report."
---

# Task Lifecycle Reporting

As an agent executing a dispatched item, you interact with the task dependence graph through reading your assigned node and submitting lifecycle updates.

Your execution workflow consists of three core tool operations: reading task requirements, declaring execution start, and submitting final or blocked reports.

## 1. Inspecting Task Context (`task_read`)

For the task id dispatched to you, read the task instructions with `task_read(id="<task_id>", fields="description")` to understand its scope and requirements. A plain `task_read(id="<task_id>")` returns the metadata and graph context (deps, dependents, readiness, change history) without the long bodies; `fields="report"` loads the completion report of a task (e.g. a review node); `fields="full"` returns everything.

## 2. Declaring Start (`task_start`)

Once you are going to start working on it, you declare you start exeusion with tool `task_start(id="<task_id>")`.
It confirms that work is underway and let other agents know.

---

## 3. Submitting Reports (`task_submit_report`)

When execution completes, or when reality prevents full completion, submit a detailed report to close your active work on the task.

* **Tool**: `task_submit_report(id="<task_id>", report="<structured_report_text>")`
* **Purpose**: Records your execution findings permanently on the task node and automatically replies to the dispatcher.
* **When to Call**: 
  - **On Completion**: When all task deliverables and acceptance criteria are satisfied.
  - **On Blocker / Reality Gap**: Immediately when an assumption fails, execution hits an unforeseen barrier, or a dependency is missing (per the `reality-beats-plan` skill). Do not hold off or wait for full completion when blocked.
