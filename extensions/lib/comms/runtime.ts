/**
 * Shared comms runtime contract — the single typed handle published by
 * extensions/comms.ts on session_start and consumed by sibling extensions
 * (task-comms-ops) that need the comms identity and messaging module.
 *
 * Why pi's event bus and not a plain import: pi loads each -e extension as
 * its OWN module instance, so module-level state is never shared across
 * extension files — an import of "./comms" from another extension would be
 * a DIFFERENT module instance (no identity, no NATS connection). The
 * sanctioned inter-extension channel is pi's shared event bus (pi docs
 * "pi.events"): comms.ts emits the handle on COMMS_RUNTIME_EVENT during
 * session_start, and consumers subscribe at factory time (all extension
 * factories run BEFORE any session_start event, so the subscription is
 * always live when the emit fires).
 *
 * This module is the single typed contract for that handle. The channel
 * constant is a plain string, so every extension instance's copy is
 * identical — the channel name is matched by value across instances, which
 * is what makes the bus work where object identity (an imported binding)
 * cannot. No runtime state lives here: the imports are type-only (erased
 * at compile time), so this module never couples an importing extension to
 * comms' implementation modules at runtime.
 */

import type { Identity, StoredProfile } from "./protocol";
import type { MessagingInstance } from "./messaging";
import type { RegistryInstance } from "./registry";

/** Event channel carrying the shared comms runtime handle (CommsRuntime). */
export const COMMS_RUNTIME_EVENT = "comms:runtime";

/**
 * The comms runtime shared across extension instances: the comms identity
 * plus the live factory instances (messaging, registry). The identity object
 * is mutated in place by registry.register on a name-collision suffix
 * (register returns void), and consumers hold the reference — so the handle
 * always reflects the final name, exactly as if it were read late. register
 * asserts this in-place contract at its own end.
 *
 * Emit contract: the event fires TWICE per session_start — once BEFORE the
 * NATS connect with a DEGRADED handle (messaging/registry null, updateProfile
 * throws "comms: not connected") so consumers see the identity immediately and
 * on any boot failure, and once after the instances are built with the FULL
 * handle under the same event. Consumers MUST null-guard .messaging/.registry.
 */
export interface CommsRuntime {
	identity: Identity;
	/** Null until the boot has built the messaging factory (NATS connected,
	 *  name registered). Null on every boot-failure path. */
	messaging: MessagingInstance | null;
	/** Null until the boot has built the registry factory (same lifecycle). */
	registry: RegistryInstance | null;
	/** Update own comms profile — the SAME implementation as the
	 *  comms_update_profile tool (immediate KV put carrying live metrics).
	 *  task-comms-ops uses it to auto-track current_task from the task
	 *  lifecycle (task_start sets it, task_submit_report clears it).
	 *  Throws "comms: not connected" on a degraded handle. */
	updateProfile: (patch: { current_task?: string | undefined }) => Promise<StoredProfile>;
}
