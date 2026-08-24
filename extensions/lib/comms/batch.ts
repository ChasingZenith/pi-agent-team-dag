/**
 * comms — batch state machine: inbound queue + active-batch lifecycle.
 *
 * Single owner of the batch model (queue + active batch + turn gate + prompt
 * assembly):
 *
 *   - inboundQueue: prompts arriving via the durable consumer queue here,
 *     held unacked until their batch is settled at agent_settled ("processing"
 *     is literally ack-pending; a crashed process redelivers instead of losing).
 *   - tryDrain: whenever no batch turn is in flight (activeBatch null) the
 *     WHOLE queue is drained in insertion order into one active batch and
 *     injected, so a burst of concurrent prompts is answered together instead
 *     of the latest prompt silently winning.
 *   - delivery mode: a drained batch is split by deliver_as and each group
 *     is injected with its OWN pi mode — steer members (including
 *     unspecified ones, which default to steer) in one "steer" injection,
 *     then follow-up members in a "followUp" injection. No member's mode is
 *     ever rewritten or promoted (a follow-up member is never injected as
 *     steer), matching pi's sendMessage. The order — steer first, follow-up
 *     second — mirrors pi's own consumption order (the steering queue
 *     drains at every LLM boundary, the follow-up queue only when the agent
 *     would stop). "next turn" never enters the batch: enqueue routes it
 *     straight to pi's next-turn queue (deliverAs "nextTurn" — pi schedules
 *     the injection at the target's next turn; it does NOT trigger a turn,
 *     so it must not go through the turn gate, which is released only by
 *     agent_settled).
 *   - releaseTurn: the entry calls it at pi's agent_settled — NOT agent_end
 *     (the run-active flag is reset right before the event is emitted;
 *     agent_end listeners still run inside the active run). The answered
 *     batch is settled by the entry first, the gate opens, and anything
 *     that queued during the turn drains into the next batch.
 *   - crash safety: batches gate unacked until their settle at agent_settled,
 *     and a crashed process redelivers anything unacked. While a message is
 *     pending (queued or in the in-flight batch), redeliveries are NOT
 *     dedupe-acked (messaging.handlePrompt + isPending) — the stream copy
 *     stays alive until the batch settles. The one exception: a "next turn"
 *     message is acked as soon as pi's queue accepts it (injectNextTurn) —
 *     its delivery is pi's memory, exactly like pi's own nextTurn messages.
 *
 * Zero Pi dependencies: only protocol.ts types. Everything here is plain
 * state + function calls; auditing is done by the callers (messaging / the
 * entry extension), not here.
 */

import type { InboundContext } from "./protocol.ts";

/**
 * pi.sendMessage deliverAs values (pi-internal names). The batch layer
 * injects per delivery-mode group with the group's own mode ("steer" /
 * "followUp" — see tryDrain) and routes "next turn" straight to pi's
 * next-turn queue (see enqueue) — nothing is promoted or rewritten.
 */
export type PiDeliverAs = "steer" | "followUp" | "nextTurn";

// ━━ Module state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Prompts waiting for the next turn (insertion order). */
const inboundQueue = new Map<string, InboundContext>();
/**
 * The batch the agent's current turn is answering (drained from the queue).
 * Non-null while a batch-injected turn is in flight — it IS the turn gate:
 * tryDrain refuses to drain while it is set. Cleared by settleBatch at
 * agent_settled (the only release; injection failures narrow it to the
 * groups that actually made it into pi).
 */
let activeBatch: InboundContext[] | null = null;
/**
 * Entry-provided injector: wraps pi.sendMessage (customType "comms-inbound",
 * content = buildBatchPrompt, details msg_ids/sender_names, deliverAs =
 * the group's own pi mode — see tryDrain, triggerTurn true). While unset,
 * drained batches are settled (acked) directly instead of injected — senders
 * get no answer (their remind_ms reminders keep firing).
 */
let batchInjector: ((batch: InboundContext[], message: string, deliverAs: PiDeliverAs) => void) | null = null;

// ━━ Public API (the entry's only contract — nothing else to initialise) ━━━━

/**
 * Register the entry's batch injector (see module state above). Called once
 * during session_start; batches settle as ack-only until then. The injector
 * is called once PER delivery-mode group with that group's own pi mode —
 * "steer" then "followUp" (see tryDrain; a member's mode is never promoted).
 */
export function setBatchInjector(inject: (batch: InboundContext[], message: string, deliverAs: PiDeliverAs) => void): void {
	batchInjector = inject;
}

/**
 * Queue an inbound prompt and try to drain the queue into a batch. Called by
 * messaging.handlePrompt via the entry's onPrompt wrapper. If the drain's
 * injection throws (the gate is released first), the error propagates to the
 * caller, which drops the message's dedupe mark so a redelivery may re-enter.
 *
 * "next turn" messages never enter the queue: they are routed straight to
 * pi's next-turn queue (injectNextTurn) — pi schedules the injection at the
 * target's next turn and does NOT trigger one, so these must not go through
 * the turn gate (released only by agent_settled; a next-turn injection
 * causes no turn and the gate would never open again).
 */
export function enqueue(inbound: InboundContext): void {
	if (inbound.deliver_as === "next turn") {
		injectNextTurn(inbound);
		return;
	}
	inboundQueue.set(inbound.msg_id, inbound);
	tryDrain();
}

/** The batch the agent's current turn is answering, or null between turns. */
export function getActiveBatch(): InboundContext[] | null {
	return activeBatch;
}

/**
 * Ack every member of a finished batch (and only them). Ack failures are
 * swallowed; the active batch is cleared when it matches, so a late settle of
 * a previous batch cannot clear the next one.
 */
export function settleBatch(batch: InboundContext[]): void {
	for (const inbound of batch) {
		try { inbound.jsMsg.ack(); } catch { /* ignore */ }
	}
	if (activeBatch === batch) activeBatch = null;
}

/**
 * True while a received message is still pending delivery: queued (waiting
 * behind the turn gate) or a member of the in-flight batch. Messaging
 * consults this before dedupe-acking a redelivery — a pending message must
 * keep its stream copy until its batch settles (acking the redelivery would
 * discard the copy while the content was never injected, breaking the crash
 * fallback). False once settled. "next turn" messages are acked as soon as
 * they reach pi's queue (injectNextTurn), so they never count as pending.
 */
export function isPending(msgId: string): boolean {
	if (inboundQueue.has(msgId)) return true;
	return activeBatch?.some((i) => i.msg_id === msgId) ?? false;
}

/**
 * End-of-turn: called by the entry at pi's agent_settled, after it settled
 * the answered batch (settleBatch already cleared the gate — activeBatch).
 * This just drains anything that queued during the turn. (A throwing
 * injector propagates here too; the entry's handler may want to guard it.)
 */
export function releaseTurn(): void {
	tryDrain();
}

/**
 * TEST-ONLY: reset all module state (inbound queue, active batch, injector).
 * Lets a single imported module instance serve many independent tests.
 * Never called from extension code.
 */
export function resetForTest(): void {
	inboundQueue.clear();
	activeBatch = null;
	batchInjector = null;
}

// ━━ Internals ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Assemble the injected-turn prompt for a batch. Single inbound: one framed
 * message; multiple: numbered sections handled together.
 *
 * The framing shows each message's msg_id — the address a reply needs — and
 * marks protocol state: messages that ARE replies to one of our pending sends
 * (reply_to_pending) are labelled as replies to the pending msg_id (this
 * breaks the ping-pong loop); messages that CLAIMED to be a reply but matched
 * no pending send (attempted_reply_to_msg_id) get a mismatch note instead of
 * being silently treated as ordinary prompts.
 */
function buildBatchPrompt(batch: InboundContext[]): string {
	if (batch.length === 1) {
		const inbound = batch[0];
		if (inbound.reply_to_pending) {
			return (
				`[inbound comms message: this is ${inbound.sender_name}'s reply to your comms_send(msg_id=${inbound.reply_to_msg_id})]\n\n` +
				`${inbound.message}`
			);
		}
		return (
			`[inbound comms message from ${inbound.sender_name} @ ${inbound.sender_cwd} msg_id=${inbound.msg_id}]\n` +
			mismatchedReplyNote(inbound) +
			`\n${inbound.message}`
		);
	}
	const msgs = batch.map((inbound, i) => {
		if (inbound.reply_to_pending) {
			return (
				`[msg ${i + 1} — ${inbound.sender_name}'s reply to your msg_id ${inbound.reply_to_msg_id}]\n${inbound.message}`
			);
		}
		return (
			`[msg ${i + 1} from ${inbound.sender_name} @ ${inbound.sender_cwd} msg_id=${inbound.msg_id}]\n` +
			mismatchedReplyNote(inbound) +
			`${inbound.message}`
		);
	}).join("\n\n");
	return (
		`[inbound comms: ${batch.length} message(s) from your peers — handle them together in this one turn]\n\n` +
		msgs
	);
}

/**
 * When a message claimed to be a reply to one of our sends but the msg_id did
 * not resolve (foreign id / wrong sender), surface the mismatch instead of
 * silently injecting it as an ordinary prompt. Empty string when the message
 * is a genuine plain message.
 */
function mismatchedReplyNote(inbound: InboundContext): string {
	if (!inbound.attempted_reply_to_msg_id) return "";
	return (
		`[note: this message was marked as a reply to your msg_id=${inbound.attempted_reply_to_msg_id}, ` +
		`but it did not match your pending sends — treat it as a normal message; ` +
		`use comms_outbox(msg_id=${inbound.attempted_reply_to_msg_id}) to check]\n`
	);
}

/** Drain the whole queue (insertion order) into one batch for a single turn. */
function takeAll(): InboundContext[] {
	if (inboundQueue.size === 0) return [];
	const batch = [...inboundQueue.values()];
	inboundQueue.clear();
	activeBatch = batch;
	return batch;
}

/**
 * Drain the whole queue into one batch and inject it, if no batch turn is in
 * flight (the gate — activeBatch — is held until settleBatch at
 * agent_settled; tryDrain is synchronous, so the gate cannot change between
 * the check and the injections). Without an injector, settles the batch
 * directly (senders observe a timeout). "next turn" messages never reach
 * this path (enqueue routes them to injectNextTurn).
 *
 * Delivery mode: the batch is split by deliver_as (splitByDeliverAs) and
 * each group is injected separately with its own mode — the steer group
 * (messages without a mode default to steer) first, then the follow-up
 * group. A member's mode is never rewritten: a follow-up member is injected
 * as "followUp", exactly like pi's sendMessage would. Both groups belong to
 * the same active batch and settle together at agent_settled.
 *
 * On injector failure: groups that already made it into pi stay the active
 * batch (their run still ends at agent_settled, which settles them); only
 * the groups that never got injected are requeued (still unacked) for the
 * next drain, and the error rethrown. If nothing was injected, activeBatch
 * stays null and the gate is open again right away.
 */
function tryDrain(): void {
	if (activeBatch) return;
	const batch = takeAll();
	if (batch.length === 0) return;
	if (!batchInjector) {
		settleBatch(batch);
		return;
	}
	const { steer, followUp } = splitByDeliverAs(batch);
	const injected: InboundContext[] = [];
	try {
		if (steer.length > 0) {
			batchInjector(steer, buildBatchPrompt(steer), "steer");
			injected.push(...steer);
		}
		if (followUp.length > 0) {
			batchInjector(followUp, buildBatchPrompt(followUp), "followUp");
			injected.push(...followUp);
		}
	} catch (err) {
		const injectedIds = new Set(injected.map((i) => i.msg_id));
		const notInjected = batch.filter((i) => !injectedIds.has(i.msg_id));
		// What was injected stays the active batch (agent_settled settles it —
		// the entry must not ack messages the agent never saw); the rest goes
		// back at the head of the queue for the next drain.
		activeBatch = injected.length > 0 ? injected : null;
		if (notInjected.length > 0) requeue(notInjected);
		throw err;
	}
}

/**
 * Split a drained batch into delivery-mode groups. Members without a mode
 * (or unknown wire values — parseDeliverAs normalized them) default to
 * steer, the pi default. The groups are injected separately (see tryDrain)
 * so every member keeps its own delivery mode; nothing is promoted.
 * "next turn" never reaches a batch — enqueue routes it away before
 * queuing, so this only ever sees "steer" / "follow-up" / undefined.
 */
function splitByDeliverAs(batch: InboundContext[]): { steer: InboundContext[]; followUp: InboundContext[] } {
	const steer: InboundContext[] = [];
	const followUp: InboundContext[] = [];
	for (const inbound of batch) {
		if (inbound.deliver_as === "follow-up") followUp.push(inbound);
		else steer.push(inbound);
	}
	return { steer, followUp };
}

/**
 * Deliver a "next turn" message straight to pi's next-turn queue, bypassing
 * the batch gate. pi's sendMessage(nextTurn) only enqueues (it never triggers
 * a turn — the message is injected at the target's next turn, whenever that
 * is), so there is no agent_settled to release a gate here: the message is
 * acked immediately once pi has accepted it. A failure leaves it unacked so
 * NATS redelivery re-enters enqueue and retries.
 */
function injectNextTurn(inbound: InboundContext): void {
	if (!batchInjector) {
		// No session to deliver into — ack-only settle (senders observe a timeout).
		settleBatch([inbound]);
		return;
	}
	batchInjector([inbound], buildBatchPrompt([inbound]), "nextTurn");
	settleBatch([inbound]);
}

/** Put a failed batch back at the front of the queue, keeping insertion order. */
function requeue(batch: InboundContext[]): void {
	const queued = [...inboundQueue.entries()];
	inboundQueue.clear();
	for (const inbound of batch) inboundQueue.set(inbound.msg_id, inbound);
	for (const [msgId, inbound] of queued) inboundQueue.set(msgId, inbound);
}
