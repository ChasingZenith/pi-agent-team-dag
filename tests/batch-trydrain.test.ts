/**
 * Unit tests for lib/comms/batch tryDrain behavior — the turn-gate state
 * machine that decides when a batch is injected, gated, settled, or
 * requeued. A drained batch is split by deliver_as and each group injected
 * with its own mode (steer first, follow-up second — never promoted), all
 * under ONE gate, settled together at agent_settled. This is the part of
 * the deliver_as change with real deadlock and ack-risk, so it gets direct
 * coverage here. ("next turn" bypasses the gate entirely — its
 * straight-to-pi path is exercised in batch-deliver.test.ts.)
 *
 * tryDrain is module-private; these tests drive it through the public API
 * (enqueue / releaseTurn / settleBatch / setBatchInjector) with a fake
 * injector. Each test imports a FRESH module instance via query-string
 * cache-busting, so the module-level gate state never leaks between tests.
 *
 * Run: bun test tests/batch-trydrain.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { InboundContext } from "../extensions/lib/comms/protocol.ts";
import type { PiDeliverAs } from "../extensions/lib/comms/batch.ts";

// ━━ helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface AckSpy {
  acked: boolean;
}

function mkInbound(partial: Partial<InboundContext> = {}): InboundContext {
  const ack: AckSpy = { acked: false };
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

interface InjectedCall {
  batch: InboundContext[];
  deliverAs: PiDeliverAs;
}

type BatchModule = typeof import("../extensions/lib/comms/batch.ts");

let instanceCounter = 0;
/** Fresh module instance (fresh inboundQueue / activeBatch). */
function freshBatch(): Promise<BatchModule> {
  instanceCounter += 1;
  return import(`../extensions/lib/comms/batch.ts?trydrain=${instanceCounter}`) as Promise<BatchModule>;
}

/** Records injector calls; after a recorded call the batch is "answered". */
function recordingInjector(calls: InjectedCall[]) {
  return (batch: InboundContext[], _message: string, deliverAs: PiDeliverAs) => {
    calls.push({ batch, deliverAs });
  };
}

// ━━ tryDrain behavior ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("tryDrain gate and settle behavior", () => {
  test("steer batch (no deliver_as) closes the gate; settles only at agent_end, then drains what queued during the turn", async () => {
    const batch = await freshBatch();
    const calls: InjectedCall[] = [];
    batch.setBatchInjector(recordingInjector(calls));

    const m1 = mkInbound();
    batch.enqueue(m1);
    expect(calls.length).toBe(1);
    expect(calls[0].deliverAs).toBe("steer");
    expect(calls[0].batch).toEqual([m1]);
    expect((m1 as any)._ackSpy.acked).toBe(false); // unacked until settled

    // Gate is closed: a message arriving during the turn must NOT drain.
    const m2 = mkInbound();
    batch.enqueue(m2);
    expect(calls.length).toBe(1);

    // agent_end: settle the answered batch, then release the gate.
    batch.settleBatch(batch.getActiveBatch()!);
    expect((m1 as any)._ackSpy.acked).toBe(true);
    expect(batch.getActiveBatch()).toBeNull();

    batch.releaseTurn();
    expect(calls.length).toBe(2);
    expect(calls[1].batch).toEqual([m2]);
    expect(calls[1].deliverAs).toBe("steer");
  });

  test("a next-turn message bypasses the gate entirely: injected immediately, acked, no gate held", async () => {
    const batch = await freshBatch();
    const calls: InjectedCall[] = [];
    batch.setBatchInjector(recordingInjector(calls));

    // "next turn" goes straight to pi's next-turn queue — the batch layer
    // never gates it (pi never triggers a turn for it, so there would be no
    // agent_settled to release a gate).
    const next = mkInbound({ deliver_as: "next turn" });
    batch.enqueue(next);
    expect(calls.length).toBe(1);
    expect(calls[0].deliverAs).toBe("nextTurn");
    expect(calls[0].batch).toEqual([next]);
    expect((next as any)._ackSpy.acked).toBe(true);
    expect(batch.getActiveBatch()).toBeNull();

    // No gate was held: a steer message drains immediately.
    const steer = mkInbound();
    batch.enqueue(steer);
    expect(calls.length).toBe(2);
    expect(calls[1].batch).toEqual([steer]);
    expect(calls[1].deliverAs).toBe("steer");
  });

  test("mixed batch: split by mode — each group injected with its OWN mode, no promotion", async () => {
    const batch = await freshBatch();
    const calls: InjectedCall[] = [];
    batch.setBatchInjector(recordingInjector(calls));

    // Gate closes with a steer batch in flight.
    batch.enqueue(mkInbound());
    expect(calls[0].deliverAs).toBe("steer");

    // These queue during the turn and drain together at releaseTurn. The
    // mixed batch is split by deliver_as: the steer group injects first
    // (its own mode), then the follow-up group (still "followUp") — a
    // follow-up member is NEVER promoted to steer.
    const f1 = mkInbound({ deliver_as: "follow-up" });
    const s1 = mkInbound({ deliver_as: "steer" });
    const f2 = mkInbound({ deliver_as: "follow-up" });
    batch.enqueue(f1);
    batch.enqueue(s1);
    batch.enqueue(f2);
    batch.settleBatch(batch.getActiveBatch()!);
    batch.releaseTurn();

    expect(calls.length).toBe(3);
    expect(calls[1].deliverAs).toBe("steer");
    expect(calls[1].batch).toEqual([s1]);
    expect(calls[2].deliverAs).toBe("followUp");
    expect(calls[2].batch.map((i) => i.msg_id)).toEqual([f1.msg_id, f2.msg_id]);

    // Both groups belong to the SAME active batch (insertion order — the
    // split only changes the injections, not the batch) and settle together
    // at agent_settled.
    const active = batch.getActiveBatch()!;
    expect(active.map((i) => i.msg_id)).toEqual([f1.msg_id, s1.msg_id, f2.msg_id]);
    batch.settleBatch(active);
    expect((s1 as any)._ackSpy.acked).toBe(true);
    expect((f1 as any)._ackSpy.acked).toBe(true);
    expect((f2 as any)._ackSpy.acked).toBe(true);
  });

  test("follow-up-only batch injects once as followUp (nothing to promote)", async () => {
    const batch = await freshBatch();
    const calls: InjectedCall[] = [];
    batch.setBatchInjector(recordingInjector(calls));

    // Close the gate with a steer batch, queue two follow-up messages, then
    // release — they drain together as ONE follow-up injection.
    batch.enqueue(mkInbound());
    const f1 = mkInbound({ deliver_as: "follow-up" });
    const f2 = mkInbound({ deliver_as: "follow-up" });
    batch.enqueue(f1);
    batch.enqueue(f2);
    batch.settleBatch(batch.getActiveBatch()!);
    batch.releaseTurn();

    expect(calls.length).toBe(2);
    expect(calls[1].deliverAs).toBe("followUp");
    expect(calls[1].batch).toEqual([f1, f2]);
  });

  test("partial injector failure: injected group stays the active batch, the rest is requeued", async () => {
    const batch = await freshBatch();
    let failOnFollowUp = true;
    const calls: InjectedCall[] = [];
    batch.setBatchInjector((b, _m, deliverAs) => {
      calls.push({ batch: b, deliverAs });
      if (failOnFollowUp && deliverAs === "followUp") throw new Error("injector boom");
    });

    // Close the gate with a steer batch, then queue a mixed batch during the
    // turn; releaseTurn drains it — the second group's injection throws and
    // the error propagates out of the releaseTurn.
    batch.enqueue(mkInbound());
    const s1 = mkInbound();
    const f1 = mkInbound({ deliver_as: "follow-up" });
    batch.enqueue(s1);
    batch.enqueue(f1);
    batch.settleBatch(batch.getActiveBatch()!);
    expect(() => batch.releaseTurn()).toThrow("injector boom");

    expect(calls.length).toBe(3);
    expect(calls[1].deliverAs).toBe("steer");
    expect(calls[1].batch).toEqual([s1]);
    expect(calls[2].deliverAs).toBe("followUp");

    // The injected steer group stays the active batch (settled at
    // agent_settled); the follow-up group was requeued — still unacked.
    expect(batch.getActiveBatch()).toEqual([s1]);
    expect((s1 as any)._ackSpy.acked).toBe(false);
    expect((f1 as any)._ackSpy.acked).toBe(false);

    // A run is in flight from the steer injection, so the gate stays closed:
    // a new message must not drain.
    const m2 = mkInbound();
    batch.enqueue(m2);
    expect(calls.length).toBe(3);

    // agent_settled settles the injected part; the gate opens and the
    // requeued follow-up group drains together with the queued message —
    // again split by mode.
    failOnFollowUp = false;
    batch.settleBatch(batch.getActiveBatch()!);
    expect((s1 as any)._ackSpy.acked).toBe(true);
    batch.releaseTurn();
    expect(calls.length).toBe(5);
    expect(calls[3].deliverAs).toBe("steer");
    expect(calls[3].batch).toEqual([m2]);
    expect(calls[4].deliverAs).toBe("followUp");
    expect(calls[4].batch).toEqual([f1]);
  });

  test("injector throw: error propagates, batch requeued at head, retried on the next drain", async () => {
    const batch = await freshBatch();
    let shouldThrow = true;
    const calls: InjectedCall[] = [];
    batch.setBatchInjector((b, _m, deliverAs) => {
      calls.push({ batch: b, deliverAs });
      if (shouldThrow) throw new Error("injector boom");
    });

    const m1 = mkInbound();
    expect(() => batch.enqueue(m1)).toThrow("injector boom");
    expect(calls.length).toBe(1);

    // Gate was released on failure; the next enqueue drains BOTH messages
    // (m1 requeued at the head, then m2) — nothing was acked.
    shouldThrow = false;
    const m2 = mkInbound();
    batch.enqueue(m2);
    expect(calls.length).toBe(2);
    expect(calls[1].batch.map((i) => i.msg_id)).toEqual([m1.msg_id, m2.msg_id]);
    expect((m1 as any)._ackSpy.acked).toBe(false);
    expect((m2 as any)._ackSpy.acked).toBe(false);
  });

  test("without an injector, batches settle directly (acked) — senders observe a timeout", async () => {
    const batch = await freshBatch();
    // No setBatchInjector call: ack-only settle.
    const m = mkInbound();
    batch.enqueue(m);
    expect((m as any)._ackSpy.acked).toBe(true);
    expect(batch.getActiveBatch()).toBeNull();
  });

  test("settleBatch of a stale batch cannot clear a newer active batch", async () => {
    const batch = await freshBatch();
    const calls: InjectedCall[] = [];
    batch.setBatchInjector(recordingInjector(calls));

    const b1 = mkInbound();
    batch.enqueue(b1);
    const active1 = batch.getActiveBatch()!;
    expect(active1).toEqual([b1]);

    // A late settle from a previous turn (bogus batch) must not clear B1.
    const stale = mkInbound();
    batch.settleBatch([stale]);
    expect(batch.getActiveBatch()).toEqual([b1]);
    expect((b1 as any)._ackSpy.acked).toBe(false);

    batch.settleBatch(active1);
    expect((b1 as any)._ackSpy.acked).toBe(true);
    expect(batch.getActiveBatch()).toBeNull();
  });
});
