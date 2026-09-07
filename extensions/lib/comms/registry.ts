/**
 * comms — agent registry over the profiles KV bucket:
 *
 *   comms_profiles — permanent lifecycle records (a.<subnet>.<name>, NO bucket
 *                TTL). ONE entry per agent carries the name claim, the
 *                lifecycle state ("living" | "gracefully_exited") and the
 *                raw heartbeat timestamp; addressability and status always
 *                come from the same snapshot.
 *
 * Entries outlive the agent: a stale/exited agent stays visible. Name
 * reclaim happens when a register collides with a dead holder — a
 * gracefully_exited terminal state (immutable, so the steal is race-free via
 * revision-check) or a living profile whose last_seen_at is older than
 * reclaimAfterMs (conservative second threshold, never fires on a merely
 * slow agent).
 *
 * The profile key is the NAME (not the session id): one entry per name, and
 * reclaiming a name overwrites the old profile — no duplicate profiles for a
 * restarted agent.
 *
 * Every key is namespaced by the subnet (the communication domain): agents
 * in different subnets never see each other's profiles or names. The subnet
 * flows in from the identity (registry calls) or as an explicit argument
 * (startWatch/resolveName/statusOfName).
 */

import type { KV, KvEntry, QueuedIterator } from "nats";
import type { AgentProfile, AgentStatus, Identity, StoredProfile } from "./protocol.ts";
import {
	profileKey,
	profileKeyPrefix,
	nowIso,
	statusFromProfile,
} from "./protocol.ts";
import { audit, type AuditFn } from "./audit.ts";

// ━━ Factory ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RegistryConfig {
	/** Display-stale threshold (ms) — REQUIRED. Kept small so status
	 *  converges fast; NOT used for name reclaim. */
	staleAfterMs: number;
	/** Name-reclaim threshold (ms) — REQUIRED. Conservative: a steal must
	 *  never fire on a merely slow/lagging agent. */
	reclaimAfterMs: number;
	/** comms_profiles KV accessor (thunk — resolved lazily so the factory can
	 *  be built before or after the NATS connect). */
	kvProfiles: () => KV;
	audit?: AuditFn;
}

export interface RegistryInstance {
	/** Claim the name; on collision mutate identity.name IN PLACE (never
	 *  reassign — sibling extensions hold the same reference). */
	register(identity: Identity, extra: ProfileHeartbeatExtra): Promise<void>;
	heartbeat(identity: Identity, extra: ProfileHeartbeatExtra): Promise<StoredProfile>;
	updateOwnProfile(identity: Identity, patch: { current_task?: string | undefined }, live?: ProfileHeartbeatExtra): Promise<StoredProfile>;
	/** Explicitly vacate a name so a coordinated same-name re-register (restart)
	 *  can reclaim it IMMEDIATELY instead of waiting for reclaimAfterMs. Best-effort. */
	releaseName(subnet: string, name: string): Promise<void>;
	startWatch(subnet: string): void;
	stopWatch(): void;
	getPeers(): AgentProfile[];
	resolveName(subnet: string, name: string): Promise<StoredProfile | null>;
	statusOfName(subnet: string, name: string): AgentStatus;
	statusOfProfile(profile: StoredProfile): AgentStatus;
	clearOwn(identity: Identity): Promise<void>;
	/** Latest callback wins; null clears. */
	onCacheChange(cb: (() => void) | null): void;
}

export interface ProfileHeartbeatExtra {
	context_used_pct: number;
	model: string;
}

export function createRegistry(cfg: RegistryConfig): RegistryInstance {
	const { staleAfterMs, reclaimAfterMs } = cfg;
	const kv = cfg.kvProfiles;
	const auditLog = cfg.audit ?? audit;

	// ━━ Instance state (owned by this instance — no module globals) ━━━━━━━━

	const cache = new Map<string, StoredProfile>();
	let watchIter: QueuedIterator<KvEntry> | null = null;
	let watchShutdown = false;
	let watchActive = false;
	let onChange: (() => void) | null = null;

	/**
	 * Is a living profile's name reclaimable — i.e. the holder is presumed
	 * crashed? Deliberately a much larger threshold than the display-stale
	 * threshold: a steal must never fire on a merely slow/lagging agent.
	 */
	function isReclaimable(profile: StoredProfile): boolean {
		const last = Date.parse(profile.last_seen_at);
		return Number.isNaN(last) || Date.now() - last > reclaimAfterMs;
	}

	// ━━ Registration / lifecycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	function buildProfile(identity: Identity, extra: ProfileHeartbeatExtra): StoredProfile {
		return {
			name: identity.name,
			model: extra.model || identity.model,
			cwd: identity.cwd,
			subnet: identity.subnet,
			started_at: identity.started_at,
			context_used_pct: extra.context_used_pct,
			lifecycle: "living",
			current_task: identity.current_task,
			last_seen_at: nowIso(),
		};
	}

	/**
	 * Register: claim the name via create() on the profile key (atomic — fails if
	 * taken), then the entry IS the initial profile. On collision: suffix and
	 * retry — UNLESS the current holder is dead, in which case the name is stolen
	 * via a revision-checked update (race-free: only one claimant's update can
	 * match the observed revision):
	 *   - gracefully_exited — terminal, immutable (the exited agent never writes
	 *     again), so the steal condition cannot flip between read and write;
	 *   - living with last_seen_at older than reclaimAfterMs — presumed crashed.
	 *     The conservative threshold keeps the in-flight-heartbeat race window
	 *     negligible (a merely slow agent is never stolen).
	 *
	 * In-place only: the suffix must reach the sibling extensions that hold the
	 * same `identity` reference (emitted on COMMS_RUNTIME_EVENT before register),
	 * so a fresh object would silently diverge them — hence the assertion below.
	 */
	async function register(identity: Identity, extra: ProfileHeartbeatExtra): Promise<void> {
		const base = identity.name;
		let assigned = base;

		for (let n = 2; ; n++) {
			try {
				const profile = buildProfile({ ...identity, name: assigned }, extra);
				await kv().create(profileKey(identity.subnet, assigned), JSON.stringify(profile));
				break;
			} catch (err: any) {
				// Only a genuine name collision (KV wrong-last-sequence, 10071)
				// warrants a suffix/steal; a network/other failure must fail
				// loudly instead of silently renaming the agent.
				if (err?.api_error?.err_code !== 10071) throw err;

				if (await tryStealDeadName(identity, assigned)) break;

				if (n > 100) {
					throw new Error(`comms: cannot claim a unique name for "${base}"`);
				}
				assigned = `${base}${n}`;
			}
		}

		if (assigned !== identity.name) {
			auditLog("name_collision", { desired: base, assigned, subnet: identity.subnet });
			identity.name = assigned;
		}

		if (identity.name !== assigned) {
			throw new Error(
				`comms: register failed to mutate identity in place (want name "${assigned}", got "${identity.name}")`,
			);
		}

		auditLog("register", { name: identity.name, subnet: identity.subnet });
	}

	/**
	 * Try to steal a dead holder's name claim (see register). Returns true when
	 * the steal succeeded and the profile entry now belongs to us.
	 */
	async function tryStealDeadName(identity: Identity, name: string): Promise<boolean> {
		const key = profileKey(identity.subnet, name);
		let holder: StoredProfile | null = null;
		let revision: number;
		try {
			const entry = await kv().get(key);
			if (!entry) return false; // key never existed — retry create next pass
			revision = entry.revision;
			// A deleted key comes back as a DEL tombstone entry — the DEL message
			// still occupies a stream sequence, so create() keeps failing (10071);
			// the name is vacated: steal it by updating at the DEL revision.
			if (entry.operation !== "DEL") {
				holder = entry.json<StoredProfile>();
				if (!holder || typeof holder.name !== "string") return false;
			}
		} catch {
			return false; // unreadable holder — treat as alive, suffix instead
		}
		const dead = holder === null
			|| holder.lifecycle === "gracefully_exited"
			|| isReclaimable(holder);
		if (!dead) return false;
		try {
			const profile = buildProfile({ ...identity, name }, { context_used_pct: 0, model: identity.model });
			await kv().update(key, JSON.stringify(profile), revision);
			auditLog("name_reclaimed", {
				name,
				subnet: identity.subnet,
				holder_lifecycle: holder === null ? "deleted" : holder.lifecycle ?? "living",
				holder_last_seen_at: holder?.last_seen_at ?? null,
			});
			return true;
		} catch (err: any) {
			// Lost the revision race (holder heartbeated in between, or another
			// claimant stole first) — fall through to suffix/retry.
			auditLog("name_reclaim_lost", { name, subnet: identity.subnet, reason: err?.message ?? String(err) });
			return false;
		}
	}

	/**
	 * Heartbeat: a full-profile put — refreshes last_seen_at and keeps the name
	 * claim alive (the claim is the entry itself). Returns the stored profile
	 * that was written.
	 */
	async function heartbeat(identity: Identity, extra: ProfileHeartbeatExtra): Promise<StoredProfile> {
		const profile = buildProfile(identity, extra);
		await kv().put(profileKey(identity.subnet, identity.name), JSON.stringify(profile));
		return profile;
	}

	/**
	 * Update own profile fields and sync them into the local identity so the next
	 * heartbeat persists them. Returns the updated stored profile (callers use it to
	 * echo back what changed without rebuilding one).
	 */
	async function updateOwnProfile(
		identity: Identity,
		patch: {
			current_task?: string | undefined;
		},
		live?: ProfileHeartbeatExtra,
	): Promise<StoredProfile> {
		if (patch.current_task !== undefined) identity.current_task = patch.current_task || undefined;

		// Immediate visibility (don't wait for the next heartbeat tick). Carry the
		// caller's live metrics through instead of zeroing them — a profile pushed
		// with context_used_pct 0 would show peers a bogus "idle" until the next
		// heartbeat tick.
		return heartbeat(identity, live ?? { context_used_pct: 0, model: identity.model });
	}

	// ━━ Watch cache ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Only the profiles bucket is watched (name index is not, and needs no prune
	// tick: profiles have no TTL, so nothing expires silently — the only DEL events
	// are explicit deletes like clearOwn, which the watch does see).

	function startWatch(subnet: string): void {
		if (watchActive) return;
		watchActive = true;
		watchShutdown = false;
		void runWatchLoop(subnet);
	}

	/**
	 * Watch loop with self-healing: the KV watch rides an ephemeral ordered
	 * consumer, so a NATS disconnect terminates the iterator. On any unexpected
	 * end — iterator exit or setup failure (NATS still reconnecting) — wait
	 * briefly and rebuild. The rebuilt watch delivers a fresh snapshot, so the
	 * cache is dropped first: a peer that left while the watch was down must not
	 * linger as a ghost.
	 */
	async function runWatchLoop(subnet: string): Promise<void> {
		while (!watchShutdown) {
			let iter: QueuedIterator<KvEntry> | null = null;
			try {
				iter = await kv().watch({ key: profileKeyPrefix(subnet) });
				watchIter = iter;
				cache.clear();
				onChange?.();
				for await (const e of iter) {
					if (e.operation === "DEL" || e.operation === "PURGE") {
						cache.delete(e.key);
					} else {
						try {
							const profile = e.json<StoredProfile>();
							if (profile && typeof profile.name === "string") {
								cache.set(e.key, profile);
							}
						} catch {
							// malformed profile — skip
						}
					}
					onChange?.();
				}
				// Iterator ended without shutdown — watch died; recreate.
				if (watchShutdown) return;
				watchIter = null;
				await new Promise((r) => setTimeout(r, 1_000));
			} catch {
				if (watchShutdown) return;
				// Watch setup failed (e.g. NATS still reconnecting); retry.
				watchIter = null;
				await new Promise((r) => setTimeout(r, 1_000));
			}
		}
	}

	function stopWatch(): void {
		watchActive = false;
		watchShutdown = true;
		try { watchIter?.stop(); } catch { /* ignore */ }
		watchIter = null;
		cache.clear();
	}

	// ━━ Queries ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	/** Display rank so the peer list sorts online → stale → exited. Exited is
	 *  last: a tombstone is the least actionable, so it sinks to the bottom. */
	function statusRank(status: AgentStatus): number {
		if (status === "online") return 0;
		if (status === "stale") return 1;
		return 2;
	}

	/** Live peer profiles (status derived from lifecycle + last_seen_at), for
	 *  comms_list_peer. Terminal (gracefully_exited) entries are included — they
	 *  are the tombstones that let the UI distinguish a clean exit from a crash.
	 *  Sorted online → stale → exited (name tiebreak) so the TUI widget and the
	 *  tool both show the actionable peers first. */
	function getPeers(): AgentProfile[] {
		const out: AgentProfile[] = [];
		for (const profile of cache.values()) {
			out.push({
				...profile,
				status: statusFromProfile(profile, staleAfterMs),
			});
		}
		out.sort((a, b) => (statusRank(a.status) - statusRank(b.status)) || a.name.localeCompare(b.name));
		return out;
	}

	/**
	 * Resolve a peer name to its holder's profile. Returns null only for an
	 * unclaimed name — a genuine key miss, never a failed read. A
	 * gracefully_exited holder is returned as-is so callers can give a precise
	 * reason instead of a generic "not found"; a crashed (living + stale) holder
	 * also resolves — messages still queue on the stream and redeliver on
	 * restart.
	 *
	 * A read failure (NATS down, JetStream timeout) propagates: callers must
	 * report "comms unreachable, retry later" rather than a missing-target
	 * error, which would send an agent down the wrong recovery path.
	 */
	async function resolveName(subnet: string, name: string): Promise<StoredProfile | null> {
		const entry = await kv().get(profileKey(subnet, name));
		// A deleted key comes back as a DEL tombstone entry (non-null).
		if (!entry || entry.operation === "DEL") return null;
		const profile = entry.json<StoredProfile>();
		if (!profile || typeof profile.name !== "string") return null;
		return profile;
	}

	/**
	 * Status of a peer name, derived from the CACHED profile (watch mirror of the
	 * profiles bucket). Used by paths with no fresh evidence of their own, e.g.
	 * the reminder path (listActiveReminders arms reminders for arbitrary peers
	 * from history with no liveness check); the send path derives its status from
	 * the resolveName snapshot instead.
	 *
	 * A missing cached profile means the peer is NOT known to be alive — the
	 * answer is unconditionally "stale" (never assume a peer we know nothing
	 * about is alive; the message still delivers via the stream). A cached
	 * terminal entry (gracefully_exited) is exited; a cached living entry is
	 * judged by last_seen_at.
	 */
	function statusOfName(subnet: string, name: string): AgentStatus {
		const profile = cache.get(profileKey(subnet, name));
		if (!profile) return "stale";
		return statusOfProfile(profile);
	}

	/**
	 * Status of a specific profile snapshot (instance-tuned thresholds). The send
	 * path uses this on the resolveName result so its target_status is derived
	 * from the same entry that proved addressability.
	 */
	function statusOfProfile(profile: StoredProfile): AgentStatus {
		return statusFromProfile(profile, staleAfterMs);
	}

	/**
	 * Best-effort graceful-exit write on clean shutdown (2s cap): put a TERMINAL
	 * profile (lifecycle "gracefully_exited"). The entry becomes an immutable
	 * tombstone — peers see the exit immediately and can tell a clean leave from
	 * a crash; a later register under this name steals the entry race-free
	 * (terminal state cannot flip between read and write).
	 */
	async function clearOwn(identity: Identity): Promise<void> {
		try {
			const tombstone: StoredProfile = {
				name: identity.name,
				model: identity.model,
				cwd: identity.cwd,
				subnet: identity.subnet,
				started_at: identity.started_at,
				context_used_pct: 0,
				lifecycle: "gracefully_exited",
				current_task: identity.current_task,
				last_seen_at: nowIso(),
			};
			await Promise.race([
				kv().put(profileKey(identity.subnet, identity.name), JSON.stringify(tombstone)),
				new Promise<void>((resolve) => {
					const timer = setTimeout(() => resolve(), 2_000);
					try { (timer as any).unref?.(); } catch { /* ignore */ }
				}),
			]);
		} catch {
			// best-effort — a stale living profile just shows stale (presumed
			// crashed) and is reclaimable after reclaimAfterMs
		}
	}

	/**
	 * Explicitly vacate a name for a coordinated same-name re-register (agent
	 * restart): writes a terminal `gracefully_exited` tombstone for the given
	 * name — the same immutable terminal state clearOwn creates for the holder's
	 * own name — so register's collision path steals it RACE-FREE immediately
	 * (terminal state cannot flip between read and write). This is the escape
	 * hatch for a restart that must keep its exact name, instead of waiting out
	 * the conservative reclaimAfterMs (which would suffix the name).
	 *
	 * Best-effort: a failure (holder unreadable / revision raced / NATS down)
	 * only leaves the name to be reclaimed by the ordinary conservative path.
	 */
	async function releaseName(subnet: string, name: string): Promise<void> {
		try {
			const key = profileKey(subnet, name);
			const entry = await kv().get(key);
			// Already free (key miss) or a DEL tombstone — register reclaims them.
			if (!entry || entry.operation === "DEL") return;
			const holder = entry.json<StoredProfile>();
			if (!holder || typeof holder.name !== "string") return;
			// Revision-checked update: if another register stole the name between
			// our read and write, the revision mismatches and we abandon (no
			// clobber of a fresh holder).
			const tombstone: StoredProfile = { ...holder, lifecycle: "gracefully_exited" };
			await kv().update(key, JSON.stringify(tombstone), entry.revision);
		} catch {
			// best-effort — falls back to the ordinary reclaim path
		}
	}

	function onCacheChange(cb: (() => void) | null): void {
		onChange = cb;
	}

	return {
		register,
		heartbeat,
		updateOwnProfile,
		releaseName,
		startWatch,
		stopWatch,
		getPeers,
		resolveName,
		statusOfName,
		statusOfProfile,
		clearOwn,
		onCacheChange,
	};
}

