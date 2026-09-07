/**
 * Guard for the restart name-reclaim fix: a restart re-registers the SAME name
 * almost immediately (well inside reclaimAfterMs), but the dead agent's comms
 * profile stays `living` with a fresh last_seen_at — so the ordinary reclaim
 * path (conservative reclaimAfterMs) would SCUFFIX the name to `<name>2`, and
 * the restarted agent would NOT be the same comms identity the coordinator
 * re-dispatches to. registry.releaseName() is the escape hatch: it writes a
 * terminal gracefully_exited tombstone so a same-name register reclaims the
 * name immediately.
 *
 * Proves both halves:
 *   - WITHOUT releaseName, a same-name re-register inside reclaimAfterMs
 *     suffix→ `<name>2` (the bug we fixed);
 *   - WITH releaseName, the re-register reclaims the exact name (no suffix).
 */

import { describe, expect, test } from "bun:test";
import type { Identity } from "../extensions/lib/comms/protocol";
import { createRegistry } from "../extensions/lib/comms/registry";

const SUB = "test";
const RECLAIM_AFTER_MS = 10 * 60_000;

interface FakeEntry {
	key: string;
	operation: "PUT" | "DEL";
	revision: number;
	value: string;
	json<T>(): T;
}

/** Minimal KV covering the surface register/releaseName touch. */
class FakeKv {
	#store = new Map<string, FakeEntry>();
	#rev = 0;

	create(key: string, value: string): Promise<unknown> {
		if (this.#store.has(key)) {
			// JetStream KV create on an existing key → wrong-last-sequence 10071.
			return Promise.reject({ api_error: { err_code: 10071 } });
		}
		this.#store.set(key, { key, operation: "PUT", revision: ++this.#rev, value, json: <T,>() => JSON.parse(value) as T });
		return Promise.resolve({});
	}

	get(key: string): Promise<FakeEntry | null> {
		const e = this.#store.get(key);
		return Promise.resolve(e ? { ...e, json: <T,>() => JSON.parse(e.value) as T } : null);
	}

	update(key: string, value: string, revision: number): Promise<unknown> {
		const e = this.#store.get(key);
		if (!e || e.revision !== revision) return Promise.reject(new Error("revision mismatch"));
		this.#store.set(key, { key, operation: e.operation, revision: ++this.#rev, value, json: <T,>() => JSON.parse(value) as T });
		return Promise.resolve({});
	}
}

const kv = new FakeKv();
const registry = createRegistry({
	staleAfterMs: 60_000,
	reclaimAfterMs: RECLAIM_AFTER_MS,
	kvProfiles: () => kv as any,
});

function identity(name: string): Identity {
	return {
		name,
		subnet: SUB,
		cwd: "/tmp",
		model: "test",
		started_at: new Date().toISOString(),
	};
}

describe("registry — same-name restart reclaim", () => {
	test("WITHOUT releaseName, a same-name re-register inside reclaimAfterMs suffixes", async () => {
		const a = identity("worker-1");
		await registry.register(a, { context_used_pct: 0, model: "test" });
		expect(a.name).toBe("worker-1");

		// The old holder never gets a graceful exit (hard kill) so its profile
		// stays `living` with a fresh last_seen_at. A second register of the SAME
		// name happens seconds later — conservatively NOT reclaimable.
		const b = identity("worker-1");
		await registry.register(b, { context_used_pct: 0, model: "test" });
		expect(b.name).not.toBe("worker-1");
		expect(b.name).toBe("worker-12");
	});

	test("WITH releaseName, the re-register reclaims the exact name (no suffix)", async () => {
		const a = identity("worker-2");
		await registry.register(a, { context_used_pct: 0, model: "test" });
		expect(a.name).toBe("worker-2");

		// The restart path calls releaseName after reaping the old process.
		await registry.releaseName(SUB, a.name);

		// The restarted agent registers the SAME name and reclaims it.
		const b = identity("worker-2");
		await registry.register(b, { context_used_pct: 0, model: "test" });
		expect(b.name).toBe("worker-2");
	});

	test("releaseName is a no-op on an already-vacated / missing name", async () => {
		await expect(registry.releaseName(SUB, "never-existed")).resolves.toBeUndefined();

		// Release a name, then release it again — idempotent, no throw.
		const a = identity("worker-3");
		await registry.register(a, { context_used_pct: 0, model: "test" });
		expect(a.name).toBe("worker-3");
		await registry.releaseName(SUB, a.name);
		await expect(registry.releaseName(SUB, a.name)).resolves.toBeUndefined();
	});
});
