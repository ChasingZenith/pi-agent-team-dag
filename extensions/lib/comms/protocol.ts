/**
 * comms — shared protocol (types + subject/stream/bucket templates + constants).
 *
 * Pure module: no I/O, no pi imports. Imported by the client extension
 * (extensions/comms.ts + extensions/lib/comms/*) and by the server side
 * (scripts/comms-nats/up.sh). This is the single source of truth for the
 * NATS/JetStream topology. The subnet dimension (a comms network's
 * independent communication domain — agents in different subnets can't see
 * each other) is parameterised through every template function below; the
 * default subnet is "subnet0":
 *
 *   stream  COMMS_<subnet>             subjects <subnet>.msg.>
 *   bucket  comms_profiles               keys a.<subnet>.<name> (profile = lifecycle
 *                                     record, no TTL — offline/exited agents stay visible;
 *                                     liveness derived from lifecycle + last_seen_at)
 *   bucket  comms_history             keys h.<subnet>.<name>.<out|in>.<msg_id>
 *                                     (bidirectional message content history, bucket TTL)
 *   message <subnet>.msg.<targetname>.<msgid>
 *   reply   a REPLY is a message marked with PromptPayload.reply_to_msg_id pointing
 *                                     at the msg_id it answers.
 *
 * Addressing: every durable address (message subject, prompt consumer, history
 * key) is derived from the agent NAME — the agent's stable identity — not from
 * any per-process id. A restarted agent under the same name reuses the same
 * consumer and history keys, so crash redelivery, queued delivery and outbox
 * re-read all survive a restart (up to the stream/history TTLs). The name is
 * unique per subnet (exclusive claim + collision suffix), and sanitized before
 * use as a NATS segment.
 *
 * Single source of truth: ONE entry per agent (the profile) carries the name
 * claim and the lifecycle state ("living" | "gracefully_exited") —
 * addressability (the entry exists) and status (derived from lifecycle +
 * last_seen_at) always come from the same snapshot. A name is released when
 * a claimant reads a dead holder: a gracefully_exited entry (immutable
 * terminal state) or a living entry whose last_seen_at is older than
 * reclaimAfterMs (presumed crashed).
 */

import type { JsMsg } from "nats";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Root of all comms state. PI_COMMS_DIR overrides the default so tests
 * and the bash launcher (scripts/comms-nats/up.sh) can redirect the whole
 * directory in one place. `just check-paths` verifies up.sh matches.
 */
export const COMMS_DIR =
	process.env.PI_COMMS_DIR ?? path.join(os.homedir(), ".pi", "comms");
/** Single secret file for the local NATS server. */
export const SECRET_FILE = path.join(COMMS_DIR, "server.secret.json");
/** Where up.sh caches the downloaded nats-server binary. */
export const BIN_DIR = path.join(COMMS_DIR, "bin");
/** Where up.sh writes the nats-server runtime config. */
export const SERVER_CONF_FILE = path.join(COMMS_DIR, "nats-server.conf");
/** Where up.sh points JetStream storage. */
export const JETSTREAM_DIR = path.join(COMMS_DIR, "jetstream");

export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";
/** Default communication domain. Agents in different subnets are isolated
 *  (separate streams/subjects/KV keys) — pass --subnet to join a specific one. */
export const DEFAULT_SUBNET = "subnet0";
export const DEFAULT_HEARTBEAT_MS = 10_000;
/** No heartbeat for this long → the peer is OFFline (status derived from
 *  last_seen_at — a single threshold; there is no intermediate state). Kept
 *  small so status converges fast; NOT used for name reclaim. */
export const DEFAULT_OFFLINE_AFTER_MS = 60_000;
/** No heartbeat for this long → the name claim of a living-profiled agent is
 *  presumed dead and reclaimable (register's collision path steals it). Kept
 *  deliberately larger than OFFLINE_AFTER_MS: a steal must never fire on a
 *  merely slow/lagging agent — only on a deeply-gone one. */
export const DEFAULT_RECLAIM_AFTER_MS = 10 * 60_000;
export const DEFAULT_MESSAGE_TTL_MS = 1_800_000; // 30 min
/** How long the message content history bucket keeps records (comms_history
 *  bucket TTL — applied on first creation; changing it requires deleting the
 *  bucket). Long enough to cover compact + restart re-reads. */
export const DEFAULT_HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Two buckets with deliberately different lifetimes (see the header):
//   comms_profiles — permanent (no TTL): lifecycle record, the single source
//                   of truth for the name claim AND the status.
//   comms_history — bidirectional message content history (bucket TTL, default
//                   24h): outbox/inbox re-read content after compact/restart.
export const KV_BUCKET_PROFILES = "comms_profiles";
export const KV_BUCKET_HISTORY = "comms_history";
const STREAM_PREFIX = "COMMS_";

/** Cap on prompt redeliveries before the stream discards the message. */
export const MAX_DELIVER = 3;
/** Max unacked prompt messages in flight per agent. */
export const MAX_ACK_PENDING = 50;
/**
 * Per-delivery redelivery window (consumer ack_wait). Kept well below the
 * stream message TTL so max_deliver retries actually happen before the
 * message ages out — with ack_wait == max_age the 2nd delivery races the TTL
 * expiry and the 3rd can never occur.
 */
export const ACK_WAIT_MS = 5 * 60_000;
/**
 * Consumer inactivity threshold (nats-server 2.10+): a consumer with no pull
 * request for this long is auto-deleted by the server. Kept well above the
 * message TTL: an offline period within an hour leaves the durable consumer in
 * place, so a restart resumes the same cursor. Beyond it the consumer is
 * reaped — the recreated one starts with deliver_policy: All over the stream
 * window, which is safe because every acked message is already past the TTL
 * (> 30 min ago), so only messages that arrived while the agent was gone are
 * replayed. This is the reaper for abandoned/renamed agent names.
 */
export const CONSUMER_INACTIVE_THRESHOLD_MS = 60 * 60_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ━━ Name sanitisation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NATS subjects, stream names and KV keys share restricted charsets:
// subjects cannot contain `.` ` ` `*` `>`, stream/durable names are
// [A-Za-z0-9_-], KV bucket names are [-\w]+. The subnet is a runtime value
// (CLI flag, default "subnet0"), so only agent names still need sanitisation —
// reject early with a clear error instead of surfacing a confusing NATS error
// later.

export function sanitizeAgentName(name: string): string {
	// Names become a KV key segment; keep them subject-safe.
	const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "-");
	return cleaned.length > 0 ? cleaned : "agent";
}

// ━━ Topology templates (subnet parameterised; DEFAULT_SUBNET when omitted) ━━

/**
 * Stream name for a subnet. One stream per subnet: TTL/quotas/message volume
 * are isolated per communication domain. `streamSubjects()` MUST cover every
 * subject `msgSubject()` can produce for the same subnet — both are derived
 * here so the stream config and the publish subject cannot drift apart.
 */
export function streamName(subnet: string = DEFAULT_SUBNET): string {
	return STREAM_PREFIX + subnet;
}

/**
 * Profile key is the agent NAME, not the session id: one entry per name, and
 * reclaiming a name overwrites the old profile — no duplicate profiles for a
 * restarted agent. The entry persists even after the agent goes offline
 * (profiles bucket has no TTL) — it is the tombstone that keeps dead agents
 * visible and their last state readable.
 */
export function profileKey(subnet: string, name: string): string {
	return `a.${subnet}.${sanitizeAgentName(name)}`;
}

/** History key for a message WE sent (outbox direction). Name-anchored: the
 *  record stays readable across restarts of the same agent. */
export function historyOutKey(subnet: string, name: string, msgId: string): string {
	return `h.${subnet}.${sanitizeAgentName(name)}.out.${msgId}`;
}

/** History key for a message we RECEIVED (inbox direction). */
export function historyInKey(subnet: string, name: string, msgId: string): string {
	return `h.${subnet}.${sanitizeAgentName(name)}.in.${msgId}`;
}

/** Watch/list filter prefixes for our own outbound / inbound history. */
export function historyOutPrefix(subnet: string, name: string): string {
	return `h.${subnet}.${sanitizeAgentName(name)}.out.`;
}

export function historyInPrefix(subnet: string, name: string): string {
	return `h.${subnet}.${sanitizeAgentName(name)}.in.`;
}

/** Watch filter prefix for all profiles in a subnet. */
export function profileKeyPrefix(subnet: string): string {
	return `a.${subnet}.>`;
}

/** Message subject for a target agent (addressed by NAME — the stable agent
 *  identity; the stream holds the message up to its TTL, and a restarted
 *  agent under the same name consumes it). */
export function msgSubject(subnet: string, targetName: string, msgId: string): string {
	return `${subnet}.msg.${sanitizeAgentName(targetName)}.${msgId}`;
}

/** Subjects the message stream must capture (see streamName). */
export function streamSubjects(subnet: string): string[] {
	return [`${subnet}.msg.>`];
}

export function msgSubjectPrefix(subnet: string, name: string): string {
	return `${subnet}.msg.${sanitizeAgentName(name)}.>`;
}

/** Durable prompt consumer for an agent, named after the agent itself. The
 *  consumer persists across restarts (clean shutdown does NOT delete it —
 *  the profile entry just becomes a terminal tombstone), so a restart under
 *  the same name resumes the same cursor: unacked prompts redeliver, acked
 *  ones are never replayed, and messages queued while offline deliver on
 *  return. */
export function promptDurable(name: string): string {
	return `p_${sanitizeAgentName(name)}`;
}

// ━━ Shared types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type AgentStatus = "online" | "offline";

/**
 * Lifecycle of an agent, as WRITTEN by the agent itself:
 *   living — the agent is (or claims to be) heartbeating; liveness is derived
 *            from last_seen_at. A crashed agent is stuck here forever — its
 *            entry is the tombstone, liveness is presumed dead via timeout.
 *   gracefully_exited — terminal, immutable: written once by clearOwn(). The
 *            agent will never write again, so the state is unconditionally
 *            trusted (no timestamp check needed).
 */
export type ProfileLifecycle = "living" | "gracefully_exited";

export interface AgentProfile {
	name: string;
	model: string;
	cwd: string;
	subnet: string;
	started_at: string;
	context_used_pct: number;
	status: AgentStatus;
	current_task?: string;
}

/** AgentProfile as stored in the KV bucket: the written lifecycle + the raw
 *  heartbeat timestamp. Display status is never stored — it is derived
 *  (statusFromProfile). */
export interface StoredProfile {
	name: string;
	model: string;
	cwd: string;
	subnet: string;
	started_at: string;
	context_used_pct: number;
	current_task?: string;
	/** Absent → treated as "living". */
	lifecycle?: ProfileLifecycle;
	last_seen_at: string;
}

/**
 * The agent's comms identity. The NAME is the identity — it is the address
 * for every durable construct (message subjects, prompt consumer, history
 * keys) and is stable across restarts, so a restarted agent under the same
 * name resumes its queue and history. There is deliberately no per-process
 * id: an incarnation is distinguished by started_at, not by a changing id.
 */
export interface Identity {
	name: string;
	subnet: string;
	cwd: string;
	model: string;
	started_at: string;
	current_task?: string;
}

/**
 * Wire format of comms_send's delivery mode — how the message is delivered at
 * the target (pi queues custom messages; nothing preempts mid-stream):
 *  - "steer"     (default) — injected at the target's next LLM-call boundary
 *                 (after the current turn's tool calls, before the next
 *                 response, not mid-stream); triggers a turn when idle.
 *  - "followUp"  — processed after the target's current turn fully ends
 *                 (immediate when idle).
 * The wire value matches the pi sendMessage deliverAs parameter naming
 * ("steer" | "followUp" — unified naming across wire and API).
 */
export type DeliverAsValue = "steer" | "followUp";

/**
 * Validate a wire deliver_as value (it crossed the NATS boundary — could be
 * anything). Unknown values normalize to undefined (treated as "steer" by the
 * receiver); known values pass through.
 */
export function parseDeliverAs(value: unknown): DeliverAsValue | undefined {
	return value === "steer" || value === "followUp" ? value : undefined;
}

export interface PromptPayload {
	msg_id: string;
	subnet: string;
	sender: {
		name: string;
		cwd: string;
	};
	/** The message content delivered to the target agent. */
	message: string;
	/**
	 * When this message is a REPLY to an earlier message, the msg_id of the
	 * message it answers. The recipient resolves it against its own pending
	 * sends: a match records the reply as the result (comms_outbox) and stops
	 * the remind_s reminder for that msg_id. Always set by comms_send when
	 * the caller passes reply_to_msg_id.
	 */
	reply_to_msg_id?: string;
	/**
	 * Delivery mode at the target (see DeliverAsValue). Optional — a missing
	 * value means the target's default ("steer").
	 */
	deliver_as?: DeliverAsValue;
}

/** An inbound message (or reply) injected on arrival into the target session. */
export interface InboundContext {
	msg_id: string;
	sender_name: string;
	sender_cwd: string;
	message: string;
	/** Set when the sender marked this message as a reply (message payload reply_to_msg_id). */
	reply_to_msg_id?: string;
	/** True when reply_to_msg_id matched a pending send of ours (reply already recorded). */
	reply_to_pending?: boolean;
	/** Set when the message's reply_to_msg_id FAILED to resolve against our
	 *  pending sends (foreign id, or a sender other than the target we sent
	 *  to) — the framing surfaces the mismatch so the agent can chase it
	 *  via comms_outbox instead of silently treating it as an ordinary prompt. */
	attempted_reply_to_msg_id?: string;
	/**
	 * Delivery mode requested by the sender (wire DeliverAsValue, validated).
	 * Undefined = sender did not specify — delivery falls back to "steer".
	 */
	deliver_as?: DeliverAsValue;
	/** The JetStream message — acked by the receiver as soon as injection
	 *  succeeds; left unacked on failure so the stream redelivers it. */
	jsMsg: JsMsg;
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** Derived status from last_seen: heartbeated within offlineAfterMs → online,
 *  otherwise offline. One threshold — no intermediate state. */
export function statusFromLastSeen(lastSeenIso: string, offlineAfterMs: number): AgentStatus {
	const last = Date.parse(lastSeenIso);
	if (Number.isNaN(last)) return "offline";
	return Date.now() - last > offlineAfterMs ? "offline" : "online";
}

/**
 * Derived status from a full profile record. A terminal lifecycle
 * (gracefully_exited) is unconditionally offline; a living record is judged
 * by last_seen_at (a crash leaves "living" behind, so the timestamp is the
 * only liveness evidence).
 */
export function statusFromProfile(
	profile: Pick<StoredProfile, "lifecycle" | "last_seen_at">,
	offlineAfterMs: number,
): AgentStatus {
	if (profile.lifecycle === "gracefully_exited") return "offline";
	return statusFromLastSeen(profile.last_seen_at, offlineAfterMs);
}
