/**
 * Unit tests for lib/comms/batch + lib/comms/protocol — the pure
 * delivery-mode helper (parseDeliverAs) and the "next turn" straight-to-pi
 * path (bypasses the batch gate, acked on pi's acceptance). (The batch
 * split-by-mode behavior itself is exercised in batch-trydrain.test.ts.)
 *
 * The helper functions are pure over unknown / InboundContext[] /
 * DeliverAsValue, so the tests construct minimal inbound stubs (jsMsg as
 * any) without touching NATS. The parseDeliverAs tests pin the
 * normalization of arbitrary NATS payload bytes (unknown → undefined →
 * treated as the safe "steer" default downstream). The enqueue tests drive
 * the module through its public API with a fake injector, resetting module
 * state via resetForTest.
 *
 * Run: bun test tests/batch-deliver.test.ts
 */
import { beforeEach, describe, it, expect } from "bun:test";
import {
  isPending,
  resetForTest,
  setBatchInjector,
  enqueue,
  releaseTurn,
  settleBatch,
  getActiveBatch,
} from "../extensions/lib/comms/batch.ts";
import type { PiDeliverAs } from "../extensions/lib/comms/batch.ts";
import { parseDeliverAs } from "../extensions/lib/comms/protocol.ts";
import type { InboundContext } from "../extensions/lib/comms/protocol.ts";

// ━━ helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Minimal inbound; jsMsg stubs the ack-holding field and _ackSpy lets tests
 * observe acks. msg_id is unique per call so requeue/drain tests can tell
 * messages apart.
 */
function mkInbound(partial: Partial<InboundContext> = {}): InboundContext {
  const ack: { acked: boolean } = { acked: false };
  return {
    msg_id: `m${Math.random().toString(36).slice(2, 10)}`,
    sender_name: "alice",
    sender_cwd: "/virtual/cwd",
    message: "hello",
    jsMsg: { ack() { ack.acked = true; } } as any,
    _ackSpy: ack, // test-only handle, never read by batch.ts
    ...partial,
  } as any;
}

// ━━ parseDeliverAs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("parseDeliverAs", () => {
  it("passes the three known wire values through", () => {
    expect(parseDeliverAs("steer")).toBe("steer");
    expect(parseDeliverAs("follow-up")).toBe("follow-up");
    expect(parseDeliverAs("next turn")).toBe("next turn");
  });

  it("normalizes unknown wire values to undefined", () => {
    expect(parseDeliverAs("banana")).toBeUndefined();
    expect(parseDeliverAs("")).toBeUndefined();
  });

  it("normalizes non-string wire values (malformed payloads) to undefined", () => {
    expect(parseDeliverAs(42)).toBeUndefined();
    expect(parseDeliverAs(null)).toBeUndefined();
    expect(parseDeliverAs(undefined)).toBeUndefined();
    expect(parseDeliverAs({})).toBeUndefined();
    expect(parseDeliverAs(["steer"])).toBeUndefined();
  });
});

// ━━ enqueue: next turn straight to pi ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface InjectedCall {
  batch: InboundContext[];
  deliverAs: PiDeliverAs;
}

describe("next-turn enqueue (straight to pi's next-turn queue)", () => {
  let calls: InjectedCall[];

  beforeEach(() => {
    resetForTest();
    calls = [];
    setBatchInjector((batch, _message, deliverAs) => {
      calls.push({ batch, deliverAs });
    });
  });

  it("injects immediately with deliverAs nextTurn and acks on pi's acceptance", () => {
    const next = mkInbound({ deliver_as: "next turn" });
    enqueue(next);

    expect(calls.length).toBe(1);
    expect(calls[0].deliverAs).toBe("nextTurn");
    expect(calls[0].batch).toEqual([next]);
    // Acknowledged right away — pi's next-turn queue now owns delivery (pi
    // never triggers a turn for it, so there is no agent_settled to ack at).
    expect((next as any)._ackSpy.acked).toBe(true);
    expect(getActiveBatch()).toBeNull();
  });

  it("does not close the turn gate — a steer message drains right after", () => {
    enqueue(mkInbound({ deliver_as: "next turn" }));
    const steer = mkInbound();
    enqueue(steer);

    expect(calls.length).toBe(2);
    expect(calls[1].deliverAs).toBe("steer");
    expect(calls[1].batch).toEqual([steer]);
  });

  it("is unaffected by an in-flight batch turn (the gate blocks only batch drains)", () => {
    // A steer batch opens the gate.
    const first = mkInbound();
    enqueue(first);
    expect(calls.length).toBe(1);

    // A next-turn message arrives DURING that batch turn: it must not be
    // queued behind the gate — it goes straight to pi's queue.
    const next = mkInbound({ deliver_as: "next turn" });
    enqueue(next);
    expect(calls.length).toBe(2);
    expect(calls[1].deliverAs).toBe("nextTurn");
    expect((next as any)._ackSpy.acked).toBe(true);

    // The batch turn's own settle still works as before.
    settleBatch(getActiveBatch()!);
    releaseTurn();
  });

  it("injector throw: error propagates and the message stays unacked (redelivery re-enters)", () => {
    let shouldThrow = true;
    setBatchInjector((batch, _message, deliverAs) => {
      calls.push({ batch, deliverAs });
      if (shouldThrow) throw new Error("injector boom");
    });

    const next = mkInbound({ deliver_as: "next turn" });
    expect(() => enqueue(next)).toThrow("injector boom");
    expect(calls.length).toBe(1);
    expect((next as any)._ackSpy.acked).toBe(false); // retried via NATS redelivery

    // A later successful delivery acks it.
    shouldThrow = false;
    enqueue(mkInbound({ deliver_as: "next turn" }));
    expect((next as any)._ackSpy.acked).toBe(false); // this is a DIFFERENT message
  });

  it("without an injector, settles directly (acked) — senders observe a timeout", () => {
    resetForTest();
    const next = mkInbound({ deliver_as: "next turn" });
    enqueue(next);
    expect((next as any)._ackSpy.acked).toBe(true);
    expect(getActiveBatch()).toBeNull();
  });
});

// ━━ isPending (redelivery dedupe must not discard never-injected copies) ━━━

describe("isPending", () => {
  it("reports queued and in-flight-batch messages as pending; settled messages as not", () => {
    resetForTest();
    let injected = 0;
    setBatchInjector(() => { injected += 1; });

    // A queued message that cannot drain yet (gate closed by a busy batch
    // turn) is pending — the redelivery dedupe must keep its stream copy.
    const first = mkInbound();
    enqueue(first);
    expect(injected).toBe(1); // drained — the gate is open
    expect(isPending(first.msg_id)).toBe(true);

    const m2 = mkInbound();
    enqueue(m2); // queued behind the closed gate — pending
    expect(isPending(m2.msg_id)).toBe(true);

    // Settled at agent_settled — no longer pending.
    settleBatch(getActiveBatch()!);
    releaseTurn();
    expect(isPending(first.msg_id)).toBe(false);
    expect(isPending(m2.msg_id)).toBe(true); // drained now, still unacked
    settleBatch(getActiveBatch()!);
    expect(isPending(m2.msg_id)).toBe(false);
  });

  it("reports a next-turn message as not pending once delivered to pi (acked at acceptance)", () => {
    resetForTest();
    const next = mkInbound({ deliver_as: "next turn" });
    enqueue(next);
    // Bypasses the batch entirely and is acked on pi's acceptance — the
    // redelivery dedupe must NOT keep a stream copy for it.
    expect(isPending(next.msg_id)).toBe(false);
  });

  it("reports unknown msg_ids as not pending", () => {
    resetForTest();
    expect(isPending("nope")).toBe(false);
  });
});
