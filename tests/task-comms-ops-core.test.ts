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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitTask, readTask, setTaskStatus } from "../extensions/lib/tasks/store";
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

const ME = "tester";
/** Create a task through the real public API: metadata draft → commitTask. */
function createTask(id: string, opts: { kind?: string; deps?: string[] } = {}): void {
  const dir = join(process.env.PI_TASKS_DIR!, "draft", ME);
  mkdirSync(dir, { recursive: true });
  const lines = [`id = '${id}'`, `title = '${id}'`];
  if (opts.kind) lines.push(`kind = '${opts.kind}'`);
  if (opts.deps) lines.push(`deps = [ ${opts.deps.map((d) => `'${d}'`).join(", ")} ]`);
  writeFileSync(join(dir, `${id}.toml`), lines.join("\n"));
  commitTask(CWD, id, { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
}

// ━━ waitingDispatchees ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("waitingDispatchees — who to notify when an item's status changes", () => {
  function item(id: string, deps: string[] = [], dispatched?: string) {
    return createTask(id, { deps });
  }

  it("returns only dependents dispatched to an agent", () => {
    const a = item("a");
    const b = createTask("b", { kind: "module", deps: ["a"] });
    const c = createTask("c", { kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c", dispatched_by: ME, dispatch_msg_id: "m1" } });
    // Undispatched dependents: d depends on a but nobody owns it.
    createTask("d", { kind: "module", deps: ["a"] });
    void a;

    const items = ["a", "b", "c", "d"].map((id) => readTask(CWD, id)!);
    const waiters = waitingDispatchees(items, "a");
    expect(waiters.sort()).toEqual(["worker-b", "worker-c"]);
  });

  it("returns nothing when no dependent is dispatched", () => {
    item("a");
    createTask("b", { kind: "module", deps: ["a"] });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(waitingDispatchees(items, "a")).toEqual([]);
  });

  it("ignores items that do not depend on the changed item", () => {
    item("a");
    createTask("b", { kind: "module", deps: ["a"] });
    const unrelated = createTask("x");
    setTaskStatus(CWD, "x", "dispatched", { dispatched_to: { name: "worker-x", dispatched_by: ME, dispatch_msg_id: "m1" } });
    void unrelated;

    const items = ["a", "b", "x"].map((id) => readTask(CWD, id)!);
    expect(waitingDispatchees(items, "a")).toEqual([]);
    expect(waitingDispatchees(items, "b")).toEqual([]);
  });

  it("notifies direct dependents only — no transitive reach-through", () => {
    item("a");
    createTask("b", { kind: "module", deps: ["a"] });
    createTask("c", { kind: "module", deps: ["b"] });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c", dispatched_by: ME, dispatch_msg_id: "m1" } });

    // c depends on b, not on a — a's change does not notify c's dispatchee.
    expect(waitingDispatchees(["a", "b", "c"].map((id) => readTask(CWD, id)!), "a")).toEqual([]);

    // Direct dependent b gets a dispatchee — now a's change notifies it.
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });
    expect(waitingDispatchees(["a", "b", "c"].map((id) => readTask(CWD, id)!), "a")).toEqual(["worker-b"]);
  });
});

// ━━ dispatcheesOf ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dispatcheesOf — who to notify when items get unlocked (done/cancelled)", () => {
  it("returns the dispatchees of the given items themselves", () => {
    createTask("a");
    createTask("b", { kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b"])).toEqual(["worker-b"]);
  });

  it("skips undispatched and unknown ids", () => {
    createTask("a");
    createTask("b", { kind: "module", deps: ["a"] });

    const items = ["a", "b"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b", "ghost"])).toEqual([]);
  });

  it("dedupes when several unlocked items share one dispatchee", () => {
    createTask("a");
    createTask("b", { kind: "module", deps: ["a"] });
    createTask("c", { kind: "module", deps: ["a"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });

    const items = ["a", "b", "c"].map((id) => readTask(CWD, id)!);
    expect(dispatcheesOf(items, ["b", "c"])).toEqual(["worker-b"]);
  });

  it("notifies the unlocked item's own dispatchee, NOT its dependents' — direction guard", () => {
    // Graph a → b → c. Completing a unlocks b; the one to notify is worker-b
    // (b's own dispatchee), not worker-c (dispatchee of a task that depends on b
    // and is still locked). Regression guard for the flipped-direction bug.
    createTask("a");
    createTask("b", { kind: "module", deps: ["a"] });
    createTask("c", { kind: "module", deps: ["b"] });
    setTaskStatus(CWD, "b", "dispatched", { dispatched_to: { name: "worker-b", dispatched_by: ME, dispatch_msg_id: "m1" } });
    setTaskStatus(CWD, "c", "dispatched", { dispatched_to: { name: "worker-c", dispatched_by: ME, dispatch_msg_id: "m1" } });

    const items = ["a", "b", "c"].map((id) => readTask(CWD, id)!);
    // unlocked = [b]; the waiter is b's dispatchee:
    expect(dispatcheesOf(items, ["b"])).toEqual(["worker-b"]);
    // waitingDispatchees on b would answer "who depends on b" — the wrong set here:
    expect(waitingDispatchees(items, "b")).toEqual(["worker-c"]);
    expect(dispatcheesOf(items, ["b"])).not.toEqual(waitingDispatchees(items, "b"));
  });
});
