/**
 * lib/tasks/store — Task artifact storage (filesystem, pure, no pi
 * dependency).
 *
 * The task graph system is a single entity — a Task at any granularity —
 * over a pure DAG with two relationships. The dependency edge `deps`:
 * B.deps = [A] means B depends on A having completed — A must be done (or
 * cancelled) before B can start, and a node cannot be marked done while any
 * dep is unsatisfied. The subgraph gate `subgraph_deps` (modules only):
 * declaring subgraph_deps = [X] on a module M makes the WHOLE subgraph of M
 * (M itself plus everything it depends on, transitively) additionally wait
 * for X — one stored field instead of an edge written into every node of the
 * subgraph. Gates are expanded at read time (see lib/tasks/graph), so tasks
 * added to the subgraph later are gated automatically. A gate must not be
 * inside the gated module's own subgraph (that would be a cycle), and the
 * expanded graph stays DAG-checked.
 *
 * Storage: <cwd>/.pi/tasks/<id>.json — one JSON file per item. All spawned
 * agents share the spawner's cwd, so the whole network reads and writes the
 * same directory. PI_TASKS_DIR overrides the whole directory for tests and
 * redirection (same pattern as PI_COMMS_DIR).
 *
 * State machine — done/cancelled are terminal except reopen/undo; cancelled
 * counts as satisfied everywhere (dependents), so cancelling resolves a stuck
 * task without blocking everything downstream:
 *   | current   | legal next                                              |
 *   |-----------|---------------------------------------------------------|
 *   | pending    | dispatched, active, blocked, done, cancelled            |
 *   | dispatched | active, pending, blocked, done, cancelled               |
 *   | active     | pending, blocked, done, cancelled                       |
 *   | blocked    | pending, dispatched, active, done, cancelled           |
 *   | done       | active (reopen)                                          |
 *   | cancelled  | pending (undo)                                           |
 * dispatched = the delegation message is sent and the owner recorded, but work
 * not started — the owner's task_start moves it to active and records its
 * execution session (session id + JSONL transcript file, kept for
 * retrospection even after done/cancelled). Constraint beyond the table:
 * marking a node done while deps are unsatisfied is a hard error listing the
 * missing deps ("mark them done, cancel them, or update the deps").
 *
 * Versioning: create = v1; every update/status change bumps the version, the
 * old version's trace entry (summaries only, single-lined) is pushed into
 * history (cap HISTORY_CAP), and the file is rewritten atomically
 * (.tmp + rename). Before the main file is rewritten, the REPLACED version's
 * full content is archived atomically to history/<id>.v<N>.json (N = the
 * replaced version; no cap — full retention), so any past version stays
 * retrievable (see readTaskVersion).
 *
 * Optimistic concurrency: the three write functions (updateTask,
 * setTaskStatus, setCompletionReport) accept an optional expected_version —
 * when provided and the record has moved past it, the write is rejected with
 * a conflict error (both versions named) BEFORE anything is written — main
 * file and snapshot untouched; the caller re-reads and retries. Omitted =
 * last-writer-wins as before (the default for role-split writers).
 *
 * Corruption: readTask throws with the available ids; createTask
 * silently overwrites a corrupted file (last-writer-wins as repair);
 * listTasks skips corrupted files so the listing never blows up; the
 * graph layer (validateGraph) exists to inspect hand-edited damage.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DepGraphCycleError } from "dependency-graph";
import { ulid } from "../comms/protocol";
import { buildGraph, dependencyClosure, effectiveDeps, unlockedBy } from "./graph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "dispatched" | "active" | "done" | "blocked" | "cancelled";

const STATUSES: readonly TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled"];

/**
 * Granularity kind: "unit" (directly executable, no children) or "module"
 * (aggregation — may have a subgraph below it and need delegation). Review
 * nodes are modules too: their deps are the implementation children they
 * verify. Both kinds carry deps (ordering edges — see Task.deps); the
 * difference is executability: a unit with deps just waits for its
 * prerequisites, it is still dispatched directly to one worker. subgraph_deps
 * (subgraph gates) stay module-only — a gate is meaningless without a
 * subgraph to gate.
 */
export type TaskKind = "module" | "unit";

const KINDS: readonly TaskKind[] = ["module", "unit"];

/** One version's trace entry — summaries only; full content lives in the
 *  history/<id>.v<N>.json snapshots (see readTaskVersion). */
export interface TaskHistoryEntry {
	/** The version that was replaced by this write. */
	version: number;
	updated_at: string;
	updated_by: string;
	/** Why this write happened — deviations and corrected assumptions go here. */
	change_summary: string;
}

/** The agent currently responsible for a task — recorded at dispatch. */
export interface TaskDispatch {
	/** Agent name — the comms identity (name IS the address: messages,
	 *  history and the consumer are all name-anchored). */
	name: string;
	/** The dispatcher's agent name — who delegated this item; notified when the worker's task_start declares the start. */
	dispatched_by: string;
	/** The msg_id of the delegation message — the worker's task_submit_report replies to it. */
	dispatch_msg_id: string;
}

/**
 * The worker's execution session — recorded by the WORKER itself at
 * task_start (only the executing agent knows its own pi session). Points at
 * the session transcript (JSONL) so the manager can open it and see how the
 * item was actually executed. Kept on terminal states on purpose — that is
 * exactly when retrospection happens; a reopen/undo keeps it until the next
 * start overwrites it.
 */
export interface TaskExecutionSession {
	/** pi session id — the session header id (uuidv7) of the worker's session file. */
	session_id: string;
	/** The worker's session file (JSONL transcript), relative to the shared cwd. */
	session_file: string;
}

/** A stored task — the single entity at any granularity (task, module, milestone). */
export interface Task {
	/** kebab-case slug ("task-auth-login"). */
	id: string;
	/** Single-line title. */
	title: string;
	/** Free-form Markdown: acceptance criteria, numbered assumptions (A1/A2), interface contracts. */
	description: string;
	/** Dependency edges (deduplicated, sorted): B.deps = [A] means B depends on A having completed.
	 *  Legal on any kind — a unit with deps waits for its prerequisites but is still executed directly. */
	deps: string[];
	/** Subgraph gates (modules only, deduplicated, sorted): the whole subgraph of this
	 *  item — itself plus everything it depends on, transitively — additionally waits
	 *  for these ids to complete. An ordering edge, not a data dependency. Stored once
	 *  here and expanded at read time (see lib/tasks/graph): nodes added to the subgraph
	 *  later are gated automatically. A gate must exist and must not be inside the
	 *  item's own subgraph (that would create a cycle at expansion). */
	subgraph_deps: string[];
	status: TaskStatus;
	/** Granularity kind: "unit" (directly executable, no children — may still carry deps) or "module" (aggregation — may have a subgraph). */
	kind: TaskKind;
	version: number;
	created_at: string;
	updated_at: string;
	updated_by: string;
	/** Current responsible agent — set at dispatch (status dispatched), preserved while active, cleared on done/cancelled. */
	dispatched_to: TaskDispatch | null;
	/** The executing agent's pi session — session id + JSONL transcript file, recorded by the worker itself at task_start (task-comms-ops), kept on terminal states for retrospection. Null until the worker starts. */
	execution_session: TaskExecutionSession | null;
	/** The dispatched agent's execution record — what was actually done, how it deviates from the plan (written by the worker via task_submit_report, read by the manager before task_complete). Null until reported; cleared on reopen/undo. */
	completion_report: string | null;
	/** Past version traces, newest first. */
	history: TaskHistoryEntry[];
}

/** One row of the task listing. */
export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	kind: TaskKind;
	version: number;
	updated_at: string;
	updated_by: string;
	/** Current responsible agent, when dispatched. */
	dispatched_to: TaskDispatch | null;
	/** Number of dependency edges. */
	depCount: number;
	/** Subgraph gate ids declared by this item (modules only). */
	subgraph_deps: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max history entries kept (summaries only). */
export const HISTORY_CAP = 10;

// ---------------------------------------------------------------------------
// Paths / ids
// ---------------------------------------------------------------------------

/** Directory holding task files. PI_TASKS_DIR overrides the default. */
export function tasksDir(cwd: string): string {
	return process.env.PI_TASKS_DIR ?? join(cwd, ".pi", "tasks");
}

function taskJsonPath(cwd: string, id: string): string {
	return join(tasksDir(cwd), `${id}.json`);
}

/**
 * Sanitize a user-supplied task id: lowercase; illegal characters become
 * "-" (same convention as sanitizePlanId, so "Work Auth!" → "work-auth" keeps
 * kebab-case readability); collapse runs of separators and strip leading/
 * trailing ones — "Work Auth!" and "work-auth" must never be two files.
 * Returns "" when nothing survives (caller decides: omitted ids auto-generate,
 * explicit invalid ids error).
 */
export function sanitizeTaskId(id: string): string {
	return id
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Auto-generated task id when the caller omits one: "task-<ulid8>". The
 * tail of the ulid (the random segment) is used, not the head (the timestamp
 * prefix) — two ids generated in the same millisecond must still differ.
 */
export function defaultTaskId(): string {
	return `task-${ulid().toLowerCase().slice(-8)}`;
}

/** Resolve a caller-provided id: omitted → auto; explicit → sanitized or error. */
function resolveTaskId(cwd: string, rawId: string | undefined): string {
	if (!rawId || !rawId.trim()) return defaultTaskId();
	const cleaned = sanitizeTaskId(rawId);
	if (!cleaned) {
		throw new Error(
			`tasks: invalid task id "${rawId}" — use letters, digits, underscore, hyphen (e.g. "task-auth-login")`,
		);
	}
	return cleaned;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a task to its file form: pretty-printed JSON + trailing
 * newline. All fields are mechanical — free-form text lives in description,
 * so no markup parsing is needed on read.
 */
export function serializeTask(item: Task): string {
	return JSON.stringify(item, null, 2) + "\n";
}

/** Lenient dispatch parse: a well-shaped {name} object, else null.
 *  dispatched_by / dispatch_msg_id are lenient (missing on pre-existing
 *  files → "") — the dispatcher-notifications are best-effort. */
function parseDispatch(raw: unknown): TaskDispatch | null {
	if (typeof raw !== "object" || raw === null) return null;
	const a = raw as Record<string, unknown>;
	if (typeof a.name !== "string" || !a.name.trim()) return null;
	return {
		name: a.name,
		dispatched_by: typeof a.dispatched_by === "string" ? a.dispatched_by : "",
		dispatch_msg_id: typeof a.dispatch_msg_id === "string" ? a.dispatch_msg_id : "",
	};
}

/** Lenient execution-session parse: a well-shaped {session_id} object, else
 *  null (absent on pre-existing files and before the worker starts).
 *  session_file is lenient (missing → "") — a worker without a resolvable
 *  transcript still records its session id. */
function parseExecutionSession(raw: unknown): TaskExecutionSession | null {
	if (typeof raw !== "object" || raw === null) return null;
	const a = raw as Record<string, unknown>;
	if (typeof a.session_id !== "string" || !a.session_id.trim()) return null;
	return {
		session_id: a.session_id,
		session_file: typeof a.session_file === "string" ? a.session_file : "",
	};
}

/**
 * Parse the JSON file form. Returns null when the structure is unusable:
 * not an object, missing/empty id or title, unknown status, missing/invalid
 * kind, non-array deps, non-integer version. Description, timestamps and
 * history are lenient (defaults); history entries that fail the shape check
 * are dropped (the trace is advisory — a stray hand edit must not block
 * reading the item).
 */
export function parseTask(raw: string): Task | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id.trim()) return null;
	if (typeof d.title !== "string" || !d.title.trim()) return null;
	if (typeof d.status !== "string" || !(STATUSES as readonly string[]).includes(d.status)) return null;
	if (typeof d.kind !== "string" || !(KINDS as readonly string[]).includes(d.kind)) return null;
	if (!Array.isArray(d.deps) || !d.deps.every((x) => typeof x === "string")) return null;
	if (
		d.subgraph_deps !== undefined &&
		(!Array.isArray(d.subgraph_deps) || !d.subgraph_deps.every((x) => typeof x === "string"))
	) {
		return null;
	}
	if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) return null;

	return {
		id: d.id,
		title: d.title,
		description: typeof d.description === "string" ? d.description : "",
		deps: d.deps,
		subgraph_deps: Array.isArray(d.subgraph_deps) ? d.subgraph_deps : [],
		status: d.status as TaskStatus,
		kind: d.kind as TaskKind,
		version: d.version,
		created_at: typeof d.created_at === "string" ? d.created_at : "",
		updated_at: typeof d.updated_at === "string" ? d.updated_at : "",
		updated_by: typeof d.updated_by === "string" ? d.updated_by : "unknown",
		dispatched_to: parseDispatch(d.dispatched_to),
		execution_session: parseExecutionSession(d.execution_session),
		completion_report:
			typeof d.completion_report === "string" && d.completion_report.trim() ? d.completion_report : null,
		history: Array.isArray(d.history)
			? d.history.filter((h): h is TaskHistoryEntry => {
					if (typeof h !== "object" || h === null) return false;
					const e = h as Record<string, unknown>;
					return (
						typeof e.version === "number" &&
						Number.isInteger(e.version) &&
						typeof e.updated_at === "string" &&
						typeof e.updated_by === "string" &&
						typeof e.change_summary === "string"
					);
				})
			: [],
	};
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Lenient read: returns null when absent OR corrupted. Writers use this —
 * a write overwrites a corrupted file (last-writer-wins as repair);
 * readTask stays strict so the tool surfaces corruption.
 */
function tryReadTaskFile(cwd: string, id: string): Task | null {
	const jsonPath = taskJsonPath(cwd, id);
	if (!existsSync(jsonPath)) return null;
	return parseTask(readFileSync(jsonPath, "utf-8"));
}

/**
 * Read a task. Returns null when the item does not exist; throws with
 * the list of available ids when the file is corrupted.
 */
export function readTask(cwd: string, id: string): Task | null {
	const clean = sanitizeTaskId(id);
	const jsonPath = taskJsonPath(cwd, clean);
	if (!existsSync(jsonPath)) return null;
	const item = parseTask(readFileSync(jsonPath, "utf-8"));
	if (!item) {
		const available = listTasks(cwd).map((w) => w.id).join(", ") || "(none)";
		throw new Error(
			`tasks: task "${clean}" is corrupted (malformed JSON or missing fields) — available tasks: ${available}`,
		);
	}
	return item;
}

/**
 * Read the archived full-content snapshot of a past version from
 * history/<id>.v<N>.json. Returns null when the TASK does not exist (same
 * contract as readTask, so callers reuse their found/not-found paths).
 * Throws for: non-positive-integer version; version >= current (read the
 * live record instead); no snapshot for the version (the item was created
 * before snapshotting, or the snapshot is gone); a corrupted snapshot — each
 * error names the archived versions that do exist.
 */
export function readTaskVersion(cwd: string, id: string, version: number): Task | null {
	const clean = sanitizeTaskId(id);
	if (!Number.isInteger(version) || version < 1) {
		throw new Error(`tasks: invalid version "${version}" — versions are positive integers`);
	}
	const current = readTask(cwd, clean);
	if (!current) return null;
	if (version >= current.version) {
		const archived = archivedVersions(cwd, clean);
		throw new Error(
			`tasks: "${clean}" has no version ${version} — it is at version ${current.version}` +
				(archived.length > 0 ? ` — archived versions: ${archived.join(", ")}` : ""),
		);
	}
	const p = taskVersionJsonPath(cwd, clean, version);
	if (!existsSync(p)) {
		const archived = archivedVersions(cwd, clean);
		throw new Error(
			`tasks: "${clean}" has no snapshot for version ${version} — snapshots start at the first change made after this feature shipped` +
				(archived.length > 0 ? ` — archived versions: ${archived.join(", ")}` : ""),
		);
	}
	const item = parseTask(readFileSync(p, "utf-8"));
	if (!item) {
		throw new Error(
			`tasks: snapshot for "${clean}" v${version} is corrupted (malformed JSON or missing fields) — archived versions: ${archivedVersions(cwd, clean).join(", ") || "(none)"}`,
		);
	}
	return item;
}

/** Atomically write the .json file (tmp + rename). */
function atomicWriteTask(cwd: string, id: string, item: Task): void {
	const jsonPath = taskJsonPath(cwd, id);
	const tmp = `${jsonPath}.tmp`;
	writeFileSync(tmp, serializeTask(item), "utf-8");
	renameSync(tmp, jsonPath);
}

// ---------------------------------------------------------------------------
// Version snapshots (history/)
// ---------------------------------------------------------------------------

/** Directory holding archived full-content snapshots (history/<id>.v<N>.json). */
function taskHistoryDir(cwd: string): string {
	return join(tasksDir(cwd), "history");
}

/** Path of the archived snapshot for one version of one item. */
function taskVersionJsonPath(cwd: string, id: string, version: number): string {
	return join(taskHistoryDir(cwd), `${id}.v${version}.json`);
}

/**
 * Archive the old version's FULL content before it is replaced (atomic,
 * no cap — full retention). The snapshot is self-contained: it keeps the
 * history chain it carried at the time, so it round-trips through parseTask
 * unchanged. Written BEFORE the main file is rewritten — the old version must
 * be durable before the new one becomes visible.
 */
function writeTaskSnapshot(cwd: string, existing: Task): void {
	const p = taskVersionJsonPath(cwd, existing.id, existing.version);
	const tmp = `${p}.tmp`;
	mkdirSync(taskHistoryDir(cwd), { recursive: true });
	writeFileSync(tmp, serializeTask(existing), "utf-8");
	renameSync(tmp, p);
}

/** Sorted list of archived version numbers for one id (readdir-based truth). */
function archivedVersions(cwd: string, id: string): number[] {
	const dir = taskHistoryDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.startsWith(`${id}.v`) && f.endsWith(".json"))
		.map((f) => Number(f.slice(`${id}.v`.length, -".json".length)))
		.filter((n) => Number.isInteger(n) && n >= 1)
		.sort((a, b) => a - b);
}

/**
 * Build the next version of a task: the replaced version's FULL content is
 * first archived to history/<id>.v<N>.json (see writeTaskSnapshot), then
 * version+1 with the old version's trace entry (summaries only, single-lined)
 * pushed into history (cap HISTORY_CAP), timestamps and author updated.
 * Shared by updateTask, setTaskStatus and setCompletionReport — all three
 * validate before calling (legal transitions, deps existence, no cycles), so
 * snapshots are written only for successful mutations. A snapshot failure
 * aborts the mutation: the main file is untouched.
 */
function bump(
	cwd: string,
	existing: Task,
	patch: Partial<Pick<Task, "title" | "description" | "deps" | "subgraph_deps" | "kind" | "status" | "dispatched_to" | "execution_session" | "completion_report">>,
	summary: string,
	updatedBy: string,
	now: string,
): Task {
	writeTaskSnapshot(cwd, existing);
	const entry: TaskHistoryEntry = {
		version: existing.version,
		updated_at: existing.updated_at,
		updated_by: existing.updated_by,
		change_summary: summary.replace(/\s+/g, " ").trim(),
	};
	return {
		...existing,
		...patch,
		version: existing.version + 1,
		updated_at: now,
		updated_by: updatedBy,
		history: [entry, ...existing.history].slice(0, HISTORY_CAP),
	};
}

// ---------------------------------------------------------------------------
// Deps / graph validation
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-provided dep list: sanitize each id (same rules as the
 * item id), deduplicate, sort — the stored array is deterministic regardless
 * of input order. Every dep must resolve to an existing item; a dep that is
 * the item's own id is a self-loop and rejected with the cycle error format.
 */
function normalizeDeps(cwd: string, itemId: string, rawDeps: string[]): string[] {
	const deps = [...new Set(rawDeps.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	for (const dep of deps) {
		if (dep === itemId) {
			throw new Error(`tasks: would create a dependency cycle: ${itemId} → ${itemId}`);
		}
		if (!tryReadTaskFile(cwd, dep)) {
			const available = listTasks(cwd).map((w) => w.id).join(", ") || "(none)";
			throw new Error(
				`tasks: dep "${dep}" does not exist — create it first — available tasks: ${available}`,
			);
		}
	}
	return deps;
}

/**
 * Normalize a caller-provided subgraph_deps (subgraph gate) list: sanitize each
 * id, deduplicate, sort. Every gate must resolve to an existing item.
 * The remaining gate constraints — not the module itself, not inside its own
 * subgraph — are checked by assertSubgraphDepOutsideSubgraph (needs the graph); cycles
 * that only arise BETWEEN gates (A gates B while B gates A) are caught by
 * assertNoCycle, which validates the expanded graph.
 */
function normalizeSubgraphDeps(cwd: string, rawGates: string[]): string[] {
	const gates = [...new Set(rawGates.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	for (const gate of gates) {
		if (!tryReadTaskFile(cwd, gate)) {
			const available = listTasks(cwd).map((w) => w.id).join(", ") || "(none)";
			throw new Error(
				`tasks: subgraph_deps gate "${gate}" does not exist — create it first — available tasks: ${available}`,
			);
		}
	}
	return gates;
}

/**
 * A gate on the module itself or on anything inside its own subgraph would
 * create a self-loop at expansion time (every subgraph node, the gate included,
 * would depend on the gate) — rejected here with the cycle teaching. The check
 * runs on an overlay of the item's NEW deps (deps define the subgraph; gates do
 * not extend it), so a deps change that moves a gate inside the subgraph is
 * caught on update too. Cross-gate cycles are left to assertNoCycle.
 */
function assertSubgraphDepOutsideSubgraph(cwd: string, itemId: string, deps: string[], gates: string[]): void {
	if (gates.length === 0) return;
	const items = loadAllItems(cwd);
	const idx = items.findIndex((i) => i.id === itemId);
	const overlay: Task[] =
		idx >= 0
			? items.map((i, n) => (n === idx ? { ...i, deps } : i))
			: [...items, { id: itemId, deps } as Task];
	for (const gate of gates) {
		if (gate === itemId || dependencyClosure(overlay, itemId).includes(gate)) {
			throw new Error(
				`tasks: subgraph_deps gate "${gate}" is inside the subgraph of "${itemId}" — gating would create a dependency cycle (the subgraph already depends on it); gate on something outside the subgraph`,
			);
		}
	}
}

/** All parseable items in the directory, sorted by id. */
function loadAllItems(cwd: string): Task[] {
	const items: Task[] = [];
	for (const summary of listTasks(cwd)) {
		const item = tryReadTaskFile(cwd, summary.id);
		if (item) items.push(item);
	}
	return items;
}

/**
 * Reject writes that would close a cycle: build a DepGraph over the existing
 * items with the target item's (new) deps and subgraph_deps overlaid, then run
 * the library's cycle check and translate its error into the friendly form.
 * The graph is built with subgraph_deps expanded (see lib/tasks/graph), so this
 * also catches cycles that only arise between gates — e.g. A gates on B while
 * B gates on A — which the per-item subgraph check cannot see. The check runs
 * on the in-memory overlay — nothing is written by it.
 */
function assertNoCycle(cwd: string, itemId: string, deps: string[], moduleDeps: string[] = []): void {
	const items = loadAllItems(cwd);
	const idx = items.findIndex((i) => i.id === itemId);
	const withTarget: Task[] =
		idx >= 0
			? items.map((i, n) => (n === idx ? { ...i, deps, subgraph_deps: moduleDeps } : i))
			: [...items, { id: itemId, deps, subgraph_deps: moduleDeps } as Task];
	const graph = buildGraph(withTarget);
	try {
		graph.overallOrder();
	} catch (err: unknown) {
		if (err instanceof DepGraphCycleError) {
			throw new Error(
				`tasks: would create a dependency cycle: ${err.cyclePath.join(" → ")}`,
			);
		}
		if (err instanceof Error && err.message.startsWith("Node does not exist:")) {
			const missing = err.message.slice("Node does not exist:".length).trim();
			throw new Error(
				`tasks: cannot validate the graph — an existing task references missing dep "${missing}" — fix or remove that reference first`,
			);
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Create / update / status
// ---------------------------------------------------------------------------

/**
 * Resolve the granularity kind: default "unit"; rejects unknown values and
 * the contradiction "unit with subgraph_deps". deps are ordering edges and
 * legal on ANY kind — a unit with deps waits for its prerequisites but is
 * still directly executable (no delegation). subgraph_deps (subgraph gates)
 * remain module-only — a gate is meaningless without a subgraph to gate, so
 * neither a plain unit nor a unit flipped from module may carry gates.
 */
function resolveKind(raw: TaskKind | undefined, deps: string[], moduleDeps: string[] = []): TaskKind {
	const kind = raw ?? "unit";
	if (!(KINDS as readonly string[]).includes(kind)) {
		throw new Error(`tasks: invalid kind "${String(kind)}" — one of: ${KINDS.join(" | ")}`);
	}
	if (kind === "unit" && moduleDeps.length > 0) {
		throw new Error(
			`tasks: kind "unit" cannot declare subgraph_deps — a subgraph_deps gates the module's whole subgraph, and a unit has no subgraph; use kind "module"`,
		);
	}
	return kind;
}

/**
 * Create a task (v1, status "pending"). deps are normalized (sanitize +
 * dedupe + sort) and every dep must already exist; cycles (including
 * self-dependency) are rejected before anything is written. subgraph_deps
 * (subgraph gates, modules only) are normalized the same way: every gate must
 * exist, gates inside the module's own subgraph are rejected, and the expanded
 * graph stays cycle-free (cross-gate cycles included).
 *
 * A file already at the target path is an ERROR (update it instead) — except
 * a corrupted one, which this create silently overwrites (last-writer-wins
 * as repair, same as writePlan).
 */
export function createTask(
	cwd: string,
	opts: {
		id?: string;
		title: string;
		description?: string;
		deps?: string[];
		subgraph_deps?: string[];
		kind?: TaskKind;
		change_summary?: string;
		updated_by?: string;
	},
): Task {
	const id = resolveTaskId(cwd, opts.id);
	const title = opts.title?.trim() ?? "";
	if (!title) throw new Error("tasks: task title is required");

	const dir = tasksDir(cwd);
	mkdirSync(dir, { recursive: true });
	if (tryReadTaskFile(cwd, id)) {
		throw new Error(`tasks: task "${id}" already exists — update it instead`);
	}

	const deps = normalizeDeps(cwd, id, opts.deps ?? []);
	const moduleDeps = normalizeSubgraphDeps(cwd, opts.subgraph_deps ?? []);
	assertSubgraphDepOutsideSubgraph(cwd, id, deps, moduleDeps);
	assertNoCycle(cwd, id, deps, moduleDeps);
	const kind = resolveKind(opts.kind, deps, moduleDeps);

	const now = new Date().toISOString();
	const item: Task = {
		id,
		title,
		description: opts.description ?? "",
		deps,
		subgraph_deps: moduleDeps,
		status: "pending",
		kind,
		version: 1,
		created_at: now,
		updated_at: now,
		updated_by: opts.updated_by ?? "unknown",
		dispatched_to: null,
		execution_session: null,
		completion_report: null,
		history: [],
	};
	atomicWriteTask(cwd, id, item);
	return item;
}

/**
 * Optimistic-concurrency guard shared by all three write functions: when the
 * caller supplied an expected_version and the record has moved past it, throw
 * BEFORE anything is written — main file and snapshot both stay untouched.
 * Omitted expected_version = last-writer-wins as before.
 */
function assertExpectedVersion(id: string, currentVersion: number, expectedVersion: number | undefined): void {
	if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
		throw new Error(
			`tasks: conflict on "${id}" — expected version ${expectedVersion}, current version ${currentVersion} (concurrent update); re-read the node and retry`,
		);
	}
}

/**
 * Update a task's metadata (title/description/deps/subgraph_deps). Version
 * bumps +1 with the old version's trace entry pushed into history. deps and
 * subgraph_deps are validated exactly like create (existence, gates outside the
 * subgraph, no cycles — cross-gate cycles included). Omitting subgraph_deps
 * keeps the current value; [] clears the gates.
 */
export function updateTask(
	cwd: string,
	id: string,
	opts: {
		title?: string;
		description?: string;
		deps?: string[];
		subgraph_deps?: string[];
		kind?: TaskKind;
		change_summary?: string;
		updated_by?: string;
		/** Optimistic concurrency: the version the caller read — the write fails
		 *  with a conflict error if the record has moved past it (re-read and
		 *  retry). Omitted = last-writer-wins. */
		expected_version?: number;
	},
): Task {
	const clean = sanitizeTaskId(id);
	const existing = readTask(cwd, clean);
	if (!existing) {
		throw new Error(`tasks: task "${clean}" does not exist — create it with task_create first`);
	}
	assertExpectedVersion(clean, existing.version, opts.expected_version);

	const title = opts.title !== undefined ? opts.title.trim() : existing.title;
	if (!title) throw new Error("tasks: task title is required");
	const deps = opts.deps !== undefined ? normalizeDeps(cwd, clean, opts.deps) : existing.deps;
	const moduleDeps =
		opts.subgraph_deps !== undefined ? normalizeSubgraphDeps(cwd, opts.subgraph_deps) : existing.subgraph_deps;
	assertSubgraphDepOutsideSubgraph(cwd, clean, deps, moduleDeps);
	assertNoCycle(cwd, clean, deps, moduleDeps);
	const kind = resolveKind(opts.kind ?? existing.kind, deps, moduleDeps);

	const now = new Date().toISOString();
	const item = bump(
		cwd,
		existing,
		{ title, description: opts.description ?? existing.description, deps, subgraph_deps: moduleDeps, kind },
		opts.change_summary?.trim() || "updated",
		opts.updated_by || "unknown",
		now,
	);
	atomicWriteTask(cwd, clean, item);
	return item;
}

/** Legal next statuses per current status (see the state machine in the header). */
const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	pending: ["dispatched", "active", "blocked", "done", "cancelled"],
	dispatched: ["active", "pending", "blocked", "done", "cancelled"],
	active: ["pending", "blocked", "done", "cancelled"],
	blocked: ["pending", "dispatched", "active", "done", "cancelled"],
	done: ["active"],
	cancelled: ["pending"],
};

/** Human-readable legal-targets list for error messages. */
const TRANSITION_HINTS: Record<TaskStatus, string> = {
	pending: "dispatched, active, blocked, done (with deps satisfied), cancelled",
	dispatched: "active (start), pending, blocked, done (with deps satisfied), cancelled",
	active: "pending, blocked, done (with deps satisfied), cancelled",
	blocked: "pending, dispatched, active, done (with deps satisfied), cancelled",
	done: "active (reopen)",
	cancelled: "pending (undo)",
};

/**
 * Transition a task's status (version bump + history entry). Hard rules:
 * - the transition must be legal (see the state machine in the header);
 * - a node can only be marked done when ALL deps are done/cancelled —
 *   otherwise the error lists the missing deps and teaches the remedies.
 *
 * Returns the stored item plus one computed (never persisted) result:
 * - unlocked: ids that marking this item done (or cancelled — cancelled also
 *   satisfies) newly makes ready — computed from the pre-write snapshot so
 *   "newly" is accurate (nodes already ready are excluded).
 */
export function setTaskStatus(
	cwd: string,
	id: string,
	status: TaskStatus,
	opts: {
		change_summary?: string;
		updated_by?: string;
		/** Record the responsible agent when setting dispatched (dispatch). */
		dispatched_to?: TaskDispatch | null;
		/** Record the worker's execution session when setting active (start). */
		execution_session?: TaskExecutionSession | null;
		/** Optimistic concurrency: the version the caller read — the write fails
		 *  with a conflict error if the record has moved past it (re-read and
		 *  retry). Omitted = last-writer-wins. */
		expected_version?: number;
	} = {},
): { item: Task; unlocked: string[] } {
	const clean = sanitizeTaskId(id);
	const existing = readTask(cwd, clean);
	if (!existing) {
		throw new Error(`tasks: task "${clean}" does not exist — create it with task_create first`);
	}
	assertExpectedVersion(clean, existing.version, opts.expected_version);
	if (!LEGAL_TRANSITIONS[existing.status].includes(status)) {
		throw new Error(
			`tasks: cannot transition "${clean}" from "${existing.status}" to "${status}" — legal transitions: ${TRANSITION_HINTS[existing.status]}`,
		);
	}
	if (opts.dispatched_to !== undefined && status !== "dispatched") {
		throw new Error(
			`tasks: cannot record a responsible agent while setting status "${status}" — dispatch records the agent: set the item to "dispatched" with dispatched_to`,
		);
	}
	if (opts.execution_session !== undefined && status !== "active") {
		throw new Error(
			`tasks: cannot record an execution session while setting status "${status}" — start records the worker's session: set the item to "active" with execution_session`,
		);
	}

	// Snapshot BEFORE the write: the unlocked set is "what THIS change newly
	// unlocks", which requires the pre-change state (id not yet satisfied).
	const preItems = loadAllItems(cwd);
	if (status === "done") {
		const byId = new Map(preItems.map((i) => [i.id, i]));
		// Effective deps: the item's own deps plus the gates of every module
		// whose subgraph contains it (subgraph_deps read-time expansion).
		const missing = effectiveDeps(preItems, existing).filter((depId) => {
			const dep = byId.get(depId);
			if (!dep) return true; // dangling dep — never satisfied
			return dep.status !== "done" && dep.status !== "cancelled";
		});
		if (missing.length > 0) {
			throw new Error(
				`tasks: cannot mark "${clean}" done — deps not satisfied: ${missing.join(", ")} — mark them done, cancel them, or update the deps / subgraph_deps`,
			);
		}
	}

	const now = new Date().toISOString();
	const patch: Partial<Pick<Task, "status" | "dispatched_to" | "execution_session" | "completion_report">> = { status };
	if (status === "dispatched" && opts.dispatched_to) {
		// normalize: dispatched_by / dispatch_msg_id default to "" — only
		// task_dispatch knows the dispatcher and the delegation msg_id; a
		// bare set_status dispatch has neither (no one to notify, no
		// message to reply to)
		patch.dispatched_to = {
			...opts.dispatched_to,
			dispatched_by: opts.dispatched_to.dispatched_by ?? "",
			dispatch_msg_id: opts.dispatched_to.dispatch_msg_id ?? "",
		};
	} else if (status === "done" || status === "cancelled") {
		// terminal states end responsibility — the dispatchee no longer owns the item
		patch.dispatched_to = null;
	}
	if (status === "active" && opts.execution_session) {
		// start records the worker's execution session — kept on terminal
		// states for retrospection (unlike dispatched_to, never cleared here);
		// a reopen/undo keeps it until the next start overwrites it
		patch.execution_session = {
			session_id: opts.execution_session.session_id ?? "",
			session_file: opts.execution_session.session_file ?? "",
		};
	}
	// reopen (done → active) / undo (cancelled → pending) restart the work —
	// the old completion report no longer applies, so it is voided
	if (
		(existing.status === "done" && status === "active") ||
		(existing.status === "cancelled" && status === "pending")
	) {
		patch.completion_report = null;
	}
	const item = bump(
		cwd,
		existing,
		patch,
		opts.change_summary?.trim() || `status: ${status}`,
		opts.updated_by || "unknown",
		now,
	);
	atomicWriteTask(cwd, clean, item);

	const unlocked =
		status === "done" || status === "cancelled" ? unlockedBy(preItems, clean) : [];
	return { item, unlocked };
}

// ---------------------------------------------------------------------------
// Completion report
// ---------------------------------------------------------------------------

/**
 * Write the dispatched agent's completion report — the execution record of what
 * was actually done and how it deviates from the plan. The ONLY writer is the
 * agent the item is dispatched to (identity from the --cname CLI flag): this is
 * the worker's own record, separate from the manager's one-line change_summary
 * on task_complete. Version bumps +1 with the old version's trace entry (the
 * report's first line, single-lined) pushed into history; the previous report
 * is overwritten (an item completes once — on reopen/undo the report is
 * voided instead).
 *
 * Rejects:
 * - the item does not exist;
 * - the report is empty;
 * - the caller is not the dispatched agent — including terminal states
 *   (done/cancelled clear dispatched_to, so writing after completion is
 *   naturally refused).
 */
export function setCompletionReport(
	cwd: string,
	id: string,
	report: string,
	updatedBy: string,
	opts: {
		/** Optimistic concurrency: the version the caller read — the write fails
		 *  with a conflict error if the record has moved past it (re-read and
		 *  retry). Omitted = last-writer-wins. */
		expected_version?: number;
	} = {},
): Task {
	const clean = sanitizeTaskId(id);
	const existing = readTask(cwd, clean);
	if (!existing) {
		throw new Error(`tasks: task "${clean}" does not exist — create it with task_create first`);
	}
	assertExpectedVersion(clean, existing.version, opts.expected_version);
	const text = report?.trim() ?? "";
	if (!text) {
		throw new Error(
			`tasks: completion report for "${clean}" is empty — write what you actually did (brief when it matches the plan, detailed when it deviates)`,
		);
	}
	if (!existing.dispatched_to || existing.dispatched_to.name !== updatedBy) {
		throw new Error(
			`tasks: cannot write the completion report for "${clean}" — it is dispatched to ${existing.dispatched_to ? existing.dispatched_to.name : "(no one)"}, not to you (${updatedBy}); only the dispatched agent records the completion report`,
		);
	}
	const now = new Date().toISOString();
	const item = bump(
		cwd,
		existing,
		{ completion_report: text },
		// history keeps one-line summaries only — the report's first line is its digest
		text.split("\n")[0],
		updatedBy,
		now,
	);
	atomicWriteTask(cwd, clean, item);
	return item;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * List all tasks, sorted by id (deterministic — the deps array is
 * id-ordered, so sorted input makes dependentsOf etc. stable). Corrupted
 * files are skipped so one bad file never blows up the listing (readTask
 * surfaces corruption on direct access instead).
 */
export function listTasks(cwd: string): TaskSummary[] {
	const dir = tasksDir(cwd);
	if (!existsSync(dir)) return [];
	const out: TaskSummary[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const item = parseTask(readFileSync(join(dir, file), "utf-8"));
			if (!item) continue;
			out.push({
				id: item.id,
				title: item.title,
				status: item.status,
				kind: item.kind,
				version: item.version,
				updated_at: item.updated_at,
				updated_by: item.updated_by,
				dispatched_to: item.dispatched_to,
				depCount: item.deps.length,
				subgraph_deps: item.subgraph_deps,
			});
		} catch {
			// corrupted — skip in the listing
		}
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

// (Dispatch records the agent NAME — the comms identity, which is the
// address comms actually delivers to and which survives restarts. No session
// file lookup at dispatch time.)
