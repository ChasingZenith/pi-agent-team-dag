/**
 * Unit tests for lib/tasks/graph — the pure graph algorithm layer.
 *
 * The graph functions are pure over in-memory Task arrays, so nearly all
 * tests here construct items directly with the mkTask() helper — no filesystem.
 * The last describe block exercises the store's cycle rejection (the
 * dependency-graph library error wrapped into the friendly form), which is
 * the only part that touches disk.
 *
 * Run: bun test tests/tasks-graph.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependentsOf,
  orphanItems,
  readyBuckets,
  readySet,
  renderGraph,
  unlockedBy,
  validateGraph,
} from "../extensions/lib/tasks/graph.ts";
import {
  createTask,
  updateTask,
} from "../extensions/lib/tasks/store.ts";
import type { Task } from "../extensions/lib/tasks/store.ts";

// ━━ helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Minimal in-memory Task; fields default like a freshly created item. */
function mkTask(partial: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: partial.id,
    description: "",
    deps: [],
    subgraph_deps: [],
    status: "pending",
    kind: "unit",
    version: 1,
    created_at: "t0",
    updated_at: "t0",
    updated_by: "test",
    history: [],
    ...partial,
  };
}

// ━━ readySet ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readySet", () => {
  it("marks pending items with all deps satisfied as ready", () => {
    const a = mkTask({ id: "task-a", status: "done" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c" }); // no deps
    const r = readySet([c, a, b]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-b", "task-c"]); // sorted by id
    expect(r.notReady).toEqual([]);
  });

  it("excludes non-pending items (dispatched, blocked, active) from both lists", () => {
    const blocked = mkTask({ id: "task-x", status: "blocked" });
    const active = mkTask({ id: "task-y", status: "active" });
    const dispatched = mkTask({ id: "task-z", status: "dispatched" }); // dispatched but not started — already owned
    const r = readySet([blocked, active, dispatched]);
    expect(r.ready).toEqual([]);
    expect(r.notReady).toEqual([]);
  });

  it("treats a cancelled dep as satisfied", () => {
    const c = mkTask({ id: "task-c", status: "cancelled" });
    const b = mkTask({ id: "task-b", deps: ["task-c"] });
    const r = readySet([c, b]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-b"]);
  });

  it("reports the unsatisfied dep ids in notReady.missing", () => {
    const a = mkTask({ id: "task-a", status: "done" });
    const b = mkTask({ id: "task-b", deps: ["task-a", "task-c"] });
    const c = mkTask({ id: "task-c" });
    const r = readySet([a, b, c]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-c"]);
    expect(r.notReady).toHaveLength(1);
    expect(r.notReady[0].item.id).toBe("task-b");
    expect(r.notReady[0].missing).toEqual(["task-c"]);
  });

  it("treats a dangling dep (no item at all) as unsatisfied and lists it in missing", () => {
    const b = mkTask({ id: "task-b", deps: ["task-ghost"] });
    const r = readySet([b]);
    expect(r.ready).toEqual([]);
    expect(r.notReady).toEqual([{ item: b, missing: ["task-ghost"] }]);
  });

  it("sorts both lists by id regardless of input order", () => {
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const a = mkTask({ id: "task-a" }); // no deps — ready itself; b and c wait on it
    const c = mkTask({ id: "task-c", deps: ["task-a"] });
    const r = readySet([c, b, a]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-a"]);
    expect(r.notReady.map((e) => e.item.id)).toEqual(["task-b", "task-c"]);
  });

  it("is empty for an empty input", () => {
    const r = readySet([]);
    expect(r.ready).toEqual([]);
    expect(r.notReady).toEqual([]);
  });

  it("resolves a full diamond: both leaves ready in parallel, the join waits for both", () => {
    const t1 = mkTask({ id: "task-t1" });
    const t2 = mkTask({ id: "task-t2" });
    const t3 = mkTask({ id: "task-t3", deps: ["task-t1", "task-t2"] });
    const join = mkTask({ id: "task-join", kind: "module", deps: ["task-t3"] });
    const r = readySet([join, t3, t1, t2]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-t1", "task-t2"]);
    expect(r.notReady.map((e) => [e.item.id, e.missing])).toEqual([
      ["task-join", ["task-t3"]],
      ["task-t3", ["task-t1", "task-t2"]],
    ]);
  });

  it("ready set excludes done/cancelled items themselves (only pending can dispatch)", () => {
    const done = mkTask({ id: "task-done", status: "done" });
    const cancelled = mkTask({ id: "task-cancel", status: "cancelled" });
    const r = readySet([done, cancelled]);
    expect(r.ready).toEqual([]);
    expect(r.notReady).toEqual([]);
  });
});

// ━━ readyBuckets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readyBuckets", () => {
  it("splits the ready list by kind: units execute, modules may need delegation", () => {
    const unit = mkTask({ id: "task-unit" });
    const mod = mkTask({ id: "task-mod", kind: "module" });
    const r = readyBuckets([unit, mod]);
    expect(r.execute.map((i) => i.id)).toEqual(["task-unit"]);
    expect(r.modules.map((i) => i.id)).toEqual(["task-mod"]);
  });

  it("routes review nodes (modules with deps) to the modules bucket", () => {
    const review = mkTask({ id: "task-review", kind: "module", deps: ["task-impl"] });
    const r = readyBuckets([review]);
    expect(r.execute).toEqual([]);
    expect(r.modules.map((i) => i.id)).toEqual(["task-review"]);
  });

  it("keeps the ready-set order (sorted by id) in both buckets", () => {
    const items = [
      mkTask({ id: "task-b", kind: "module" }),
      mkTask({ id: "task-a" }),
      mkTask({ id: "task-c", kind: "module" }),
    ];
    const r = readyBuckets(items);
    expect(r.execute.map((i) => i.id)).toEqual(["task-a"]);
    expect(r.modules.map((i) => i.id)).toEqual(["task-b", "task-c"]);
  });

  it("returns empty buckets for an empty ready list", () => {
    const r = readyBuckets([]);
    expect(r.execute).toEqual([]);
    expect(r.modules).toEqual([]);
  });
});

// ━━ unlockedBy ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("unlockedBy", () => {
  it("unlocks a node whose only unsatisfied dep is the id", () => {
    const a = mkTask({ id: "task-a" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c", deps: ["task-a", "task-b"] });
    expect(unlockedBy([a, b, c], "task-a")).toEqual(["task-b"]);
  });

  it("unlocks multiple nodes at once", () => {
    const a = mkTask({ id: "task-a" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c", deps: ["task-a"] });
    expect(unlockedBy([a, b, c], "task-a")).toEqual(["task-b", "task-c"]);
  });

  it("excludes nodes already ready (the dep is already satisfied in the given state)", () => {
    const a = mkTask({ id: "task-a", status: "done" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    expect(unlockedBy([a, b], "task-a")).toEqual([]);
  });
});

// ━━ subgraph_deps gates (subgraph gates) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("subgraph_deps gates (subgraph gates)", () => {
  it("gates the whole subgraph: nothing under a gated module is ready until the gate completes", () => {
    const coding = mkTask({ id: "task-coding" });
    const case1 = mkTask({ id: "task-case1" });
    const case2 = mkTask({ id: "task-case2" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1", "task-case2"],
      subgraph_deps: ["task-coding"],
    });
    const r = readySet([coding, case1, case2, testing]);
    // the gate itself is ready (no deps) — everything gated is not
    expect(r.ready.map((i) => i.id)).toEqual(["task-coding"]);
    // every gated node reports the gate among its missing — that is why it is not ready
    // (full expansion: the module itself is gated too)
    expect(r.notReady.map((e) => [e.item.id, e.missing])).toEqual([
      ["task-case1", ["task-coding"]],
      ["task-case2", ["task-coding"]],
      ["task-testing", ["task-case1", "task-case2", "task-coding"]],
    ]);
  });

  it("releases the whole subgraph when the gate completes", () => {
    const coding = mkTask({ id: "task-coding", status: "done" });
    const case1 = mkTask({ id: "task-case1" });
    const case2 = mkTask({ id: "task-case2" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1", "task-case2"],
      subgraph_deps: ["task-coding"],
    });
    const r = readySet([coding, case1, case2, testing]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-case1", "task-case2"]);
  });

  it("gates transitively: a node deep in the subgraph waits too", () => {
    const coding = mkTask({ id: "task-coding" });
    const deep = mkTask({ id: "task-deep" });
    const mid = mkTask({ id: "task-mid", deps: ["task-deep"] });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-mid"],
      subgraph_deps: ["task-coding"],
    });
    const r = readySet([coding, deep, mid, testing]);
    expect(r.notReady.find((e) => e.item.id === "task-deep")?.missing).toEqual(["task-coding"]);
    // missing = own deps first, then gates (deps-then-gates order, not merged sort)
    expect(r.notReady.find((e) => e.item.id === "task-mid")?.missing).toEqual([
      "task-deep",
      "task-coding",
    ]);
  });

  it("gates nodes added to the subgraph later (read-time expansion — the field follows the subgraph)", () => {
    const coding = mkTask({ id: "task-coding" });
    const case1 = mkTask({ id: "task-case1" });
    const lateCase = mkTask({ id: "task-late" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-coding"],
    });
    // 第一次读图:只有 case1 在子图里
    const r1 = readySet([coding, case1, testing]);
    expect(r1.notReady.map((e) => e.item.id).sort()).toEqual(["task-case1", "task-testing"]);
    // 演化后:testing 新增 deps 晚节点 — 同一字段自动覆盖它
    const testing2 = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1", "task-late"],
      subgraph_deps: ["task-coding"],
    });
    const r2 = readySet([coding, case1, lateCase, testing2]);
    expect(r2.notReady.find((e) => e.item.id === "task-late")?.missing).toEqual(["task-coding"]);
  });

  it("a cancelled gate counts as satisfied", () => {
    const coding = mkTask({ id: "task-coding", status: "cancelled" });
    const case1 = mkTask({ id: "task-case1" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-coding"],
    });
    const r = readySet([coding, case1, testing]);
    expect(r.ready.map((i) => i.id)).toEqual(["task-case1"]);
  });

  it("a dangling gate (no item) keeps the gated nodes unsatisfied", () => {
    const case1 = mkTask({ id: "task-case1" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-ghost"],
    });
    const r = readySet([case1, testing]);
    expect(r.ready).toEqual([]);
    expect(r.notReady.find((e) => e.item.id === "task-case1")?.missing).toEqual(["task-ghost"]);
  });

  it("unlockedBy: completing the gate unlocks every gated frontier node", () => {
    const coding = mkTask({ id: "task-coding" });
    const case1 = mkTask({ id: "task-case1" });
    const case2 = mkTask({ id: "task-case2" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1", "task-case2"],
      subgraph_deps: ["task-coding"],
    });
    expect(unlockedBy([coding, case1, case2, testing], "task-coding")).toEqual([
      "task-case1",
      "task-case2",
    ]);
  });

  it("a module can declare multiple gates — the subgraph waits for all of them", () => {
    const coding = mkTask({ id: "task-coding" });
    const infra = mkTask({ id: "task-infra" });
    const case1 = mkTask({ id: "task-case1" });
    const testing = mkTask({
      id: "task-testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-coding", "task-infra"],
    });
    const r = readySet([coding, case1, infra, testing]);
    expect(r.notReady.find((e) => e.item.id === "task-case1")?.missing).toEqual([
      "task-coding",
      "task-infra",
    ]);
  });
});

// ━━ dependentsOf ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dependentsOf", () => {
  it("finds all items that list the id in their deps, sorted", () => {
    const a = mkTask({ id: "task-a" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c", deps: ["task-a"] });
    const d = mkTask({ id: "task-d" });
    expect(dependentsOf([a, b, c, d], "task-a")).toEqual(["task-b", "task-c"]);
    expect(dependentsOf([a, b, c, d], "task-d")).toEqual([]);
  });
});

// ━━ validateGraph ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("validateGraph", () => {
  it("reports cycles and dangling references (hand-edited damage)", () => {
    const a = mkTask({ id: "task-a", deps: ["task-b"] });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c", deps: ["task-nope"] });
    const v = validateGraph([a, b, c]);
    expect(v.cycles).toEqual([["task-a", "task-b", "task-a"]]);
    expect(v.dangling).toEqual([{ id: "task-c", dep: "task-nope" }]);
  });

  it("finds multiple disjoint cycles", () => {
    const a = mkTask({ id: "task-a", deps: ["task-b"] });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    const c = mkTask({ id: "task-c", deps: ["task-d"] });
    const d = mkTask({ id: "task-d", deps: ["task-c"] });
    const v = validateGraph([a, b, c, d]);
    expect(v.cycles).toEqual([
      ["task-a", "task-b", "task-a"],
      ["task-c", "task-d", "task-c"],
    ]);
    expect(v.dangling).toEqual([]);
  });

  it("reports cycles that only arise BETWEEN gates (A gates B while B gates A)", () => {
    const a = mkTask({ id: "task-a", kind: "module", subgraph_deps: ["task-b"] });
    const b = mkTask({ id: "task-b", kind: "module", subgraph_deps: ["task-a"] });
    const v = validateGraph([a, b]);
    expect(v.cycles).toEqual([["task-a", "task-b", "task-a"]]);
    expect(v.dangling).toEqual([]);
  });

  it("reports a gate between a module and its own ancestor as a cycle", () => {
    // a.deps=[b], b gates on a → expanded edges: b → a (gate) and a → b (dep)
    const a = mkTask({ id: "task-a", deps: ["task-b"] });
    const b = mkTask({ id: "task-b", kind: "module", subgraph_deps: ["task-a"] });
    const v = validateGraph([a, b]);
    expect(v.cycles.length).toBe(1);
    expect(v.dangling).toEqual([]);
  });

  it("reports a dangling gate (id with no item)", () => {
    const m = mkTask({ id: "task-m", kind: "module", subgraph_deps: ["task-ghost"] });
    const v = validateGraph([m]);
    expect(v.cycles).toEqual([]);
    expect(v.dangling).toEqual([{ id: "task-m", dep: "task-ghost" }]);
  });
});

// ━━ orphanItems ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("orphanItems", () => {
  it("returns [] when everything lives inside a module subgraph", () => {
    const m = mkTask({ id: "task-m", kind: "module", deps: ["task-a"] });
    const a = mkTask({ id: "task-a", deps: ["task-b"] });
    const b = mkTask({ id: "task-b" });
    expect(orphanItems([m, a, b])).toEqual([]);
  });

  it("reports a pending unit with no dependents outside every module subgraph", () => {
    const m = mkTask({ id: "task-m", kind: "module", deps: ["task-a"] });
    const a = mkTask({ id: "task-a" });
    const loose = mkTask({ id: "task-loose" }); // free-floating
    expect(orphanItems([m, a, loose]).map((i) => i.id)).toEqual(["task-loose"]);
  });

  it("excludes items that someone depends on — only the unreferenced head of a loose cluster is an orphan", () => {
    const m = mkTask({ id: "task-m", kind: "module" });
    const consumer = mkTask({ id: "task-consumer", deps: ["task-supplier"] });
    const supplier = mkTask({ id: "task-supplier" });
    // the whole consumer/supplier pair is outside the module; supplier is
    // referenced by consumer, so only consumer is the loose head
    expect(orphanItems([m, consumer, supplier]).map((i) => i.id)).toEqual(["task-consumer"]);
  });

  it("excludes items referenced only as a subgraph gate", () => {
    const m = mkTask({ id: "task-m", kind: "module", subgraph_deps: ["task-gate"] });
    const gate = mkTask({ id: "task-gate" });
    expect(orphanItems([m, gate])).toEqual([]);
  });

  it("never reports done or cancelled items — they are finished, not loose", () => {
    const m = mkTask({ id: "task-m", kind: "module" });
    const done = mkTask({ id: "task-done", status: "done" });
    const cancelled = mkTask({ id: "task-cancel", status: "cancelled" });
    expect(orphanItems([m, done, cancelled])).toEqual([]);
  });

  it("returns [] when the plan has no modules — every root is a top-level deliverable", () => {
    const a = mkTask({ id: "task-a" });
    const b = mkTask({ id: "task-b", deps: ["task-a"] });
    expect(orphanItems([a, b])).toEqual([]);
  });

  it("never reports modules themselves (each module is its own subgraph's root)", () => {
    const m = mkTask({ id: "task-m", kind: "module" });
    expect(orphanItems([m])).toEqual([]);
  });

  it("sorts by id regardless of input order", () => {
    const m = mkTask({ id: "task-m", kind: "module" });
    const z = mkTask({ id: "task-z" });
    const a = mkTask({ id: "task-a" });
    expect(orphanItems([m, z, a]).map((i) => i.id)).toEqual(["task-a", "task-z"]);
  });
});

// ━━ renderGraph ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("renderGraph", () => {
  it("renders the dependency forest top-down: roots are the top deliverables", () => {
    const milestone = mkTask({ id: "task-milestone", title: "Milestone", deps: ["task-mod-a", "task-mod-b"] });
    const modA = mkTask({ id: "task-mod-a", title: "Module A", deps: ["task-t1"], status: "done" });
    const modB = mkTask({ id: "task-mod-b", title: "Module B", deps: ["task-t3"] });
    const t1 = mkTask({ id: "task-t1", title: "T1", status: "done" });
    const t3 = mkTask({ id: "task-t3", title: "T3" });
    const other = mkTask({ id: "task-other", title: "Other", status: "active" });
    const out = renderGraph([modA, t3, other, milestone, t1, modB]);
    expect(out).toBe(
      "◻ task-milestone Milestone (deps:2)\n" +
      "  ✓ task-mod-a Module A (deps:1)\n" +
      "    ✓ task-t1 T1 (deps:0)\n" +
      "  ◻ task-mod-b Module B (deps:1)\n" +
      "    ◻ task-t3 T3 (deps:0)\n" +
      "◐ task-other Other (deps:0)\n" +
      "\n" +
      "pending: 3, active: 1, done: 2\n",
    );
  });

  it("shows every status glyph", () => {
    const dep = mkTask({ id: "task-dep", title: "Dep", status: "done" });
    const parent = mkTask({ id: "task-agg", title: "Agg", deps: ["task-dep"] });
    const blocked = mkTask({ id: "task-b", title: "B", status: "blocked" });
    const cancelled = mkTask({ id: "task-c", title: "C", status: "cancelled" });
    const dispatched = mkTask({ id: "task-d", title: "D", status: "dispatched" });
    const out = renderGraph([parent, dep, blocked, cancelled, dispatched]);
    expect(out).toContain("◻ task-agg Agg (deps:1)"); // manual pending — no derivation
    expect(out).toContain("◔ task-d D (deps:0)"); // dispatched — not yet started
    expect(out).toContain("⊘ task-b B (deps:0)");
    expect(out).toContain("✕ task-c C (deps:0)");
  });

  it("orders dispatched after pending in the footer counts", () => {
    const out = renderGraph([
      mkTask({ id: "task-p" }),
      mkTask({ id: "task-a", status: "dispatched" }),
      mkTask({ id: "task-s", status: "active" }),
    ]);
    expect(out.endsWith("pending: 1, dispatched: 1, active: 1\n")).toBe(true);
  });

  it("tags module nodes with [module]; units stay unmarked", () => {
    const mod = mkTask({ id: "task-mod", title: "Mod", kind: "module", deps: ["task-unit"] });
    const unit = mkTask({ id: "task-unit", title: "Unit" });
    const out = renderGraph([mod, unit]);
    expect(out).toContain("◻ task-mod Mod [module] (deps:1)");
    expect(out).toContain("  ◻ task-unit Unit (deps:0)");
  });

  it("appends the ready ids line with showReady", () => {
    const a = mkTask({ id: "task-a", title: "A", status: "done" });
    const b = mkTask({ id: "task-b", title: "B", deps: ["task-a"] });
    const out = renderGraph([a, b], { showReady: true });
    expect(out.endsWith("Ready: task-b\n")).toBe(true);
  });

  it("shows Ready: (none) when nothing is ready", () => {
    const a = mkTask({ id: "task-a", title: "A", status: "done" });
    const b = mkTask({ id: "task-b", title: "B", status: "done" });
    expect(renderGraph([a, b], { showReady: true }).endsWith("Ready: (none)\n")).toBe(true);
  });

  it("guards a corrupted cycle with the ↻ marker instead of recursing", () => {
    const r = mkTask({ id: "task-r", title: "R", deps: ["task-b"] });
    const b = mkTask({ id: "task-b", title: "B", deps: ["task-a"] });
    const a = mkTask({ id: "task-a", title: "A", deps: ["task-b"] });
    const out = renderGraph([r, a, b]);
    expect(out).toContain("      ↻ task-b B (deps:1)");
  });

  it("renders the subgraph gate ONCE on the module line, not on every gated node", () => {
    const coding = mkTask({ id: "task-coding", title: "Coding" });
    const case1 = mkTask({ id: "task-case1", title: "Case 1" });
    const testing = mkTask({
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-coding"],
    });
    const out = renderGraph([testing, case1, coding]);
    // the gate is a marker on the module line, not a traversed edge — the
    // gate task renders as its own root (nothing depends on it via deps)
    expect(out).toContain("◻ task-testing Testing [module] (deps:1, subgraph_deps: task-coding)");
    expect(out).toContain("  ◻ task-case1 Case 1 (deps:0)"); // gated node unmarked
    expect(out).toContain("◻ task-coding Coding (deps:0)");
  });

  it("the ready line respects gates: nothing gated is ready while the gate is pending", () => {
    const coding = mkTask({ id: "task-coding", title: "Coding" });
    const case1 = mkTask({ id: "task-case1", title: "Case 1" });
    const testing = mkTask({
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case1"],
      subgraph_deps: ["task-coding"],
    });
    const out = renderGraph([testing, case1, coding], { showReady: true });
    // the gate itself is ready (no deps) — but everything gated stays out
    expect(out.endsWith("Ready: task-coding\n")).toBe(true);
  });
});

// ━━ store integration: cycle rejection (library error wrapped) ━━━━━━━━━━━━━━

describe("store integration — cycle rejection", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wigraph-test-"));
    process.env.PI_TASKS_DIR = tmp;
  });
  afterEach(() => {
    delete process.env.PI_TASKS_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });
  /** cwd is fully overridden by PI_TASKS_DIR — any value works. */
  const CWD = "/virtual/cwd";

  it("rejects a self-dependency with the cycle path in the error", () => {
    expect(() => createTask(CWD, { id: "task-a", title: "A", deps: ["task-a"] }))
      .toThrow(/would create a dependency cycle: task-a → task-a/);
  });

  it("rejects a 2-cycle with the cycle path in the error", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module", deps: ["task-a"] });
    expect(() => updateTask(CWD, "task-a", { deps: ["task-b"] }))
      .toThrow(/would create a dependency cycle: task-a → task-b → task-a/);
  });

  it("rejects a 3-cycle with the cycle path in the error", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module", deps: ["task-a"] });
    createTask(CWD, { id: "task-c", title: "C", kind: "module", deps: ["task-b"] });
    expect(() => updateTask(CWD, "task-a", { deps: ["task-c"] }))
      .toThrow(/would create a dependency cycle: task-a → task-c → task-b → task-a/);
  });
});
