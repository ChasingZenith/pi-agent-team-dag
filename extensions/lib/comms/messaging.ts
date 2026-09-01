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
 *    (ACK_WAIT_MS), max_deliver 3). inactive_threshold (1h, well above the
 *    message TTL) lets nats-server 2.10+ reap a durable whose name stops
 *    pulling for an hour — the offline-window restart still resumes the same
 *    cursor, and a recreated consumer only replays messages still in the TTL
 *    window (acked ones are already past it).
 *  - inject-then-ack: every prompt is injected into pi as it arrives and
 *    acked the moment injection succeeds — at-most-once delivery at the NATS
 *    layer; nothing is held ack-pending for a settle phase. A prompt whose
 *    injection throws stays UNACKED, so ack_wait redelivers it as the retry:
 *    a redelivered copy is dedupe-acked when the injection had already
 *    succeeded, re-injected when it had failed (max_deliver 3 bounds the
 *    retries). The one crash window — injected and acked, but the turn never
 *    answered — is covered by the sender's remind_s as a fallback.
 *  - replies: a REPLY is a prompt marked with PromptPayload.reply_to_msg_id
 *    (comms_send with reply_to_msg_id). On receipt the sender resolves the
 *    msg_id against its own pending sends: a match records the reply as the
 *    result (readable via comms_outbox) and stops the reminder for that
 *    msg_id. A mismatch (foreign id / wrong sender) still arrives as an
 *    ordinary prompt but carries attempted_reply_to_msg_id. Replies are
 *    explicit — the responder must call comms_send(target=<sender>,
 *    reply_to_msg_id=…).
 *  - reminders: a reminder is per-message, for ANY message — one you sent
 *    (awaiting a reply) or one you received (follow-up you want to act on).
 *    The item EXISTS only while its reminder is active; stopping the reminder
 *    DELETES the item. Reminders are pure scheduling state — no terminal
 *    status, no result, nothing persisted (a restart drops them; the message
 *    itself lives on in comms_history). ONE shared scheduler (reminder.ts)
 *    ticks every ~30s and, when at least one item is due, calls the entry's
 *    injector ONCE with the full active list (ActiveReminder[]) — a single
 *    consolidated reminder turn instead of a per-msg storm. Message TTL only
 *    surfaces in the UI (expires_in_ms / comms_outbox "expired"); it never
 *    suppresses a reminder — cancel/resend decisions stay with the agent.
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
import type { DeliverAsValue, Identity, InboundContext, PromptPayload } from "./protocol.ts";
import {
	ACK_WAIT_MS,
	CONSUMER_INACTIVE_THRESHOLD_MS,
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

/**
 * One active reminder item (pure scheduling state): present == a reminder is
 * armed for this msg_id, removed == stopped. Holds the per-item facts the
 * consolidated reminder turn shows (peer, direction, elapsed) plus a summary
 * so the injector never needs to touch history.
 */
interface ReminderItem {
	/** Which side of the conversation this message is on. */
	dir: "out" | "in";
	/** out: the peer we sent to; in: the peer we received from. */
	peer: string;
	/** ms epoch of the message (sent/received at) — out items expire at this + TTL. */
	ts: number;
	/** Reminder cadence in seconds; > 0 (items hold no 0: 0 == not in the map). */
	remindS: number;
	/** ms epoch when the reminder was last armed/retuned (drive the first fire). */
	armedAt: number;
	/** Single-line summary shown in the consolidated reminder. */
	summary: string;
}

/** Active reminders, keyed by message msg_id — only items with remindS > 0. */
const reminders = new Map<string, ReminderItem>();
/** msg_ids already injected as prompts — dedupe redeliveries. */
const processedIds = new Set<string>();
const PROCESSED_CAP = 256;
/** Cap on active reminder items — FIFO-evicted beyond this so a long session
 *  cannot grow memory without bound. An evicted item just loses its reminder
 *  (re-armable via remind(), which re-reads the message from history). */
const PENDING_CAP = 256;

let shuttingDown = false;
/** Stream message TTL (entry wires it via setMessageTtlMs); 0 = not configured. */
let messageTtlMs = 0;
/** Subnet (communication domain) — wired via setSubnet (entry or
 *  startConsumers). Drives the no-identity lookups (listActiveReminders). */
let subnet = DEFAULT_SUBNET;
/** Entry-provided consolidated reminder injector (pi.sendMessage followUp, triggerTurn). */
let remindInjector: ((pending: ActiveReminder[]) => void) | null = null;

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
		for (const [msgId, p] of reminders) {
			out.push({
				msg_id: msgId,
				remindS: p.remindS,
				lastRemindAt: p.armedAt,
			});
		}
		return out;
	},
	onTick: () => remindInjector?.(listActiveReminders()),
	// Message TTL is not the scheduler's concern: expiry surfaces via
	// expires_in_ms / comms_outbox, and the agent decides (cancel, resend).
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
 *  listActiveReminders; sends use identity.subnet directly. */
export function setSubnet(s: string): void {
	subnet = s;
}

/** One active reminder with computed timing/status, for the consolidated
 *  reminder injector, comms_outbox and the auto-exit guard. */
export interface ActiveReminder {
	msg_id: string;
	/** in = received, out = sent — "from x" vs "to x" in the reminder text. */
	dir: "out" | "in";
	/** Peer name (out: the target; in: the sender). */
	target: string;
	/** ms since the message was sent/received. */
	elapsed_ms: number;
	/** Peer status at read time ("unknown" when the name is missing). */
	target_status: "online" | "stale" | "offline" | "unknown";
	/** ms remaining until sentAt + TTL (out only); null when no TTL configured. */
	expires_in_ms: number | null;
	/** Reminder cadence in seconds. */
	remind_s: number;
	/** Single-line message summary. */
	summary: string;
}

/**
 * Register the entry's consolidated reminder injector. Called once during
 * session_start; the scheduler is inert (no reminder injection) until then.
 * The injector receives the full active list at most once per scheduler
 * tick, and only on ticks where at least one item is due.
 */
export function setRemindInjector(injector: ((pending: ActiveReminder[]) => void) | null): void {
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
			// Reap consumers of abandoned/renamed names (nats-server 2.10+): an
			// agent offline under a name for an hour stops having pull requests,
			// so the server deletes the durable. Well above the message TTL, so
			// normal offline windows keep the consumer and the restart resumes
			// the same cursor; a recreated consumer's deliver_policy: All only
			// replays messages still inside the TTL window — every acked one is
			// already past it.
			inactive_threshold: nanos(CONSUMER_INACTIVE_THRESHOLD_MS),
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
	onMsg: (m: JsMsg) => Promise<void>,
): Promise<void> {
	while (!shuttingDown) {
		try {
			const consumer = await ensureConsumer(stream, durable, filterSubject);
			const msgs = await consumer.consume();

			for await (const m of msgs) {
				// Inject concurrently: each prompt's own inject-then-ack stays
				// sequenced inside handlePrompt (a message is acked only after
				// ITS injection), but a slow injection never holds back the
				// prompts behind it — pi.sendMessage queues the calls in
				// arrival order, so delivery order is preserved. Injections
				// that fail stay unacked and rely on ack_wait redelivery; the
				// .catch below is a defensive guard (nak for prompt re-delivery).
				void onMsg(m).catch(() => {
					try { m.nak(30_000); } catch { /* ignore */ }
				});
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
 * Start the durable prompt consumer. The injector is wired by the entry to
 * pi.sendMessage: every arriving prompt is injected immediately and acked on
 * success (see handlePrompt). Replies arrive on the same subject with a
 * reply_to_msg_id marker — one consumer carries both.
 */
export async function startConsumers(
	identity: Identity,
	injector: (inbound: InboundContext) => Promise<void>,
): Promise<void> {
	setSubnet(identity.subnet);
	const stream = streamName(identity.subnet);

	void runConsumerLoop(stream, promptDurable(identity.name), msgSubjectPrefix(identity.subnet, identity.name), (m) => {
		// Each prompt is injected as it arrives (the loop does not await one
		// before the next); handlePrompt sequences the message's own
		// inject-then-ack, and pi's sendMessage queues calls in arrival order.
		return handlePrompt(m, injector, identity);
	});
}

// ━━ Prompt / reply inbound ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handlePrompt(m: JsMsg, injector: (inbound: InboundContext) => Promise<void>, identity: Identity): Promise<void> {
	let payload: PromptPayload;
	try {
		payload = m.json<PromptPayload>();
	} catch {
		try { m.ack(); } catch { /* ignore */ }
		return;
	}
	const msgId = payload.msg_id;

	// Redelivery dedupe: this prompt was already injected (and acked below).
	// Any copy that re-arrives — a lost ack, a racing redelivery — is acked
	// and dropped; never re-injected. (A redelivery after a FAILED injection
	// has no mark left: the catch below deletes it, so the retry re-enters.)
	if (processedIds.has(msgId)) {
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
		// Unknown/missing deliver_as values normalize to undefined — the
		// injector then falls back to the default ("steer").
		deliver_as: parseDeliverAs(payload.deliver_as),
		jsMsg: m,
	};

	// Reply resolution: a reply_to_msg_id matching one of OUR active out
	// reminders stops that reminder; the reply is folded into the out history
	// record below (outbox derives replied from it) and the message still gets
	// injected as a normal turn — the reply content is what the sender needs
	// to see (inbound.reply_to_pending marks it as a reply). The match is on the sender NAME
	// (the stable identity): a sender that crashed and restarted under the
	// same name still resolves. Anything else — a stray or forged
	// reply_to_msg_id, or a mix-up between parallel conversations — must NOT
	// stop the reminder; the message arrives as an ordinary prompt with
	// attempted_reply_to_msg_id set instead.
	if (payload.reply_to_msg_id) {
		inbound.reply_to_msg_id = payload.reply_to_msg_id;
		const item = reminders.get(payload.reply_to_msg_id);
		if (item && item.dir === "out" && item.peer === payload.sender?.name) {
			reminders.delete(payload.reply_to_msg_id);
			scheduler.cancel(payload.reply_to_msg_id);
			inbound.reply_to_pending = true;
		} else {
			inbound.attempted_reply_to_msg_id = payload.reply_to_msg_id;
		}
	}

	// Persist inbound content + fold the reply into the out record (best-effort,
	// non-blocking — a history write must not delay or fail the injection path).
	// Redeliveries re-enter here and overwrite the same key — idempotent.
	void history.recordInbound(identity, inbound)
		.catch((err: any) => audit("history_write_failed", { direction: "in", msg_id: msgId, reason: err?.message ?? String(err) }));
	if (payload.reply_to_msg_id) {
		void history.recordReplyIntoOut(identity, payload.reply_to_msg_id, {
			msg_id: msgId,
			sender: inbound.sender_name,
			ts: Date.now(),
		}).catch((err: any) => audit("history_write_failed", { direction: "reply", msg_id: msgId, reply_to: payload.reply_to_msg_id, reason: err?.message ?? String(err) }));
	}

	// Inject into pi, then ack on success. The injector is AWAITED — the
	// message reaches pi (pi.sendMessage) before it is acked, and the
	// consumer loop waits for each injection before delivering the next.
	try {
		await injector(inbound);
		try { m.ack(); } catch { /* ignore */ }
	} catch {
		// Injection failed: the message stays UNACKED, so NATS redelivers it
		// on ack_wait and the retry re-enters handlePrompt from the top. The
		// dedupe mark is dropped — it was never actually injected, so the
		// redelivered copy may be re-injected. Not rethrown: redelivery IS
		// the retry mechanism (a throw here would only surface in the
		// consumer loop and nak it again).
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
	 * no reminder — the publish and the comms_history record still happen,
	 * but NO reminder item is registered: no reminder, no comms_outbox
	 * "waiting" entry, and the auto-exit guard is not armed.
	 * (Later armable via remind(): the message is re-read from history.)
	 * - > 0 (e.g. 300 = every 5 min): reminder armed — one consolidated
	 *   reminder whenever due, until a reply arrives, the user stops it via
	 *   remind(..., 0), eviction, TTL expiry or shutdown.
	 */
	remindS?: number;
	/**
	 * Delivery mode at the target (wire DeliverAsValue, see protocol.ts):
	 * "steer" (default) — injected at the target's next LLM-call boundary /
	 * triggers a turn when idle; "followUp" — after the target's current
	 * turn fully ends.
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
	// A reminder is armed only by an explicit remindS > 0 (seconds). Omitted
	// and 0 are equivalent no-reminder sends: publish and persist to history
	// but register no reminder — one-way sends must not arm the auto-exit
	// guard or take up reminder slots. (Later armable via remind(): the
	// message is re-read from history.)
	const remindS = opts?.remindS ?? 0;

	if (remindS > 0) {
		reminders.set(msgId, {
			dir: "out",
			peer: target,
			ts: now,
			remindS,
			armedAt: now,
			summary: history.flatten(message, 48),
		});

		// Arm through the shared scheduler (single interval for all reminders);
		// the first reminder fires after remindS has elapsed.
		scheduler.arm(msgId);

		// FIFO cap: evict the oldest entry. The scheduler is shared, so no
		// per-key teardown is needed — an evicted entry just stops being
		// collected (re-armable later via remind()).
		fifoEvict(reminders, PENDING_CAP, (evictedId) => {
			audit("pending_evicted", { msg_id: evictedId });
		});
	}

	return { msg_id: msgId, target_status: targetStatus };
}

// (Prompt acking happens in handlePrompt — a message is acked the moment its
// injection succeeds; a failed injection stays unacked and retries via ack_wait.)

// ━━ Reminders ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Set, retune, or stop the reminder on ANY message (comms_remind) — one we
 * sent or one we received, at any stage of its life (including replied or
 * past-TTL ones: arming a reminder means "remind me about this thread" — a
 * reminder is cancelled automatically only when a reply ARRIVES). remindS > 0
 * creates/retunes the item (same shape as the send-side registration in
 * send()); remindS 0 deletes it (stop). Unknown msg_ids are resolved against
 * comms_history (out first, then in), so a no-reminder send or a received
 * message can be armed later, and a FIFO-evicted reminder re-armed.
 * Stopping a message that has no armed reminder is an idempotent success:
 * the target state ("no reminder") already holds, so it answers "stopped"
 * with wasArmed=false. Only a msg_id absent from comms_history entirely
 * answers "unknown" — message STATUS (replied / expired) is comms_outbox's
 * job, not this tool's.
 */
export async function remind(
	identity: Identity,
	msgId: string,
	seconds: number,
): Promise<{ outcome: "reminded" | "stopped" | "unknown"; wasArmed: boolean }> {
	const remindS = Math.max(0, Math.min(3600, Math.floor(seconds)));

	const existing = reminders.get(msgId);
	if (existing) {
		if (remindS === 0) {
			reminders.delete(msgId);
			scheduler.cancel(msgId);
			return { outcome: "stopped", wasArmed: true };
		}
		// Retune: keep the item, refresh the cadence and the reminder clock.
		existing.remindS = remindS;
		existing.armedAt = Date.now();
		scheduler.arm(msgId);
		return { outcome: "reminded", wasArmed: true };
	}

	// Not active — resolve the message from history so any message can be
	// reminded, whichever direction or stage of its life it is in. (No TTL
	// check: even an expired message may be worth a "resend this" reminder —
	// expiry only shows up as a status in comms_outbox.)
	const out = await history.getOutbound(identity.subnet, identity.name, msgId);
	let item: ReminderItem | null = null;
	if (out) {
		if (remindS === 0) return { outcome: "stopped", wasArmed: false }; // nothing armed — idle stop
		item = { dir: "out", peer: out.target, ts: out.ts, remindS, armedAt: Date.now(), summary: history.flatten(out.message, 48) };
	} else {
		const inp = await history.getInbound(identity.subnet, identity.name, msgId);
		if (!inp) return { outcome: "unknown", wasArmed: false };
		if (remindS === 0) return { outcome: "stopped", wasArmed: false }; // nothing armed — idle stop
		item = { dir: "in", peer: inp.sender, ts: inp.ts, remindS, armedAt: Date.now(), summary: history.flatten(inp.message, 48) };
	}
	reminders.set(msgId, item);

	// Arm through the shared scheduler; the first reminder fires after remindS.
	scheduler.arm(msgId);
	// FIFO cap (re-armable via a later remind() — this one is fresh).
	fifoEvict(reminders, PENDING_CAP, (evictedId) => {
		audit("pending_evicted", { msg_id: evictedId });
	});
	return { outcome: "reminded", wasArmed: false };
}

/**
 * All active reminders, oldest first (used by the consolidated reminder
 * injector, the auto-exit guard and comms_outbox list mode). Only items with
 * remindS > 0 live in the map, so this IS the active set — including past-TTL
 * out items, which carry expires_in_ms = 0 so the injector can mark them
 * expired (the agent decides, not the scheduler).
 */
export function listActiveReminders(): ActiveReminder[] {
	const now = Date.now();
	const out: ActiveReminder[] = [];
	for (const [msgId, p] of reminders) {
		out.push({
			msg_id: msgId,
			dir: p.dir,
			target: p.peer,
			elapsed_ms: now - p.ts,
			target_status: p.peer ? statusOfName(subnet, p.peer) : "unknown",
			expires_in_ms: p.dir === "out" && messageTtlMs > 0 ? Math.max(0, p.ts + messageTtlMs - now) : null,
			remind_s: p.remindS,
			summary: p.summary,
		});
	}
	out.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
	return out;
}

/** Remind cadence (s) for one msg_id, or null when no active reminder — used
 *  by comms_outbox detail mode to overlay the "remind N" marker on top of the
 *  history-derived status. */
export function getActiveRemindS(msgId: string): number | null {
	const p = reminders.get(msgId);
	if (!p) return null;
	return p.remindS;
}

/** Stop the shared reminder scheduler (shutdown). Returns how many items were armed. */
export function clearAllReminders(): number {
	return scheduler.stopAll();
}
