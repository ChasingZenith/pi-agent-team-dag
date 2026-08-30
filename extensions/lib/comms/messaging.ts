/**
 * comms — JetStream messaging: durable prompt consumer, send, explicit
 * replies (reply_to_msg_id), consolidated remind_s reminders (one shared
 * scheduler), pending-reply resolution.
 *
 * Delivery model:
 *  - prompts: stream subject <subnet>.msg.<targetname>.<msgid>, durable consumer
 *    p_<name> — both name-anchored. The consumer PERSISTS across restarts (the
 *    entry does not delete it on clean shutdown), so a restarted agent under
 *    the same name resumes the same cursor: unacked prompts redeliver, acked
 *    ones are never replayed, and messages queued while offline deliver on
 *    return. deliver_policy All (see ensureConsumer) only takes effect when the
 *    consumer is first created — it is the offline queue for messages that
 *    predate the consumer (explicit ack, ack_wait 5-min redelivery window
 *    (ACK_WAIT_MS), max_deliver 3).
 *    The prompt is held UNACKED from receipt until its batch is settled at
 *    agent_settled — "processing" is literally ack-pending, and a crashed
 *    process redelivers instead of losing. A redelivery of a still-pending
 *    message is NOT dedupe-acked — the stream copy stays alive until its
 *    batch settles (see handlePrompt + batch.isPending). The one exception:
 *    "next turn" messages are acked as soon as pi's next-turn queue accepts
 *    them (see batch.ts injectNextTurn) — delivery from there on is pi's
 *    memory, exactly like pi's own nextTurn messages.
 *  - inbound batching: prompts queue on arrival; batch.ts drains the WHOLE
 *    queue in order into one active batch between turns, so a burst of
 *    concurrent prompts is answered in a single turn.
 *  - replies: a REPLY is a prompt marked with PromptPayload.reply_to_msg_id
 *    (comms_send with reply_to_msg_id). On receipt the sender resolves the
 *    msg_id against its own pending sends: a match records the reply as the
 *    result (readable via comms_outbox) and stops the reminder for that
 *    msg_id. A mismatch (foreign id / wrong sender) still arrives as an
 *    ordinary prompt but carries attempted_reply_to_msg_id. Replies are
 *    explicit — the responder must call comms_send(target=<sender>,
 *    reply_to_msg_id=…).
 *  - terminal states: a pending send ends when a reply arrives (ended/replied),
 *    its TTL passes (ended/expired), or the sender dismisses it via
 *    comms_dismiss (ended/dismissed — entry kept so a genuinely late reply
 *    still overwrites the result).
 *  - remind_s reminders: ONE shared scheduler (reminder.ts) ticks every ~30s
 *    and, when at least one send is due, calls the entry's injector ONCE with
 *    the full pending list (PendingInfo[]) — a single consolidated reminder
 *    turn instead of a per-msg storm. Entries expire at sentAt + stream TTL
 *    (setMessageTtlMs): expired sends stop being reminded and poll as
 *    "expired".
 *  - publishes carry msgID = msg_id, so a retried publish is deduped by the
 *    stream's duplicate window; redelivered prompts are deduped client-side.
 */

import {
	AckPolicy,
	DeliverPolicy,
	type Consumer,
	type JsMsg,
	nanos,
} from "nats";
import * as batch from "./batch.ts";
import type { DeliverAsValue, Identity, InboundContext, PendingReply, PromptPayload } from "./protocol.ts";
import {
	ACK_WAIT_MS,
	DEFAULT_SUBNET,
	MAX_ACK_PENDING,
	MAX_DELIVER,
	msgSubject,
	msgSubjectPrefix,
	parseDeliverAs,
	promptDurable,
	streamName,
	ulid,
} from "./protocol.ts";
import { getJs, getJsm } from "./nats.ts";
import { resolveName, statusOfName } from "./registry.ts";
import { audit } from "./audit.ts";
import { createReminderScheduler, fifoEvict, type ReminderEntry } from "./reminder.ts";
import * as history from "./history.ts";

// ━━ Module state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const pendingReplies = new Map<string, PendingReply>();
/** msg_ids already injected as prompts — dedupe redeliveries. */
const processedIds = new Set<string>();
const PROCESSED_CAP = 256;
/** Cap on parked pending replies — resolved and dismissed entries stay parked
 *  so comms_outbox can re-read the terminal result, but FIFO-evicted beyond
 *  this so a long session of send+get polling cannot grow memory without
 *  bound. An evicted msg_id polls as "unknown" to the caller. */
const PENDING_CAP = 256;

let shuttingDown = false;
/** Stream message TTL (entry wires it via setMessageTtlMs); 0 = not configured. */
let messageTtlMs = 0;
/** Subnet (communication domain) — wired via setSubnet (entry or
 *  startConsumers). Drives the no-identity lookups (listPendingReplies). */
let subnet = DEFAULT_SUBNET;
/** Entry-provided consolidated reminder injector (pi.sendMessage followUp, triggerTurn). */
let remindInjector: ((pending: PendingInfo[]) => void) | null = null;

/**
 * Shared reminder scheduler: one unref'd interval (~30s). Each tick it asks
 * for the pending entries and, when at least one send is due, calls the
 * injector ONCE with the full pending list — no per-msg reminder loops.
 * Inert (tick skipped) while shutting down or before the entry wires the
 * injector.
 */
const scheduler = createReminderScheduler({
	tickMs: 30_000,
	isSuspended: () => shuttingDown || !remindInjector,
	collect: () => {
		const out: ReminderEntry[] = [];
		for (const [msgId, p] of pendingReplies) {
			if (p.result) continue; // answered / dismissed — nothing to remind
			out.push({
				msg_id: msgId,
				sentAt: p.sentAt,
				remindS: p.remindS,
				lastRemindAt: p.lastRemindAt,
				expiresAt: messageTtlMs > 0 ? p.sentAt + messageTtlMs : null,
			});
		}
		return out;
	},
	onTick: () => remindInjector?.(listPendingReplies()),
	// onExpire deliberately omitted: expiry is visible via pollReply("expired")
	// and listPendingReplies (expires_in_ms), no extra notification needed.
});

export function setMessagingShuttingDown(v: boolean): void {
	shuttingDown = v;
}

/** Configure the stream message TTL (ms) — drives pending-send expiry. 0/omit disables. */
export function setMessageTtlMs(ms: number): void {
	messageTtlMs = ms;
}

/** Set the subnet (communication domain) for messaging — wired from the
 *  entry's config (and startConsumers). Used by no-identity lookups like
 *  listPendingReplies; sends use identity.subnet directly. */
export function setSubnet(s: string): void {
	subnet = s;
}

/** One parked, still-awaiting send with computed timing/status, for the
 *  consolidated reminder injector and the no-arg comms_outbox. */
export interface PendingInfo {
	msg_id: string;
	/** Peer NAME the send went to. */
	target: string;
	/** ms since the send was made. */
	elapsed_ms: number;
	/** Peer status at read time ("unknown" when the target name is missing). */
	target_status: "online" | "stale" | "offline" | "unknown";
	/** ms remaining until sentAt + TTL; null when no TTL configured. */
	expires_in_ms: number | null;
	/** Reminder cadence in seconds; 0 = reminder off. */
	remind_s: number;
}

/** One ended (reminder stopped) send, for the no-arg comms_outbox. */
export interface EndedInfo {
	msg_id: string;
	/** Peer NAME the send went to. */
	target: string;
	/** ms since the send was made. */
	elapsed_ms: number;
	/** Why the reminder stopped: replied / expired / dismissed / error. */
	reason: "replied" | "expired" | "dismissed" | "error";
}

/**
 * Register the entry's consolidated reminder injector. Called once during
 * session_start; the scheduler is inert (no reminder injection) until then.
 * The injector receives the full pending list at most once per scheduler
 * tick, and only on ticks where at least one send is due.
 */
export function setRemindInjector(injector: ((pending: PendingInfo[]) => void) | null): void {
	remindInjector = injector;
}

// ━━ Consumer lifecycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function ensureConsumer(stream: string, durable: string, filterSubject: string): Promise<Consumer> {
	const jsm = getJsm();
	try {
		await jsm.consumers.add(stream, {
			durable_name: durable,
			filter_subjects: [filterSubject],
			ack_policy: AckPolicy.Explicit,
			deliver_policy: DeliverPolicy.All,
			// Well below the stream max_age (message TTL) so max_deliver retries
			// actually get a chance to happen before the message ages out.
			ack_wait: nanos(ACK_WAIT_MS),
			max_deliver: MAX_DELIVER,
			max_ack_pending: MAX_ACK_PENDING,
		});
	} catch (err: any) {
		const code = err?.isJetStreamError?.() ? err.jsError()?.code : undefined;
		// 10014 = consumer exists (identical config is fine), 10105 = name in use.
		if (code !== 10014 && code !== 10105) throw err;
	}
	return getJs().consumers.get(stream, durable);
}

async function runConsumerLoop(
	stream: string,
	durable: string,
	filterSubject: string,
	onMsg: (m: JsMsg) => Promise<void> | void,
): Promise<void> {
	while (!shuttingDown) {
		try {
			const consumer = await ensureConsumer(stream, durable, filterSubject);
			const msgs = await consumer.consume();

			for await (const m of msgs) {
				try {
					await onMsg(m);
				} catch {
					try { m.nak(30_000); } catch { /* ignore */ }
				}
			}
			// Iterator ended without shutdown — consumer went away; recreate.
			if (!shuttingDown) {
				await new Promise((r) => setTimeout(r, 1_000));
			}
		} catch (err: any) {
			if (shuttingDown) return;
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}
}

/**
 * Start the durable prompt consumer. onPrompt is wired by the entry to
 * batch.enqueue (queue + drain). Replies arrive on the same subject with a
 * reply_to_msg_id marker — one consumer carries both.
 */
export async function startConsumers(
	identity: Identity,
	onPrompt: (inbound: InboundContext) => void,
): Promise<void> {
	setSubnet(identity.subnet);
	const stream = streamName(identity.subnet);

	void runConsumerLoop(stream, promptDurable(identity.name), msgSubjectPrefix(identity.subnet, identity.name), (m) => {
		handlePrompt(m, onPrompt, identity);
	});
}

// ━━ Prompt / reply inbound ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handlePrompt(m: JsMsg, onPrompt: (inbound: InboundContext) => void, identity: Identity): void {
	let payload: PromptPayload;
	try {
		payload = m.json<PromptPayload>();
	} catch {
		try { m.ack(); } catch { /* ignore */ }
		return;
	}
	const msgId = payload.msg_id;

	// Redelivery dedupe: this prompt was already received once. Ack the copy
	// ONLY when the message is no longer pending in the batch layer — a
	// message still queued or still in the in-flight batch keeps its stream
	// copy until its batch settles (dedupe-acking it would discard content
	// that was never injected).
	if (processedIds.has(msgId)) {
		if (batch.isPending(msgId)) return;
		try { m.ack(); } catch { /* ignore */ }
		return;
	}
	// FIFO eviction (not clear()): a redelivered old msg_id stays deduped for
	// as long as the set can hold it — nuking the whole set re-injects stale
	// redeliveries after >256 distinct messages.
	processedIds.add(msgId);
	if (processedIds.size > PROCESSED_CAP) {
		const oldest = processedIds.values().next().value;
		if (oldest) processedIds.delete(oldest);
	}

	const inbound: InboundContext = {
		msg_id: msgId,
		sender_name: payload.sender?.name ?? "unknown",
		sender_cwd: payload.sender?.cwd ?? "?",
		message: payload.message,
		// Unknown/missing deliver_as values normalize to undefined — the batch
		// then falls back to the default ("steer").
		deliver_as: parseDeliverAs(payload.deliver_as),
		jsMsg: m,
	};

	// Reply resolution: a reply_to_msg_id matching one of OUR pending sends
	// records the reply as that send's result and stops its reminder; the
	// message still gets injected as a normal turn — the reply content is what
	// the sender needs to see (batch.ts marks it as a reply). The match is on
	// the sender NAME (the stable identity): a sender that crashed and
	// restarted under the same name still resolves. Anything else — a stray or
	// forged reply_to_msg_id, or a mix-up between parallel conversations —
	// must NOT stop the reminder or overwrite the result; the message arrives
	// as an ordinary prompt with attempted_reply_to_msg_id set instead.
	if (payload.reply_to_msg_id) {
		inbound.reply_to_msg_id = payload.reply_to_msg_id;
		const pending = pendingReplies.get(payload.reply_to_msg_id);
		if (pending && pending.target_name === payload.sender?.name) {
			pending.result = { response: payload.message, error: null };
			pending.remindS = 0; // answered — never remind again
			pending.lastRemindAt = Date.now();
			scheduler.cancel(payload.reply_to_msg_id);
			inbound.reply_to_pending = true;
		} else {
			inbound.attempted_reply_to_msg_id = payload.reply_to_msg_id;
		}
	}

	// Persist inbound content + fold the reply into the out record (best-effort,
	// non-blocking — a history write must not delay or fail the injection path;
	// the message stays unacked with its batch regardless). Redeliveries re-enter
	// here and overwrite the same key — idempotent.
	void history.recordInbound(identity, inbound)
		.catch((err: any) => audit("history_write_failed", { direction: "in", msg_id: msgId, reason: err?.message ?? String(err) }));
	if (payload.reply_to_msg_id) {
		void history.recordReplyIntoOut(identity, payload.reply_to_msg_id, {
			msg_id: msgId,
			sender: inbound.sender_name,
			message: payload.message,
			ts: Date.now(),
		}).catch((err: any) => audit("history_write_failed", { direction: "reply", msg_id: msgId, reply_to: payload.reply_to_msg_id, reason: err?.message ?? String(err) }));
	}

	try {
		// The entry's onPrompt wrapper calls batch.enqueue (queue + drain);
		// if a turn is already active the prompt stays queued in batch.ts.
		onPrompt(inbound);
	} catch (err: any) {
		// Injection failed — batch.ts requeued the whole batch (this message
		// included) unacked, so do NOT ack the triggering message: it stays
		// with its batch for the next drain. Its dedupe mark is dropped too —
		// it was never actually injected, so a redelivery may re-enter.
		// (The batch's other members keep their marks: a successful retry
		// settles them, and if injection never recovers the process is
		// shutting down anyway.)
		processedIds.delete(msgId);
	}
}

// ━━ Outbound ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface SendResult {
	msg_id: string;
	/** Target status at send time (online / stale / offline) — the message is queued regardless. */
	target_status: "online" | "stale" | "offline";
}

export interface SendOptions {
	/**
	 * Reply mode: when set, this message is a REPLY to the pending send with
	 * this msg_id (comms_send(target=<original sender>, message=<reply>,
	 * reply_to_msg_id=<the msg_id you received>)). The sender resolves it against
	 * its own pending sends, records the reply, and stops the reminder.
	 */
	replyToMsgId?: string;
	/**
	 * Reminder interval in SECONDS. Default 0 (and omitted behaves the same):
	 * fire-and-forget — the publish and the comms_history record still
	 * happen, but NO pending entry is parked: no reply resolution, no
	 * reminder, no comms_outbox "waiting" entry, and the auto-exit guard is
	 * not armed.
	 * - > 0 (e.g. 300 = every 5 min): reminder armed — one consolidated
	 *   reminder whenever due, until reply, dismiss, eviction, TTL expiry or
	 *   shutdown.
	 */
	remindS?: number;
	/**
	 * Delivery mode at the target (wire DeliverAsValue, see protocol.ts):
	 * "steer" (default) — injected at the target's next LLM-call boundary /
	 * triggers a turn when idle; "follow-up" — after the target's current
	 * turn fully ends; "next turn" — delivered to pi's next-turn queue,
	 * injected at the start of the target's next turn, never triggers a turn
	 * (see batch.ts injectNextTurn).
	 */
	deliverAs?: DeliverAsValue;
}

export async function send(
	identity: Identity,
	target: string,
	message: string,
	opts?: SendOptions,
): Promise<SendResult> {
	// The name lease is the liveness check: an index entry existing == the
	// agent is heartbeating. The message address is the NAME itself (stable
	// across restarts), so a message published to a live agent is queued by
	// the stream up to its TTL even if the agent crashes right after.
	const resolved = await resolveName(identity.subnet, target);
	if (!resolved) {
		throw new Error(
			`comms: target not found: ${target} — check the exact name via comms_list_peer ` +
			`(names are case-sensitive and auto-suffixed on collision)`,
		);
	}

	const msgId = ulid();
	const payload: PromptPayload = {
		msg_id: msgId,
		subnet: identity.subnet,
		sender: {
			name: identity.name,
			cwd: identity.cwd,
		},
		message,
		reply_to_msg_id: opts?.replyToMsgId,
		deliver_as: opts?.deliverAs,
	};

	const pub = await getJs().publish(msgSubject(identity.subnet, target, msgId), JSON.stringify(payload), { msgID: msgId });
	if (!pub) {
		throw new Error(`comms: message publish to ${target} was not acknowledged`);
	}

	// Persist the outbound content (best-effort — history must never fail a
	// send that already published): comms_outbox re-reads this after a
	// compact or restart, when the in-memory pending table is gone.
	void history.recordOutbound(identity, target, msgId, message, opts?.replyToMsgId ?? null)
		.catch((err: any) => audit("history_write_failed", { direction: "out", msg_id: msgId, reason: err?.message ?? String(err) }));

	// Target status for the caller (comms_send's target_status): derived
	// from the peer profile cache; falls back to online when the profile is not
	// cached yet but the name lease resolved it (live == heartbeating). The
	// message is queued to the stream regardless — an offline target simply
	// redelivers on restart.
	const targetStatus = statusOfName(identity.subnet, target);

	const now = Date.now();
	// The reminder is armed only by an explicit remindS > 0 (seconds). Omitted
	// and 0 are equivalent fire-and-forget: publish and persist to history
	// but park nothing — one-way sends must not arm the auto-exit guard,
	// show up as comms_outbox "waiting" entries, or take up pending table
	// slots.
	const remindS = opts?.remindS ?? 0;
	const reminderArmed = remindS > 0;

	if (reminderArmed) {
		const pending: PendingReply = {
			target_name: target,
			sentAt: now,
			remindS,
			lastRemindAt: now,
		};

		pendingReplies.set(msgId, pending);

		// Reminder: arm through the shared scheduler (single interval for all
		// sends); the first reminder fires after remindS has elapsed.
		scheduler.arm(msgId);

		// FIFO cap: evict the oldest parked entry. The scheduler is shared, so
		// no per-key teardown is needed — an evicted entry just stops being
		// collected. A late reply to an evicted msg_id surfaces as an
		// orphan/unmatched reply; the caller polls it as unknown.
		fifoEvict(pendingReplies, PENDING_CAP, (evictedId) => {
			audit("pending_evicted", { msg_id: evictedId });
		});
	}

	return { msg_id: msgId, target_status: targetStatus };
}

// (batch acking lives in batch.ts — every drained batch member is acked
// there, so a crashed turn redelivers instead of being lost)

// ━━ Reminders / poll / cancel / pending list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Non-blocking status poll for comms_outbox. Three states:
 * - "waiting": still under reminder, no reply yet (remindS > 0 = reminder armed).
 * - "ended": reminder stopped — reason says why: "replied" (result in
 *   `result`), "expired" (sentAt + TTL passed, no reply), or "dismissed"
 *   (a late reply still overwrites `result`).
 * - "unknown": no parked entry (unknown msg_id, or FIFO-evicted).
 */
export function pollReply(msgId: string): {
	state: "waiting" | "ended" | "unknown";
	reason?: "replied" | "expired" | "dismissed" | "error";
	remindS: number;
	result?: { response?: any; error?: string | null };
} {
	const pending = pendingReplies.get(msgId);
	if (!pending) return { state: "unknown", remindS: 0 };
	if (pending.result) {
		if (!pending.result.error) return { state: "ended", reason: "replied", remindS: 0, result: pending.result };
		if (pending.result.error === "dismissed") return { state: "ended", reason: "dismissed", remindS: 0, result: pending.result };
		return { state: "ended", reason: "error", remindS: 0, result: pending.result };
	}
	if (messageTtlMs > 0 && Date.now() - pending.sentAt > messageTtlMs) return { state: "ended", reason: "expired", remindS: 0 };
	return { state: "waiting", remindS: pending.remindS };
}

/**
 * All parked sends still under reminder, with computed elapsed/status/expiry,
 * oldest first (used by the no-arg comms_outbox and the consolidated
 * reminder injector). Dismissed/replied/expired entries are excluded — they
 * are reported via listEndedReplies.
 */
export function listPendingReplies(): PendingInfo[] {
	const now = Date.now();
	const out: PendingInfo[] = [];
	for (const [msgId, p] of pendingReplies) {
		if (p.result) continue;
		if (messageTtlMs > 0 && now - p.sentAt > messageTtlMs) continue; // expired → ended
		out.push({
			msg_id: msgId,
			target: p.target_name,
			elapsed_ms: now - p.sentAt,
			target_status: p.target_name ? statusOfName(subnet, p.target_name) : "unknown",
			expires_in_ms: messageTtlMs > 0 ? Math.max(0, p.sentAt + messageTtlMs - now) : null,
			remind_s: p.remindS,
		});
	}
	out.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
	return out;
}

/**
 * All parked, ended sends (replied / expired / dismissed / error), oldest
 * first — the no-arg comms_outbox shows them in a separate section so the
 * pending list stays a pure to-do list.
 */
export function listEndedReplies(): EndedInfo[] {
	const now = Date.now();
	const out: EndedInfo[] = [];
	for (const [msgId, p] of pendingReplies) {
		let reason: EndedInfo["reason"];
		if (p.result) {
			reason = !p.result.error ? "replied" : p.result.error === "dismissed" ? "dismissed" : "error";
		} else if (messageTtlMs > 0 && now - p.sentAt > messageTtlMs) {
			reason = "expired";
		} else {
			continue; // still waiting — not ended
		}
		out.push({ msg_id: msgId, target: p.target_name, elapsed_ms: now - p.sentAt, reason });
	}
	out.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
	return out;
}

/**
 * Stop reminding on a parked msg_id (comms_dismiss): stops its reminder and
 * records it as ended/dismissed. Direction is implied by the msg_id: only
 * sends we made ourselves are parked here. The entry is KEPT parked with
 * result { error: "dismissed" }, so a genuinely late reply still overwrites
 * it with the real result.
 * Returns: "unknown" (no parked entry), "already_answered" (a real reply was
 * already recorded), or "dismissed".
 */
export function dismissReply(msgId: string): "dismissed" | "already_answered" | "unknown" {
	const pending = pendingReplies.get(msgId);
	if (!pending) return "unknown";
	if (pending.result && !pending.result.error) return "already_answered";
	scheduler.cancel(msgId);
	pending.result = { error: "dismissed" };
	pending.remindS = 0;
	return "dismissed";
}

/** Stop the shared reminder scheduler (shutdown). Returns how many sends were armed. */
export function clearAllReminders(): number {
	return scheduler.stopAll();
}
