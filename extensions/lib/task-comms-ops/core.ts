/**
 * lib/task-comms-ops/core — Pure, testable core of the task-comms-ops tools
 *
 * The graph semantics of the high-level graph operations live here so they
 * can be unit-tested exactly like lib/tasks (no pi / comms dependency):
 * the task-comms-ops extension shells wrap these functions with comms I/O
 * (send, identity, notifications) and tool registration.
 *
 * Covered semantics:
 * - waitingDispatchees: the peers whose next action just changed because an
 *   item's status changed — dependents of the item that are dispatched to an
 *   agent (undispatched dependents have no one to notify; keep quiet).
 * - dispatcheesOf: the dispatchees of given items themselves — the peers whose
 *   task just became ready because a dep completed/cancelled. Used for the
 *   done/cancelled notification (the newly unlocked items are the ones to
 *   notify, NOT their dependents).
 */

import { type Task } from "../tasks/store";
import { dependentsOf } from "../tasks/graph";

// ---------------------------------------------------------------------------
// waitingDispatchees
// ---------------------------------------------------------------------------

/**
 * Peers currently dispatched to tasks that depend on `itemId` — the ones whose
 * next action just changed (their dep got satisfied, cancelled, or blocked).
 * Only dependents WITH a dispatchee are returned: an undispatched dependent has
 * no one to notify, so keep quiet for it.
 */
export function waitingDispatchees(items: Task[], itemId: string): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const depId of dependentsOf(items, itemId)) {
    const dep = byId.get(depId);
    if (dep?.dispatched_to?.name) out.add(dep.dispatched_to.name);
  }
  return [...out];
}

/**
 * Dispatchees of the given items THEMSELVES — the peers whose task just became
 * ready because a dep completed/cancelled. The done/cancelled notification
 * targets these people (their next action changed), not the dependents of
 * the unlocked items. Undispatched items are skipped: no one to notify.
 */
export function dispatcheesOf(items: Task[], ids: string[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const id of ids) {
    const name = byId.get(id)?.dispatched_to?.name;
    if (name) out.add(name);
  }
  return [...out];
}
