/**
 * Unit tests for lib/task-comms-ops/core — the pure graph semantics of the
 * task-comms-ops notification helpers (waiting-dispatchee selection, unlocked-item
 * notification).
 *
 * Same pattern as tests/tasks-store.test.ts: redirect the task directory
 * via PI_TASKS_DIR to a fresh temp dir per test, then remove it.
 *
 * Run: bun test tests/task-comms-ops-core.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  setTaskStatus,
  readTask,
} from "../extensions/lib/tasks/store";
import { dispatcheesOf, waitingDispatchees } from "../extensions/lib/task-comms-ops/core";

let CWD = "";

beforeEach(() => {
  CWD = mkdtempSync(join(tmpdir(), "task-comms-ops-core-"));
  process.env.PI_TASKS_DIR = join(CWD, ".pi", "tasks");
});

afterEach(() => {
  delete process.env.PI_TASKS_DIR;
  rmSync(CWD, { recursive: true, force: true });
});

// ━━ waitingDispatchees ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("waitingDispatchees — who to notify when an item's status changes", () => {
  function item(id: string, deps: string[], dispatched?: string) {
    return createTask(CWD, { id, title: id, deps });
  }

  it("returns only dependents dispatched to an agent", () => {
    const a = item("a");
    const b = createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    const c = createTask(CWD, { id: "c", title: "c", kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c" } });
    // Undispatched dependents: d depends on a but nobody owns it.
    createTask(CWD, { id: "d", title: "d", kind: "module", deps: ["a"] });
    void a;

    const items = ["a", "b", "c", "d"].map((id) => readTask(CWD, id)!);
    const waiters = waitingDispatchees(items, "a");
    expect(waiters.sort()).toEqual(["worker-b", "worker-c"]);
  });

  it("returns nothing when no dependent is dispatched", () => {
    item("a");
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(waitingDispatchees(items, "a")).toEqual([]);
  });

  it("ignores items that do not depend on the changed item", () => {
    item("a");
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    const unrelated = createTask(CWD, { id: "x", title: "x" });
    setTaskStatus(CWD, "x", "dispatched", { dispatched_to: { name: "worker-x" } });
    void unrelated;

    const items = ["a", "b", "x"].map((id) => readTask(CWD, id)!);
    expect(waitingDispatchees(items, "a")).toEqual([]);
    expect(waitingDispatchees(items, "b")).toEqual([]);
  });

  it("notifies direct dependents only — no transitive reach-through", () => {
    item("a");
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    createTask(CWD, { id: "c", title: "c", kind: "module", deps: ["b"] });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c" } });

    // c depends on b, not on a — a's change does not notify c's dispatchee.
    expect(waitingDispatchees(["a", "b", "c"].map((id) => readTask(CWD, id)!), "a")).toEqual([]);

    // Direct dependent b gets a dispatchee — now a's change notifies it.
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b" } });
    expect(waitingDispatchees(["a", "b", "c"].map((id) => readTask(CWD, id)!), "a")).toEqual(["worker-b"]);
  });
});

// ━━ dispatcheesOf ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dispatcheesOf — who to notify when items get unlocked (done/cancelled)", () => {
  it("returns the dispatchees of the given items themselves", () => {
    createTask(CWD, { id: "a", title: "a" });
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b" } });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b"])).toEqual(["worker-b"]);
  });

  it("skips undispatched and unknown ids", () => {
    createTask(CWD, { id: "a", title: "a" });
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b", "ghost"])).toEqual([]);
  });

  it("dedupes when several unlocked items share one dispatchee", () => {
    createTask(CWD, { id: "a", title: "a" });
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    createTask(CWD, { id: "c", title: "c", kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-b" } });

    const items = ["a", "b", "c"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b", "c"])).toEqual(["worker-b"]);
  });

  it("notifies the unlocked item's own dispatchee, NOT its dependents' — direction guard", () => {
    // Graph a → b → c. Completing a unlocks b; the one to notify is worker-b
    // (b's own dispatchee), not worker-c (dispatchee of a task that depends on b
    // and is still locked). Regression guard for the flipped-direction bug.
    createTask(CWD, { id: "a", title: "a" });
    createTask(CWD, { id: "b", title: "b", kind: "module", deps: ["a"] });
    createTask(CWD, { id: "c", title: "c", kind: "module", deps: ["b"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c" } });

    const items = ["a", "b", "c"].map((id) => readTask(CWD, id)!);
    // unlocked = [b]; the waiter is b's dispatchee:
    expect(dispatcheesOf(items, ["b"])).toEqual(["worker-b"]);
    // waitingDispatchees on b would answer "who depends on b" — the wrong set here:
    expect(waitingDispatchees(items, "b")).toEqual(["worker-c"]);
    expect(dispatcheesOf(items, ["b"])).not.toEqual(waitingDispatchees(items, "b"));
  });
});
