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
 *   bucket  comms_profiles               keys a.<subnet>.<name> (profile, no TTL — offline
 *                                     agents stay visible; status derived from last_seen)
 *   bucket  comms_names               keys n.<subnet>.<name> (name lease, TTL — a name
 *                                     entry existing means the agent is heartbeating)
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
 * unique per subnet (exclusive lease + collision suffix), and sanitized before
 * use as a NATS segment.
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
export const DEFAULT_REGISTRY_TTL_MS = 30_000;
export const DEFAULT_STALE_AFTER_MS = 30_000;
export const DEFAULT_OFFLINE_AFTER_MS = 60_000;
export const DEFAULT_MESSAGE_TTL_MS = 1_800_000; // 30 min
/** How long the message content history bucket keeps records (comms_history
 *  bucket TTL — applied on first creation; changing it requires deleting the
 *  bucket). Long enough to cover compact + restart re-reads. */
export const DEFAULT_HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Three buckets with deliberately different lifetimes (see the header):
//   comms_profiles — permanent (no TTL; status derived from last_seen_at).
//   comms_names — TTL lease; the name is released when heartbeats stop.
//   comms_history — bidirectional message content history (bucket TTL, default
//                   24h): outbox/inbox re-read content after compact/restart.
export const KV_BUCKET_PROFILES = "comms_profiles";
export const KV_BUCKET_NAMES = "comms_names";
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
 * Profile key is the agent NAME, not the session id: one profile per name, and
 * reclaiming a name (put to the names bucket) overwrites the old profile —
 * no stale duplicate profiles after a restart. The profile persists even after
 * the agent goes offline (profiles bucket has no TTL).
 */
export function profileKey(subnet: string, name: string): string {
	return `a.${subnet}.${sanitizeAgentName(name)}`;
}

export function nameKey(subnet: string, name: string): string {
	return `n.${subnet}.${sanitizeAgentName(name)}`;
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
 *  consumer persists across restarts (clean shutdown does NOT delete it — the
 *  entry only releases the name lease), so a restart under the same name
 *  resumes the same cursor: unacked prompts redeliver, acked ones are never
 *  replayed, and messages queued while offline deliver on return. */
export function promptDurable(name: string): string {
	return `p_${sanitizeAgentName(name)}`;
}

// ━━ Shared types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type AgentStatus = "online" | "stale" | "offline";

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

/** AgentProfile as stored in the KV bucket: status computed, lease tracked. */
export interface StoredProfile extends AgentProfile {
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
 *  - "follow-up" — processed after the target's current turn fully ends
 *                 (immediate when idle).
 */
export type DeliverAsValue = "steer" | "follow-up";

/**
 * Validate a wire deliver_as value (it crossed the NATS boundary — could be
 * anything). Unknown values normalize to undefined (treated as "steer" by the
 * receiver); known values pass through.
 */
export function parseDeliverAs(value: unknown): DeliverAsValue | undefined {
	return value === "steer" || value === "follow-up" ? value : undefined;
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

/** An inbound message (or reply) queued for the next batch-injected turn. */
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
	 *  to) — the batch framing surfaces the mismatch so the agent can chase it
	 *  via comms_outbox instead of silently treating it as an ordinary prompt. */
	attempted_reply_to_msg_id?: string;
	/**
	 * Delivery mode requested by the sender (wire DeliverAsValue, validated).
	 * Undefined = sender did not specify — the batch falls back to "steer".
	 */
	deliver_as?: DeliverAsValue;
	/** The JetStream message — held unacked until its batch is settled. */
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

/** Derived status from last_seen: fresh → online, aged → stale, gone → offline. */
export function statusFromLastSeen(lastSeenIso: string, staleAfterMs: number, offlineAfterMs: number): AgentStatus {
	const last = Date.parse(lastSeenIso);
	if (Number.isNaN(last)) return "offline";
	const dt = Date.now() - last;
	if (dt > offlineAfterMs) return "offline";
	if (dt > staleAfterMs) return "stale";
	return "online";
}
