/**
 * Unit tests for resolveName's error semantics in messaging.send():
 * a genuine key miss (unclaimed name) must report "target not found", while
 * an infra failure (NATS down / JetStream timeout → kv.get rejects) must
 * report the registry as unreachable — NEVER masquerade as "target not found".
 *
 * nats.ts's getKvProfiles singleton is mocked (bun mock.module) with a tiny
 * fake whose get() can inject a rejection. messaging.ts is imported
 * dynamically after the mock is installed so it binds the fake.
 *
 * Run: bun test tests/resolve-name.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { Identity } from "../extensions/lib/comms/protocol";
import { createRegistry } from "../extensions/lib/comms/registry";
import { createMessaging } from "../extensions/lib/comms/messaging";

// ━━ fake KV (resolve / send only touch get; the not-found and unreachable
//    branches both fail BEFORE publish/history, so a minimal surface suffices)

interface FakeEntry {
	key: string;
	operation: "PUT" | "DEL";
	revision: number;
	value: string;
	json<T>(): T;
}

class FakeKv {
	#store = new Map<string, FakeEntry>();
	#rev = 0;
	/** Fail the next N get() calls (injected infra failure). */
	failGet = 0;

	get(key: string): Promise<FakeEntry | null> {
		if (this.failGet > 0) {
			this.failGet--;
			return Promise.reject(new Error("kv get failed (injected NATS outage)"));
		}
		const e = this.#store.get(key);
		return Promise.resolve(e ? { ...e, json: <T,>() => JSON.parse(e.value) as T } : null);
	}

	put(key: string, value: string): FakeEntry {
		const e = { key, operation: "PUT" as const, revision: ++this.#rev, value, json: <T,>() => JSON.parse(value) as T };
		this.#store.set(key, e);
		return e;
	}

	/** Replace the entry with a DEL tombstone (KV deletion semantics). */
	setTombstone(key: string): void {
		this.#store.set(key, { key, operation: "DEL" as const, revision: ++this.#rev, value: "", json: <T,>() => JSON.parse("") as T });
	}
}

const kv = new FakeKv();

// Factory construction with the fake KV injected directly — no module mock.
const registry = createRegistry({
	staleAfterMs: 60_000,
	reclaimAfterMs: 10 * 60_000,
	kvProfiles: () => kv as any,
});
const messaging = createMessaging({
	identity: { name: "tester", subnet: "test", cwd: "/tmp", model: "test", started_at: new Date().toISOString() },
	subnet: "test",
	messageTtlMs: 30 * 60_000,
	js: () => { throw new Error("not reached"); },
	jsm: () => { throw new Error("not reached"); },
	registry,
	history: {
		recordOutbound: async () => {},
		recordInbound: async () => {},
		recordReplyIntoOut: async () => {},
		deleteOutbound: async () => {},
		getOutbound: async () => null,
		getInbound: async () => null,
	},
});

const identity: Identity = {
	name: "tester",
	subnet: "test",
	cwd: "/tmp",
	model: "test",
	started_at: new Date().toISOString(),
};

function profile(name: string): Record<string, unknown> {
	return {
		name,
		model: "test",
		cwd: "/tmp",
		subnet: "test",
		started_at: new Date().toISOString(),
		context_used_pct: 0,
		lifecycle: "living",
		last_seen_at: new Date().toISOString(),
	};
}

describe("send → resolveName error semantics", () => {
	test("genuine unclaimed name reports 'target not found'", async () => {
		// No profile for "ghost" — resolveName returns null (key miss).
		await expect(messaging.send("ghost", "hi")).rejects.toThrow(/target not found/);
	});

	test("DEL tombstone reports 'target not found' (unclaimed, not infra)", async () => {
		kv.setTombstone("a.test.dead");
		await expect(messaging.send("dead", "hi")).rejects.toThrow(/target not found/);
	});

	test("kv.get rejecting (NATS down) reports 'cannot reach the registry', NOT 'target not found'", async () => {
		// A real peer exists, but the registry read fails (infra outage).
		kv.put("a.test.real", JSON.stringify(profile("real")));
		kv.failGet = 1;
		await expect(messaging.send("real", "hi")).rejects.toThrow(/cannot reach the registry/);
		await expect(messaging.send("real", "hi")).rejects.not.toThrow(/target not found/);
	});
});
