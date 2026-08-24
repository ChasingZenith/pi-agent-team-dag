/**
 * Unit tests for lib/tasks/store — the Task storage layer.
 *
 * Pure filesystem, no pi dependency: each test redirects the task
 * directory via PI_TASKS_DIR to a fresh temp dir, then removes it.
 *
 * Run: bun test tests/tasks-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  defaultTaskId,
  HISTORY_CAP,
  listTasks,
  readTask,
  readTaskVersion,
  sanitizeTaskId,
  setCompletionReport,
  setTaskStatus,
  updateTask,
} from "../extensions/lib/tasks/store.ts";

// ━━ helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tasks-test-"));
  process.env.PI_TASKS_DIR = tmp;
});
afterEach(() => {
  delete process.env.PI_TASKS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});
/** cwd is fully overridden by PI_TASKS_DIR — any value works. */
const CWD = "/virtual/cwd";

// ━━ sanitizeTaskId / defaultTaskId ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("sanitizeTaskId", () => {
  it("lowercases and strips illegal characters", () => {
    expect(sanitizeTaskId("Auth Login!")).toBe("auth-login");
    expect(sanitizeTaskId("TASK-X")).toBe("task-x");
    expect(sanitizeTaskId("task_auth-2")).toBe("task_auth-2");
  });

  it("strips leading/trailing separators; empty when nothing survives", () => {
    expect(sanitizeTaskId("-task-auth-")).toBe("task-auth");
    expect(sanitizeTaskId("!!!")).toBe("");
  });
});

describe("defaultTaskId", () => {
  it("is a task- prefixed, filesystem-safe id", () => {
    const id = defaultTaskId();
    expect(id.startsWith("task-")).toBe(true);
    expect(id).toMatch(/^[a-z0-9_-]+$/);
  });

  it("produces distinct ids", () => {
    expect(defaultTaskId()).not.toBe(defaultTaskId());
  });
});

// ━━ createTask ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("createTask", () => {
  it("creates v1 with pending status, no history, timestamps equal", () => {
    const item = createTask(CWD, { id: "task-auth", title: "Auth" });
    expect(item).toMatchObject({
      id: "task-auth",
      title: "Auth",
      description: "",
      deps: [],
      status: "pending",
      version: 1,
      updated_by: "unknown",
      dispatched_to: null,
      history: [],
    });
    expect(item.created_at).toBe(item.updated_at);
  });

  it("writes PI_TASKS_DIR/<id>.json that JSON.parse round-trips", () => {
    const item = createTask(CWD, {
      id: "task-auth",
      title: "Auth",
      description: "A1: …\nA2: …",
      updated_by: "coordinator-main",
    });
    expect(existsSync(join(tmp, "task-auth.json"))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmp, "task-auth.json"), "utf-8"));
    expect(parsed).toEqual(item);
  });

  it("normalizes deps: dedupe + sort before storing", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B" });
    const item = createTask(CWD, { id: "task-c", title: "C", kind: "module", deps: ["task-b", "task-a", "task-b"] });
    expect(item.deps).toEqual(["task-a", "task-b"]);
  });

  it("rejects a dep that does not exist, listing the available ids", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    expect(() => createTask(CWD, { id: "task-b", title: "B", deps: ["task-nope"] }))
      .toThrow(/dep "task-nope" does not exist/);
    expect(() => createTask(CWD, { id: "task-b", title: "B", deps: ["task-nope"] }))
      .toThrow(/task-a/); // available ids listed
  });

  it("rejects an empty title", () => {
    expect(() => createTask(CWD, { id: "task-x", title: "  " })).toThrow(/title is required/);
  });

  it("rejects creating over an existing valid item", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    expect(() => createTask(CWD, { id: "task-a", title: "A2" })).toThrow(/already exists/);
  });

  it("leaves no .tmp files behind", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    expect(readdirSync(tmp).every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("records updated_by", () => {
    const item = createTask(CWD, { id: "task-a", title: "A", updated_by: "coordinator-main" });
    expect(item.updated_by).toBe("coordinator-main");
    expect(readTask(CWD, "task-a")!.updated_by).toBe("coordinator-main");
  });
});

// ━━ updateTask ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("updateTask", () => {
  it("bumps the version and pushes the old trace with this change_summary into history", () => {
    createTask(CWD, { id: "task-a", title: "A", updated_by: "coordinator-main" });
    const updated = updateTask(CWD, "task-a", {
      title: "A2",
      change_summary: "偏差: A2 不成立; 修正: 范围缩减",
      updated_by: "coordinator-main",
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe("A2");
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]).toMatchObject({
      version: 1,
      updated_by: "coordinator-main",
      change_summary: "偏差: A2 不成立; 修正: 范围缩减",
    });
    expect(updated.updated_by).toBe("coordinator-main");
  });

  it("caps history at HISTORY_CAP, newest first", () => {
    createTask(CWD, { id: "task-cap", title: "Cap" });
    for (let i = 1; i <= 12; i++) updateTask(CWD, "task-cap", { title: `Cap ${i}` });
    const item = readTask(CWD, "task-cap")!;
    expect(item.version).toBe(13);
    expect(item.history).toHaveLength(HISTORY_CAP);
    expect(item.history[0].version).toBe(12);
    expect(item.history[HISTORY_CAP - 1].version).toBe(3);
  });

  it("single-lines multi-line change summaries in history", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    updateTask(CWD, "task-a", { change_summary: "line1\nline2  spaced" });
    expect(readTask(CWD, "task-a")!.history[0].change_summary).toBe("line1 line2 spaced");
  });

  it("rejects a deps change that would create a cycle", () => {
    createTask(CWD, { id: "task-a", title: "A", kind: "module" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module", deps: ["task-a"] });
    expect(() => updateTask(CWD, "task-a", { deps: ["task-b"] }))
      .toThrow(/would create a dependency cycle/);
  });

  it("throws for a missing item", () => {
    expect(() => updateTask(CWD, "task-nope", { title: "X" })).toThrow(/does not exist/);
  });
});

// ━━ kind — granularity declaration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("kind", () => {
  it("defaults to unit when omitted, in the item, the file, and the summary", () => {
    const item = createTask(CWD, { id: "task-a", title: "A" });
    expect(item.kind).toBe("unit");
    expect(readTask(CWD, "task-a")!.kind).toBe("unit");
    expect(listTasks(CWD)[0].kind).toBe("unit");
  });

  it("persists an explicit module kind (JSON round-trip)", () => {
    const item = createTask(CWD, { id: "task-mod", title: "Mod", kind: "module" });
    expect(item.kind).toBe("module");
    const parsed = JSON.parse(readFileSync(join(tmp, "task-mod.json"), "utf-8"));
    expect(parsed.kind).toBe("module");
    expect(readTask(CWD, "task-mod")!.kind).toBe("module");
    expect(listTasks(CWD)[0].kind).toBe("module");
  });

  it("rejects a file missing the kind field as corrupted", () => {
    // kind is always written by create/update — a file without it is not a
    // valid task record: strict read, skipped by list, repaired by create.
    writeFileSync(
      join(tmp, "task-nokind.json"),
      JSON.stringify({
        id: "task-nokind",
        title: "No Kind",
        description: "",
        deps: [],
        status: "pending",
        version: 1,
        created_at: "t",
        updated_at: "t",
        updated_by: "unknown",
        dispatched_to: null,
        history: [],
      }),
      "utf-8",
    );
    expect(() => readTask(CWD, "task-nokind")).toThrow(/corrupted/);
    expect(listTasks(CWD).some((t) => t.id === "task-nokind")).toBe(false);
  });

  it("rejects an invalid kind value on create and update", () => {
    expect(() => createTask(CWD, { id: "task-x", title: "X", kind: "review" as never }))
      .toThrow(/invalid kind "review"/);
    createTask(CWD, { id: "task-a", title: "A" });
    expect(() => updateTask(CWD, "task-a", { kind: "garbage" as never }))
      .toThrow(/invalid kind "garbage"/);
  });

  it("allows a unit with deps on create — ordering edge, no delegation", () => {
    createTask(CWD, { id: "task-dep", title: "Dep" });
    const unit = createTask(CWD, { id: "task-unit", title: "Unit", deps: ["task-dep"] });
    expect(unit.kind).toBe("unit");
    expect(unit.deps).toEqual(["task-dep"]);
  });

  it("allows adding deps to an existing unit; module→unit flip with deps, rejected with gates", () => {
    createTask(CWD, { id: "task-dep", title: "Dep" });
    createTask(CWD, { id: "task-unit", title: "Unit" });
    const linked = updateTask(CWD, "task-unit", { deps: ["task-dep"] });
    expect(linked.kind).toBe("unit");
    expect(linked.deps).toEqual(["task-dep"]);

    // module with deps flips back to unit cleanly (deps are ordering edges, not a subgraph)
    createTask(CWD, { id: "task-mod", title: "Mod", kind: "module", deps: ["task-dep"] });
    const flipped = updateTask(CWD, "task-mod", { kind: "unit" });
    expect(flipped.kind).toBe("unit");
    expect(flipped.deps).toEqual(["task-dep"]);

    // ...but a module with subgraph_deps cannot flip — a unit has no subgraph to gate
    createTask(CWD, { id: "task-mod2", title: "Mod2", kind: "module", subgraph_deps: ["task-dep"] });
    expect(() => updateTask(CWD, "task-mod2", { kind: "unit" }))
      .toThrow(/kind "unit" cannot declare subgraph_deps/);
  });

  it("allows module with deps — aggregation and review nodes", () => {
    createTask(CWD, { id: "task-impl", title: "Impl" });
    const review = createTask(CWD, {
      id: "task-review",
      title: "Review",
      kind: "module",
      deps: ["task-impl"],
    });
    expect(review.kind).toBe("module");
    expect(review.deps).toEqual(["task-impl"]);
  });

  it("flips a unit to module via update (execution revealed it decomposes)", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const flipped = updateTask(CWD, "task-x", {
      kind: "module",
      change_summary: "execution revealed it decomposes",
    });
    expect(flipped.kind).toBe("module");
    expect(readTask(CWD, "task-x")!.kind).toBe("module");
    expect(flipped.history[0].change_summary).toBe("execution revealed it decomposes");
  });
});

// ━━ setTaskStatus — state machine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("setTaskStatus", () => {
  it("walks the legal transition paths, including reopen and undo", () => {
    const item = createTask(CWD, { id: "task-x", title: "X" });
    expect(setTaskStatus(CWD, "task-x", "dispatched").item.status).toBe("dispatched"); // dispatch
    expect(setTaskStatus(CWD, "task-x", "active").item.status).toBe("active"); // worker's task_start
    expect(setTaskStatus(CWD, "task-x", "pending").item.status).toBe("pending");
    expect(setTaskStatus(CWD, "task-x", "blocked").item.status).toBe("blocked");
    expect(setTaskStatus(CWD, "task-x", "active").item.status).toBe("active");
    expect(setTaskStatus(CWD, "task-x", "done").item.status).toBe("done"); // no deps — trivially satisfied
    expect(setTaskStatus(CWD, "task-x", "active").item.status).toBe("active"); // done → active: reopen
    expect(setTaskStatus(CWD, "task-x", "cancelled").item.status).toBe("cancelled");
    expect(setTaskStatus(CWD, "task-x", "pending").item.status).toBe("pending"); // cancelled → pending: undo
    expect(item.status).toBe("pending"); // the returned item of the original create is unchanged
  });

  it("rejects transitions out of done except reopen, listing legal targets", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    setTaskStatus(CWD, "task-x", "done");
    expect(() => setTaskStatus(CWD, "task-x", "cancelled"))
      .toThrow(/cannot transition "task-x" from "done" to "cancelled"/);
    expect(() => setTaskStatus(CWD, "task-x", "cancelled"))
      .toThrow(/legal transitions: active \(reopen\)/);
    expect(() => setTaskStatus(CWD, "task-x", "pending")).toThrow(/from "done"/);
  });

  it("rejects transitions out of cancelled except undo", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    setTaskStatus(CWD, "task-x", "cancelled");
    expect(() => setTaskStatus(CWD, "task-x", "active"))
      .toThrow(/cannot transition "task-x" from "cancelled" to "active"/);
    expect(() => setTaskStatus(CWD, "task-x", "done")).toThrow(/from "cancelled"/);
    expect(() => setTaskStatus(CWD, "task-x", "blocked")).toThrow(/from "cancelled"/);
  });

  it("strictly rejects marking a leaf done while deps are unsatisfied, listing missing deps", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B" });
    createTask(CWD, { id: "task-leaf", title: "Leaf", kind: "module", deps: ["task-a", "task-b"] });
    expect(() => setTaskStatus(CWD, "task-leaf", "done"))
      .toThrow(/deps not satisfied: task-a, task-b/);
    expect(() => setTaskStatus(CWD, "task-leaf", "done"))
      .toThrow(/mark them done, cancel them, or update the deps/);
  });

  it("marks a parent done only after ALL its deps are done; cancelled deps count as satisfied", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B" });
    createTask(CWD, { id: "task-agg", title: "Agg", kind: "module", deps: ["task-a", "task-b"] });
    createTask(CWD, { id: "task-leaf", title: "Leaf", kind: "module", deps: ["task-agg"] });
    createTask(CWD, { id: "task-c", title: "C" });
    createTask(CWD, { id: "task-leaf2", title: "Leaf2", kind: "module", deps: ["task-c"] });

    setTaskStatus(CWD, "task-a", "done");
    expect(() => setTaskStatus(CWD, "task-agg", "done")).toThrow(/deps not satisfied: task-b/);
    expect(() => setTaskStatus(CWD, "task-leaf", "done")).toThrow(/deps not satisfied/);
    setTaskStatus(CWD, "task-b", "done");
    setTaskStatus(CWD, "task-agg", "done"); // all deps done → the manager marks the parent done
    setTaskStatus(CWD, "task-leaf", "done"); // dep done → satisfied
    expect(readTask(CWD, "task-leaf")!.status).toBe("done");

    setTaskStatus(CWD, "task-c", "cancelled"); // cancelled counts as satisfied
    setTaskStatus(CWD, "task-leaf2", "done");
    expect(readTask(CWD, "task-leaf2")!.status).toBe("done");
  });

  it("returns the unlocked ids newly made ready", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B" });
    createTask(CWD, { id: "task-agg", title: "Agg", kind: "module", deps: ["task-a", "task-b"] });
    createTask(CWD, { id: "task-x", title: "X", kind: "module", deps: ["task-a"] });

    const r1 = setTaskStatus(CWD, "task-a", "done");
    expect(r1.unlocked).toEqual(["task-x"]); // task-x's only missing dep was task-a

    const r2 = setTaskStatus(CWD, "task-b", "done");
    expect(r2.unlocked).toEqual(["task-agg"]); // its only missing dep was task-b
  });

  it("returns no unlocked ids for non-satisfying transitions (reopen)", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    createTask(CWD, { id: "task-y", title: "Y", kind: "module", deps: ["task-x"] });
    setTaskStatus(CWD, "task-x", "done");
    const r = setTaskStatus(CWD, "task-x", "active"); // reopen — nothing newly satisfied
    expect(r.unlocked).toEqual([]);
  });

  it("bumps the version and records updated_by on status changes", () => {
    createTask(CWD, { id: "task-x", title: "X", updated_by: "worker-1" });
    const r = setTaskStatus(CWD, "task-x", "done", { updated_by: "worker-1" });
    expect(r.item.version).toBe(2);
    expect(r.item.status).toBe("done");
    expect(r.item.history[0]).toMatchObject({ version: 1, updated_by: "worker-1" });
  });

  it("records the responsible agent on dispatched, preserves it on active, clears on done/cancelled", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    // bare dispatches (task_set_status) have no dispatcher / delegation
    // message — the store normalizes both to ""
    const a = {
      name: "worker-1",
      dispatched_by: "",
      dispatch_msg_id: "",
    };
    const r = setTaskStatus(CWD, "task-x", "dispatched", { dispatched_to: a });
    expect(r.item.dispatched_to).toEqual(a);
    expect(readTask(CWD, "task-x")!.dispatched_to).toEqual(a);

    // task_start path: dispatched → active preserves the dispatch
    const started = setTaskStatus(CWD, "task-x", "active");
    expect(started.item.dispatched_to).toEqual(a);
    expect(readTask(CWD, "task-x")!.dispatched_to).toEqual(a);

    // done clears the dispatch — the item is no longer owned
    const done = setTaskStatus(CWD, "task-x", "done");
    expect(done.item.dispatched_to).toBeNull();
    expect(readTask(CWD, "task-x")!.dispatched_to).toBeNull();

    // reopen → reclaim → re-dispatch → cancelled also clears
    setTaskStatus(CWD, "task-x", "active"); // reopen
    setTaskStatus(CWD, "task-x", "pending"); // reclaim
    setTaskStatus(CWD, "task-x", "dispatched", { dispatched_to: a });
    setTaskStatus(CWD, "task-x", "cancelled");
    expect(readTask(CWD, "task-x")!.dispatched_to).toBeNull();
  });

  it("rejects recording a responsible agent when not setting dispatched", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const a = { name: "worker-1" };
    expect(() => setTaskStatus(CWD, "task-x", "done", { dispatched_to: a }))
      .toThrow(/dispatch records the agent/);
    expect(() => setTaskStatus(CWD, "task-x", "blocked", { dispatched_to: a }))
      .toThrow(/dispatch records the agent/);
    expect(() => setTaskStatus(CWD, "task-x", "active", { dispatched_to: a }))
      .toThrow(/dispatch records the agent/);
  });

  it("records the worker's execution session on active, keeps it on done, overwrites on re-start", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-x", "dispatched", { dispatched_to: a });

    // task_start path: setting active records the worker's own session
    const sess = { session_id: "01J0Z1WXYZ-9abc", session_file: ".pi/agent-sessions/worker-1.json" };
    const started = setTaskStatus(CWD, "task-x", "active", { execution_session: sess });
    expect(started.item.execution_session).toEqual(sess);
    expect(readTask(CWD, "task-x")!.execution_session).toEqual(sess);

    // done KEEPS the session — retrospection happens exactly after completion
    const done = setTaskStatus(CWD, "task-x", "done");
    expect(done.item.execution_session).toEqual(sess);
    expect(readTask(CWD, "task-x")!.execution_session).toEqual(sess);

    // reopen keeps the old session until the next start overwrites it
    setTaskStatus(CWD, "task-x", "active"); // reopen — session preserved
    setTaskStatus(CWD, "task-x", "pending"); // reclaim
    setTaskStatus(CWD, "task-x", "dispatched", { dispatched_to: a });
    const sess2 = { session_id: "01J0Z1XABC-def0", session_file: ".pi/agent-sessions/worker-1.json" };
    const restarted = setTaskStatus(CWD, "task-x", "active", { execution_session: sess2 });
    expect(restarted.item.execution_session).toEqual(sess2);
  });

  it("rejects recording an execution session when not setting active", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const s = { session_id: "s1", session_file: ".pi/agent-sessions/worker-1.json" };
    expect(() => setTaskStatus(CWD, "task-x", "done", { execution_session: s }))
      .toThrow(/start records the worker's session/);
    expect(() => setTaskStatus(CWD, "task-x", "dispatched", { execution_session: s }))
      .toThrow(/start records the worker's session/);
    expect(() => setTaskStatus(CWD, "task-x", "blocked", { execution_session: s }))
      .toThrow(/start records the worker's session/);
  });

  it("parses a malformed execution_session leniently as null", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const file = join(tmp, "task-x.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));

    data.execution_session = { session_id: 42 }; // wrong shape
    writeFileSync(file, JSON.stringify(data), "utf-8");
    expect(readTask(CWD, "task-x")!.execution_session).toBeNull();

    data.execution_session = "worker-1"; // wrong type
    writeFileSync(file, JSON.stringify(data), "utf-8");
    expect(readTask(CWD, "task-x")!.execution_session).toBeNull();

    delete data.execution_session; // absent on pre-existing files
    writeFileSync(file, JSON.stringify(data), "utf-8");
    expect(readTask(CWD, "task-x")!.execution_session).toBeNull();
  });

  it("walks the dispatched transitions: dispatch, direct close, reclaim, re-dispatch from blocked", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    // dispatched → done directly: the worker may skip task_start and still be closed by the manager
    expect(setTaskStatus(CWD, "task-x", "dispatched").item.status).toBe("dispatched");
    expect(setTaskStatus(CWD, "task-x", "done").item.status).toBe("done");
    // reclaim: reopen → pending, then re-dispatch
    setTaskStatus(CWD, "task-x", "active"); // reopen
    setTaskStatus(CWD, "task-x", "pending"); // reclaim — back into the ready set
    // blocked → dispatched: re-dispatch after unblocking
    setTaskStatus(CWD, "task-x", "blocked");
    expect(setTaskStatus(CWD, "task-x", "dispatched").item.status).toBe("dispatched");
  });

  it("parses a malformed dispatched_to leniently as null", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    const file = join(tmp, "task-x.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));

    data.dispatched_to = { name: 42 }; // wrong shape
    writeFileSync(file, JSON.stringify(data), "utf-8");
    expect(readTask(CWD, "task-x")!.dispatched_to).toBeNull();

    data.dispatched_to = "worker-1"; // wrong type
    writeFileSync(file, JSON.stringify(data), "utf-8");
    expect(readTask(CWD, "task-x")!.dispatched_to).toBeNull();
  });

  it("throws for a missing item", () => {
    expect(() => setTaskStatus(CWD, "task-nope", "done")).toThrow(/does not exist/);
  });
});

// ━━ readTask / listTasks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readTask", () => {
  it("returns null for a missing item", () => {
    expect(readTask(CWD, "task-nope")).toBeNull();
  });
});

describe("listTasks", () => {
  it("returns [] when the dir does not exist", () => {
    expect(listTasks("/virtual/nonexistent")).toEqual([]);
  });

  it("lists sorted by id with depCount and metadata", () => {
    createTask(CWD, { id: "task-b", title: "B" });
    createTask(CWD, { id: "task-a", title: "A", kind: "module", deps: ["task-b"] });
    const items = listTasks(CWD);
    expect(items.map((w) => w.id)).toEqual(["task-a", "task-b"]);
    expect(items[0]).toMatchObject({
      title: "A",
      status: "pending",
      version: 1,
      updated_by: "unknown",
      dispatched_to: null,
      depCount: 1,
    });
  });
});

// ━━ atomicity & corruption ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("atomic writes", () => {
  it("leave no .tmp files after updates and status changes", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    updateTask(CWD, "task-a", { title: "A2" });
    setTaskStatus(CWD, "task-a", "done");
    expect(readdirSync(tmp).every((f) => !f.endsWith(".tmp"))).toBe(true);
  });
});

describe("corrupted files", () => {
  it("readTask throws with the available ids for a corrupted file", () => {
    createTask(CWD, { id: "task-ok", title: "Ok" });
    writeFileSync(join(tmp, "task-broken.json"), "not json at all", "utf-8");
    expect(() => readTask(CWD, "task-broken")).toThrow(/corrupted/);
    expect(() => readTask(CWD, "task-broken")).toThrow(/task-ok/); // available ids listed
  });

  it("listTasks skips corrupted files", () => {
    createTask(CWD, { id: "task-ok", title: "Ok" });
    writeFileSync(join(tmp, "task-broken.json"), "not json at all", "utf-8");
    expect(listTasks(CWD).map((w) => w.id)).toEqual(["task-ok"]);
  });

  it("createTask overwrites a corrupted file (last-writer-wins as repair)", () => {
    writeFileSync(join(tmp, "task-broken.json"), "not json at all", "utf-8");
    const item = createTask(CWD, { id: "task-broken", title: "Fresh" });
    expect(item.version).toBe(1);
    expect(readTask(CWD, "task-broken")!.title).toBe("Fresh");
  });

  it("a structurally-invalid JSON file counts as corrupted", () => {
    writeFileSync(join(tmp, "task-empty.json"), "{\"id\":\"task-empty\"}", "utf-8"); // no title
    expect(() => readTask(CWD, "task-empty")).toThrow(/corrupted/);
  });
});

// ━━ version snapshots — history/<id>.v<N>.json ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("version snapshots (history/)", () => {
  const HISTORY_DIR = () => join(tmp, "history");
  /** Parse a snapshot file; asserts it exists. */
  const readSnapshot = (id: string, version: number) =>
    JSON.parse(readFileSync(join(HISTORY_DIR(), `${id}.v${version}.json`), "utf-8"));

  it("updateTask archives the full old version before replacing it", () => {
    const v1 = createTask(CWD, {
      id: "task-a",
      title: "A",
      description: "assumption A1: X\nacceptance: Y",
      kind: "module",
      deps: [],
      updated_by: "planner-1",
    });
    updateTask(CWD, "task-a", { title: "A2", change_summary: "scope reduced", updated_by: "coordinator-main" });
    expect(readSnapshot("task-a", 1)).toEqual(v1); // full content, not a summary
    expect(readSnapshot("task-a", 1).description).toBe("assumption A1: X\nacceptance: Y");
  });

  it("status-only changes archive too (snapshot = pre-change state)", () => {
    createTask(CWD, { id: "task-x", title: "X", updated_by: "planner-1" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-x", "dispatched", { dispatched_to: a, updated_by: "coordinator-main" });
    // v1 snapshot predates the dispatch — it must not carry it
    expect(readSnapshot("task-x", 1).dispatched_to).toBeNull();
    setTaskStatus(CWD, "task-x", "done", { updated_by: "coordinator-main" });
    // v2 snapshot predates done — it must still carry the dispatch
    expect(readSnapshot("task-x", 2).dispatched_to).toMatchObject({ name: "worker-1" });
    expect(readTask(CWD, "task-x")!.version).toBe(3);
  });

  it("setCompletionReport archives", () => {
    createTask(CWD, { id: "task-r", title: "R", updated_by: "planner-1" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-r", "dispatched", { dispatched_to: a, updated_by: "coordinator-main" });
    setCompletionReport(CWD, "task-r", "done as planned, no deviation", "worker-1");
    expect(readSnapshot("task-r", 2).completion_report).toBeNull();
    expect(readSnapshot("task-r", 2).version).toBe(2);
    expect(readTask(CWD, "task-r")!.completion_report).toBe("done as planned, no deviation");
  });

  it("keeps every version — no cap on snapshots (history field still caps)", () => {
    createTask(CWD, { id: "task-snap", title: "Snap" });
    for (let i = 1; i <= 12; i++) updateTask(CWD, "task-snap", { title: `Snap ${i}` });
    const files = readdirSync(HISTORY_DIR())
      .filter((f) => f.startsWith("task-snap."))
      .sort((a, b) => {
        const na = Number(a.slice("task-snap.v".length, -".json".length));
        const nb = Number(b.slice("task-snap.v".length, -".json".length));
        return na - nb;
      });
    expect(files).toHaveLength(12);
    expect(files[0]).toBe("task-snap.v1.json");
    expect(files[11]).toBe("task-snap.v12.json");
    expect(readTask(CWD, "task-snap")!.history).toHaveLength(HISTORY_CAP); // summaries still capped
  });

  it("snapshots are self-contained — each keeps the history chain it carried", () => {
    createTask(CWD, { id: "task-h", title: "H" });
    updateTask(CWD, "task-h", { title: "H2", change_summary: "first change", updated_by: "planner-1" });
    updateTask(CWD, "task-h", { title: "H3", change_summary: "second change", updated_by: "planner-1" });
    expect(readSnapshot("task-h", 1).history).toEqual([]);
    expect(readSnapshot("task-h", 2).history).toHaveLength(1);
    expect(readSnapshot("task-h", 2).history[0]).toMatchObject({
      version: 1,
      change_summary: "first change",
    });
  });

  it("readTaskVersion round-trips a past version's full content", () => {
    const v1 = createTask(CWD, {
      id: "task-v",
      title: "V",
      description: "acceptance: works",
      kind: "module",
      deps: [],
    });
    const v2 = updateTask(CWD, "task-v", { title: "V2", change_summary: "renamed", updated_by: "planner-1" });
    updateTask(CWD, "task-v", { title: "V3", change_summary: "renamed again", updated_by: "planner-1" });
    expect(readTaskVersion(CWD, "task-v", 1)).toEqual(v1);
    expect(readTaskVersion(CWD, "task-v", 2)).toEqual(v2);
  });

  it("readTaskVersion returns null for a missing task", () => {
    expect(readTaskVersion(CWD, "task-nope", 1)).toBeNull();
  });

  it("readTaskVersion rejects non-positive-integer versions", () => {
    createTask(CWD, { id: "task-v", title: "V" });
    expect(() => readTaskVersion(CWD, "task-v", 0)).toThrow(/invalid version/);
    expect(() => readTaskVersion(CWD, "task-v", -1)).toThrow(/invalid version/);
    expect(() => readTaskVersion(CWD, "task-v", 1.5)).toThrow(/invalid version/);
    expect(() => readTaskVersion(CWD, "task-v", NaN)).toThrow(/invalid version/);
  });

  it("readTaskVersion rejects current/future versions and lists archived ones", () => {
    createTask(CWD, { id: "task-v", title: "V" });
    updateTask(CWD, "task-v", { title: "V2", updated_by: "planner-1" });
    updateTask(CWD, "task-v", { title: "V3", updated_by: "planner-1" });
    expect(() => readTaskVersion(CWD, "task-v", 3)).toThrow(/no version 3/);
    expect(() => readTaskVersion(CWD, "task-v", 99)).toThrow(/no version 99/);
    expect(() => readTaskVersion(CWD, "task-v", 99)).toThrow(/archived versions: 1, 2/);
  });

  it("readTaskVersion throws when no snapshot exists for the version", () => {
    // a valid item created before snapshotting shipped: live file, no history dir
    writeFileSync(
      join(tmp, "task-legacy.json"),
      JSON.stringify({
        id: "task-legacy",
        title: "Legacy",
        description: "",
        deps: [],
        status: "pending",
        kind: "unit",
        version: 7,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        updated_by: "unknown",
        dispatched_to: null,
        completion_report: null,
        history: [],
      }),
      "utf-8",
    );
    expect(() => readTaskVersion(CWD, "task-legacy", 3)).toThrow(/no snapshot/);
    // a deleted snapshot is the same error
    createTask(CWD, { id: "task-gone", title: "Gone" });
    updateTask(CWD, "task-gone", { title: "Gone2" });
    rmSync(join(HISTORY_DIR(), "task-gone.v1.json"));
    expect(() => readTaskVersion(CWD, "task-gone", 1)).toThrow(/no snapshot/);
  });

  it("does not disturb listTasks, and leaves no .tmp files in history/", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    updateTask(CWD, "task-a", { title: "A2" });
    setTaskStatus(CWD, "task-a", "done");
    expect(listTasks(CWD)).toHaveLength(1); // history/ is invisible to the listing
    expect(readdirSync(tmp)).toContain("history");
    expect(readdirSync(HISTORY_DIR()).every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("createTask repairing a corrupted file writes no snapshot", () => {
    writeFileSync(join(tmp, "task-broken.json"), "not json at all", "utf-8");
    createTask(CWD, { id: "task-broken", title: "Fresh" });
    expect(existsSync(HISTORY_DIR())).toBe(false);
  });
});

// ━━ setCompletionReport — the dispatched agent's execution record ━━━━━━━━━━━━

describe("setCompletionReport", () => {
  /** create + dispatch an item to an agent (store layer — dispatch direct, no session file needed). */
  function dispatch(id: string, agent = "worker-1") {
    createTask(CWD, { id, title: id });
    return setTaskStatus(CWD, id, "dispatched", {
      dispatched_to: { name: agent },
      updated_by: agent,
    }).item;
  }

  it("the dispatched agent writes the report: persisted, version bumps, first line into history", () => {
    dispatch("task-x");
    const reported = setCompletionReport(
      CWD,
      "task-x",
      "Implemented login form.\nDeviation: the API returns camelCase, not snake_case as assumed.",
      "worker-1",
    );
    expect(reported.completion_report).toContain("Implemented login form.");
    expect(reported.version).toBe(3); // create v1 → dispatch v2 → report v3
    expect(reported.updated_by).toBe("worker-1");
    // history keeps the one-line digest (the report's first line)
    expect(reported.history[0]).toMatchObject({
      version: 2,
      updated_by: "worker-1",
      change_summary: "Implemented login form.",
    });
    // round-trips through the file, multiline intact
    expect(readTask(CWD, "task-x")?.completion_report).toBe(
      "Implemented login form.\nDeviation: the API returns camelCase, not snake_case as assumed.",
    );
  });

  it("overwrites the previous report, pushing its first line into history", () => {
    dispatch("task-x");
    setCompletionReport(CWD, "task-x", "First attempt.", "worker-1");
    const second = setCompletionReport(CWD, "task-x", "Second attempt.", "worker-1");
    expect(second.completion_report).toBe("Second attempt.");
    expect(second.version).toBe(4); // create → dispatch → report → report
    // history holds each replaced version's summary: v3 ("Second attempt.") then v2 ("First attempt.")
    expect(second.history[0].change_summary).toBe("Second attempt.");
    expect(second.history[1].change_summary).toBe("First attempt.");
  });

  it("rejects a report from an agent that is not the dispatchee", () => {
    dispatch("task-x", "worker-1");
    expect(() => setCompletionReport(CWD, "task-x", "hijack", "worker-2"))
      .toThrow(/dispatched to worker-1/);
  });

  it("rejects an undispatched (pending) item — there is no dispatchee to write", () => {
    createTask(CWD, { id: "task-y", title: "Y" });
    expect(() => setCompletionReport(CWD, "task-y", "nope", "worker-1"))
      .toThrow(/dispatched to \(no one\)/);
  });

  it("rejects an empty report", () => {
    dispatch("task-x");
    expect(() => setCompletionReport(CWD, "task-x", "   ", "worker-1"))
      .toThrow(/is empty/);
    expect(() => setCompletionReport(CWD, "task-x", "", "worker-1"))
      .toThrow(/is empty/);
  });

  it("rejects writing after completion — done clears the dispatch", () => {
    dispatch("task-x");
    setCompletionReport(CWD, "task-x", "done work", "worker-1");
    setTaskStatus(CWD, "task-x", "done");
    expect(() => setCompletionReport(CWD, "task-x", "late", "worker-1"))
      .toThrow(/dispatched to \(no one\)/);
  });

  it("reopen (done → active) voids the old report; a fresh dispatch allows a new one", () => {
    dispatch("task-x");
    setCompletionReport(CWD, "task-x", "first pass", "worker-1");
    setTaskStatus(CWD, "task-x", "done");
    const reopened = setTaskStatus(CWD, "task-x", "active");
    expect(reopened.item.completion_report).toBeNull();
    // active → pending → dispatched re-dispatch, then a fresh report replaces
    setTaskStatus(CWD, "task-x", "pending");
    setTaskStatus(CWD, "task-x", "dispatched", {
      dispatched_to: { name: "worker-1" },
    });
    const again = setCompletionReport(CWD, "task-x", "second pass", "worker-1");
    expect(again.completion_report).toBe("second pass");
  });

  it("undo (cancelled → pending) voids the old report", () => {
    dispatch("task-x");
    setCompletionReport(CWD, "task-x", "partial", "worker-1");
    setTaskStatus(CWD, "task-x", "cancelled");
    const undone = setTaskStatus(CWD, "task-x", "pending");
    expect(undone.item.completion_report).toBeNull();
  });

  it("throws for a missing item", () => {
    expect(() => setCompletionReport(CWD, "task-nope", "x", "worker-1"))
      .toThrow(/does not exist/);
  });
});

// ━━ subgraph_deps (subgraph dependences) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("subgraph_deps (subgraph dependences)", () => {
  it("stores and round-trips subgraph_deps on a module", () => {
    createTask(CWD, { id: "task-coding", title: "Coding" });
    const m = createTask(CWD, {
      id: "task-testing",
      title: "Testing",
      kind: "module",
      subgraph_deps: ["task-coding"],
    });
    expect(m.subgraph_deps).toEqual(["task-coding"]);
    expect(readTask(CWD, "task-testing")?.subgraph_deps).toEqual(["task-coding"]);
  });

  it("normalizes subgraph_deps: dedupe + sort before storing", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B" });
    const m = createTask(CWD, {
      id: "task-m",
      title: "M",
      kind: "module",
      subgraph_deps: ["task-b", "task-a", "task-b"],
    });
    expect(m.subgraph_deps).toEqual(["task-a", "task-b"]);
  });

  it("rejects a dependence that does not exist, listing the available ids", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    expect(() =>
      createTask(CWD, { id: "task-m", title: "M", kind: "module", subgraph_deps: ["task-nope"] }),
    ).toThrow(/subgraph_deps gate "task-nope" does not exist/);
  });

  it("rejects a unit declaring subgraph_deps", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    expect(() =>
      createTask(CWD, { id: "task-u", title: "U", subgraph_deps: ["task-a"] }),
    ).toThrow(/kind "unit" cannot declare subgraph_deps/);
  });

  it("rejects a dependence on the module itself", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    const m = createTask(CWD, { id: "task-m", title: "M", kind: "module" });
    expect(() => updateTask(CWD, "task-m", { subgraph_deps: ["task-m"] }))
      .toThrow(/gate "task-m" is inside the subgraph/);
  });

  it("rejects a dependence inside the module's own subgraph (a transitive dep)", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module", deps: ["task-a"] });
    expect(() => updateTask(CWD, "task-b", { subgraph_deps: ["task-a"] }))
      .toThrow(/gate "task-a" is inside the subgraph of "task-b"/);
  });

  it("catches a deps update that moves a dependence inside the subgraph", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    const m = createTask(CWD, { id: "task-m", title: "M", kind: "module", subgraph_deps: ["task-a"] });
    // m 现在依赖在 a 上 — 若把 a 变成 m 的 deps,a 就进了子图 → 拒绝
    createTask(CWD, { id: "task-child", title: "Child" });
    const withChild = updateTask(CWD, "task-m", { deps: ["task-child"] });
    expect(withChild.subgraph_deps).toEqual(["task-a"]);
    expect(() => updateTask(CWD, "task-m", { deps: ["task-a"] }))
      .toThrow(/gate "task-a" is inside the subgraph of "task-m"/);
  });

  it("rejects mutually gating modules (A's subgraph depends on B while B's depends on A)", () => {
    const a = createTask(CWD, { id: "task-a", title: "A", kind: "module" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module" });
    expect(updateTask(CWD, "task-a", { subgraph_deps: ["task-b"] }).subgraph_deps).toEqual(["task-b"]);
    expect(() => updateTask(CWD, "task-b", { subgraph_deps: ["task-a"] }))
      .toThrow(/would create a dependency cycle: task-a → task-b → task-a/);
  });

  it("rejects a dependence that would close a cycle through the module's deps", () => {
    // b.deps = [a], a gates on b → 展开后 a → b → a
    createTask(CWD, { id: "task-a", title: "A" });
    createTask(CWD, { id: "task-b", title: "B", kind: "module", deps: ["task-a"] });
    expect(() => updateTask(CWD, "task-a", { kind: "module", subgraph_deps: ["task-b"] }))
      .toThrow(/would create a dependency cycle: task-a → task-b → task-a/);
  });

  it("clears gates with an empty list on update", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    const m = createTask(CWD, { id: "task-m", title: "M", kind: "module", subgraph_deps: ["task-a"] });
    const cleared = updateTask(CWD, "task-m", { subgraph_deps: [] });
    expect(cleared.subgraph_deps).toEqual([]);
  });

  it("done-gating uses effective deps: a dependent node cannot be done while the gate is unsatisfied", () => {
    createTask(CWD, { id: "task-coding", title: "Coding" });
    createTask(CWD, { id: "task-case", title: "Case" });
    createTask(CWD, {
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case"],
      subgraph_deps: ["task-coding"],
    });
    expect(() => setTaskStatus(CWD, "task-case", "done"))
      .toThrow(/deps not satisfied: task-coding/);
    setTaskStatus(CWD, "task-coding", "done");
    expect(setTaskStatus(CWD, "task-case", "done").item.status).toBe("done");
  });

  it("a cancelled dependence counts as satisfied for done checks", () => {
    createTask(CWD, { id: "task-coding", title: "Coding" });
    createTask(CWD, { id: "task-case", title: "Case" });
    createTask(CWD, {
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case"],
      subgraph_deps: ["task-coding"],
    });
    setTaskStatus(CWD, "task-coding", "cancelled");
    expect(setTaskStatus(CWD, "task-case", "done").item.status).toBe("done");
  });

  it("completing the gate unlocks the dependent frontier", () => {
    createTask(CWD, { id: "task-coding", title: "Coding" });
    createTask(CWD, { id: "task-case1", title: "Case 1" });
    createTask(CWD, { id: "task-case2", title: "Case 2" });
    createTask(CWD, {
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case1", "task-case2"],
      subgraph_deps: ["task-coding"],
    });
    const r = setTaskStatus(CWD, "task-coding", "done");
    expect(r.unlocked).toEqual(["task-case1", "task-case2"]);
  });

  it("evolution: a dep added to the module later is covered automatically", () => {
    createTask(CWD, { id: "task-coding", title: "Coding" });
    createTask(CWD, { id: "task-case", title: "Case" });
    createTask(CWD, { id: "task-late", title: "Late" });
    createTask(CWD, {
      id: "task-testing",
      title: "Testing",
      kind: "module",
      deps: ["task-case"],
      subgraph_deps: ["task-coding"],
    });
    updateTask(CWD, "task-testing", { deps: ["task-case", "task-late"] });
    // 新加入子图的节点自动带上该依赖 — done 门控直接拒绝
    expect(() => setTaskStatus(CWD, "task-late", "done"))
      .toThrow(/deps not satisfied: task-coding/);
  });
});

// ━━ optimistic concurrency — expected_version (CAS) ━━━━━━━━━━━━━━━━━━━━━━━━

describe("optimistic concurrency (expected_version)", () => {
  it("updateTask: a matching expected_version writes and bumps version +1", () => {
    createTask(CWD, { id: "task-a", title: "A" }); // v1
    const updated = updateTask(CWD, "task-a", { title: "A2", expected_version: 1 });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe("A2");
    expect(readTask(CWD, "task-a")!.version).toBe(2);
  });

  it("updateTask: a stale expected_version throws with both versions and leaves the file unchanged", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    updateTask(CWD, "task-a", { title: "A2" }); // v2 — the caller's read is stale
    expect(() => updateTask(CWD, "task-a", { title: "A3", expected_version: 1 }))
      .toThrow(/conflict on "task-a"/);
    expect(() => updateTask(CWD, "task-a", { title: "A3", expected_version: 1 }))
      .toThrow(/expected version 1, current version 2/);
    // nothing was written — re-read shows the old v2 state, and no v2 snapshot exists
    const after = readTask(CWD, "task-a")!;
    expect(after.version).toBe(2);
    expect(after.title).toBe("A2");
    const snapshots = existsSync(join(tmp, "history"))
      ? readdirSync(join(tmp, "history")).filter((f) => f.startsWith("task-a.")).sort()
      : [];
    expect(snapshots).toEqual(["task-a.v1.json"]);
  });

  it("updateTask: omitted expected_version keeps the legacy last-writer-wins behavior", () => {
    createTask(CWD, { id: "task-a", title: "A" });
    updateTask(CWD, "task-a", { title: "A2" }); // a stale writer with no expected_version
    const updated = updateTask(CWD, "task-a", { title: "A3" }); // still wins
    expect(updated.version).toBe(3);
    expect(readTask(CWD, "task-a")!.title).toBe("A3");
  });

  it("setTaskStatus: a matching expected_version writes and bumps version +1", () => {
    createTask(CWD, { id: "task-x", title: "X" }); // v1
    const r = setTaskStatus(CWD, "task-x", "done", { expected_version: 1 });
    expect(r.item.version).toBe(2);
    expect(r.item.status).toBe("done");
    expect(readTask(CWD, "task-x")!.status).toBe("done");
  });

  it("setTaskStatus: a stale expected_version throws with both versions; the status is unchanged", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    setTaskStatus(CWD, "task-x", "dispatched"); // v2
    expect(() => setTaskStatus(CWD, "task-x", "done", { expected_version: 1 }))
      .toThrow(/expected version 1, current version 2/);
    expect(() => setTaskStatus(CWD, "task-x", "done", { expected_version: 1 }))
      .toThrow(/re-read the node and retry/);
    const after = readTask(CWD, "task-x")!;
    expect(after.status).toBe("dispatched");
    expect(after.version).toBe(2);
  });

  it("setTaskStatus: omitted expected_version keeps the legacy behavior", () => {
    createTask(CWD, { id: "task-x", title: "X" });
    setTaskStatus(CWD, "task-x", "done");
    const r = setTaskStatus(CWD, "task-x", "active"); // reopen — no expected_version needed
    expect(r.item.version).toBe(3);
    expect(r.item.status).toBe("active");
  });

  it("setCompletionReport: a matching expected_version writes and bumps version +1", () => {
    createTask(CWD, { id: "task-r", title: "R" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-r", "dispatched", { dispatched_to: a }); // v2
    const reported = setCompletionReport(CWD, "task-r", "done as planned", "worker-1", {
      expected_version: 2,
    });
    expect(reported.version).toBe(3);
    expect(readTask(CWD, "task-r")!.completion_report).toBe("done as planned");
  });

  it("setCompletionReport: a stale expected_version throws with both versions; the report is unchanged", () => {
    createTask(CWD, { id: "task-r", title: "R" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-r", "dispatched", { dispatched_to: a });
    setCompletionReport(CWD, "task-r", "first pass", "worker-1"); // v3
    expect(() =>
      setCompletionReport(CWD, "task-r", "second pass", "worker-1", { expected_version: 2 }),
    ).toThrow(/expected version 2, current version 3/);
    const after = readTask(CWD, "task-r")!;
    expect(after.completion_report).toBe("first pass");
    expect(after.version).toBe(3);
  });

  it("setCompletionReport: omitted expected_version keeps the legacy behavior", () => {
    createTask(CWD, { id: "task-r", title: "R" });
    const a = { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" };
    setTaskStatus(CWD, "task-r", "dispatched", { dispatched_to: a });
    setCompletionReport(CWD, "task-r", "first pass", "worker-1");
    const second = setCompletionReport(CWD, "task-r", "second pass", "worker-1"); // overwrites
    expect(second.version).toBe(4);
    expect(readTask(CWD, "task-r")!.completion_report).toBe("second pass");
  });
});
