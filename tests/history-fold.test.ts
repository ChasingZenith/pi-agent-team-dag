/**
 * Unit tests for the reply fold in lib/comms/history.ts
 * (recordReplyIntoOut): revision-checked read-modify-write with bounded
 * retry, no-op on a missing out record, give-up on a corrupt record.
 *
 * nats.ts's getKvHistory singleton is mocked (bun mock.module) with a tiny
 * in-memory KV fake — no real NATS. history.ts is imported dynamically after
 * the mock is installed so it binds the fake.
 *
 * Run: bun test tests/history-fold.test.ts
 */
import { describe, expect, test, mock } from "bun:test";
import type { Identity } from "../extensions/lib/comms/protocol";

// ━━ fake KV (minimal surface history.ts actually uses) ━━━━━━━━━━━━━━━━━━━━━

interface FakeEntry {
	key: string;
	operation: "PUT" | "DEL";
	revision: number;
	value: string;
	/** Matches the real KvEntry shape history.ts uses. */
	json<T>(): T;
}

class FakeKv {
	#store = new Map<string, FakeEntry>();
	#rev = 0;
	/** Injected failures for the next N calls (shifted per call). */
	failGet = 0;
	failUpdate = 0;
	conflictUpdate = 0;
	corrupt = false;

	get(key: string): Promise<FakeEntry | null> {
		if (this.failGet > 0) {
			this.failGet--;
			return Promise.reject(new Error("kv get failed (injected)"));
		}
		const e = this.#store.get(key);
		return Promise.resolve(e ? { ...e, json: <T,>() => JSON.parse(e.value) as T } : null);
	}

	async put(key: string, value: string): Promise<void> {
		this.#store.set(key, { key, operation: "PUT", revision: ++this.#rev, value });
	}

	async update(key: string, value: string, revision: number): Promise<void> {
		if (this.conflictUpdate > 0) {
			this.conflictUpdate--;
			throw { api_error: { err_code: 10071 } }; // wrong last sequence
		}
		if (this.failUpdate > 0) {
			this.failUpdate--;
			throw new Error("kv update failed (injected)");
		}
		const cur = this.#store.get(key);
		if (!cur || cur.revision !== revision) {
			throw { api_error: { err_code: 10071 } };
		}
		cur.value = value;
		cur.revision = ++this.#rev;
	}

	value(key: string): string | undefined {
		return this.#store.get(key)?.value;
	}

	json<T>(key: string): T | undefined {
		const v = this.#store.get(key)?.value;
		return v ? (JSON.parse(v) as T) : undefined;
	}

	setCorrupt(key: string): void {
		this.#store.set(key, { key, operation: "PUT", revision: ++this.#rev, value: "{not json" });
	}

	/** Replace the entry with a DEL tombstone (KV deletion semantics). */
	setTombstone(key: string): void {
		this.#store.set(key, { key, operation: "DEL", revision: ++this.#rev, value: "" });
	}
}

const kv = new FakeKv();
mock.module("../extensions/lib/comms/nats.ts", () => ({
	getKvHistory: () => kv,
	getKvProfiles: () => {
		throw new Error("not used in this test");
	},
}));

const { recordReplyIntoOut } = await import("../extensions/lib/comms/history");

const identity: Identity = {
	name: "tester",
	subnet: "test",
	cwd: "/tmp",
	model: "test",
	started_at: new Date().toISOString(),
};

function seedOut(msgId: string): string {
	const key = `h.test.tester.out.${msgId}`;
	const rec = {
		dir: "out",
		msg_id: msgId,
		target: "peer",
		message: "hello",
		reply_to_msg_id: null,
		ts: Date.now(),
	};
	kv.put(key, JSON.stringify(rec));
	return key;
}

function outKey(msgId: string): string {
	return `h.test.tester.out.${msgId}`;
}

const reply = { msg_id: "reply-1", sender: "peer", ts: Date.now() };

describe("recordReplyIntoOut (reply fold)", () => {
	test("folds the reply into an existing out record via revision-checked update", async () => {
		const msgId = "01FOLDTEST0001";
		seedOut(msgId);
		await recordReplyIntoOut(identity, msgId, reply);
		const rec = kv.json<any>(outKey(msgId));
		expect(rec.reply).toEqual(reply);
		expect(rec.message).toBe("hello"); // rest of the record intact
	});

	test("no-op (no write) when the out record does not exist", async () => {
		await recordReplyIntoOut(identity, "01FOLDTEST0002", reply);
		expect(kv.value(outKey("01FOLDTEST0002"))).toBeUndefined();
	});

	test("no-op on a DEL tombstone", async () => {
		const msgId = "01FOLDTEST0003";
		seedOut(msgId);
		// simulate deletion by replacing the entry with a DEL tombstone
		kv.setTombstone(outKey(msgId));
		await recordReplyIntoOut(identity, msgId, reply);
		expect(kv.json<any>(outKey(msgId))?.reply ?? "deleted").toBe("deleted");
	});

	test("is idempotent — redelivery overwrites the same reply value", async () => {
		const msgId = "01FOLDTEST0004";
		seedOut(msgId);
		await recordReplyIntoOut(identity, msgId, reply);
		await recordReplyIntoOut(identity, msgId, reply);
		expect(kv.json<any>(outKey(msgId)).reply).toEqual(reply);
	});

	test("retries on revision conflict (concurrent fold) and succeeds", async () => {
		const msgId = "01FOLDTEST0005";
		seedOut(msgId);
		kv.conflictUpdate = 2; // first two updates lose the revision race
		await recordReplyIntoOut(identity, msgId, reply);
		expect(kv.json<any>(outKey(msgId)).reply).toEqual(reply);
	});

	test("retries on transient read/write failures and succeeds", async () => {
		const msgId = "01FOLDTEST0006";
		seedOut(msgId);
		kv.failGet = 2;
		kv.failUpdate = 1;
		await recordReplyIntoOut(identity, msgId, reply);
		expect(kv.json<any>(outKey(msgId)).reply).toEqual(reply);
	});

	test("gives up (no throw) when failures exceed the retry budget", async () => {
		const msgId = "01FOLDTEST0007";
		seedOut(msgId);
		kv.failGet = 100; // every attempt fails
		await recordReplyIntoOut(identity, msgId, reply); // must not throw
		expect(kv.json<any>(outKey(msgId))?.reply).toBeUndefined();
	});

	test("gives up (no throw) on a corrupt out record", async () => {
		const msgId = "01FOLDTEST0008";
		seedOut(msgId);
		kv.setCorrupt(outKey(msgId));
		await recordReplyIntoOut(identity, msgId, reply); // must not throw or loop forever
	});
});
