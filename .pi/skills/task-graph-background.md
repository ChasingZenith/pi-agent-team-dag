---
name: task-graph-background
description: Manages directed acyclic graph (DAG) execution workflows, including Unit vs. Module task typing, explicit dependency links, and sub-graph gating logic.
---

# Task Dependence Graph

Workflows are modeled as a Directed Acyclic Graph (DAG) consisting of two distinct task types, explicit execution edges, and dynamic gating rules.

## 1. Task Types

- **Unit**: A concrete, directly executable work item assigned to a single agent.
  - *Constraint*: Units are atomic leaves in the graph. Units **cannot** carry `deps` (dependencies) or `subgraph_deps` (gates).
- **Module**: A higher-level objective that encompasses sub-goals or multiple execution phases.
  - *Constraint*: Modules act as containers/interfaces. They do not specify atomic inner details up front; their subgraphs are decomposed layer-by-layer as execution progresses. Modules **can** carry `deps` and `subgraph_deps`.

## 2. Dependency Edge Types

### A. Ordering Dependencies (`deps`)
- Directed ordering edges where `A -> B` indicates that task A must be completed (or cancelled) before task B can start (`A` is listed in `B.deps`).
- **Module Parent Completion Rule**: A parent module's `deps` are its children. A module task is considered finished only when all of its child tasks in `deps` reach a terminal state.

### B. Subgraph Gates (`subgraph_deps`)
- **Modules only**. A gating mechanism, not a direct ordering edge between individual nodes.
- Setting `B.subgraph_deps = [A]` causes **B's entire transitive subgraph** (B itself, its children, grandchildren, and all downstream nodes) to wait for task A to finish before execution starts.
- **Dynamic Expansion**: Gates are stored once on the parent module and expanded automatically at read time. Any child/grandchild node added under module B later automatically inherits the gate without manual enumeration into every sub-node's `deps`.
- **Validation Constraint**: A gate cannot reference a node that resides inside the gated module's own subgraph.

## 3. Graph Integrity Rules

1. **Strict Acyclicity**: The store validates every write against the live graph. Any `task_commit` that would form a cycle (evaluating expanded gates alongside standard `deps`) is rejected with a cycle path trace in the error.
2. **Bottom-Up Creation**: Dependencies and gates must exist in the system *before* referencing them (`deps` and `subgraph_deps` targets must be created first).

## 4. Graph Operations & Tools

The full operational guidance for every graph tool lives in each tool's own description, shown at call time: `task_commit`, `task_checkout`, `task_set_status`, `task_read`, `task_list`, `task_ready_set`, `task_render`. Key flows:

- **Node Creation / Subgraph Embedding**: `task_checkout` to prepare a draft → edit it as a file → `task_commit` (metadata PATCH: only present fields change; `status` / `version` / `history` are machine-managed). Clear gates by putting `subgraph_deps = []` in the draft.
- **Description editing**: `task_checkout(scope="description")` → edit → `task_commit(scope="description")`.
- **Worker reports**: `task_checkout(scope="report")` + `task_submit_report` — see the `task-lifecycle-reporting` skill. A report is anchored to the exact description version the worker executed; if that is older than the current version the report is **accepted but flagged stale** (the worker must not be forced to re-base work it legitimately did against an older contract). The stale flag is a **read-time** cue: when reviewing the node, `report_for_version < version` tells you the report was written against an OLDER plan, so its findings may seed a correction (revise the description, re-dispatch) rather than validate the current contract.
- **Completion judgment**: before `task_complete`, read the completion report's anchor (`report_for_version`). If it is *behind* the current version, the work was done against an **older plan** — decide whether the old-contract work still satisfies the current description, or whether the stale report uncovers new findings that belong in a correction (revise the description, re-dispatch) before closing. `task_complete` prints a ⚠ stale warning and sets `details.stale_report` when this applies.
- **Read & Execution**: `task_read` (metadata + graph context by default, long bodies on demand via `fields`), `task_list`, `task_ready_set` (ready set / missing deps), `task_render` (graph tree), and lifecycle `task_set_status` — status transitions do NOT bump the version (versions count content commits only).
