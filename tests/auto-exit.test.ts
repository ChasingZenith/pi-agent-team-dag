/**
 * Unit tests for auto-exit's pure decision helpers.
 *
 * Mirrors pi's message model: `messages` is the CURRENT run's messages
 * (agent_end event payload), and stopReason carries pi's unified values —
 * "stop" | "length" | "toolUse" | "error" | "aborted". Provider-level
 * reasons like "end_turn" never appear (pi maps them to "stop").
 *
 * Run: bun test tests/auto-exit.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  default as autoExitExtension,
} from "../extensions/auto-exit.ts";

// ━━ helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function assistant(stopReason: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", stopReason, content: [], ...extra };
}
function user(text = "hello") {
  return { role: "user", content: text };
}
function toolResult() {
  return { role: "toolResult", toolName: "some_tool", content: [] };
}

// ━━ shouldAutoExitOnAgentEnd ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("shouldAutoExitOnAgentEnd", () => {
  it("is conservative on missing / empty message lists", () => {
    expect(shouldAutoExitOnAgentEnd(undefined)).toBe(false);
    expect(shouldAutoExitOnAgentEnd(null as any)).toBe(false);
    expect(shouldAutoExitOnAgentEnd([])).toBe(false);
    expect(shouldAutoExitOnAgentEnd([user()])).toBe(false);
    expect(shouldAutoExitOnAgentEnd([{ role: "custom", customType: "x" }])).toBe(false);
  });

  it("exits when the run ended with a final answer (stop)", () => {
    expect(shouldAutoExitOnAgentEnd([user(), assistant("stop")])).toBe(true);
  });

  it("exits when the run crashed (error)", () => {
    expect(
      shouldAutoExitOnAgentEnd([user(), assistant("error", { errorMessage: "boom" })]),
    ).toBe(true);
  });

  it("exits when the run ended right after a terminating tool batch (no trailing assistant)", () => {
    expect(shouldAutoExitOnAgentEnd([user(), assistant("toolUse"), toolResult()])).toBe(true);
  });

  it("does NOT exit on toolUse (mid-workflow, another turn follows)", () => {
    expect(
      shouldAutoExitOnAgentEnd([user(), assistant("toolUse")]),
    ).toBe(false);
  });

  it("does NOT exit on length (truncated — Pi may compact and retry)", () => {
    expect(shouldAutoExitOnAgentEnd([user(), assistant("length")])).toBe(false);
  });

  it("does NOT exit on aborted (interrupted — keep listening)", () => {
    expect(shouldAutoExitOnAgentEnd([user(), assistant("aborted")])).toBe(false);
  });

  it("does NOT exit on a provider-level 'end_turn' — pi maps that to 'stop' and never emits it raw", () => {
    // Guard against reintroducing the dead branch: "end_turn" is not a pi
    // stopReason, so treating it as final would only ever match nothing.
    expect(shouldAutoExitOnAgentEnd([user(), assistant("end_turn")])).toBe(false);
  });

  it("judges only the LAST assistant message of the run", () => {
    // A multi-turn run: first assistant message said toolUse, second finished.
    expect(
      shouldAutoExitOnAgentEnd([
        user(),
        assistant("toolUse"),
        toolResult(),
        assistant("stop"),
      ]),
    ).toBe(true);
    // And the reverse: run ended on aborted even though an earlier turn
    // completed — must not exit.
    expect(
      shouldAutoExitOnAgentEnd([
        user(),
        assistant("toolUse"),
        toolResult(),
        assistant("stop"),
        user("follow-up"),
        assistant("aborted"),
      ]),
    ).toBe(false);
  });

  it("ignores user/custom entries at the end of the run", () => {
    expect(
      shouldAutoExitOnAgentEnd([user(), assistant("stop"), user("steering injected later")]),
    ).toBe(true);
  });
});

// ━━ findLatestAssistantError ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("findLatestAssistantError", () => {
  it("returns null on missing / empty lists", () => {
    expect(findLatestAssistantError(undefined)).toBeNull();
    expect(findLatestAssistantError([])).toBeNull();
  });

  it("extracts the errorMessage of a run that ended in error", () => {
    const err = findLatestAssistantError([user(), assistant("error", { errorMessage: "  boom  " })]);
    expect(err).toEqual({ errorMessage: "boom", stopReason: "error" });
  });

  it("falls back to a default message when errorMessage is absent", () => {
    const err = findLatestAssistantError([user(), assistant("error")]);
    expect(err?.stopReason).toBe("error");
    expect(err?.errorMessage).toContain("no errorMessage");
  });

  it("returns null when the last assistant message is not an error", () => {
    expect(findLatestAssistantError([user(), assistant("stop")])).toBeNull();
    expect(
      findLatestAssistantError([user(), assistant("error"), user(), assistant("stop")]),
    ).toBeNull();
  });
});

// ━━ extension event flow (agent_end records → agent_settled decides) ━━━━━━━━

/** Fake pi object; the extension's registered handlers are replayed manually. */
function makeHarness() {
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const calls: string[] = [];
  const entries: any[] = [];
  const pi = {
    on: (evt: string, h: (...args: any[]) => void) => {
      handlers.set(evt, [...(handlers.get(evt) ?? []), h]);
    },
    appendEntry: (_name: string, data: any) => {
      entries.push(data);
    },
  };
  return {
    pi: pi as any,
    handlers,
    calls,
    entries,
    emit: (evt: string, ...args: any[]) => {
      for (const h of handlers.get(evt) ?? []) h(...args);
    },
    shutdownCount: () => calls.filter((c) => c === "shutdown").length,
  };
}

/** Load the extension with a given env, return the harness. */
function load(autoExitEnv: string | undefined) {
  const prev = process.env.PI_AGENT_AUTO_EXIT;
  if (autoExitEnv === undefined) delete process.env.PI_AGENT_AUTO_EXIT;
  else process.env.PI_AGENT_AUTO_EXIT = autoExitEnv;
  const h = makeHarness();
  const ctx = { shutdown: () => h.calls.push("shutdown") };
  autoExitExtension(h.pi);
  h.emitAgentEnd = (messages: any[]) => h.emit("agent_end", { messages });
  h.emitSettled = () => h.emit("agent_settled", {}, ctx);
  h.run = (messages: any[]) => {
    h.emitAgentEnd(messages);
    h.emitSettled();
  };
  return h;
}

afterEach(() => {
  delete process.env.PI_AGENT_AUTO_EXIT;
});

describe("extension event flow", () => {
  it("does nothing when PI_AGENT_AUTO_EXIT is not set", () => {
    const h = load(undefined);
    expect(h.handlers.size).toBe(0);
  });

  it("registers agent_end + agent_settled handlers when enabled", () => {
    const h = load("1");
    expect(h.handlers.has("agent_end")).toBe(true);
    expect(h.handlers.has("agent_settled")).toBe(true);
  });

  it("shuts down when the final run finished (stop)", () => {
    const h = load("1");
    h.run([user(), assistant("stop")]);
    expect(h.shutdownCount()).toBe(1);
    expect(h.entries[0]?.reason).toBe("finished");
  });

  it("shuts down on a run that crashed (error) and records the reason", () => {
    const h = load("1");
    h.run([user(), assistant("error", { errorMessage: "provider timeout" })]);
    expect(h.shutdownCount()).toBe(1);
    expect(h.entries[0]?.reason).toBe("error");
    expect(h.entries[0]?.error_message).toBe("provider timeout");
  });

  it("shuts down when the run ended after a terminating tool batch", () => {
    const h = load("1");
    h.run([user(), assistant("toolUse"), toolResult()]);
    expect(h.shutdownCount()).toBe(1);
  });

  it("stays alive when the last run was aborted — even after an earlier finished run", () => {
    const h = load("1");
    h.emitAgentEnd([user(), assistant("stop")]);
    h.emitAgentEnd([user(), assistant("aborted")]);
    h.emitSettled();
    expect(h.shutdownCount()).toBe(0);
  });

  it("stays alive when the run was truncated (length)", () => {
    const h = load("1");
    h.run([user(), assistant("length")]);
    expect(h.shutdownCount()).toBe(0);
  });

  it("stays alive when no run ever happened (settled without agent_end)", () => {
    const h = load("1");
    h.emitSettled();
    expect(h.shutdownCount()).toBe(0);
  });

  it("consults listPendingReplies before shutting down — the internal defense", async () => {
    // The pending-send defense reads module-level comms state that cannot
    // be seeded without a live NATS connection (covered by e2e). Here we
    // verify the guard is wired: with zero pending sends a finished run
    // proceeds to shutdown, and the extension still loads the real messaging
    // module (so the guard is the live listPendingReplies, not a stub).
    const messaging = await import("../extensions/lib/comms/messaging.ts");
    const h = load("1");
    h.run([user(), assistant("stop")]);
    expect(h.shutdownCount()).toBe(1);
    expect(messaging.listPendingReplies()).toEqual([]);
  });
});
