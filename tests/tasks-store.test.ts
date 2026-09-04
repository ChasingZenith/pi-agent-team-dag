/**
 * Unit tests for lib/tasks/store — the Task storage layer.
 *
 * Pure filesystem, no pi dependency: each test redirects the task
 * directory via PI_TASKS_DIR to a fresh temp dir, then removes it.
 * Tasks are created through the REAL public API (draft files +
 * commitTask) — exactly what task_commit does.
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
  commitTask,
  effectiveDescription,
  HISTORY_CAP,
  listTasks,
  parseTask,
  readTask,
  readTaskVersion,
  sanitizeTaskId,
  setCompletionReport,
  setTaskStatus,
  taskDescriptionPath,
  taskDraftDescriptionPath,
  taskDraftTomlPath,
  taskReportPath,
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
const ME = "tester";

/** Write one draft file for the tester agent. */
function draft(rel: string, content: string): void {
  const p = join(tmp, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
}

/**
 * Create a task through the real public API: metadata draft (id/title/deps/
 * kind) + optional description draft → commitTask.
 */
function createTask(opts: {
  id: string;
  title?: string;
  deps?: string[];
  subgraph_deps?: string[];
  kind?: string;
  description?: string;
  scope?: "metadata" | "description" | "all";
}) {
  const lines: string[] = [`id = '${opts.id}'`, `title = '${opts.title ?? opts.id}'`];
  if (opts.deps) lines.push(`deps = [ ${opts.deps.map((d) => `'${d}'`).join(", ")} ]`);
  if (opts.subgraph_deps) lines.push(`subgraph_deps = [ ${opts.subgraph_deps.map((d) => `'${d}'`).join(", ")} ]`);
  if (opts.kind) lines.push(`kind = '${opts.kind}'`);
  draft(`draft/${ME}/${opts.id}.toml`, lines.join("\n"));
  if (opts.description !== undefined) draft(`draft/${ME}/${opts.id}.description.md`, opts.description);
  return commitTask(CWD, opts.id, {
    scope: opts.scope ?? "all",
    cname: ME,
    updated_by: ME,
    expected_version: 1,
  }).item;
}

/** Commit a description change: write the description draft, then commit. */
function commitDescription(id: string, body: string, expected_version: number) {
  draft(`draft/${ME}/${id}.description.md`, body);
  return commitTask(CWD, id, {
    scope: "description",
    cname: ME,
    updated_by: ME,
    expected_version,
    change_summary: "updated description",
  }).item;
}

// ━━ sanitizeTaskId ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("sanitizeTaskId", () => {
  it("lowercases and strips illegal characters", () => {
    expect(sanitizeTaskId("Auth Login!")).toBe("auth-login");
    expect(sanitizeTaskId("TASK-X")).toBe("task-x");
    expect(sanitizeTaskId("task_auth-2")).toBe("task_auth-2");
  });
});

// ━━ create via commitTask ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("commitTask — create (v1)", () => {
  it("creates the three true copies + snapshot, consumes drafts, records hashes", () => {
    const item = createTask({
      id: "task-a",
      description: "A1: …\nA2: …",
    });
    expect(item.id).toBe("task-a");
    expect(item.title).toBe("task-a");
    expect(item.kind).toBe("unit");
    expect(item.status).toBe("pending");
    expect(item.version).toBe(1);
    expect(item.description).toBe("A1: …\nA2: …");
    expect(item.completion_report).toBeNull();

    // three true copies + one snapshot dir with three files
    expect(existsSync(join(tmp, "task-a.toml"))).toBe(true);
    expect(existsSync(join(tmp, "task-a.description.md"))).toBe(true);
    expect(existsSync(join(tmp, "task-a.report.md"))).toBe(true);
    expect(existsSync(join(tmp, "history", "task-a.v1", "metadata.toml"))).toBe(true);
    expect(existsSync(join(tmp, "history", "task-a.v1", "description.md"))).toBe(true);
    expect(existsSync(join(tmp, "history", "task-a.v1", "report.md"))).toBe(true);

    // hashes recorded in the metadata
    expect(item.description_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.report_sha256).toMatch(/^[0-9a-f]{64}$/);

    // drafts consumed
    expect(existsSync(join(tmp, "draft", ME, "task-a.toml"))).toBe(false);
    expect(existsSync(join(tmp, "draft", ME, "task-a.description.md"))).toBe(false);
  });

  it("description.md carries the version frontmatter; reading strips it", () => {
    const item = createTask({ id: "task-fm", description: "body line" });
    const raw = readFileSync(taskDescriptionPath(CWD, "task-fm"), "utf-8");
    expect(raw).toContain("---\nversion: 1\n---\n\nbody line");
    expect(item.description).toBe("body line");
    // readTask round-trips the body without the frontmatter
    expect(readTask(CWD, "task-fm")?.description).toBe("body line");
  });

  it("draft frontmatter is stripped and rebuilt at commit", () => {
    createTask({ id: "fx", description: "orig" });
    draft(`draft/${ME}/fx.description.md`, "---\nversion: 1\n---\n\nedited body");
    const item = commitTask(CWD, "fx", { scope: "description", cname: ME, updated_by: ME, expected_version: 1 }).item;
    expect(item.description).toBe("edited body");
    expect(item.version).toBe(2);
    const raw = readFileSync(taskDescriptionPath(CWD, "fx"), "utf-8");
    expect(raw).toContain("---\nversion: 2\n---\n\nedited body");
  });

  it("requires the metadata draft (id/title) for creation", () => {
    draft(`draft/${ME}/task-y.description.md`, "body");
    expect(() =>
      commitTask(CWD, "task-y", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/needs a metadata draft/);
  });

  it("creation must specify expected_version=1", () => {
    draft(`draft/${ME}/task-z.toml`, "id = 'task-z'\ntitle = 'z'");
    expect(() =>
      commitTask(CWD, "task-z", { scope: "all", cname: ME, updated_by: ME, expected_version: 2 }),
    ).toThrow(/expected_version=1/);
    expect(() =>
      commitTask(CWD, "task-z", { scope: "all", cname: ME, updated_by: ME, expected_version: 3 }),
    ).toThrow(/expected_version=1/);
  });

  it("rejects a missing dep with the available list", () => {
    draft(`draft/${ME}/task-b.toml`, "id = 'task-b'\ntitle = 'b'\ndeps = [ 'nope' ]");
    expect(() => commitTask(CWD, "task-b", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 })).toThrow(
      /dep "nope" does not exist/,
    );
  });

  it("rejects cycles (self-loop and mutual)", () => {
    createTask({ id: "a" });
    createTask({ id: "b", deps: ["a"] });
    // self-loop
    draft(`draft/${ME}/c.toml`, "id = 'c'\ntitle = 'c'\ndeps = [ 'c' ]");
    expect(() => commitTask(CWD, "c", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 })).toThrow(/cycle/);
    // a → b → a mutual cycle
    draft(`draft/${ME}/a.toml`, "id = 'a'\ntitle = 'a'\ndeps = [ 'b' ]");
    expect(() =>
      commitTask(CWD, "a", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/cycle/);
  });

  it("unit cannot declare subgraph_deps; module can", () => {
    createTask({ id: "ga" });
    createTask({ id: "gb" });
    draft(`draft/${ME}/g.toml`, "id = 'g'\ntitle = 'g'\nkind = 'unit'\nsubgraph_deps = [ 'ga' ]");
    expect(() => commitTask(CWD, "g", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 })).toThrow(
      /kind "unit" cannot declare subgraph_deps/,
    );
    createTask({ id: "mod", kind: "module", subgraph_deps: ["ga"], deps: ["gb"] });
  });

  it("invalid kind rejected", () => {
    draft(`draft/${ME}/k.toml`, "id = 'k'\ntitle = 'k'\nkind = 'bogus'");
    expect(() => commitTask(CWD, "k", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 })).toThrow(
      /invalid kind/,
    );
  });
});

// ━━ update via commitTask (patch semantics) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("commitTask — update (patch semantics)", () => {
  it("version +1 on description/title/kind changes (deps bump struct_version instead); snapshot archives the old version", () => {
    createTask({ id: "dep" });
    createTask({ id: "u", deps: [] });
    expect(readTask(CWD, "u")!.version).toBe(1);

    // description change → v2 + snapshot v1 archived
    const v2 = commitDescription("u", "new body", 1);
    expect(v2.version).toBe(2);
    expect(v2.description).toBe("new body");
    expect(v2.history[0]).toMatchObject({ changed_items: ["description"], version: 2 });
    const snap1 = readTaskVersion(CWD, "u", 1)!;
    expect(snap1.version).toBe(1);
    expect(snap1.description).toBe("");

    // deps change → struct_version +1, content version UNCHANGED (structure-only)
    draft(`draft/${ME}/u.toml`, "deps = [ 'dep' ]");
    const v3 = commitTask(CWD, "u", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 2 }).item;
    expect(v3.version).toBe(2); // content version did NOT bump
    expect(v3.struct_version).toBe(2); // structural version bumped
    expect(v3.history[0].changed_items).toContain("deps");

    // title change → v4 (title bumps content version)
    draft(`draft/${ME}/u.toml`, "title = 'New Title'");
    const v4 = commitTask(CWD, "u", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 2 }).item;
    expect(v4.version).toBe(3);
    expect(v4.title).toBe("New Title");
    expect(v4.history[0].changed_items).toContain("title");

    // kind flip → v4
    draft(`draft/${ME}/u.toml`, "kind = 'module'");
    const v5 = commitTask(CWD, "u", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 3 }).item;
    expect(v5.version).toBe(4);
    expect(v5.kind).toBe("module");
  });

  it("expected_version must match the current version (REQUIRED on updates)", () => {
    createTask({ id: "e" });
    // a correct expected_version commits the update (v1 → v2); a wrong one rejects
    expect(commitDescription("e", "x", 1).version).toBe(2);
    draft(`draft/${ME}/e.description.md`, "y");
    expect(() =>
      commitTask(CWD, "e", { scope: "description", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/expected version 1, current version 2/);
  });

  it("stale expected_version rejects with both versions", () => {
    createTask({ id: "s" });
    commitDescription("s", "first", 1); // → v2
    draft(`draft/${ME}/s.description.md`, "stale edit");
    expect(() =>
      commitTask(CWD, "s", { scope: "description", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/expected version 1, current version 2/);
    // nothing changed — the record is still v2 with the committed body
    expect(readTask(CWD, "s")!.version).toBe(2);
    expect(readTask(CWD, "s")!.description).toBe("first");
  });

  it("rejects a no-op commit (nothing changed)", () => {
    createTask({ id: "n", description: "same" });
    draft(`draft/${ME}/n.description.md`, "same");
    expect(() =>
      commitTask(CWD, "n", { scope: "description", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/no changes to commit/);
    expect(readTask(CWD, "n")!.version).toBe(1);
  });

  it("an empty metadata draft is a no-op and rejected", () => {
    createTask({ id: "no", description: "x" });
    draft(`draft/${ME}/no.toml`, "");
    expect(() =>
      commitTask(CWD, "no", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/no changes to commit/);
  });

  it("draft id must match the committed task id", () => {
    createTask({ id: "m" });
    draft(`draft/${ME}/m.toml`, "id = 'other'\ntitle = 'm'");
    expect(() =>
      commitTask(CWD, "m", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/does not match task "m"/);
  });

  it("a gate moved inside the subgraph is rejected on update", () => {
    createTask({ id: "x1" });
    createTask({ id: "mod", kind: "module", deps: ["x1"], subgraph_deps: [] });
    // try to gate the module on its own dep — a self-loop at expansion
    draft(`draft/${ME}/mod.toml`, "subgraph_deps = [ 'x1' ]");
    expect(() =>
      commitTask(CWD, "mod", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/inside the subgraph/);
  });
});

// ━━ version semantics: lifecycle + report do NOT bump ━━━━━━━━━━━━━━━━━━━━━━

describe("version semantics — lifecycle and reports do not bump", () => {
  it("status transitions record history but keep the version", () => {
    createTask({ id: "v" });
    const r = setTaskStatus(CWD, "v", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m1" },
      change_summary: "dispatched to worker-1",
      updated_by: "manager",
      event: "dispatch",
    });
    expect(r.item.version).toBe(1);
    expect(r.item.status).toBe("dispatched");
    expect(r.item.dispatched_to?.name).toBe("worker-1");
    expect(r.item.history[0]).toMatchObject({
      changed_items: ["status"],
      event: "dispatch",
      version: 1,
    });
    // the v1 snapshot exists (written at create); lifecycle events add no new ones
    expect(existsSync(join(tmp, "history", "v.v1"))).toBe(true);
    expect(existsSync(join(tmp, "history", "v.v2"))).toBe(false);

    const done = setTaskStatus(CWD, "v", "done", { change_summary: "completed", updated_by: "manager", event: "complete" });
    expect(done.item.version).toBe(1);
    expect(done.item.dispatched_to).toBeNull();
  });

  it("done requires deps satisfied (effective deps incl. gates)", () => {
    createTask({ id: "d1" });
    createTask({ id: "d2", deps: ["d1"] });
    expect(() =>
      setTaskStatus(CWD, "d2", "done", { updated_by: ME, event: "complete" }),
    ).toThrow(/deps not satisfied: d1/);
    setTaskStatus(CWD, "d1", "done", { updated_by: ME, event: "complete" });
    const r = setTaskStatus(CWD, "d2", "done", { updated_by: ME, event: "complete" });
    expect(r.item.status).toBe("done");
    expect(r.unlocked).toEqual([]);
  });

  it("illegal transition rejected with legal targets", () => {
    createTask({ id: "t" });
    expect(() => setTaskStatus(CWD, "t", "done", { updated_by: ME })).not.toThrow();
    expect(() => setTaskStatus(CWD, "t", "cancelled", { updated_by: ME })).toThrow(/legal transitions/);
  });

  it("worker_offline transitions: active/dispatched → worker_offline, then worker_offline → dispatched", () => {
    createTask({ id: "wo" });
    // dispatched → worker_offline (worker died before starting)
    let r = setTaskStatus(CWD, "wo", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m1" },
      updated_by: "manager",
      event: "dispatch",
    });
    expect(r.item.status).toBe("dispatched");
    expect(r.item.dispatched_to?.name).toBe("worker-1");
    r = setTaskStatus(CWD, "wo", "worker_offline", { updated_by: "manager", event: "worker_offline", change_summary: "worker-1 offline" });
    expect(r.item.status).toBe("worker_offline");
    // worker_offline → dispatched after restart (recovery path)
    r = setTaskStatus(CWD, "wo", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m2" },
      updated_by: "manager",
      event: "dispatch",
    });
    expect(r.item.status).toBe("dispatched");
    expect(r.item.dispatched_to?.name).toBe("worker-1");
    // now active → worker_offline (worker died mid-flight)
    r = setTaskStatus(CWD, "wo", "active", {
      execution_session: { session_id: "s1", session_file: ".pi/agent-sessions/x.json" },
      updated_by: "worker-1",
      event: "start",
    });
    r = setTaskStatus(CWD, "wo", "worker_offline", { updated_by: "manager", event: "worker_offline" });
    expect(r.item.status).toBe("worker_offline");
    // version unchanged (lifecycle event)
    expect(r.item.version).toBe(1);
  });

  it("worker_offline is not satisfied for dependents (locks them, like blocked)", () => {
    createTask({ id: "dep-wo", deps: [] });
    createTask({ id: "waits-wo", deps: ["dep-wo"] });
    setTaskStatus(CWD, "dep-wo", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m1" },
      updated_by: "manager",
      event: "dispatch",
    });
    setTaskStatus(CWD, "dep-wo", "worker_offline", { updated_by: "manager", event: "worker_offline" });
    // While dep-wo is worker_offline (not done/cancelled), its dependent stays locked:
    // marking the dependent done must FAIL with the missing dep listed.
    expect(() => setTaskStatus(CWD, "waits-wo", "done", { updated_by: "manager", event: "complete" })).toThrow(
      /deps not satisfied: dep-wo/,
    );
    // Once dep-wo is done, the dependent can complete.
    setTaskStatus(CWD, "dep-wo", "done", { updated_by: "manager", event: "complete" });
    const r = setTaskStatus(CWD, "waits-wo", "done", { updated_by: "manager", event: "complete" });
    expect(r.item.status).toBe("done");
  });

  it("reopen (done → active) voids the report; the report true copy resets", () => {
    createTask({ id: "re" });
    setTaskStatus(CWD, "re", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "m", dispatch_msg_id: "m1" },
      updated_by: "m",
      event: "dispatch",
    });
    draft(`draft/${ME}/re.report.md`, "finished the work");
    const reported = setCompletionReport(CWD, "re", "worker-1", { expected_version: 1, cname: ME });
    expect(reported.completion_report).toBe("finished the work");
    expect(reported.version).toBe(1); // report does not bump
    expect(reported.history[0]).toMatchObject({ changed_items: ["report"], version: 1 });

    setTaskStatus(CWD, "re", "done", { updated_by: "m", event: "complete" });
    const reopened = setTaskStatus(CWD, "re", "active", { updated_by: "m", event: "status" });
    expect(reopened.item.completion_report).toBeNull();
    const reportRaw = readFileSync(taskReportPath(CWD, "re"), "utf-8");
    expect(reportRaw).toContain("---\nfor_version: 1\n---\n");
  });

  it("undo (cancelled → pending) voids the report", () => {
    createTask({ id: "un" });
    setTaskStatus(CWD, "un", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "m", dispatch_msg_id: "m1" },
      updated_by: "m",
      event: "dispatch",
    });
    draft(`draft/${ME}/un.report.md`, "done as planned");
    setCompletionReport(CWD, "un", "worker-1", { expected_version: 1, cname: ME });
    setTaskStatus(CWD, "un", "cancelled", { updated_by: "m", event: "cancel" });
    const undone = setTaskStatus(CWD, "un", "pending", { updated_by: "m", event: "status" });
    expect(undone.item.completion_report).toBeNull();
  });
});

// ━━ completion report (draft-driven) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("setCompletionReport — the worker's record", () => {
  function dispatched(id: string) {
    createTask({ id });
    setTaskStatus(CWD, id, "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m1" },
      updated_by: "manager",
      event: "dispatch",
    });
  }

  it("commits the report from the draft, anchors for_version, version unchanged", () => {
    dispatched("task-x");
    draft(`draft/${ME}/task-x.report.md`, "Implemented login form.\nVerified by tests.");
    const reported = setCompletionReport(CWD, "task-x", "worker-1", { expected_version: 1, cname: ME });
    expect(reported.completion_report).toContain("Implemented login form.");
    expect(reported.version).toBe(1); // report does NOT bump the version
    expect(reported.updated_by).toBe("worker-1");
    expect(reported.history[0]).toMatchObject({ changed_items: ["report"], version: 1 });
    // history keeps the one-line digest (the report's first line)
    expect(reported.history[0].change_summary).toBe("Implemented login form.");
    // report.md carries the for_version anchor
    const raw = readFileSync(taskReportPath(CWD, "task-x"), "utf-8");
    expect(raw).toContain("---\nfor_version: 1\n---\n\nImplemented login form.");
    // draft consumed
    expect(existsSync(join(tmp, "draft", ME, "task-x.report.md"))).toBe(false);
    // readTask surfaces the anchor
    expect(readTask(CWD, "task-x")?.report_for_version).toBe(1);
  });

  it("expected_version is REQUIRED", () => {
    dispatched("task-e");
    draft(`draft/${ME}/task-e.report.md`, "report body");
    expect(() =>
      setCompletionReport(CWD, "task-e", "worker-1", { expected_version: undefined as unknown as number, cname: ME }),
    ).toThrow(/requires expected_version/);
  });

  it("a stale expected_version (description advanced) is ACCEPTED and anchored to the read version", () => {
    dispatched("task-c");
    commitDescription("task-c", "contract changed", 1); // → v2
    draft(`draft/${ME}/task-c.report.md`, "report for old contract");
    const reported = setCompletionReport(CWD, "task-c", "worker-1", { expected_version: 1, cname: ME });
    // the report stands and is anchored to the version the worker actually read
    expect(reported.completion_report).toBe("report for old contract");
    expect(reported.version).toBe(2); // the description version is unchanged
    expect(reported.report_for_version).toBe(1); // anchored to the read version, not current
    // report.md carries the for_version anchor of the read version
    const raw = readFileSync(taskReportPath(CWD, "task-c"), "utf-8");
    expect(raw).toContain("---\nfor_version: 1\n---\n\nreport for old contract");
    // the staleness is flagged in history for the reader
    expect(reported.history[0].change_summary).toContain("[report against v1, current v2]");
    expect(reported.report_for_version).toBeLessThan(reported.version);
  });

  it("rejects an expected_version ahead of the current version (never readable)", () => {
    dispatched("task-fwd");
    draft(`draft/${ME}/task-fwd.report.md`, "should not happen");
    expect(() =>
      setCompletionReport(CWD, "task-fwd", "worker-1", { expected_version: 5, cname: ME }),
    ).toThrow(/ahead of the current version/);
  });

  it("rejects a report from an agent that is not the dispatchee", () => {
    dispatched("task-o");
    draft(`draft/${ME}/task-o.report.md`, "sneaky");
    expect(() =>
      setCompletionReport(CWD, "task-o", "intruder", { expected_version: 1, cname: ME }),
    ).toThrow(/dispatched to worker-1, not to you \(intruder\)/);
  });

  it("rejects when the report draft is missing or empty", () => {
    dispatched("task-m");
    expect(() =>
      setCompletionReport(CWD, "task-m", "worker-1", { expected_version: 1, cname: ME }),
    ).toThrow(/write your report first/);
    draft(`draft/${ME}/task-m.report.md`, "   ");
    expect(() =>
      setCompletionReport(CWD, "task-m", "worker-1", { expected_version: 1, cname: ME }),
    ).toThrow(/is empty/);
  });

  it("a fresh dispatch after reopen allows a new report", () => {
    dispatched("task-r");
    draft(`draft/${ME}/task-r.report.md`, "first pass");
    setCompletionReport(CWD, "task-r", "worker-1", { expected_version: 1, cname: ME });
    setTaskStatus(CWD, "task-r", "done", { updated_by: "manager", event: "complete" });
    setTaskStatus(CWD, "task-r", "active", { updated_by: "manager", event: "status" });
    setTaskStatus(CWD, "task-r", "pending", { updated_by: "manager", event: "status" });
    setTaskStatus(CWD, "task-r", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager", dispatch_msg_id: "m2" },
      updated_by: "manager",
      event: "dispatch",
    });
    draft(`draft/${ME}/task-r.report.md`, "second pass");
    const again = setCompletionReport(CWD, "task-r", "worker-1", { expected_version: 1, cname: ME });
    expect(again.completion_report).toBe("second pass");
  });
});

// ━━ integrity hashes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("integrity — sha256 verification of the true copies", () => {
  it("reports a mismatch when a true body is modified outside a commit", () => {
    createTask({ id: "h", description: "committed body" });
    // tamper with the true copy
    writeFileSync(taskDescriptionPath(CWD, "h"), "---\nversion: 1\n---\n\ntampered", "utf-8");
    const item = readTask(CWD, "h")!;
    expect(item.integrity_warnings?.length).toBe(1);
    expect(item.integrity_warnings![0]).toContain("hash mismatch");
  });

  it("reports a missing true body file", () => {
    createTask({ id: "del", description: "x" });
    rmSync(taskDescriptionPath(CWD, "del"));
    const item = readTask(CWD, "del")!;
    expect(item.integrity_warnings?.length).toBe(1);
    expect(item.integrity_warnings![0]).toContain("is missing");
  });

  it("hash covers the full file including frontmatter — frontmatter edits break it", () => {
    createTask({ id: "f", description: "body" });
    writeFileSync(taskDescriptionPath(CWD, "f"), "---\nversion: 99\n---\n\nbody", "utf-8");
    const item = readTask(CWD, "f")!;
    expect(item.integrity_warnings?.length).toBe(1);
  });

  it("the snapshot metadata carries its own body hashes (self-consistent)", () => {
    createTask({ id: "sn", description: "v1 body" });
    commitDescription("sn", "v2 body", 1);
    const snap = readTaskVersion(CWD, "sn", 1)!;
    expect(snap.description_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.report_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the snapshot's own description.md round-trips
    expect(snap.description).toBe("v1 body");
  });
});

// ━━ readTaskVersion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("readTaskVersion — archived snapshots", () => {
  it("reads any past version's three files", () => {
    createTask({ id: "v1", description: "first" });
    commitDescription("v1", "second", 1); // v2
    commitDescription("v1", "third", 2); // v3
    const s1 = readTaskVersion(CWD, "v1", 1)!;
    const s2 = readTaskVersion(CWD, "v1", 2)!;
    expect(s1.version).toBe(1);
    expect(s1.description).toBe("first");
    expect(s2.description).toBe("second");
    expect(readTask(CWD, "v1")!.description).toBe("third");
  });

  it("rejects version >= current with the archived list", () => {
    createTask({ id: "cur", description: "x" });
    expect(() => readTaskVersion(CWD, "cur", 1)).toThrow(/at version 1/);
    expect(() => readTaskVersion(CWD, "cur", 0)).toThrow(/positive integers/);
  });

  it("rejects a non-integer version", () => {
    createTask({ id: "neg", description: "x" });
    expect(() => readTaskVersion(CWD, "neg", 1.5)).toThrow(/positive integers/);
  });
});

// ━━ listing / parse ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("listTasks / parseTask", () => {
  it("lists metadata summaries; skips non-toml and corrupted files", () => {
    createTask({ id: "a", description: "x" });
    createTask({ id: "b" });
    writeFileSync(join(tmp, "garbage.toml"), "not toml [[[", "utf-8");
    writeFileSync(join(tmp, "notes.md"), "# not a task", "utf-8");
    const all = listTasks(CWD);
    expect(all.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(all[0].version).toBe(1);
    expect(all[0].depCount).toBe(0);
  });

  it("serializeMetadata round-trips through parseTask", () => {
    const item = createTask({ id: "rt", description: "body", kind: "module" });
    const raw = readFileSync(join(tmp, "rt.toml"), "utf-8");
    const parsed = parseTask(raw)!;
    expect(parsed.id).toBe("rt");
    expect(parsed.kind).toBe("module");
    expect(parsed.description_sha256).toBe(item.description_sha256);
    expect(parsed.report_sha256).toBe(item.report_sha256);
    // bodies are NOT in the metadata file
    expect(raw).not.toContain("description =");
    expect(raw).not.toContain("completion_report");
  });

  it("history keeps only the newest HISTORY_CAP entries", () => {
    createTask({ id: "cap" });
    for (let i = 1; i <= HISTORY_CAP + 3; i++) {
      commitDescription("cap", `body ${i}`, i);
    }
    const item = readTask(CWD, "cap")!;
    expect(item.history.length).toBe(HISTORY_CAP);
    expect(item.history[0].version).toBe(HISTORY_CAP + 4);
  });

  it("drafts are per-agent — one agent's drafts never collide with another's", () => {
    createTask({ id: "multi" });
    draft("draft/alice/multi.description.md", "alice's edit");
    draft("draft/bob/multi.description.md", "bob's edit");
    // alice commits her draft
    const r = commitTask(CWD, "multi", {
      scope: "description",
      cname: "alice",
      updated_by: "alice",
      expected_version: 1,
    });
    expect(r.item.description).toBe("alice's edit");
    // bob's draft is untouched (his own file) but now stale against v2
    expect(readFileSync(join(tmp, "draft", "bob", "multi.description.md"), "utf-8")).toBe("bob's edit");
    expect(() =>
      commitTask(CWD, "multi", {
        scope: "description",
        cname: "bob",
        updated_by: "bob",
        expected_version: 1,
      }),
    ).toThrow(/current version 2/);
  });

  it("taskDraft*Path helpers sanitize the agent name", () => {
    expect(taskDraftTomlPath(CWD, "Researcher-1!", "x").endsWith(join("draft", "researcher-1", "x.toml"))).toBe(true);
    expect(taskDraftDescriptionPath(CWD, "??", "x").includes("unknown")).toBe(true);
  });
});

// ━━ shared information nodes (kind = "info") ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("shared information nodes (kind = info)", () => {
  it("creates an info node with a description body", () => {
    const item = createTask({
      id: "site-audit-common",
      kind: "info",
      description: "Requirements for auditing any site.\n- check https\n- check headers",
    });
    expect(item.kind).toBe("info");
    expect(item.deps).toEqual([]);
    expect(item.info_refs).toEqual([]);
    expect(item.description).toContain("check https");
  });

  it("info nodes cannot declare deps or subgraph_deps", () => {
    createTask({ id: "task-a" }); // ensure the dep/gate targets exist so existence check passes first
    expect(() =>
      createTask({ id: "bad-info", kind: "info", deps: ["task-a"] }),
    ).toThrow(/kind "info" cannot declare deps/);
    expect(() =>
      createTask({ id: "bad-info2", kind: "info", subgraph_deps: ["task-a"] }),
    ).toThrow(/kind "info" cannot declare subgraph_deps/);
  });

  it("info nodes cannot be marked dispatched/done/blocked (no lifecycle)", () => {
    createTask({ id: "audit-info", kind: "info" });
    expect(() => setTaskStatus(CWD, "audit-info", "done", { updated_by: ME })).toThrow(
      /shared information node \(kind = "info"\), pure content with no lifecycle/,
    );
    expect(() => setTaskStatus(CWD, "audit-info", "blocked", { updated_by: ME })).toThrow(
      /no lifecycle/,
    );
  });

  it("info nodes cannot receive a completion report", () => {
    createTask({ id: "audit-info", kind: "info" });
    draft(`draft/${ME}/audit-info.report.md`, "done");
    expect(() =>
      setCompletionReport(CWD, "audit-info", ME, { expected_version: 1, cname: ME }),
    ).toThrow(/never dispatched and never completes/);
  });

  it("info_refs inject shared content at read time; editing keeps the own body only", () => {
    createTask({ id: "common-reqs", kind: "info", description: "COMMON: audit every site\n- must be public" });
    const site = createTask({ id: "site-a", description: "SITE-A specific: use login" });
    // add info_ref to site-a
    draft(`draft/${ME}/site-a.toml`, `info_refs = [ 'common-reqs' ]`);
    const updated = commitTask(CWD, "site-a", {
      scope: "metadata",
      cname: ME,
      updated_by: ME,
      expected_version: 1,
    }).item;
    expect(updated.info_refs).toEqual(["common-reqs"]);
    // effective description = injected shared info + own body
    const eff = effectiveDescription(CWD, updated);
    expect(eff).toContain("COMMON: audit every site");
    expect(eff).toContain("SITE-A specific: use login");
    // raw own body is NOT polluted by the shared content
    expect(updated.description).toBe("SITE-A specific: use login");
  });

  it("info_refs must be a separate kind=info node; tasks and modules are rejected", () => {
    createTask({ id: "site-a" });
    createTask({ id: "common-reqs" }); // kind defaults to unit
    expect(() => {
      draft(`draft/${ME}/site-a.toml`, `info_refs = [ 'common-reqs' ]`);
      commitTask(CWD, "site-a", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 });
    }).toThrow(/not a shared information node/);
  });

  it("info_refs must already exist", () => {
    createTask({ id: "site-a" });
    expect(() => {
      draft(`draft/${ME}/site-a.toml`, `info_refs = [ 'missing-info' ]`);
      commitTask(CWD, "site-a", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 });
    }).toThrow(/does not exist/);
  });

  it("an info node cannot reference another info node (it is itself the source)", () => {
    createTask({ id: "other", kind: "info" });
    createTask({ id: "src-info", kind: "info" });
    draft(`draft/${ME}/src-info.toml`, `info_refs = [ 'other' ]`);
    expect(() =>
      commitTask(CWD, "src-info", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/kind "info" cannot declare info_refs/);
  });

  it("info_refs appears in the listing summary", () => {
    createTask({ id: "common-reqs", kind: "info", description: "shared" });
    createTask({ id: "site-a", description: "own" });
    draft(`draft/${ME}/site-a.toml`, `info_refs = [ 'common-reqs' ]`);
    commitTask(CWD, "site-a", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 });
    const summary = listTasks(CWD).find((s) => s.id === "site-a")!;
    expect(summary.info_refs).toEqual(["common-reqs"]);
    const infoSummary = listTasks(CWD).find((s) => s.id === "common-reqs")!;
    expect(infoSummary.kind).toBe("info");
  });
});

// ━━ struct_version split + into_* wiring ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("struct_version + into_* wiring", () => {
  it("deps/subgraph_deps changes bump struct_version, not the content version", () => {
    createTask({ id: "dep" });
    createTask({ id: "m", kind: "module" });
    draft(`draft/${ME}/m.toml`, "deps = [ 'dep' ]");
    const r = commitTask(CWD, "m", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }).item;
    expect(r.version).toBe(1); // content contract untouched
    expect(r.struct_version).toBe(2); // structure bumped
    expect(r.struct_changed_at).toBeTruthy();
    // no snapshot written for a structure-only change
    expect(existsSync(join(tmp, "history", "m.v2"))).toBe(false);
  });

  it("into_deps wires a child into an EXISTING parent via its own commit — parent's deps grow, content version unchanged", () => {
    createTask({ id: "mod", kind: "module" });
    // child commits and declares it belongs in mod's deps
    draft(`draft/${ME}/child.toml`, `id = 'child'\ntitle = 'child'\ninto_deps = [ 'mod' ]`);
    const r = commitTask(CWD, "child", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
    expect(r.created).toBe(true);
    const child = readTask(CWD, "child")!;
    // the relation lives on the PARENT only — child metadata carries no into_deps
    expect(child.deps).toEqual([]);
    const parent = readTask(CWD, "mod")!;
    expect(parent.deps).toEqual(["child"]);
    expect(parent.version).toBe(1); // parent content version NOT bumped
    expect(parent.struct_version).toBe(2); // parent structure bumped
    expect(parent.history[0].event).toBe("wiring");
  });

  it("into_subgraph_deps wires a node as a module's gate", () => {
    createTask({ id: "code" });
    createTask({ id: "tests-mod", kind: "module" });
    draft(`draft/${ME}/code.toml`, `id = 'code'\ntitle = 'code'\ninto_subgraph_deps = [ 'tests-mod' ]`);
    commitTask(CWD, "code", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
    const parent = readTask(CWD, "tests-mod")!;
    expect(parent.subgraph_deps).toEqual(["code"]);
    expect(parent.version).toBe(1);
    expect(parent.struct_version).toBe(2);
  });

  it("wiring into an ACTIVE parent does not disturb it (content version unchanged, still reportable)", () => {
    createTask({ id: "mod", kind: "module" });
    setTaskStatus(CWD, "mod", "dispatched", {
      dispatched_to: { name: "coord", dispatched_by: "planner", dispatch_msg_id: "m1" },
      event: "dispatch",
      updated_by: "planner",
    });
    setTaskStatus(CWD, "mod", "active", {
      execution_session: { session_id: "sess", session_file: "f" },
      event: "start",
      updated_by: "coord",
    });
    const before = readTask(CWD, "mod")!;
    draft(`draft/${ME}/t2.toml`, `id = 't2'\ntitle = 't2'\ninto_deps = [ 'mod' ]`);
    commitTask(CWD, "t2", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
    const after = readTask(CWD, "mod")!;
    expect(after.version).toBe(before.version); // 并未推高 content version
    expect(after.struct_version).toBe(before.struct_version + 1);
    expect(after.status).toBe("active");
    expect(after.dispatched_to?.name).toBe("coord");
  });

  it("wiring is idempotent — a second commit declaring the same parent is a no-op on the parent", () => {
    createTask({ id: "mod", kind: "module" });
    draft(`draft/${ME}/c1.toml`, `id = 'c1'\ntitle = 'c1'\ninto_deps = [ 'mod' ]`);
    commitTask(CWD, "c1", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
    const pv1 = readTask(CWD, "mod")!.struct_version;
    // child re-commits (content change) declaring the same parent — parent's deps already contains it
    draft(`draft/${ME}/c1.toml`, `title = 'c1 v2'\ninto_deps = [ 'mod' ]`);
    commitTask(CWD, "c1", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 });
    expect(readTask(CWD, "mod")!.struct_version).toBe(pv1); // no additional bump
  });

  it("into_deps requires an existing parent; missing target rejected with available ids", () => {
    draft(`draft/${ME}/orphan.toml`, `id = 'orphan'\ntitle = 'orphan'\ninto_deps = [ 'nope' ]`);
    expect(() =>
      commitTask(CWD, "orphan", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/into_deps target "nope" does not exist/);
  });

  it("into_deps into a finished (done) parent is rejected", () => {
    createTask({ id: "mod", kind: "module" });
    setTaskStatus(CWD, "mod", "done", { event: "complete", updated_by: "planner" });
    draft(`draft/${ME}/late.toml`, `id = 'late'\ntitle = 'late'\ninto_deps = [ 'mod' ]`);
    expect(() =>
      commitTask(CWD, "late", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/terminal/);
  });

  it("into_subgraph_deps requires a module target — a unit is rejected", () => {
    createTask({ id: "unt" });
    draft(`draft/${ME}/g.toml`, `id = 'g'\ntitle = 'g'\ninto_subgraph_deps = [ 'unt' ]`);
    expect(() =>
      commitTask(CWD, "g", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/only a module has a subgraph/);
  });

  it("an info node cannot be wired (into_deps/into_subgraph_deps)", () => {
    createTask({ id: "mod", kind: "module" });
    draft(`draft/${ME}/inf.toml`, `id = 'inf'\ntitle = 'inf'\nkind = 'info'\ninto_deps = [ 'mod' ]`);
    expect(() =>
      commitTask(CWD, "inf", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 }),
    ).toThrow(/kind "info" cannot declare into_deps/);
  });

  it("wiring an existing node into a parent (update path) works and does not bump the child content version", () => {
    createTask({ id: "mod", kind: "module" });
    createTask({ id: "node1" });
    draft(`draft/${ME}/node1.toml`, `into_deps = [ 'mod' ]`);
    const r = commitTask(CWD, "node1", { scope: "metadata", cname: ME, updated_by: ME, expected_version: 1 }).item;
    expect(r.version).toBe(1); // child content unchanged
    expect(readTask(CWD, "mod")!.deps).toEqual(["node1"]);
  });

  it("wiring lines up before orphan detection — a wired child is no longer an orphan", () => {
    createTask({ id: "mod", kind: "module" });
    draft(`draft/${ME}/leaf.toml`, `id = 'leaf'\ntitle = 'leaf'\ninto_deps = [ 'mod' ]`);
    commitTask(CWD, "leaf", { scope: "all", cname: ME, updated_by: ME, expected_version: 1 });
    // parent's deps is the true edge; leaf is referenced, so it is not an orphan
    const parent = readTask(CWD, "mod")!;
    expect(parent.deps).toContain("leaf");
  });

  it("struct_version round-trips through parseTask/serializeMetadata", () => {
    createTask({ id: "s1", deps: [] });
    const raw = readFileSync(join(tmp, "s1.toml"), "utf-8");
    const parsed = parseTask(raw)!;
    expect(parsed.struct_version).toBe(1);
    expect(typeof parsed.struct_changed_at).toBe("string");
  });
});
