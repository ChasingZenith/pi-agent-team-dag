---
name: task-graph-background
description: Manages directed acyclic graph (DAG) execution workflows, including Unit / Module / info task typing, explicit dependency links, and sub-graph gating logic.
---

# Task Dependence Graph

Workflows are modeled as a Directed Acyclic Graph (DAG) over a single task entity at any granularity, with two graph relationships (`deps` and `subgraph_deps`), plus a non-graph `info` kind.

## 1. Task Types

- Unit: A concrete work item scoped to be resolvable by a single agent within a 400k token budget.
  - Constraint: Units carry `deps` — the unit waits for its prerequisites to finish before it starts.
- Module: A higher-level objective that encompasses sub-goals or multiple execution phases.
  - Constraint: Modules act as containers/interfaces. They do not specify atomic inner details up front; their subgraphs are decomposed layer-by-layer as execution progresses. A module's `deps` are its children (the sub-goals it decomposes into), and it finishes only when all of them reach a terminal state; it can additionally carry `subgraph_deps`.
- Info: A shared information node — NOT a DAG node. Pure content with no deps, no subgraph gate, no status lifecycle; never in the ready set, never dispatched, excluded from orphans. Tasks reference it via `info_refs` (content references, not graph edges): the info node's description body is injected into the referencing task's description at read time — write common requirements ONCE and share them across many tasks.

## 2. Dependency Edge Types

## 2. Dependency Edge Types

Both `deps` and `subgraph_deps` express the same precedence relationship — `A` completed (or cancelled) before `B` can start — with the difference being the scope of `B` the edge gates, and how `deps` on a module is additionally read.

### A. `deps` — precedence to a single node
- `B.deps = [A]` means A must be done (or cancelled) before B itself can start. This is the node-level precedence edge — a unit waits for its prerequisites.
- Subtask containment on modules: a module's `deps` are also its children (the sub-goals it decomposes into). A module is finished only when all of its children in `deps` reach a terminal state. So on a module, `deps` carries a containment (subtask) meaning in addition to the precedence meaning.

### B. `subgraph_deps` — precedence to an entire subgraph
- Modules only. `B.subgraph_deps = [A]` gates A-before-B's whole transitive subgraph — B itself plus all its children, grandchildren, and downstream nodes wait for A to finish before any of them starts. It is the same precedence idea, just applied to the whole subtree instead of one node.
- Dynamic Expansion: the gate is stored once on the parent module and expanded automatically at read time — any child/grandchild later added under B inherits the gate without being enumerated into each node's own `deps`.
- Validation Constraint: a gate cannot reference a node inside the gated module's own subgraph (that would gate B against itself).

## 3. Graph Integrity Rules

1. Strict Acyclicity: The store validates every write against the live graph. Any `task_commit` that would form a cycle (evaluating expanded gates alongside standard `deps`) is rejected with a cycle path trace in the error.
2. Bottom-Up Creation: Dependencies and gates must exist in the system before referencing them (`deps` and `subgraph_deps` targets must be created first).
