/**
 * Unit tests for the task-comms-ops extension shell: tool registration /
 * activation / the task_start worker path (identity via the comms runtime,
 * dispatched→active, dispatcher notification).
 *
 * @sinclair/typebox and @earendil-works/pi-tui are installed as real
 * devDependencies (aliased to the same versions pi embeds at runtime), so
 * the extension is imported directly — no mocks.
 * The fake pi additionally exposes an events bus so tests can emit the
 * COMMS_RUNTIME_EVENT with a stubbed runtime (identity + messaging.send,
 * recording every send) — the extension's comms access goes through that
 * handle, exactly like the real comms.ts extension publishes it.
 *
 * Run: bun test tests/task-comms-ops-shell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_RUNTIME_EVENT } from "../extensions/lib/comms/runtime";
import { createTask, readTask, setTaskStatus } from "../extensions/lib/tasks/store";

// ━━ helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let tmp: string;
let CWD: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "task-comms-ops-shell-test-"));
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
    // the sanctioned inter-extension channel: comms emits the runtime
    // handle on COMMS_RUNTIME_EVENT; the extension subscribes at factory time.
    events: {
      on: (evt: string, cb: (...a: any[]) => any) => {
        handlers[`events:${evt}`] = cb;
      },
      emit: (evt: string, payload: unknown) => {
        handlers[`events:${evt}`]?.(payload);
      },
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

/** A stubbed comms runtime: identity + messaging.send recording every send,
 *  and updateProfile recording every profile patch. */
function makeRuntime(
  agentName: string,
  sent: Array<{ target: string; body: string; opts: any }>,
  profiles: Array<{ current_task?: string | undefined }> = [],
) {
  return {
    identity: {
      name: agentName,
      subnet: "test",
      cwd: CWD,
      model: "test",
      started_at: new Date().toISOString(),
    },
    messaging: {
      send: async (_identity: unknown, target: string, body: string, opts: any) => {
        sent.push({ target, body, opts });
        return {
          msg_id: "msg-1234567890abcdef",
          target_status: "online" as const,
        };
      },
    },
    updateProfile: async (patch: { current_task?: string | undefined }) => {
      profiles.push(patch);
      return { current_task: patch.current_task };
    },
  };
}

const ALL_TOOLS = [
  "task_dispatch",
  "task_start",
  "task_submit_report",
  "task_complete",
  "task_block",
  "task_cancel",
];

// ━━ extension shell (dynamically imported after the mocks) ━━━━━━━━━━━━━━━━━━

describe("task-comms-ops extension shell", () => {
  let opsExtension: (pi: any) => void;
  beforeAll(async () => {
    const mod = await import("../extensions/task-comms-ops.ts");
    opsExtension = mod.default;
  });

  it("registers the six task tools", () => {
    const { pi, tools } = makeFakePi();
    opsExtension(pi);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(ALL_TOOLS));
  });

  it("activates the tools on session_start", async () => {
    const { pi, handlers, active } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    expect(active()).toEqual(expect.arrayContaining(ALL_TOOLS));
  });

  it("task_start moves an dispatched item to active and notifies the dispatcher", async () => {
    const { pi, tools, handlers, entries } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const dispatch = tools.find((t) => t.name === "task_dispatch");
    const start = tools.find((t) => t.name === "task_start");

    createTask(CWD, { id: "task-x", title: "X" }); // task creation is task-graph's job

    // the manager dispatches to worker-1 (identity = manager-1)
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("manager-1", sent));
    await dispatch.execute("c2", { task_id: "task-x", agent: "worker-1", message: "go" }, undefined, undefined);
    expect(sent).toHaveLength(1); // the delegation message
    expect(sent[0].target).toBe("worker-1");

    // the worker declares the start (identity = worker-1 — re-emit replaces the handle)
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-1", sent));
    const res = await start.execute(
      "c3",
      { id: "task-x" },
      undefined,
      undefined,
      // ctx: the worker's own pi session — recorded on the node as
      // execution_session so the manager can open the transcript later
      {
        sessionManager: {
          getSessionId: () => "01J0Z1WXYZ-9abc",
          getSessionFile: () => join(CWD, ".pi", "agent-sessions", "worker-1.json"),
        },
      },
    );
    expect(res.details.status).toBe("active");
    expect(res.content[0].text).toContain("→ active");
    expect(res.content[0].text).toContain("session: 01J0Z1WXYZ-9abc");
    expect(res.details.item.dispatched_to).toEqual({
      name: "worker-1",

      dispatched_by: "manager-1",
      dispatch_msg_id: "msg-1234567890abcdef",
    });
    expect(res.details.item.execution_session).toEqual({
      session_id: "01J0Z1WXYZ-9abc",
      session_file: ".pi/agent-sessions/worker-1.json",
    });
    // the dispatcher was notified with a one-line message that work has begun
    expect(sent).toHaveLength(2);
    expect(sent[1].target).toBe("manager-1");
    expect(sent[1].body).toBe("worker-1 begin to work on task task-x dispatched by you");
    // audit lands on the task-comms-ops channel
    expect(
      entries.some(
        (e) =>
          e.channel === "task-comms-ops-log" &&
          e.entry.event === "task_start" &&
          e.entry.item_id === "task-x",
      ),
    ).toBe(true);

    // already active → only dispatched items can be started
    await expect(start.execute("c4", { id: "task-x" }, undefined, undefined)).rejects.toThrow(/only dispatched items/);
  });

  it("task_start refuses a worker that is not the dispatchee", async () => {
    const { pi, tools, handlers } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const dispatch = tools.find((t) => t.name === "task_dispatch");
    const start = tools.find((t) => t.name === "task_start");

    createTask(CWD, { id: "task-x", title: "X" });

    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("manager-1", sent));
    await dispatch.execute("c2", { task_id: "task-x", agent: "worker-1", message: "go" }, undefined, undefined);

    // a different worker (worker-2) cannot start an item dispatched to worker-1
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-2", sent));
    await expect(start.execute("c3", { id: "task-x" }, undefined, undefined)).rejects.toThrow(/dispatched to worker-1/);

    // nothing was sent on the failed attempt — the dispatcher is not notified
    expect(sent).toHaveLength(1);
  });

  it("task_submit_report writes the record and replies to the dispatch message", async () => {
    const { pi, tools, handlers, entries } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const dispatch = tools.find((t) => t.name === "task_dispatch");
    const reportCompletion = tools.find((t) => t.name === "task_submit_report");

    const dispatchMsgId = "msg-1234567890abcdef";
    createTask(CWD, { id: "task-x", title: "X" });

    // the manager dispatches to worker-1 (identity = manager-1)
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("manager-1", sent));
    await dispatch.execute("c2", { task_id: "task-x", agent: "worker-1", message: "go" }, undefined, undefined);

    // the worker writes its record — the reply to the dispatch message is
    // automatic (the msg_id lives on the dispatch, no parameter needed)
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-1", sent));
    const res = await reportCompletion.execute(
      "c3",
      { id: "task-x", report: "Implemented.\nDeviation: the API returned camelCase." },
      undefined,
      undefined,
    );
    // record persisted (multiline), version bumped
    expect(res.details.item.completion_report).toBe("Implemented.\nDeviation: the API returned camelCase.");
    expect(res.details.version).toBe(3); // create v1 → dispatch v2 → report v3
    expect(readTask(CWD, "task-x")!.completion_report).toBe("Implemented.\nDeviation: the API returned camelCase.");
    // the reply: to the dispatcher, marked as a reply to the dispatch message,
    // fire-and-forget (remindMs 0)
    expect(sent).toHaveLength(2);
    expect(sent[1].target).toBe("manager-1");
    expect(sent[1].opts.replyToMsgId).toBe(dispatchMsgId);
    expect(sent[1].opts.remindMs).toBe(0);
    expect(sent[1].body).toBe("worker-1 finished task task-x");
    // audit lands on the task-comms-ops channel with the reply recorded
    expect(
      entries.some(
        (e) =>
          e.channel === "task-comms-ops-log" &&
          e.entry.event === "task_submit_report" &&
          e.entry.item_id === "task-x" &&
          e.entry.replied_to === "manager-1",
      ),
    ).toBe(true);
  });

  it("task_submit_report writes the record without replying on a bare dispatch (no delegation message)", async () => {
    const { pi, tools, handlers } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const reportCompletion = tools.find((t) => t.name === "task_submit_report");

    createTask(CWD, { id: "task-x", title: "X" });
    // a bare set_status dispatch: no dispatcher, no delegation message —
    // there is nothing to reply to
    setTaskStatus(CWD, "task-x", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "", dispatch_msg_id: "" },
    });

    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-1", sent));
    const res = await reportCompletion.execute(
      "c3",
      { id: "task-x", report: "Done." },
      undefined,
      undefined,
    );
    expect(res.details.item.completion_report).toBe("Done.");
    expect(res.details.replied_to).toBeNull();
    // nothing was sent — no delegation message to reply to
    expect(sent).toHaveLength(0);
  });

  it("task_submit_report refuses a worker that is not the dispatchee", async () => {
    const { pi, tools, handlers } = makeFakePi();
    opsExtension(pi);
    await handlers["session_start"]({}, { cwd: CWD });
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const dispatch = tools.find((t) => t.name === "task_dispatch");
    const reportCompletion = tools.find((t) => t.name === "task_submit_report");

    createTask(CWD, { id: "task-x", title: "X" });

    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("manager-1", sent));
    await dispatch.execute("c2", { task_id: "task-x", agent: "worker-1", message: "go" }, undefined, undefined);

    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-2", sent));
    await expect(
      reportCompletion.execute("c3", { id: "task-x", report: "hijack" }, undefined, undefined),
    ).rejects.toThrow(/dispatched to worker-1/);

    // nothing written, nothing sent
    expect(readTask(CWD, "task-x")!.completion_report).toBeNull();
    expect(sent).toHaveLength(1);
  });

  // =========================================================================
  // current_task auto-tracking (comms profile — the session display name is
  // driven by comms.updateProfile, see lib/comms/session-name)
  // =========================================================================

  it("auto-tracks current_task on the comms profile — set on start, cleared on submit_report", async () => {
    const { pi, tools, handlers } = makeFakePi();
    opsExtension(pi);
    const sent: Array<{ target: string; body: string; opts: any }> = [];
    const profiles: Array<{ current_task?: string | undefined }> = [];
    handlers[`events:${COMMS_RUNTIME_EVENT}`](makeRuntime("worker-1", sent, profiles));
    await handlers["session_start"]({}, { cwd: CWD });

    createTask(CWD, { id: "task-x", title: "Implement auth" });
    setTaskStatus(CWD, "task-x", "dispatched", {
      dispatched_to: { name: "worker-1", dispatched_by: "manager-1", dispatch_msg_id: "" },
    });

    // task_start pushes the task title to the profile (same implementation
    // as comms_update_profile — peers see what the worker is doing, and
    // comms drives the session display name from it)
    const start = tools.find((t) => t.name === "task_start");
    await start.execute("c1", { id: "task-x" }, undefined, undefined);
    expect(profiles).toEqual([{ current_task: "Implement auth" }]);

    // task_submit_report clears it — the worker is idle again (the display
    // name falls back to the bare agent name on comms' side)
    const submit = tools.find((t) => t.name === "task_submit_report");
    await submit.execute("c2", { id: "task-x", report: "done" }, undefined, undefined);
    expect(profiles).toEqual([{ current_task: "Implement auth" }, { current_task: undefined }]);
  });
});
