/**
 * Unit tests for the tasks extension shell: tool registration /
 * activation / wiring into the storage layer and the graph semantics.
 *
 * @sinclair/typebox and @earendil-works/pi-tui are installed as real
 * devDependencies (aliased to the same versions pi embeds at runtime), so
 * the extension is imported directly — no mocks.
 *
 * The content is FILE-DRIVEN: no task_create / task_update. Tasks are
 * created and changed by writing DRAFTS (.pi/tasks/draft/<cname>/) and
 * committing them with task_commit. The shell tests exercise that exact
 * flow through the real tool objects.
 *
 * Run: bun test tests/tasks-shell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  "task_commit",
  "task_checkout",
  "task_set_status",
  "task_read",
  "task_list",
  "task_ready_set",
  "task_render",
];

/** The shell's commsName() falls back to "unknown" without --cname. */
const ME = "unknown";

/** Write one draft file (per-agent path under draft/<cname>/). */
function writeDraft(rel: string, content: string): void {
  const p = join(process.env.PI_TASKS_DIR!, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf-8");
}

/** Create a task through the real flow: metadata draft (+ description draft) → task_commit. */
function commitCreate(commit: any, id: string, title: string, opts: { kind?: string; deps?: string[]; info_refs?: string[]; description?: string } = {}) {
  const lines = [`id = '${id}'`, `title = '${title}'`];
  if (opts.kind) lines.push(`kind = '${opts.kind}'`);
  if (opts.deps) lines.push(`deps = [ ${opts.deps.map((d) => `'${d}'`).join(", ")} ]`);
  if (opts.info_refs) lines.push(`info_refs = [ ${opts.info_refs.map((d) => `'${d}'`).join(", ")} ]`);
  writeDraft(`draft/${ME}/${id}.toml`, lines.join("\n"));
  if (opts.description !== undefined) writeDraft(`draft/${ME}/${id}.description.md`, opts.description);
  return commit.execute("c", { id, expected_version: 1 }, undefined, undefined);
}

/** Commit a metadata patch (only the changed fields in the draft toml). */
function commitPatch(commit: any, id: string, tomlPatch: string, expected_version: number, change_summary?: string) {
  writeDraft(`draft/${ME}/${id}.toml`, tomlPatch);
  return commit.execute("c", { id, scope: "metadata", expected_version, change_summary }, undefined, undefined);
}

// ━━ extension shell (dynamically imported after the mocks) ━━━━━━━━━━━━━━━━━━

describe("tasks extension shell", () => {
  let tasksExtension: (pi: any) => void;
  beforeAll(async () => {
    const mod = await import("../extensions/task-graph.ts");
    tasksExtension = mod.default;
  });

  it("registers the task tools", () => {
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

  it("draft → commit → set_status chain: parent unlocks when deps complete, audits land", async () => {
    const { pi, tools, entries } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    const read = tools.find((t) => t.name === "task_read");
    const ready = tools.find((t) => t.name === "task_ready_set");

    // children first, then the parent linking them (deps must exist)
    await commitCreate(commit, "task-jwt", "JWT auth");
    await commitCreate(commit, "task-secrets", "Secrets store");
    const parent = await commitCreate(commit, "task-auth", "Auth module", {
      kind: "module",
      deps: ["task-jwt", "task-secrets"],
    });
    expect(parent.details).toMatchObject({
      id: "task-auth",
      deps: ["task-jwt", "task-secrets"],
      version: 1,
      created: true,
      changed_items: ["created"],
    });
    expect(parent.content[0].text).toContain('task_commit: "task-auth" created v1');
    // a dependent of the parent — becomes unlocked only when the parent is done
    await commitCreate(commit, "task-session", "Session bootstrap", { kind: "module", deps: ["task-auth"] });

    // metadata patch: re-title the parent, version bumps (title is a content field)
    const upd = await commitPatch(commit, "task-auth", "title = 'Auth module v2'", 1, "renamed");
    expect(upd.details).toMatchObject({ id: "task-auth", version: 2, changed_items: ["title"] });
    expect(upd.content[0].text).toContain('task_commit: "task-auth" → v2');

    // the parent cannot be marked done before its deps — the store rejects it
    await expect(
      setStatus.execute("c6", { id: "task-auth", status: "done", change_summary: "too early" }, undefined, undefined),
    ).rejects.toThrow(/deps not satisfied/);

    // first child done — the parent is still missing its second dep
    const s1 = await setStatus.execute("c7", { id: "task-jwt", status: "done", change_summary: "implemented" }, undefined, undefined);
    expect(s1.details).toMatchObject({ id: "task-jwt", status: "done" });

    // second child done — the parent's last dep is satisfied: it is unlocked
    const s2 = await setStatus.execute("c8", { id: "task-secrets", status: "done", change_summary: "implemented" }, undefined, undefined);
    expect(s2.details.unlocked).toContain("task-auth");
    expect(s2.content[0].text).toContain("[Task Update] task-secrets done");
    expect(s2.content[0].text).toContain("Read: task_read(id=\"task-secrets\")");

    // the manager marks the parent done (its deps are now satisfied) — that
    // newly unlocks task-session. Lifecycle events do NOT bump the version.
    const s3 = await setStatus.execute("c9", { id: "task-auth", status: "done", change_summary: "parent complete" }, undefined, undefined);
    expect(s3.details.item.status).toBe("done");
    expect(s3.details.version).toBe(2); // unchanged by lifecycle
    expect(s3.details.unlocked).toContain("task-session");

    // the parent reads as done, with its dependent listed
    const r = await read.execute("c10", { id: "task-auth" }, undefined, undefined);
    expect(r.details.found).toBe(true);
    expect(r.details.item.status).toBe("done");
    expect(r.details.dependents).toContain("task-session");
    expect(r.details.ready).toBe(false); // task-auth is done, not pending — not dispatchable
    const readyRes = await ready.execute("c11", {}, undefined, undefined);
    expect(readyRes.details.ready.map((i: any) => i.id)).toContain("task-session");

    // audit: writes land on the tasks-log channel, with unlocked
    const events = entries.filter((e) => e.channel === "tasks-log").map((e) => e.entry);
    expect(events.filter((e) => e.event === "task_commit")).toHaveLength(5);
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
    const commit = tools.find((t) => t.name === "task_commit");
    await commitCreate(commit, "task-a", "A");
    writeDraft(`draft/${ME}/task-b.toml`, "id = 'task-b'\ntitle = 'B'\ndeps = [ 'nope' ]");
    await expect(commit.execute("c2", { id: "task-b", expected_version: 1 }, undefined, undefined)).rejects.toThrow(
      /dep "nope" does not exist.*available tasks: task-a/,
    );
  });

  it("rejects a commit that would create a cycle, with the cycle path", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    await commitCreate(commit, "task-a", "A");
    await commitCreate(commit, "task-b", "B", { kind: "module", deps: ["task-a"] });
    // rewire a → b (b already depends on a → cycle)
    writeDraft(`draft/${ME}/task-a.toml`, "deps = [ 'task-b' ]");
    await expect(
      commit.execute("c3", { id: "task-a", scope: "metadata", expected_version: 1 }, undefined, undefined),
    ).rejects.toThrow(/cycle/);
  });

  it("task_ready_set reports the ready set, missing deps and progress", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const ready = tools.find((t) => t.name === "task_ready_set");

    await commitCreate(commit, "task-base", "Base");
    await commitCreate(commit, "task-child", "Child", { kind: "module", deps: ["task-base"] });
    await commitCreate(commit, "task-root", "Root", { kind: "module", deps: ["task-child"] });

    const res = await ready.execute("c1", {}, undefined, undefined);
    expect(res.details.ready.map((i: any) => i.id)).toEqual(["task-base"]);
    expect(res.details.notReady.map((x: any) => x.item.id).sort()).toEqual(["task-child", "task-root"]);
    expect(res.details.progress).toMatchObject({ done: 0, total: 3, pending: 3, ready: 1 });
  });

  it("task_ready_set for=<id> scopes to the item and its dependency closure", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const ready = tools.find((t) => t.name === "task_ready_set");

    await commitCreate(commit, "task-base", "Base");
    await commitCreate(commit, "task-child", "Child", { kind: "module", deps: ["task-base"] });
    await commitCreate(commit, "task-other", "Other");

    const res = await ready.execute("c1", { for: "task-child" }, undefined, undefined);
    expect(res.details.ready.map((i: any) => i.id)).toEqual(["task-base"]);
    expect(res.details.progress.total).toBe(2); // task-child + its closure; task-other excluded
  });

  it("task_ready_set for=<id> rejects an unknown id", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const ready = tools.find((t) => t.name === "task_ready_set");
    await expect(ready.execute("c1", { for: "ghost" }, undefined, undefined)).rejects.toThrow(/not found/);
  });

  it("task_list renders the table with warnings; task_render renders the graph", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const list = tools.find((t) => t.name === "task_list");
    const render = tools.find((t) => t.name === "task_render");

    await commitCreate(commit, "task-a", "A");
    const l = await list.execute("c1", {}, undefined, undefined);
    expect(l.details.count).toBe(1);
    expect(l.content[0].text).toContain("task-a");
    const g = await render.execute("c2", {}, undefined, undefined);
    expect(g.details.count).toBe(1);
    expect(g.content[0].text).toContain("task-a");
  });

  it("task_read of a missing item returns found:false", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const read = tools.find((t) => t.name === "task_read");
    const res = await read.execute("c1", { id: "ghost" }, undefined, undefined);
    expect(res.details).toMatchObject({ id: "ghost", found: false });
  });

  it("set_status dispatched with dispatched_to records the agent name (the comms identity); done clears it", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    await commitCreate(commit, "task-x", "X");

    const d = await setStatus.execute(
      "c1",
      { id: "task-x", status: "dispatched", dispatched_to: "researcher-1", change_summary: "dispatch" },
      undefined,
      undefined,
    );
    expect(d.details.item.dispatched_to?.name).toBe("researcher-1");
    expect(d.content[0].text).toContain("dispatched to researcher-1");
    expect(d.details.version).toBe(1); // lifecycle does not bump

    const done = await setStatus.execute("c2", { id: "task-x", status: "done", change_summary: "done" }, undefined, undefined);
    expect(done.details.item.dispatched_to).toBeNull();
    expect(done.details.version).toBe(1);
  });

  it("set_status rejects dispatched_to on a non-dispatched status", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const setStatus = tools.find((t) => t.name === "task_set_status");
    await commitCreate(commit, "task-x", "X");
    await expect(
      setStatus.execute("c1", { id: "task-x", status: "active", dispatched_to: "researcher-1" }, undefined, undefined),
    ).rejects.toThrow(/set status to "dispatched"/);
  });

  it("kind flows through commit / read, and task_ready_set groups by it", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");
    const ready = tools.find((t) => t.name === "task_ready_set");

    await commitCreate(commit, "task-u", "Unit task");
    await commitCreate(commit, "task-m", "Module task", { kind: "module" });

    const r = await read.execute("c1", { id: "task-m" }, undefined, undefined);
    expect(r.details.item.status).toBe("pending");
    const rr = await ready.execute("c2", {}, undefined, undefined);
    expect(rr.details.ready.map((i: any) => i.id).sort()).toEqual(["task-m", "task-u"]);
    // grouped by kind in the rendered buckets
    expect(rr.content[0].text).toMatch(/Ready for execution \(unit\):[\s\S]*task-u/);
    expect(rr.content[0].text).toMatch(/Ready \(module — delegate to sub-Coordinator\):[\s\S]*task-m/);
  });

  it("commit rejects an invalid kind from the draft", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    writeDraft(`draft/${ME}/task-k.toml`, "id = 'task-k'\ntitle = 'K'\nkind = 'bogus'");
    await expect(commit.execute("c1", { id: "task-k", expected_version: 1 }, undefined, undefined)).rejects.toThrow(/invalid kind/);
  });

  it("task_read version=<n> reads the archived snapshot of a past version", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");

    await commitCreate(commit, "task-v", "V", { description: "first body" });
    // description change → v2 (archives v1)
    writeDraft(`draft/${ME}/task-v.description.md`, "second body");
    await commit.execute("c2", { id: "task-v", scope: "description", expected_version: 1, change_summary: "revise" }, undefined, undefined);

    const snap = await read.execute("c3", { id: "task-v", version: 1, fields: "description" }, undefined, undefined);
    expect(snap.details.archived).toBe(true);
    expect(snap.content[0].text).toContain("ARCHIVED SNAPSHOT");
    expect(snap.content[0].text).toContain("first body");
  });

  it("task_read version=<n> of a missing item returns found:false", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const read = tools.find((t) => t.name === "task_read");
    const res = await read.execute("c1", { id: "ghost", version: 1 }, undefined, undefined);
    expect(res.details).toMatchObject({ id: "ghost", found: false });
  });

  it("task_read version=<n> rejects out-of-range and invalid versions", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");
    await commitCreate(commit, "task-v", "V");
    await expect(read.execute("c1", { id: "task-v", version: 5 }, undefined, undefined)).rejects.toThrow(/at version 1/);
    await expect(read.execute("c2", { id: "task-v", version: 0 }, undefined, undefined)).rejects.toThrow(/positive integers/);
  });

  it("task_commit enforces expected_version: stale rejects, no-op rejects", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    await commitCreate(commit, "task-e", "E");

    // description commit → v2
    writeDraft(`draft/${ME}/task-e.description.md`, "v2 body");
    await commit.execute("c2", { id: "task-e", scope: "description", expected_version: 1 }, undefined, undefined);

    // stale expected_version rejected with both versions
    writeDraft(`draft/${ME}/task-e.description.md`, "stale edit");
    await expect(
      commit.execute("c3", { id: "task-e", scope: "description", expected_version: 1 }, undefined, undefined),
    ).rejects.toThrow(/expected version 1, current version 2/);

    // no-op (identical draft) rejected
    writeDraft(`draft/${ME}/task-e.description.md`, "v2 body");
    await expect(
      commit.execute("c4", { id: "task-e", scope: "description", expected_version: 2 }, undefined, undefined),
    ).rejects.toThrow(/NOTHING was committed and your draft files were NOT deleted/);

    // missing expected_version on an existing task rejected (conflict — the parameter is mandatory)
    writeDraft(`draft/${ME}/task-e.description.md`, "v3 body");
    await expect(
      commit.execute("c5", { id: "task-e", scope: "description" }, undefined, undefined),
    ).rejects.toThrow(/expected version/);
  });

  it("task_checkout copies the true description (scope=description) / creates an empty scaffold (scope=report)", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const draft = tools.find((t) => t.name === "task_checkout");

    await commitCreate(commit, "task-d", "D", { description: "the true body" });

    // description: copy the true body, frontmatter STRIPPED (commit re-adds it)
    const dd = await draft.execute("c1", { id: "task-d", scope: "description" }, undefined, undefined);
    expect(dd.details.draft).toContain("draft/unknown/task-d.description.md");
    expect(dd.details.version).toBe(1);
    expect(dd.details.source).toBeUndefined(); // no true-copy path leak
    expect(dd.details.chars).toBeGreaterThan(0);
    // the draft body is frontmatter-free
    expect(readFileSync(join(tmp, "draft", ME, "task-d.description.md"), "utf-8")).toBe("the true body");
    // re-checkout with IDENTICAL content succeeds as a no-op (draft already matches)
    const dd2 = await draft.execute("c2", { id: "task-d" }, undefined, undefined);
    expect(dd2.details.draft).toContain("draft/unknown/task-d.description.md");
    expect(dd2.details.version).toBe(1);

    // re-checkout with DIFFERING content is rejected — hint to read the previous version
    writeFileSync(join(tmp, "draft", ME, "task-d.description.md"), "---\nversion: 1\n---\n\ndiverged edit", "utf-8");
    await expect(draft.execute("c3", { id: "task-d" }, undefined, undefined)).rejects.toThrow(/differs from the current content/);

    // report: an EMPTY scaffold (no frontmatter — commit adds the for_version anchor); no old report copied
    const dr = await draft.execute("c4", { id: "task-d", scope: "report" }, undefined, undefined);
    expect(dr.details.draft).toContain("draft/unknown/task-d.report.md");
    const scaffold = readFileSync(join(tmp, "draft", ME, "task-d.report.md"), "utf-8");
    expect(scaffold).toBe("");
  });

  it("task_checkout version=0 scaffolds the creation drafts for a NEW task (then task_commit expected_version=1 creates it)", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const draft = tools.find((t) => t.name === "task_checkout");

    // checkout a brand-new id with version=0 → scaffolds the metadata draft (id) + empty description draft
    const sc = await draft.execute("c1", { id: "task-new", version: 0 }, undefined, undefined);
    expect(sc.details.creating).toBe(true);
    expect(sc.details.version).toBe(0);
    expect(sc.details.draft).toContain("draft/unknown/task-new.toml");
    expect(sc.details.draft).toContain("draft/unknown/task-new.description.md");
    expect(readFileSync(join(tmp, "draft", ME, "task-new.description.md"), "utf-8")).toBe("");
    const meta = readFileSync(join(tmp, "draft", ME, "task-new.toml"), "utf-8");
    expect(meta).toContain('id = "task-new"');

    // fill both and create with expected_version=1
    writeFileSync(join(tmp, "draft", ME, "task-new.toml"), `id = 'task-new'\ntitle = 'New'\n`, "utf-8");
    writeFileSync(join(tmp, "draft", ME, "task-new.description.md"), "the requirement", "utf-8");
    await commit.execute("c2", { id: "task-new", expected_version: 1 }, undefined, undefined);

    // the id now exists — checkout without version reads the CURRENT body
    const cur = await draft.execute("c3", { id: "task-new" }, undefined, undefined);
    expect(cur.details.creating).toBe(false);
    expect(cur.details.version).toBe(1);
    expect(readFileSync(join(tmp, "draft", ME, "task-new.description.md"), "utf-8")).toBe("the requirement");

    // a new id with a NON-zero version is rejected (version=0 is required to create)
    await expect(draft.execute("c4", { id: "task-other", version: 3 }, undefined, undefined)).rejects.toThrow(/does not exist yet/);
  });

  it("task_checkout version=<n> checks out a HISTORICAL description snapshot", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const draft = tools.find((t) => t.name === "task_checkout");

    await commitCreate(commit, "task-h", "H", { description: "v1 body" });
    // advance to v2 (edit the description via a fresh checkout + commit)
    await draft.execute("c1", { id: "task-h" }, undefined, undefined);
    writeFileSync(join(tmp, "draft", ME, "task-h.description.md"), "v2 body", "utf-8");
    await commit.execute("c2", { id: "task-h", scope: "description", expected_version: 1 }, undefined, undefined);

    // checkout v1 → the archived body lands in the draft
    const hist = await draft.execute("c3", { id: "task-h", version: 1 }, undefined, undefined);
    expect(hist.details.version).toBe(1);
    expect(readFileSync(join(tmp, "draft", ME, "task-h.description.md"), "utf-8")).toBe("v1 body");
    // checkout v2 (current) → live body (clear the diverged draft first)
    rmSync(join(tmp, "draft", ME, "task-h.description.md"));
    await draft.execute("c4", { id: "task-h", version: 2 }, undefined, undefined);
    expect(readFileSync(join(tmp, "draft", ME, "task-h.description.md"), "utf-8")).toBe("v2 body");
  });

  it("task_read never leaks file paths (true copies stay internal) and surfaces integrity warnings", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");
    await commitCreate(commit, "task-f", "F", { description: "body" });

    const res = await read.execute("c1", { id: "task-f" }, undefined, undefined);
    // no true-copy / draft file locations leak to the model
    expect(res.content[0].text).not.toContain("description file:");
    expect(res.content[0].text).not.toContain("report file:");
    expect(res.content[0].text).not.toContain(".description.md");
    expect(res.content[0].text).not.toContain(".report.md");
    expect(res.content[0].text).not.toContain("snapshot files");
    expect(res.content[0].text).not.toContain("history/");
    expect(res.content[0].text).toContain("description (v1)");
    expect(res.content[0].text).toContain("completion report (for description v1");

    // tamper with the true description → integrity warning surfaces on read
    writeFileSync(join(tmp, "task-f.description.md"), "---\nversion: 1\n---\n\ntampered", "utf-8");
    const res2 = await read.execute("c2", { id: "task-f" }, undefined, undefined);
    expect(res2.details.integrity_warnings.length).toBe(1);
    expect(res2.content[0].text).toContain("⚠ integrity: task-f.description.md hash mismatch");
  });

  it("surfaces a note when sanitizeTaskId rewrites the supplied id", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");

    // creation with a non-kebab id → normalized to kebab-case, noted in the result
    writeDraft(`draft/${ME}/task-a.toml`, "id = 'Task A!'\ntitle = 'Task A'");
    const created = await commit.execute("c1", { id: "Task A!", expected_version: 1 }, undefined, undefined);
    expect(created.details.id).toBe("task-a");
    expect(created.content[0].text).toContain('id "Task A!" was normalized to "task-a"');

    // a clean id produces no note
    const clean = await read.execute("c2", { id: "task-a" }, undefined, undefined);
    expect(clean.content[0].text).not.toContain("was normalized");

    // a non-kebab id on read also surfaces the note
    const dirty = await read.execute("c3", { id: "Task A!" }, undefined, undefined);
    expect(dirty.details.item.id).toBe("task-a");
    expect(dirty.content[0].text).toContain('id "Task A!" was normalized to "task-a"');
  });

  it("shared info (kind=info) is injected into a task's description at read time", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");

    await commitCreate(commit, "site-audit-common", "Common audit requirements", {
      kind: "info",
      description: "COMMON: check https, headers, robots.txt for any site",
    });
    const site = await commitCreate(commit, "site-100", "Audit site 100", {
      info_refs: ["site-audit-common"],
      description: "SITE-100 only: paid plan",
    });
    expect(site.details.info_refs).toEqual(["site-audit-common"]);

    // reading the task's description injects the shared content + own body
    const r = await read.execute("c4", { id: "site-100", fields: "description" }, undefined, undefined);
    const desc = r.content[0].text;
    expect(desc).toContain("COMMON: check https, headers, robots.txt");
    expect(desc).toContain("SITE-100 only: paid plan");
    // the shared info node is listed in the metadata graph context
    expect(desc).toContain("info_refs: site-audit-common");

    // the info node itself lists no lifecycle/ready semantics
    const info = await read.execute("c5", { id: "site-audit-common" }, undefined, undefined);
    expect(info.content[0].text).toContain("ready: none — shared information");
  });

  it("info node never becomes ready (not dispatchable), excluded from ready set", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const ready = tools.find((t) => t.name === "task_ready_set");

    await commitCreate(commit, "site-audit-common", "Common", { kind: "info" });
    await commitCreate(commit, "site-100", "Audit 100");
    const r = await ready.execute("c6", {}, undefined, undefined);
    const text = r.content[0].text;
    // only the real task is ready; the shared info node is never dispatchable
    expect(text).toContain("site-100");
    expect(text).not.toContain("site-audit-common");
  });

  it("task_read surfaces the subgraph-changed soft signal after wiring, without bumping content version", async () => {
    const { pi, tools } = makeFakePi();
    tasksExtension(pi);
    const commit = tools.find((t) => t.name === "task_commit");
    const read = tools.find((t) => t.name === "task_read");
    await commitCreate(commit, "task-mod", "Module", { kind: "module" });

    // wire a child into the module via into_deps
    writeDraft(`draft/${ME}/task-sub.toml`, `id = 'task-sub'\ntitle = 'Sub'\ninto_deps = [ 'task-mod' ]`);
    await commit.execute("c", { id: "task-sub", expected_version: 1 }, undefined, undefined);

    const r = await read.execute("c", { id: "task-mod" }, undefined, undefined);
    expect(r.details.item.version).toBe(1); // content version unchanged by wiring
    expect(r.content[0].text).toContain("subgraph changed (struct v2)");
    expect(r.content[0].text).toContain("task-sub"); // the wired child appears in the parent's deps
  });
});
