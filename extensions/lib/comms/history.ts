/**
 * comms — bidirectional message content history over the comms_history KV
 * bucket (keys h.<subnet>.<name>.<out|in>.<msg_id>, bucket TTL default 24h).
 *
 * The in-memory pending table (messaging.ts) stores only send metadata — after
 * a compact or a restart the message content itself is gone from context and
 * memory. This module persists every outbound and inbound message so
 * comms_outbox / comms_inbox can re-read it.
 *
 * History is anchored on the agent NAME — the stable identity — so a
 * restarted agent reads the same records its previous incarnations wrote
 * (the outbox/inbox list mode covers the agent's whole history, not just the
 * current process's).
 *
 *   out records  what WE sent (target, content, optional reply link + ended)
 *   in  records  what we RECEIVED (sender, content, optional reply_to_msg_id)
 *
 * The reply is folded INTO the out record when it arrives (one key read makes
 * an outbox(msg_id) detail self-contained); dismiss is persisted as `ended` so
 * the status survives a restart. All writes are best-effort fire-and-forget by
 * the callers — a history write must never fail a send or delay injection.
 *
 * TTL note: the bucket TTL is applied on FIRST creation only (views.kv binds
 * an existing bucket without re-applying options) — changing
 * PI_COMMS_HISTORY_TTL_MS requires deleting the bucket.
 */

import type { Identity, InboundContext } from "./protocol.ts";
import {
	historyInKey,
	historyInPrefix,
	historyOutKey,
	historyOutPrefix,
} from "./protocol.ts";
import { getKvHistory } from "./nats.ts";
import { audit } from "./audit.ts";

/** Message TTL (same value as messaging's) — drives the expired status. */
let messageTtlMs = 0;

export function setHistoryMessageTtlMs(ms: number): void {
	messageTtlMs = ms;
}

/** Outbound record — the reply and the ended marker are folded in on arrival. */
export interface HistoryOutRecord {
	dir: "out";
	msg_id: string;
	target: string;
	message: string;
	/** Set when this send was itself a reply (comms_send reply_to_msg_id). */
	reply_to_msg_id: string | null;
	/** When the send was made (ms epoch). */
	ts: number;
	/** The peer's reply, folded in when it arrives. */
	reply?: OutReply;
	/** How tracking ended, persisted so dismiss survives a restart. */
	ended?: { reason: "dismissed"; ts: number };
}

export interface OutReply {
	msg_id: string;
	sender: string;
	message: string;
	ts: number;
}

/** Inbound record — what we received. */
export interface HistoryInRecord {
	dir: "in";
	msg_id: string;
	sender: string;
	message: string;
	/** Set when the sender marked this message as a reply. */
	reply_to_msg_id: string | null;
	ts: number;
}

/** Collapse message content to one line (whitespace → single space), truncating
 *  beyond max chars — for list-mode rows, never a semantic summary. */
export function flatten(text: string, max = 120): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ━━ Writes (best-effort; callers fire-and-forget with .catch) ━━━━━━━━━━━━━━━

export async function recordOutbound(
	identity: Identity,
	target: string,
	msgId: string,
	message: string,
	replyToMsgId: string | null,
): Promise<void> {
	const rec: HistoryOutRecord = {
		dir: "out",
		msg_id: msgId,
		target,
		message,
		reply_to_msg_id: replyToMsgId,
		ts: Date.now(),
	};
	await getKvHistory().put(historyOutKey(identity.subnet, identity.name, msgId), JSON.stringify(rec));
}

export async function recordInbound(identity: Identity, inbound: InboundContext): Promise<void> {
	const rec: HistoryInRecord = {
		dir: "in",
		msg_id: inbound.msg_id,
		sender: inbound.sender_name,
		message: inbound.message,
		reply_to_msg_id: inbound.reply_to_msg_id ?? null,
		ts: Date.now(),
	};
	await getKvHistory().put(historyInKey(identity.subnet, identity.name, inbound.msg_id), JSON.stringify(rec));
}

/**
 * Fold a reply into the matching out record (idempotent — redeliveries
 * overwrite the same key). No-op when the out record is absent: a foreign or
 * already-expired msg_id must not fabricate an out record out of nothing.
 */
export async function recordReplyIntoOut(identity: Identity, replyToMsgId: string, reply: OutReply): Promise<void> {
	const key = historyOutKey(identity.subnet, identity.name, replyToMsgId);
	const entry = await getKvHistory().get(key);
	if (!entry) return;
	const rec = entry.json<HistoryOutRecord>();
	rec.reply = reply;
	await getKvHistory().put(key, JSON.stringify(rec));
}

/** Persist a dismiss (ended marker) — survives restarts. No-op when the out
 *  record is absent (never sent, or already evicted from the history bucket). */
export async function markDismissed(identity: Identity, msgId: string): Promise<void> {
	const key = historyOutKey(identity.subnet, identity.name, msgId);
	const entry = await getKvHistory().get(key);
	if (!entry) return;
	const rec = entry.json<HistoryOutRecord>();
	rec.ended = { reason: "dismissed", ts: Date.now() };
	await getKvHistory().put(key, JSON.stringify(rec));
}

// ━━ Reads ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Derive the send status purely from a persisted out record (used after a
 * restart, when the in-memory pending table is gone).
 */
export function deriveOutStatus(rec: HistoryOutRecord): { state: "waiting" | "ended"; reason?: "replied" | "expired" | "dismissed" } {
	if (rec.reply) return { state: "ended", reason: "replied" };
	if (rec.ended) return { state: "ended", reason: rec.ended.reason };
	if (messageTtlMs > 0 && Date.now() - rec.ts > messageTtlMs) return { state: "ended", reason: "expired" };
	return { state: "waiting" };
}

async function list<T>(prefix: string, limit: number): Promise<T[]> {
	// history({ key }) treats the key as an EXACT subject filter — append ">"
	// to make it a prefix match ("h…out.>" matches "h…out.<msgid>", and the
	// dot boundary keeps a sibling like "<sid>.out2.<msg>" out). Re-filter
	// client-side with the exact dotted prefix as a defensive net.
	const serverFilter = prefix.endsWith(".") ? prefix + ">" : prefix;
	const entries: T[] = [];
	for await (const e of await getKvHistory().history({ key: serverFilter })) {
		if (e.operation === "DEL") continue;
		if (!e.key.startsWith(prefix)) continue;
		try {
			entries.push(e.json<T>());
		} catch {
			// Corrupt/foreign record — skip rather than fail the whole list.
		}
	}
	return entries;
}

/** Our outbound history, newest first, capped at limit. */
export async function listOutbound(subnet: string, name: string, limit: number): Promise<HistoryOutRecord[]> {
	const recs = await list<HistoryOutRecord>(historyOutPrefix(subnet, name), limit);
	recs.sort((a, b) => b.ts - a.ts);
	return recs.slice(0, limit);
}

export async function getOutbound(subnet: string, name: string, msgId: string): Promise<HistoryOutRecord | null> {
	const entry = await getKvHistory().get(historyOutKey(subnet, name, msgId));
	if (!entry || entry.operation === "DEL") return null;
	try {
		return entry.json<HistoryOutRecord>();
	} catch {
		audit("history_read_failed", { direction: "out", msg_id: msgId });
		return null;
	}
}

/** Our inbound history, newest first, capped at limit. */
export async function listInbound(subnet: string, name: string, limit: number): Promise<HistoryInRecord[]> {
	const recs = await list<HistoryInRecord>(historyInPrefix(subnet, name), limit);
	recs.sort((a, b) => b.ts - a.ts);
	return recs.slice(0, limit);
}

export async function getInbound(subnet: string, name: string, msgId: string): Promise<HistoryInRecord | null> {
	const entry = await getKvHistory().get(historyInKey(subnet, name, msgId));
	if (!entry || entry.operation === "DEL") return null;
	try {
		return entry.json<HistoryInRecord>();
	} catch {
		audit("history_read_failed", { direction: "in", msg_id: msgId });
		return null;
	}
}
