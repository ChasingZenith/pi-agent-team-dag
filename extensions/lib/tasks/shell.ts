/**
 * lib/tasks/shell — shared shell helpers for the tasks and task-comms-ops
 * extension shells (pure: no pi, no comms).
 *
 * Both extension shells operate on the same task graph (store + graph under
 * lib/tasks/) and need the same small set of behaviors: loading every item,
 * listing the available ids, and the teaching errors that tell the model what
 * to do instead of failing silently. pi isolates each -e extension's module
 * graph, so the shells share THIS pure module instead (imports only from
 * ./store, takes cwd explicitly). Every error carries the "tasks:" prefix
 * regardless of which shell surfaced it, so the model sees the same teaching
 * text everywhere. broadcastLine is the shared change-digest tail every
 * change tool returns — the announcement body to deliver to stakeholders.
 */

import * as store from "./store";
import type { Task } from "./store";

/** Load every stored item as a full Task, keyed by id. */
export function loadAllItems(cwd: string): Map<string, Task> {
	const byId = new Map<string, Task>();
	for (const s of store.listTasks(cwd)) {
		const item = store.readTask(cwd, s.id);
		if (item) byId.set(item.id, item);
	}
	return byId;
}

/** Comma-joined ids of every stored item ("(none)" when empty). */
export function availableIds(cwd: string): string {
	const ids = store.listTasks(cwd).map((s) => s.id);
	return ids.length > 0 ? ids.join(", ") : "(none)";
}

export function notFoundError(cwd: string, id: string): Error {
	return new Error(
		`tasks: "${id}" not found — create it first with task_create. Available items: ${availableIds(cwd)}`,
	);
}

export function missingDepsError(cwd: string, missing: string[]): Error {
	return new Error(
		`tasks: dep(s) [${missing.join(", ")}] do not exist — deps must already exist: create the child items first (task_create), then link them via deps. Available items: ${availableIds(cwd)}`,
	);
}

export function missingSubgraphDepsError(cwd: string, missing: string[]): Error {
	return new Error(
		`tasks: subgraph_deps gate(s) [${missing.join(", ")}] do not exist — gates must already exist: create them first (task_create), then gate the module's subgraph on them. Available items: ${availableIds(cwd)}`,
	);
}

export function cycleError(cycle: string[]): Error {
	return new Error(
		`tasks: deps would create a cycle — ${cycle.join(" -> ")}. deps must form a pure DAG (dependencies finish before their dependents) — break the cycle by re-linking.`,
	);
}

/** The shared change-digest tail every change tool returns — the announcement
 *  body to deliver to stakeholders (delivery is the role layer's protocol). */
export function broadcastLine(kind: "created" | "update", id: string, status: string, summary: string): string {
	const label = kind === "created" ? "Created" : "Update";
	const statusPart = kind === "created" ? "" : ` ${status}`;
	return `[Task ${label}] ${id}${statusPart} — ${summary}. Read: task_read(id="${id}")`;
}
