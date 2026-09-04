/**
 * comms — agent registry over two NATS KV buckets:
 *
 *   comms_profiles — permanent agent profiles (a.<subnet>.<name>, NO bucket TTL).
 *                Profiles outlive the agent: status (online/offline) is
 *                derived from last_seen_at, so offline agents stay visible.
 *   comms_names — name lease (n.<subnet>.<name>) with a bucket-level TTL:
 *                heartbeat refreshes it (sliding expiry); an agent that stops
 *                heartbeating loses its name claim automatically, so the name
 *                can be reclaimed. An entry existing == the agent is
 *                heartbeating; the entry VALUE is the name itself (the name
 *                is the address — no separate id to map).
 *
 * The profile key is the NAME (not the session id): reclaiming a name
 * overwrites the old profile — no duplicate profiles for a restarted agent.
 *
 * Every key is namespaced by the subnet (the communication domain): agents
 * in different subnets never see each other's profiles or names. The subnet
 * flows in from the identity (registry calls) or as an explicit argument
 * (startWatch/resolveName/statusOfName).
 */

import type { KvEntry, QueuedIterator } from "nats";
import type { AgentProfile, Identity, StoredProfile } from "./protocol.ts";
import {
	profileKey,
	profileKeyPrefix,
	nameKey,
	nowIso,
	statusFromLastSeen,
} from "./protocol.ts";
import { getKvProfiles, getKvNames } from "./nats.ts";
import { audit } from "./audit.ts";

// ━━ Module state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const cache = new Map<string, StoredProfile>();
let watchIter: QueuedIterator<KvEntry> | null = null;
let watchShutdown = false;
let offlineAfterMs = 60_000;
let onChange: (() => void) | null = null;

export function setRegistryTuning(offline: number): void {
	offlineAfterMs = offline;
}

/** Called whenever the peer cache changes (entry wires this to the widget). */
export function setCacheChangeListener(cb: (() => void) | null): void {
	onChange = cb;
}

// ━━ Registration / lease ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ProfileHeartbeatExtra {
	context_used_pct: number;
	model: string;
}

function buildProfile(identity: Identity, extra: ProfileHeartbeatExtra): StoredProfile {
	return {
		name: identity.name,
		model: extra.model || identity.model,
		cwd: identity.cwd,
		subnet: identity.subnet,
		started_at: identity.started_at,
		context_used_pct: extra.context_used_pct,
		status: "online",
		current_task: identity.current_task,
		last_seen_at: nowIso(),
	};
}

/**
 * Register: claim the name via create() (atomic — fails if taken, then
 * suffix and retry), then put the initial profile. Returns the identity with
 * the resolved name.
 */
export async function register(identity: Identity, extra: ProfileHeartbeatExtra): Promise<Identity> {
	const kvNames = getKvNames();
	const base = identity.name;
	let assigned = base;

	for (let n = 2; ; n++) {
		try {
			await kvNames.create(nameKey(identity.subnet, assigned), assigned);
			break;
		} catch (err: any) {
			// Only a genuine name collision (KV wrong-last-sequence, 10071)
			// warrants a suffix; a network/other failure must fail loudly
			// instead of silently renaming the agent.
			if (err?.api_error?.err_code !== 10071) throw err;
			if (n > 100) {
				throw new Error(`comms: cannot claim a unique name for "${base}"`);
			}
			assigned = `${base}${n}`;
		}
	}

	if (assigned !== identity.name) {
		audit("name_collision", { desired: identity.name, assigned, subnet: identity.subnet });
		identity.name = assigned;
	}

	const profile = buildProfile(identity, extra);
	// Profile key = name: the old profile (if any, e.g. a previous session with the
	// same name) is overwritten — one profile per name, always.
	await getKvProfiles().put(profileKey(identity.subnet, identity.name), JSON.stringify(profile));
	audit("register", { name: identity.name, subnet: identity.subnet });
	return identity;
}

/**
 * Refresh the lease: full-profile put (permanent profiles bucket) + name-index put
 * (TTL lease — this is what keeps the name claim alive). Returns the stored
 * profile that was written (status online, last_seen_at refreshed).
 */
export async function heartbeat(identity: Identity, extra: ProfileHeartbeatExtra): Promise<StoredProfile> {
	const profile = buildProfile(identity, extra);
	const put = Promise.all([
		getKvProfiles().put(profileKey(identity.subnet, identity.name), JSON.stringify(profile)),
		getKvNames().put(nameKey(identity.subnet, identity.name), identity.name),
	]);
	await put;
	return profile;
}

/**
 * Update own profile fields and sync them into the local identity so the next
 * heartbeat persists them. Returns the updated stored profile (callers use it to
 * echo back what changed without rebuilding one).
 */
export async function updateOwnProfile(
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

// ━━ Watch cache ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Only the profiles bucket is watched (name index is not, and needs no prune
// tick: profiles have no TTL, so nothing expires silently — the only DEL events
// are explicit deletes like clearOwn, which the watch does see).

export function startWatch(subnet: string): void {
	if (watchIter || watchShutdown) return;
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
			const kv = getKvProfiles();
			iter = await kv.watch({ key: profileKeyPrefix(subnet) });
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

export function stopWatch(): void {
	watchShutdown = true;
	try { watchIter?.stop(); } catch { /* ignore */ }
	watchIter = null;
	cache.clear();
}

// ━━ Queries ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Live peer profiles (status derived from last_seen_at), for comms_list_peer. */
export function getPeers(): AgentProfile[] {
	const out: AgentProfile[] = [];
	for (const profile of cache.values()) {
		out.push({
			...profile,
			status: statusFromLastSeen(profile.last_seen_at, offlineAfterMs),
		});
	}
	return out;
}

/**
 * Liveness check: confirm a peer name is heartbeating, or null when unknown.
 * The name lease is a TTL: an entry existing == the agent is heartbeating.
 * (Profile existence is NOT checked — profiles persist forever.) The message
 * address is the name itself — no separate id to resolve.
 */
export async function resolveName(subnet: string, name: string): Promise<string | null> {
	try {
		const entry = await getKvNames().get(nameKey(subnet, name));
		// A deleted key comes back as a DEL tombstone entry (non-null).
		if (!entry || entry.operation === "DEL") return null;
		const value = entry.string().trim();
		return value.length > 0 ? name : null;
	} catch {
		return null;
	}
}

/**
 * Current status of a peer name, derived from the cached profile's
 * last_seen_at (same logic as getPeers). Used by the sender side (comms_send
 * target_status, listActiveReminders target_status). When the profile is not
 * cached yet but the caller already resolved the name (the name lease is a
 * TTL — an entry existing means the peer is heartbeating), the peer is
 * assumed online.
 */
export function statusOfName(subnet: string, name: string): "online" | "offline" {
	const profile = cache.get(profileKey(subnet, name));
	if (!profile) return "online";
	return statusFromLastSeen(profile.last_seen_at, offlineAfterMs);
}

/**
 * Best-effort removal of our own keys on clean shutdown (2s cap).
 * Profile is deleted too — a graceful exit is an explicit leave: the profile
 * disappears. Only a crashed agent's profile stays (permanent, shown offline).
 */
export async function clearOwn(identity: Identity): Promise<void> {
	try {
		const deletes = [
			getKvProfiles().delete(profileKey(identity.subnet, identity.name)),
			getKvNames().delete(nameKey(identity.subnet, identity.name)),
		];
		await Promise.race([
			Promise.all(deletes),
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), 2_000);
				try { (timer as any).unref?.(); } catch { /* ignore */ }
			}),
		]);
	} catch {
		// best-effort — a stale profile just shows offline; the name lease expires
	}
}
