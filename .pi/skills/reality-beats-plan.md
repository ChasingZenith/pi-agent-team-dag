---
name: reality-beats-plan
description: "Use when reality contradicts task description or execution is blocked, immediate execution steps, and standard report formatting."
---

# Reality Beats the Plan

Execution validates the plan. A task description represents a feed-forward prediction that may prove inaccurate during actual implementation. When reality contradicts your task's assumptions or requirements, do not force an invalid approach and do not fabricate results: stop the affected part, complete what you safely can, and report immediately via `task_submit_report`.

## The 5 Issue Types

When execution strays from the plan, categorize your findings into one of the following five conditions:

### Minor Issues (Execution continues with local resolution)
1. **Insufficient Information**: The task description or objective is too vague, or specific required inputs are missing.
2. **Contract / Interface Negotiation**: The task requires interacting with another component or task, but the exact interface, protocol, or data structure details are undefined or misaligned.

### Major Issues (Plan invalidation requiring task changes)
3. **Execution Gap**: Assumptions still hold, but you are unable to complete all objectives due to unforeseen implementation complexity, technical constraints, or resource limitations.
4. **Granularity Miss**: The task is too coarse-grained or complex to execute as a single unit and requires decomposition into sub-tasks or sub-modules.
5. **Assumption Failure**: Core premises (A1, A2, etc.) fail in reality—a required resource is unavailable, the technical approach is fundamentally infeasible, or the codebase directly contradicts the specification.

---

## What to Do

1. **Stop the Blocked Part**: Immediately halt work on the impacted sub-path. Do not force an invalid approach through or simulate missing outputs.
2. **Finish Safe Work**: Complete any sub-tasks, validations, or deliverables within your scope that do not depend on the failed premise.
3. **Apply Premise-Safe Adjustments**: Make small, local technical adjustments within your assigned item that do not violate its core interfaces or affect external tasks.
4. **Report Immediately**: Submit your report right away via `task_submit_report`. Do not wait or hold off for full completion when blocked.

---

## How to Report

Submit your report using `task_submit_report`. Your report must be precise and actionable so the manager can update the task dependence graph accordingly. Structure your submission with the following fields:

* **Issue Category**: Specify which of the 5 issue types was encountered (*Insufficient Information*, *Contract Negotiation*, *Execution Gap*, *Granularity Miss*, or *Assumption Failure*).
* **Failed Premise / Trigger**: The specific assumption, dependency, or instruction that failed or requires clarification.
* **Actual Reality**: Detailed findings, exact error logs, actual codebase state, or missing data encountered during execution.
* **Completed Work**: Safe work, sub-tasks, or tests successfully completed before halting.
* **Local Adjustments**: Any scope-safe, local changes made to adapt to the situation.
* **Blockers & Re-planning Needs**: The precise decisions, interface agreements, or graph structural changes needed before work can fully resume.