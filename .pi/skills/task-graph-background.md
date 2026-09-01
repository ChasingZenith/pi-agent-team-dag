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

1. **Strict Acyclicity**: The underlying store validates every write against the live graph. Any `task_create` or `task_update` operation that would form a cycle (evaluating expanded gates alongside standard `deps`) is rejected with a cycle path trace in the error.
2. **Bottom-Up Creation**: Dependencies and gates must exist in the system *before* referencing them (`deps` and `subgraph_deps` targets must be created first).

## 4. Graph Operations & Tools

- **Subgraph Generation (`task_create`)**: Creates a new task node in the graph.
  - Mandatory parameters include `title`, `description`, `kind` (`unit` | `module`).
  - `deps` can be supplied on creation (requires `kind="module"` and existing target IDs).
- **Subgraph Embedding / Refinement (`task_update`)**: Updates task metadata, dependencies, or kinds.
  - Modifies attributes on existing tasks (e.g., updating `description`, `deps`, or `subgraph_deps`).
  - Clear gates from a module by passing `subgraph_deps: []`.
  - Requires a concise summary in `change_summary` to preserve the item's historical audit trail.
- **Read & Execution Tools**:
  - `task_read`: Retrieves a specific task node — by default its metadata and graph context (deps, dependents, readiness, change history) WITHOUT the long description / completion report bodies; `fields="description"` / `fields="report"` / `fields="full"` load the bodies on demand (instructions only, report only, or everything).
  - `task_list`: Displays tasks across the current domain/context.
  - `task_ready_set`: Fetches nodes whose dependencies (`deps` and expanded `subgraph_deps`) are satisfied and ready for execution dispatch.
  - `task_render`: Generates visual or structural representations of the DAG.