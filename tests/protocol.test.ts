/**
 * Unit tests for lib/comms/protocol — the pure deliver_as wire-value
 * validator (parseDeliverAs). The wire carries "steer" | "followUp" (the pi
 * naming); the validator normalizes arbitrary NATS payload bytes (unknown →
 * undefined → treated as the safe "steer" default downstream).
 *
 * parseDeliverAs is pure over unknown, so no NATS connection is needed.
 *
 * Run: bun test tests/protocol.test.ts
 */
import { describe, it, expect } from "bun:test";
import { parseDeliverAs } from "../extensions/lib/comms/protocol.ts";

describe("parseDeliverAs", () => {
  it("passes the two known wire values through", () => {
    expect(parseDeliverAs("steer")).toBe("steer");
    expect(parseDeliverAs("followUp")).toBe("followUp");
  });

  it("rejects the old kebab-case spelling (values are pi-named: steer | followUp)", () => {
    expect(parseDeliverAs("follow-up")).toBeUndefined();
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
