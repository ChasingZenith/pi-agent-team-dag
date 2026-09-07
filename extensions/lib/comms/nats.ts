/**
 * comms — NATS connection singleton + idempotent JetStream/KV ensure.
 * The network stream is per subnet: ensureStream is subnet-parameterised.
 */

import {
	connect,
	nanos,
	type NatsConnection,
	type JetStreamClient,
	type JetStreamManager,
	type KV,
	DiscardPolicy,
	RetentionPolicy,
	StorageType,
} from "nats";
import type { RuntimeConfig } from "./config.ts";
import {
	KV_BUCKET_PROFILES,
	KV_BUCKET_HISTORY,
	streamName,
	streamSubjects,
} from "./protocol.ts";
import { audit } from "./audit.ts";

/**
 * Client-side timeout for JetStream API calls (publish ack, KV put/get, …).
 * Deliberately short — a stalled server must fail a tool call fast, not block
 * it for the message TTL (30 min).
 */
const JS_REQUEST_TIMEOUT_MS = 10_000;

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;
let kvProfiles: KV | null = null;
let kvHistory: KV | null = null;

export function getNc(): NatsConnection {
	if (!nc) throw new Error("comms: not connected");
	return nc;
}
export function getJs(): JetStreamClient {
	if (!js) throw new Error("comms: not connected");
	return js;
}
export function getJsm(): JetStreamManager {
	if (!jsm) throw new Error("comms: not connected");
	return jsm;
}
/** Permanent agent profiles (a.<subnet>.<name>) — no bucket TTL. */
export function getKvProfiles(): KV {
	if (!kvProfiles) throw new Error("comms: not connected");
	return kvProfiles;
}
/** Message content history (h.<subnet>.<name>.<out|in>.<msg_id>) — bucket
 *  TTL (default 24h): outbox/inbox re-read content after compact or restart. */
export function getKvHistory(): KV {
	if (!kvHistory) throw new Error("comms: not connected");
	return kvHistory;
}

export async function connectNats(cfg: RuntimeConfig): Promise<void> {
	const opts: Record<string, any> = {
		servers: cfg.natsUrl,
		// Core NATS reconnects forever with backoff by default; keep it.
		reconnect: true,
		maxReconnectAttempts: -1,
	};
	if (cfg.authToken) opts.token = cfg.authToken;
	let conn: NatsConnection;
	try {
		conn = await connect(opts);
	} catch (err: any) {
		throw new Error(`comms: cannot connect to NATS at ${cfg.natsUrl} — ${err?.message ?? String(err)}`);
	}
	nc = conn;
	const jsc = conn.jetstream({ timeout: JS_REQUEST_TIMEOUT_MS });
	js = jsc;
	jsm = await jsc.jetstreamManager();

	// Two KV buckets (see protocol.ts):
	//   comms_profiles   — permanent lifecycle records (no TTL; stale/exited
	//                  stay visible; status derived from lifecycle+last_seen_at;
	//                  the name claim lives in the same entry — reclaim is
	//                  reader-driven, no lease bucket).
	//   comms_history — message content history, bucket TTL (default 24h). NOTE:
	//                  views.kv() only BINDS an existing bucket — the TTL is
	//                  applied on first creation, never re-applied. Changing
	//                  PI_COMMS_HISTORY_TTL_MS requires deleting the bucket.
	kvProfiles = await jsc.views.kv(KV_BUCKET_PROFILES, {
		history: 1,
		description: "comms agent profiles (a.<subnet>.<name>, permanent)",
	});
	kvHistory = await jsc.views.kv(KV_BUCKET_HISTORY, {
		ttl: cfg.historyTtlMs,
		history: 1,
		description: "comms message history (h.<subnet>.<session>.{out,in}.<msg_id>, bucket TTL)",
	});

	// Surface core connection status to the audit channel.
	void (async () => {
		try {
			for await (const s of nc!.status()) {
				if (s.type === "disconnect") audit("nats_disconnect", { reason: String(s.data ?? "") });
				else if (s.type === "reconnect") audit("nats_reconnect", { attempt: Number(s.data ?? 0) });
			}
		} catch {
			// connection closed
		}
	})();
}

/**
 * Idempotently create the network stream for a subnet (one stream per
 * communication domain). Identical config is a no-op; a conflicting existing
 * stream is left untouched (log + continue).
 */
export async function ensureStream(messageTtlMs: number, subnet: string): Promise<void> {
	const name = streamName(subnet);
	const cfg: Record<string, any> = {
		name,
		subjects: streamSubjects(subnet),
		retention: RetentionPolicy.Limits,
		storage: StorageType.File,
		discard: DiscardPolicy.Old,
		max_age: nanos(messageTtlMs),
		max_msgs: 100_000,
		max_bytes: 64 * 1024 * 1024,
	};
	try {
		await jsm!.streams.add(cfg);
		audit("ensure_stream", { stream: name, created: true });
	} catch (err: any) {
		const code = err?.isJetStreamError?.() ? err.jsError()?.code : undefined;
		// "already exists" surfaces as 10058 (identical config) or 400
		// "stream name already in use with a different configuration" — BOTH
		// mean the stream exists, so never boot-fail over it: verify the live
		// config and audit any drift instead (recreating a conflicting stream
		// could destroy another agent's queued messages).
		const exists = code === 10058
			|| /stream name already in use/.test(err?.message ?? "");
		if (exists) {
			try {
				const info = await jsm!.streams.info(name);
				const liveSubjects = info.config.subjects ?? [];
				const maxAgeMs = Math.floor(Number(info.config.max_age ?? 0) / 1e6);
				const matches = liveSubjects.length === cfg.subjects.length
					&& cfg.subjects.every((s: string) => liveSubjects.includes(s))
					&& maxAgeMs === messageTtlMs;
				audit("ensure_stream", { stream: name, created: false, config_matches: matches });
				if (!matches) {
					audit("ensure_stream_config_drift", { stream: name, subjects: liveSubjects, max_age_ms: maxAgeMs });
				}
			} catch {
				audit("ensure_stream", { stream: name, created: false });
			}
			return;
		}
		audit("ensure_stream_failed", { stream: name, reason: err?.message ?? String(err) });
		throw new Error(`comms: cannot create stream ${name} — ${err?.message ?? String(err)}`);
	}
}

export async function closeNats(): Promise<void> {
	// NOTE: never destroy() the KV buckets here — they are shared state; only
	// this agent's own entry is finalized by registry.clearOwn().
	try { await nc?.drain(); } catch { /* best-effort */ }
	try { nc?.close(); } catch { /* best-effort */ }
	nc = null;
	js = null;
	jsm = null;
	kvProfiles = null;
	kvHistory = null;
}
