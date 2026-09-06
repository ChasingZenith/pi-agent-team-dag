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
import type * as messaging from "./messaging";

/** Event channel carrying the shared comms runtime handle (CommsRuntime). */
export const COMMS_RUNTIME_EVENT = "comms:runtime";

/**
 * The comms runtime shared across extension instances: the comms identity
 * plus the messaging module (send, pending replies, reminders, connection).
 * The identity object is mutated in place by registry.register on a
 * name-collision suffix, and consumers hold the reference — so the handle
 * always reflects the final name, exactly as if it were read late.
 */
export interface CommsRuntime {
	identity: Identity;
	messaging: typeof messaging;
	/** Update own comms profile — the SAME implementation as the
	 *  comms_update_profile tool (immediate KV put carrying live metrics).
	 *  task-comms-ops uses it to auto-track current_task from the task
	 *  lifecycle (task_start sets it, task_submit_report clears it). */
	updateProfile: (patch: { current_task?: string | undefined }) => Promise<StoredProfile>;
}
