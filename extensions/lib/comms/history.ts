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
 * A reply is BOTH a normal inbound record (read via comms_inbox) and folded
 * into the matching out record as metadata only (msg_id/sender/ts, so outbox
 * derivation can see "replied") — the reply's content is never duplicated
 * into the out record. All writes are best-effort fire-and-forget by the
 * callers — a history write must never fail a send or delay injection.
 *
 * TTL note: the bucket TTL is applied on FIRST creation only (views.kv binds
 * an existing bucket without re-applying options) — changing
 * PI_COMMS_HISTORY_TTL_MS requires deleting the bucket.
 */

import type { KV, KvEntry } from "nats";
import type { Identity, InboundContext } from "./protocol.ts";
import {
	historyInKey,
	historyInPrefix,
	historyOutKey,
	historyOutPrefix,
} from "./protocol.ts";
import { audit, type AuditFn } from "./audit.ts";

const FOLD_ATTEMPTS = 5;
const FOLD_RETRY_DELAY_MS = 50;

function foldSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	/** LEGACY (comms_dismiss era) — read for old records only; never written
	 *  any more because reminders no longer produce a terminal status. */
	ended?: { reason: "dismissed"; ts: number };
}

export interface OutReply {
	msg_id: string;
	sender: string;
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
	return clean.length > max ? `${clean.slice(0, max)}… (truncated)` : clean;
}

// ━━ Factory ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface HistoryDeps {
	/** Stream message TTL (ms) — REQUIRED. Drives deriveOutStatus "expired".
	 *  Deliberately no default: a forgotten TTL must be a compile error, not
	 *  a silent "never expires". */
	messageTtlMs: number;
	/** comms_history KV accessor (thunk — resolved lazily so the factory can
	 *  be built before or after the NATS connect). */
	kvHistory: () => KV;
	audit?: AuditFn;
}

export interface HistoryInstance {
	recordOutbound(identity: Identity, target: string, msgId: string, message: string, replyToMsgId: string | null): Promise<void>;
	recordInbound(identity: Identity, inbound: InboundContext): Promise<void>;
	recordReplyIntoOut(identity: Identity, replyToMsgId: string, reply: OutReply): Promise<void>;
	deleteOutbound(subnet: string, name: string, msgId: string): Promise<void>;
	deriveOutStatus(rec: HistoryOutRecord): { state: "waiting" | "ended"; reason?: "replied" | "expired" | "dismissed" };
	listOutbound(subnet: string, name: string, limit: number): Promise<{ records: HistoryOutRecord[]; total: number }>;
	getOutbound(subnet: string, name: string, msgId: string): Promise<HistoryOutRecord | null>;
	listInbound(subnet: string, name: string, limit: number): Promise<{ records: HistoryInRecord[]; total: number }>;
	getInbound(subnet: string, name: string, msgId: string): Promise<HistoryInRecord | null>;
}

export function createHistory(deps: HistoryDeps): HistoryInstance {
	const { messageTtlMs } = deps;
	const kv = deps.kvHistory;
	const auditLog = deps.audit ?? audit;

	// ━━ Writes (best-effort; callers fire-and-forget with .catch) ━━━━━━━━━━

	async function recordOutbound(
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
		await kv().put(historyOutKey(identity.subnet, identity.name, msgId), JSON.stringify(rec));
	}

	async function recordInbound(identity: Identity, inbound: InboundContext): Promise<void> {
		const rec: HistoryInRecord = {
			dir: "in",
			msg_id: inbound.msg_id,
			sender: inbound.sender_name,
			message: inbound.message,
			reply_to_msg_id: inbound.reply_to_msg_id ?? null,
			ts: Date.now(),
		};
		await kv().put(historyInKey(identity.subnet, identity.name, inbound.msg_id), JSON.stringify(rec));
	}

	/**
	 * Fold a reply into the matching out record; no-op when the record is absent
	 * (a foreign msg_id must not fabricate one — and cannot be a race: send()
	 * records before publishing, so any reply necessarily finds the record).
	 * Revision-checked update: concurrent replies to the same msg_id would
	 * otherwise last-write-win. Best-effort — the reply content itself is always
	 * persisted as its own in record; bounded retry then give up (audited).
	 */
	async function recordReplyIntoOut(identity: Identity, replyToMsgId: string, reply: OutReply): Promise<void> {
		const key = historyOutKey(identity.subnet, identity.name, replyToMsgId);
		for (let attempt = 1; ; attempt++) {
			let entry: KvEntry | null;
			try {
				entry = await kv().get(key);
			} catch (err: any) {
				if (attempt >= FOLD_ATTEMPTS) {
					auditLog("history_read_failed", { direction: "reply", msg_id: reply.msg_id, reply_to: replyToMsgId, reason: err?.message ?? String(err) });
					return;
				}
				await foldSleep(FOLD_RETRY_DELAY_MS);
				continue;
			}
			if (!entry || entry.operation === "DEL") return; // foreign/expired id
			let rec: HistoryOutRecord;
			try {
				rec = entry.json<HistoryOutRecord>();
			} catch {
				// retrying cannot fix a corrupt record
				auditLog("history_read_failed", { direction: "reply", msg_id: reply.msg_id, reply_to: replyToMsgId, reason: "corrupt out record" });
				return;
			}
			rec.reply = reply;
			try {
				await kv().update(key, JSON.stringify(rec), entry.revision);
				return;
			} catch (err: any) {
				// revision conflict (concurrent fold) or transient failure — re-read and retry
				if (attempt >= FOLD_ATTEMPTS) {
					auditLog("reply_fold_lost", { msg_id: reply.msg_id, reply_to: replyToMsgId, reason: err?.message ?? String(err) });
					return;
				}
				await foldSleep(FOLD_RETRY_DELAY_MS);
			}
		}
	}

	/** Remove a ghost out record (send() calls this when the publish was not
	 *  acknowledged, so no bogus "waiting" row lingers in the outbox). */
	async function deleteOutbound(subnet: string, name: string, msgId: string): Promise<void> {
		await kv().delete(historyOutKey(subnet, name, msgId));
	}

	// ━━ Reads ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	/**
	 * Derive the send status purely from a persisted out record (used after a
	 * restart, when the in-memory reminder table is gone). Closes over the
	 * REQUIRED messageTtlMs — no "0 = never expires" silent default.
	 */
	function deriveOutStatus(rec: HistoryOutRecord): { state: "waiting" | "ended"; reason?: "replied" | "expired" | "dismissed" } {
		if (rec.reply) return { state: "ended", reason: "replied" };
		// LEGACY: old comms_dismiss-era records carry a persisted ended marker.
		if (rec.ended) return { state: "ended", reason: rec.ended.reason };
		if (messageTtlMs > 0 && Date.now() - rec.ts > messageTtlMs) return { state: "ended", reason: "expired" };
		return { state: "waiting" };
	}

	async function list<T>(prefix: string): Promise<T[]> {
		// history({ key }) treats the key as an EXACT subject filter — append ">"
		// to make it a prefix match ("h…out.>" matches "h…out.<msgid>", and the
		// dot boundary keeps a sibling like "<sid>.out2.<msg>" out). Re-filter
		// client-side with the exact dotted prefix as a defensive net.
		const serverFilter = prefix.endsWith(".") ? prefix + ">" : prefix;
		const entries: T[] = [];
		for await (const e of await kv().history({ key: serverFilter })) {
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

	async function listOutbound(subnet: string, name: string, limit: number): Promise<{ records: HistoryOutRecord[]; total: number }> {
		const recs = await list<HistoryOutRecord>(historyOutPrefix(subnet, name));
		recs.sort((a, b) => b.ts - a.ts);
		return { records: recs.slice(0, limit), total: recs.length };
	}

	async function getOutbound(subnet: string, name: string, msgId: string): Promise<HistoryOutRecord | null> {
		const entry = await kv().get(historyOutKey(subnet, name, msgId));
		if (!entry || entry.operation === "DEL") return null;
		try {
			return entry.json<HistoryOutRecord>();
		} catch {
			auditLog("history_read_failed", { direction: "out", msg_id: msgId });
			return null;
		}
	}

	async function listInbound(subnet: string, name: string, limit: number): Promise<{ records: HistoryInRecord[]; total: number }> {
		const recs = await list<HistoryInRecord>(historyInPrefix(subnet, name));
		recs.sort((a, b) => b.ts - a.ts);
		return { records: recs.slice(0, limit), total: recs.length };
	}

	async function getInbound(subnet: string, name: string, msgId: string): Promise<HistoryInRecord | null> {
		const entry = await kv().get(historyInKey(subnet, name, msgId));
		if (!entry || entry.operation === "DEL") return null;
		try {
			return entry.json<HistoryInRecord>();
		} catch {
			auditLog("history_read_failed", { direction: "in", msg_id: msgId });
			return null;
		}
	}

	return {
		recordOutbound,
		recordInbound,
		recordReplyIntoOut,
		deleteOutbound,
		deriveOutStatus,
		listOutbound,
		getOutbound,
		listInbound,
		getInbound,
	};
}

