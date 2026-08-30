/**
 * Unit tests for lib/comms/batch + lib/comms/protocol — the pure
 * delivery-mode helper (parseDeliverAs) and isPending (redelivery dedupe).
 * (The batch split-by-mode behavior itself is exercised in
 * batch-trydrain.test.ts.)
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
  it("passes the two known wire values through", () => {
    expect(parseDeliverAs("steer")).toBe("steer");
    expect(parseDeliverAs("follow-up")).toBe("follow-up");
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

  it("reports unknown msg_ids as not pending", () => {
    resetForTest();
    expect(isPending("nope")).toBe(false);
  });
});
