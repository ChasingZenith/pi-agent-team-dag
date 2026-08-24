/**
 * Unit tests for the tasks extension shell: tool registration /
 * activation / wiring into the storage layer and the graph semantics.
 *
 * @sinclair/typebox and @earendil-works/pi-tui are installed as real
 * devDependencies (aliased to the same versions pi embeds at runtime), so
 * the extension is imported directly — no mocks.
 *
 * The storage layer (lib/tasks/store.ts + graph.ts) is built by a
 * sibling agent against the same interface contract; these tests exercise
 * the shell through that interface, so they pass once the lib lands.
 *
 * Run: bun test tests/tasks-shell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ━━ helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let tmp: string;
let CWD: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tasks-shell-test-"));
  process.env.PI_TASKS_DIR = tmp;
  // real temp cwd — dispatch resolution reads <cwd>/.pi/agent-sessions/
  CWD = tmp;
});
afterEach(() => {
  delete process.env.PI_TASKS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function makeFakePi() {
  const tools: any[] = [];
  const handlers: Record<string, (...a: any[]) => any> = {};
  const entries: any[] = [];
  let active: string[] = [];
  const pi = {
    registerTool: (t: any) => {
      tools.push(t);
    },
    registerFlag: () => {},
    on: (evt: string, cb: (...a: any[]) => any) => {
      handlers[evt] = cb;
    },
    setActiveTools: (list: string[]) => {
      active = list;
    },
    getActiveTools: () => [],
    appendEntry: (channel: string, entry: any) => {
      entries.push({ channel, entry });
    },
  } as any;
  return { pi, tools, handlers, entries, active: () => active };
}

const ALL_TOOLS = [
  "task_create",
  "task_update",
  "task_set_status",
  "task_read",
  "task_list",
  "task_ready_set",
  "task_render",
];

// ━━ extension shell (dynamically imported after the mocks) ━━━━━━━━━━━━━━━━━━

describe("tasks extension shell", () => {
  let tasksExtension: (pi: any) => void;
  beforeAll(async () => {
    const mod = await import("../extensions/task-graph.ts");
    tasksExtension = mod.default;
  });

  it("registers the seven task tools", () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(ALL_TOOLS));
  });

  it("activates the task tools on session_start", async () => {
    const { pi, handlers, active } = makeFakePi();
    tasksExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    expect(active()).toEqual(expect.arrayContaining(ALL_TOOLS));
  });

  it("create → update → set_status chain: parent unlocks when deps complete, audits land", async () => {
    const { pi, tools, entries } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    const read = tools.find((t) => t.name === "task_read");
    const ready = tools.find((t) => t.name === "task_ready_set");

    // children first, then the parent linking them (deps must exist)
    await create.execute("c1", { id: "task-jwt", title: "JWT auth", change_summary: "created" }, undefined, undefined);
    await create.execute("c2", { id: "task-secrets", title: "Secrets store", change_summary: "created" }, undefined, undefined);
    const parent = await create.execute(
      "c3",
      { id: "task-auth", title: "Auth module", kind: "module", deps: ["task-jwt", "task-secrets"], change_summary: "linking children" },
      undefined,
      undefined,
    );
    expect(parent.details).toMatchObject({
      id: "task-auth",
      deps: ["task-jwt", "task-secrets"],
      version: 1,
      created: true,
    });
    expect(parent.content[0].text).toContain("[Task Created] task-auth");
    // a dependent of the parent — becomes unlocked only when the parent is done
    await create.execute("c4", { id: "task-session", title: "Session bootstrap", kind: "module", deps: ["task-auth"], change_summary: "created" }, undefined, undefined);

    // update: re-title the parent, version bumps
    const upd = await update.execute("c5", { id: "task-auth", title: "Auth module v2", change_summary: "renamed" }, undefined, undefined);
    expect(upd.details).toMatchObject({ id: "task-auth", version: 2 });

    // the parent cannot be marked done before its deps — the store rejects it
    await expect(
      setStatus.execute("c6", { id: "task-auth", status: "done", change_summary: "too early" }, undefined, undefined),
    ).rejects.toThrow(/deps not satisfied/);

    // first child done — the parent is still missing its second dep
    const s1 = await setStatus.execute("c7", { id: "task-jwt", status: "done", change_summary: "implemented" }, undefined, undefined);
    expect(s1.details).toMatchObject({ id: "task-jwt", status: "done" });

    // second child done — the parent's last dep is satisfied: it is unlocked
    // (deps now satisfied); task-session unlocks only after the parent is done
    const s2 = await setStatus.execute("c8", { id: "task-secrets", status: "done", change_summary: "implemented" }, undefined, undefined);
    expect(s2.details.unlocked).toContain("task-auth");
    expect(s2.content[0].text).toContain("[Task Update] task-secrets done");
    expect(s2.content[0].text).toContain("Read: task_read(id=\"task-secrets\")");

    // the manager marks the parent done (its deps are now satisfied) — that
    // newly unlocks task-session
    const s3 = await setStatus.execute("c9", { id: "task-auth", status: "done", change_summary: "parent complete" }, undefined, undefined);
    expect(s3.details.item.status).toBe("done");
    expect(s3.details.unlocked).toContain("task-session");

    // the parent reads as done, with its dependent listed
    const r = await read.execute("c10", { id: "task-auth" }, undefined, undefined);
    expect(r.details.found).toBe(true);
    expect(r.details.item.status).toBe("done");
    expect(r.details.dependents).toContain("task-session");
    // task-session itself is now ready too (its dep task-auth is done)
    expect(r.details.ready).toBe(false); // task-auth is done, not pending — not dispatchable
    const readyRes = await ready.execute("c11", {}, undefined, undefined);
    expect(readyRes.details.ready.map((i: any) => i.id)).toContain("task-session");

    // audit: writes land on the tasks-log channel, with unlocked
    const events = entries.filter((e) => e.channel === "tasks-log").map((e) => e.entry);
    expect(events.filter((e) => e.event === "task_create")).toHaveLength(4);
    expect(events.filter((e) => e.event === "task_update")).toHaveLength(1);
    const setEvents = events.filter((e) => e.event === "task_set_status");
    expect(setEvents).toHaveLength(3);
    expect(setEvents[1]).toMatchObject({
      item_id: "task-secrets",
      unlocked: expect.arrayContaining(["task-auth"]),
    });
    expect(setEvents[2]).toMatchObject({
      item_id: "task-auth",
      unlocked: expect.arrayContaining(["task-session"]),
    });
  });

  it("rejects a dep that does not exist and lists available items", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    await create.execute("c1", { id: "task-existing", title: "Existing", change_summary: "created" }, undefined, undefined);
    const err = await create
      .execute("c2", { id: "task-orphan", title: "Orphan", deps: ["task-nope"], change_summary: "created" }, undefined, undefined)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("task-nope");
    expect(err!.message).toContain("task-existing");
  });

  it("rejects an update that would create a cycle, with the cycle path", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    await create.execute("c1", { id: "task-a", title: "A", change_summary: "created" }, undefined, undefined);
    await create.execute("c2", { id: "task-b", title: "B", kind: "module", deps: ["task-a"], change_summary: "created" }, undefined, undefined);
    const err = await update
      .execute("c3", { id: "task-a", deps: ["task-b"], change_summary: "re-link" }, undefined, undefined)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/cycle/i);
    expect(err!.message).toContain("task-a");
    expect(err!.message).toContain("task-b");
  });

  it("task_ready_set reports the ready set, missing deps and progress", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    await create.execute("c1", { id: "task-jwt", title: "JWT", change_summary: "created" }, undefined, undefined);
    await create.execute("c2", { id: "task-secrets", title: "Secrets", change_summary: "created" }, undefined, undefined);
    await create.execute("c3", { id: "task-auth", title: "Auth", kind: "module", deps: ["task-jwt", "task-secrets"], change_summary: "created" }, undefined, undefined);
    const ready = tools.find((t) => t.name === "task_ready_set");
    const res = await ready.execute("c4", {}, undefined, undefined);
    // children have no deps → ready; the parent is pending on them
    expect(res.details.ready.map((i: any) => i.id)).toEqual(
      expect.arrayContaining(["task-jwt", "task-secrets"]),
    );
    const auth = res.details.notReady.find((x: any) => x.item.id === "task-auth");
    expect(auth).toBeDefined();
    expect(auth.missing).toEqual(expect.arrayContaining(["task-jwt", "task-secrets"]));
    expect(res.details.progress).toMatchObject({ done: 0, total: 3, blocked: 0 });
    expect(res.content[0].text).toContain("task-auth");
  });

  it("task_ready_set for=<id> scopes to the item and its dependency closure", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    await create.execute("c1", { id: "task-a", title: "A", change_summary: "created" }, undefined, undefined);
    await create.execute("c2", { id: "task-b", title: "B", kind: "module", deps: ["task-a"], change_summary: "created" }, undefined, undefined);
    await create.execute("c3", { id: "task-c", title: "C", kind: "module", deps: ["task-b"], change_summary: "created" }, undefined, undefined);
    await create.execute("c4", { id: "task-other", title: "Unrelated", change_summary: "created" }, undefined, undefined);
    const setStatus = tools.find((t) => t.name === "task_set_status");
    const ready = tools.find((t) => t.name === "task_ready_set");
    const scopedIds = (res: any) => [
      ...res.details.ready.map((i: any) => i.id),
      ...res.details.notReady.map((x: any) => x.item.id),
    ];
    // the item itself + its closure (a, b) are reported; the unrelated item is out
    let res = await ready.execute("c5", { for: "task-c" }, undefined, undefined);
    expect(res.details.ready.map((i: any) => i.id)).toEqual(["task-a"]);
    expect(res.details.notReady.map((x: any) => x.item.id)).toEqual(["task-b", "task-c"]);
    expect(res.details.progress).toMatchObject({ done: 0, total: 3, blocked: 0, ready: 1 });
    expect(res.content[0].text).toContain("(for task-c)");
    expect(scopedIds(res)).toContain("task-c");
    expect(scopedIds(res)).not.toContain("task-other");
    // transitive: done a makes b ready inside the closure
    await setStatus.execute("c6", { id: "task-a", status: "done", change_summary: "done" }, undefined, undefined);
    res = await ready.execute("c7", { for: "task-c" }, undefined, undefined);
    expect(res.details.ready.map((i: any) => i.id)).toEqual(["task-b"]);
    expect(res.details.notReady.map((x: any) => x.item.id)).toEqual(["task-c"]);
    expect(res.details.progress).toMatchObject({ done: 1, total: 3, ready: 1 });
    // the root itself is listed once it is ready
    await setStatus.execute("c8", { id: "task-b", status: "done", change_summary: "done" }, undefined, undefined);
    res = await ready.execute("c9", { for: "task-c" }, undefined, undefined);
    expect(res.details.ready.map((i: any) => i.id)).toEqual(["task-c"]);
    expect(res.details.progress).toMatchObject({ done: 2, total: 3, ready: 1 });
    // unscoped query still covers everything
    res = await ready.execute("c10", {}, undefined, undefined);
    expect(scopedIds(res)).toContain("task-other");
  });

  it("task_ready_set for=<id> rejects an unknown id", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const ready = tools.find((t) => t.name === "task_ready_set");
    const err = await ready
      .execute("c1", { for: "task-nope" }, undefined, undefined)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("task-nope");
  });

  it("task_list renders the table with warnings; task_render renders the graph", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    await create.execute("c1", { id: "task-a", title: "Alpha", change_summary: "created" }, undefined, undefined);
    await create.execute("c2", { id: "task-b", title: "Beta", kind: "module", deps: ["task-a"], change_summary: "created" }, undefined, undefined);
    const list = tools.find((t) => t.name === "task_list");
    const listRes = await list.execute("c3", {}, undefined, undefined);
    expect(listRes.details.count).toBe(2);
    expect(listRes.content[0].text).toContain("task-a");
    expect(listRes.content[0].text).toContain("Alpha");
    const render = tools.find((t) => t.name === "task_render");
    const renderRes = await render.execute("c4", {}, undefined, undefined);
    expect(typeof renderRes.content[0].text).toBe("string");
    expect(renderRes.content[0].text.length).toBeGreaterThan(0);
    expect(renderRes.details.count).toBe(2);
  });

  it("task_read of a missing item returns found:false", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    await create.execute("c1", { id: "task-a", title: "Alpha", change_summary: "created" }, undefined, undefined);
    const read = tools.find((t) => t.name === "task_read");
    const res = await read.execute("c2", { id: "task-nope" }, undefined, undefined);
    expect(res.details.found).toBe(false);
    expect(res.content[0].text).toContain("task-a");
  });

  it("set_status dispatched with dispatched_to records the agent name (the comms identity); done clears it", async () => {
    const { pi, tools, handlers } = makeFakePi();
    tasksExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const create = tools.find((t) => t.name === "task_create");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    const read = tools.find((t) => t.name === "task_read");
    await create.execute("c1", { id: "task-x", title: "X", change_summary: "created" }, undefined, undefined);

    // dispatched_to records the agent NAME — the comms identity — with no
    // session file lookup (the name is the address, stable across restarts).
    const name = "worker-1";

    const res = await setStatus.execute(
      "c2",
      { id: "task-x", status: "dispatched", dispatched_to: name, change_summary: "dispatch" },
      undefined,
      undefined,
    );
    // a bare set_status dispatch has no dispatcher / delegation message —
    // dispatched_by and dispatch_msg_id stay ""
    expect(res.details.item.dispatched_to).toEqual({ name, dispatched_by: "", dispatch_msg_id: "" });
    expect(res.content[0].text).toContain(`dispatched to ${name}`);

    const r = await read.execute("c3", { id: "task-x" }, undefined, undefined);
    // the dispatch survives in the record — readable from the read's content
    expect(r.content[0].text).toContain(`dispatched_to: ${name}`);

    // done clears the dispatch
    const done = await setStatus.execute("c4", { id: "task-x", status: "done", change_summary: "complete" }, undefined, undefined);
    expect(done.details.item.dispatched_to).toBeNull();
    expect(done.content[0].text).toContain("undispatched");
  });

  it("set_status rejects dispatched_to on a non-dispatched status", async () => {
    const { pi, tools, handlers } = makeFakePi();
    tasksExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const create = tools.find((t) => t.name === "task_create");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    await create.execute("c1", { id: "task-x", title: "X", change_summary: "created" }, undefined, undefined);

    // dispatched_to on a non-dispatched transition is a hard error
    await expect(
      setStatus.execute("c2", { id: "task-x", status: "done", dispatched_to: "worker-1", change_summary: "x" }, undefined, undefined),
    ).rejects.toThrow(/dispatch records the agent/);
  });

  it("kind flows through create / read / update, and task_ready_set groups by it", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    const read = tools.find((t) => t.name === "task_read");
    const ready = tools.find((t) => t.name === "task_ready_set");

    // default unit; declared module
    const unit = await create.execute("c1", { id: "task-unit", title: "Unit", change_summary: "created" }, undefined, undefined);
    expect(unit.details.kind).toBe("unit");
    const mod = await create.execute("c2", { id: "task-mod", title: "Mod", kind: "module", change_summary: "created" }, undefined, undefined);
    expect(mod.details.kind).toBe("module");

    // read shows the kind line
    const r = await read.execute("c3", { id: "task-mod" }, undefined, undefined);
    expect(r.content[0].text).toContain("kind: module");

    // flip unit → module (execution revealed it decomposes)
    const flipped = await update.execute("c4", { id: "task-unit", kind: "module", change_summary: "flip" }, undefined, undefined);
    expect(flipped.details.kind).toBe("module");
    expect(flipped.content[0].text).toContain("(module");

    // units take deps too — an ordering edge, still directly executable
    await create.execute("c5", { id: "task-child", title: "Child", change_summary: "created" }, undefined, undefined);
    await create.execute("c6", { id: "task-still-unit", title: "Still unit", change_summary: "created" }, undefined, undefined);
    const linkedUnit = await update.execute("c7", { id: "task-still-unit", deps: ["task-child"], change_summary: "link" }, undefined, undefined);
    expect(linkedUnit.details.kind).toBe("unit");
    expect(linkedUnit.details.deps).toContain("task-child");
    const linked = await update.execute("c8", { id: "task-unit", deps: ["task-child"], change_summary: "link" }, undefined, undefined);
    expect(linked.details.deps).toContain("task-child");

    // ready set groups by kind — units execute, modules may need delegation
    const res = await ready.execute("c8", {}, undefined, undefined);
    expect(res.content[0].text).toContain("Ready for execution (unit):");
    expect(res.content[0].text).toContain("Ready (module — may need delegation):");
    expect(res.details.ready.map((i: any) => i.id)).toEqual(
      expect.arrayContaining(["task-mod", "task-child"]),
    );
  });

  it("task_create and task_update reject an invalid kind", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    await expect(
      create.execute("c1", { id: "task-x", title: "X", kind: "review", change_summary: "x" }, undefined, undefined),
    ).rejects.toThrow(/invalid kind "review"/);
    await create.execute("c2", { id: "task-a", title: "A", change_summary: "x" }, undefined, undefined);
    await expect(
      update.execute("c3", { id: "task-a", kind: "garbage", change_summary: "x" }, undefined, undefined),
    ).rejects.toThrow(/invalid kind "garbage"/);
  });

  it("task_read version=<n> reads the archived snapshot of a past version", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    const read = tools.find((t) => t.name === "task_read");
    await create.execute("c1", { id: "task-a", title: "Alpha", change_summary: "created" }, undefined, undefined);
    await update.execute("c2", { id: "task-a", title: "Alpha2", change_summary: "renamed" }, undefined, undefined);

    // the archived v1 snapshot: full content, no live-graph lines
    const snap = await read.execute("c3", { id: "task-a", version: 1 }, undefined, undefined);
    expect(snap.details.found).toBe(true);
    expect(snap.details.archived).toBe(true);
    // details.item is trimmed to the render fields — the full record would
    // duplicate the content text in stored messages (title lives in content)
    expect(snap.details.item).toEqual({ id: "task-a", status: "pending", version: 1 });
    expect(snap.content[0].text).toContain("ARCHIVED SNAPSHOT");
    expect(snap.content[0].text).toContain("title: Alpha");
    expect(snap.content[0].text).not.toContain("dependents:");
    expect(snap.content[0].text).not.toContain("ready:");

    // the live read shows the current version and advertises the archive
    const live = await read.execute("c4", { id: "task-a" }, undefined, undefined);
    expect(live.details.item).toEqual({ id: "task-a", status: "pending", version: 2 });
    expect(live.details.archived).toBeUndefined();
    expect(live.content[0].text).toContain("archived snapshots: v1..v1");
  });

  it("task_read version=<n> of a missing item returns found:false", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const read = tools.find((t) => t.name === "task_read");
    const res = await read.execute("c1", { id: "task-nope", version: 1 }, undefined, undefined);
    expect(res.details.found).toBe(false);
  });

  it("task_read version=<n> rejects out-of-range and invalid versions", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    const read = tools.find((t) => t.name === "task_read");
    await create.execute("c1", { id: "task-a", title: "Alpha", change_summary: "created" }, undefined, undefined);
    await update.execute("c2", { id: "task-a", title: "Alpha2", change_summary: "renamed" }, undefined, undefined);
    // version = current is refused — read the live record instead
    await expect(
      read.execute("c3", { id: "task-a", version: 2 }, undefined, undefined),
    ).rejects.toThrow(/no version 2/);
    await expect(
      read.execute("c4", { id: "task-a", version: 0 }, undefined, undefined),
    ).rejects.toThrow(/invalid version/);
  });

  it("expected_version plumbed through task_update and task_set_status (optimistic concurrency)", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const create = tools.find((t) => t.name === "task_create");
    const update = tools.find((t) => t.name === "task_update");
    const setStatus = tools.find((t) => t.name === "task_set_status");

    // the tools expose the optional expected_version parameter
    expect(update.parameters.properties.expected_version).toBeDefined();
    expect(setStatus.parameters.properties.expected_version).toBeDefined();

    await create.execute("c1", { id: "task-x", title: "X", change_summary: "created" }, undefined, undefined);
    // matching version writes
    const ok = await update.execute(
      "c2",
      { id: "task-x", title: "X2", expected_version: 1, change_summary: "renamed" },
      undefined,
      undefined,
    );
    expect(ok.details).toMatchObject({ id: "task-x", version: 2 });

    // stale version → conflict error naming both versions, nothing written
    const err = await update
      .execute("c3", { id: "task-x", title: "X3", expected_version: 1, change_summary: "renamed" }, undefined, undefined)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toContain('conflict on "task-x"');
    expect(err!.message).toContain("expected version 1, current version 2");
    const after = await update.execute(
      "c4",
      { id: "task-x", title: "X2.1", expected_version: 2, change_summary: "renamed again" },
      undefined,
      undefined,
    );
    expect(after.details.version).toBe(3);

    // set_status: matching expected_version writes; a stale one is rejected
    const done = await setStatus.execute(
      "c5",
      { id: "task-x", status: "done", expected_version: 3, change_summary: "complete" },
      undefined,
      undefined,
    );
    expect(done.details.item).toMatchObject({ status: "done", version: 4 });
    const err2 = await setStatus
      .execute("c6", { id: "task-x", status: "active", expected_version: 3, change_summary: "reopen" }, undefined, undefined)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err2).not.toBeNull();
    expect(err2!.message).toContain("expected version 3, current version 4");
    expect(err2!.message).toContain("re-read the node and retry");
  });
});
