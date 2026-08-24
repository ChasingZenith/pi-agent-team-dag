/**
 * Shared types mirroring the tasks-server /api/graph response (which
 * itself mirrors extensions/lib/tasks/store.ts). The UI is a pure
 * renderer: every computed value (ready, missing, ...) is computed
 * server-side and shipped in the payload — the frontend never reimplements
 * graph logic.
 */

export type TaskStatus = "pending" | "dispatched" | "active" | "done" | "blocked" | "cancelled";

/** Granularity kind — mirrors extensions/lib/tasks/store.ts TaskKind. */
export type TaskKind = "module" | "unit";

export interface TaskHistoryEntry {
	version: number;
	updated_at: string;
	updated_by: string;
	change_summary: string;
}

/** One stored task (extensions/lib/tasks/store.ts Task). */
export interface Task {
	id: string;
	title: string;
	description: string;
	deps: string[];
	/** Subgraph gates (modules only): the module's whole subgraph — itself plus
	 *  everything it depends on, transitively — additionally waits for these
	 *  ids. Stored once, expanded at read time server-side (the payload's
	 *  missing already includes gates); the UI shows the declared gates as-is. */
	subgraph_deps: string[];
	status: TaskStatus;
	kind: TaskKind;
	version: number;
	created_at: string;
	updated_at: string;
	updated_by: string;
	history: TaskHistoryEntry[];
}

/** One node of the graph response — the item plus the computed values for it. */
export interface GraphItem {
	item: Task;
	/** In the ready set (pending, all deps satisfied). */
	ready: boolean;
	/** Unsatisfied dep ids when not ready. */
	missing: string[];
	/** Ids of items depending on this one. */
	dependents: string[];
}

export interface GraphResponse {
	items: GraphItem[];
	warnings: {
		cycles: string[][];
		dangling: Array<{ id: string; dep: string }>;
		orphans: Array<{ id: string; status: string }>;
	};
	counts: Record<TaskStatus, number>;
}

/** Display metadata per status — glyphs match the extension's TUI rendering. */
export const STATUS_META: Record<
	TaskStatus,
	{ label: string; glyph: string; color: string }
> = {
	pending: { label: "Pending", glyph: "◻", color: "#94a3b8" },
	dispatched: { label: "Dispatched", glyph: "◔", color: "#a855f7" },
	active: { label: "Active", glyph: "▶", color: "#3b82f6" },
	done: { label: "Done", glyph: "✓", color: "#22c55e" },
	blocked: { label: "Blocked", glyph: "⛔", color: "#ef4444" },
	cancelled: { label: "Cancelled", glyph: "⊘", color: "#78716c" },
};
