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
 * A THIRD kind — `info` (shared information node) — is NOT a DAG node at
 * all: pure content with no deps, no subgraph gate, no status lifecycle. It
 * exists to let many tasks share ONE copy of repeated requirements: a task
 * holds `info_refs` (content references, not graph edges) pointing at info
 * nodes whose description bodies are injected into the task's description at
 * READ time (injectedInfo / effectiveDescription). Info nodes are excluded
 * from the ready set, orphans, and status transitions; they never dispatch.
 *
 * THREE-FILE LAYOUT — every task is THREE true-copy files (metadata, body,
 * report) plus per-agent DRAFTS and per-version SNAPSHOTS:
 *
 *   .pi/tasks/
 *   ├── <id>.toml              # ① metadata 真本 (no bodies; carries sha256 of both bodies)
 *   ├── <id>.description.md    # ② description 真本 — frontmatter: version — ONLY commit rewrites it
 *   ├── <id>.report.md         # ③ report 真本 — frontmatter: for_version — ONLY report/void rewrites it
 *   ├── draft/
 *   │   └── <cname>/           # per-agent drafts (write/edit freely; consumed by commit)
 *   │       ├── <id>.toml              # metadata 草稿 (patch semantics)
 *   │       ├── <id>.description.md    # description 草稿
 *   │       └── <id>.report.md         # report 草稿
 *   └── history/
 *       └── <id>.v<N>/         # version N snapshot — ALSO three files, frozen at the commit
 *           ├── metadata.toml
 *           ├── description.md
 *           └── report.md
 *
 * True copies are machine-maintained and stay clean between commits: agents
 * edit DRAFTS, and task_commit / task_submit_report atomically validate,
 * snapshot the replaced version (history/<id>.v<N>/ — the OLD version's
 * exact three-file state, archived before the new one becomes visible), and
 * write the new true copies. A commit consumes the drafts it used.
 *
 * BODY FORMAT — description.md and report.md carry a YAML-ish frontmatter so
 * the files are self-describing when opened directly:
 *   description.md: ---\nversion: <N>\n---\n\n<body>
 *   report.md:      ---\nfor_version: <N>\n---\n\n<body>
 * `for_version` anchors the report to the description version it was written
 * against — after a replan the report's anchor makes the staleness visible.
 * Drafts may carry frontmatter too (copied from a true copy); commit strips
 * it and rebuilds it machine-side.
 *
 * INTEGRITY — the metadata toml stores `description_sha256` / `report_sha256`
 * = sha256 of the exact true-copy file bytes (frontmatter included), written
 * at commit. Reads recompute the hashes and compare: a mismatch or a missing
 * true file surfaces as an integrity warning (tampering / outside-modification
 * of a true copy) — the record stays readable, the warning names the file.
 *
 * VERSION SEMANTICS — `version` counts CONTENT revisions: +1 on every change
 * to title / description / deps / subgraph_deps / kind / info_refs (i.e. every successful
 * task_commit). Lifecycle events (status transitions, dispatch, start) and
 * completion reports do NOT bump the version — they append a history entry
 * (changed_items) and update updated_at/by. Snapshots are written only on
 * version bumps. `expected_version` (optimistic concurrency) is MANDATORY on
 * every commit (create requires 1; updates require task_read's version). On
 * reports the version read is the MANDATORY anchor: a report is always written
 * against the exact description version the worker read (for_version), and if
 * that is older than the current version the report is still recorded but
 * flagged stale (report_for_version < version) so the reader judges whether
 * the old-contract work still satisfies the new contract.
 *
 * WRITE CONCURRENCY — the store has exactly one writer at a time, enforced by
 * a cross-process mutex (see `withStoreLock`). Optimistic `expected_version`
 * alone is NOT sufficient: the version check and the rename are separate
 * syscalls, so two PROCESSES (each agent runs its own pi) sharing one
 * .pi/tasks can both pass the check and both write, silently dropping one
 * update. Parallel tool calls within a single process cannot interleave (the
 * whole write path is synchronous JS), so the mutex exists for the
 * cross-process topology — the normal one (coordinator + workers share cwd).
 * `expected_version` remains the LOGICAL guard (a caller's stale intent is
 * rejected, not merged); the mutex is the PHYSICAL guard (writes do not
 * interleave at all).
 *
 * State machine — done/cancelled are terminal except reopen/undo; cancelled
 * counts as satisfied everywhere (dependents), so cancelling resolves a stuck
 * task without blocking everything downstream:
 *   | current   | legal next                                              |
 *   |-----------|---------------------------------------------------------|
 *   | pending    | dispatched, active, blocked, done, cancelled            |
 *   | dispatched | active, pending, blocked, done, cancelled, worker_offline |
 *   | active     | pending, blocked, done, cancelled, worker_offline       |
 *   | worker_offline | dispatched, pending, blocked, done, cancelled       |
 *   | blocked    | pending, dispatched, active, done, cancelled           |
 *   | done       | active (reopen)                                          |
 *   | cancelled  | pending (undo)                                           |
 * dispatched = the delegation message is sent and the owner recorded, but work
 * not started — the owner's task_start moves it to active and records its
 * execution session (session id + JSONL transcript file, kept for
 * retrospection even after done/cancelled). Constraint beyond the table:
 * marking a node done while deps are unsatisfied is a hard error listing the
 * missing deps.
 *
 * REOPEN/UNDO void the completion report (the work restarts) — the report
 * true copy is reset to an empty body. The old single-TOML plan format is NOT
 * supported (no migration): a stale file from a previous format parses but
 * yields an empty description — the supported path is draft + task_commit.
 *
 * Corruption: readTask throws with the available ids; listTasks skips
 * corrupted files so the listing never blows up; the graph layer
 * (validateGraph) exists to inspect hand-edited damage.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { DepGraphCycleError } from "dependency-graph";
import { parse } from "smol-toml";
import { buildGraph, dependencyClosure, effectiveDeps, unlockedBy } from "./graph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "dispatched" | "active" | "done" | "blocked" | "cancelled" | "worker_offline";

const STATUSES: readonly TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled", "worker_offline"];

/**
 * Granularity kind: "unit" (a concrete work item a single agent can resolve within a
 * 400k token budget) or "module" (aggregation — may have a subgraph below it and need
 * delegation). Both kinds carry deps (precedence edges — see Task.deps); the difference is
 * granularity/executability, not dependency freedom. subgraph_deps (subgraph gates) stay
 * module-only — a gate is meaningless without a subgraph to gate.
 */
export type TaskKind = "module" | "unit" | "info";

const KINDS: readonly TaskKind[] = ["module", "unit", "info"];

/**
 * One change's trace entry. `changed_items` names WHAT changed in this write
 * (a commit can change several at once): title / description / deps /
 * subgraph_deps / kind for content commits, "status" for lifecycle events,
 * "report" for completion-report writes. `version` is the description version
 * the entry relates to (the new version for a content commit, the current
 * version at event time otherwise). `event` carries the lifecycle action
 * (dispatch / start / complete / block / cancel / status) when the entry is
 * a status transition, else "".
 */
export interface TaskHistoryEntry {
	/** The items this write changed: title | description | deps | subgraph_deps | kind | info_refs | status | report. */
	changed_items: string[];
	/** The description version this entry relates to. */
	version: number;
	/** Lifecycle action when this is a status transition, else "". */
	event: string;
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
	/** The dispatcher's agent name — who delegated this item. */
	dispatched_by: string;
	/** The msg_id of the delegation message — the worker's task_submit_report replies to it. */
	dispatch_msg_id: string;
}

/** The worker's execution session — recorded by the WORKER itself at
 *  task_start (only the executing agent knows its own pi session). */
export interface TaskExecutionSession {
	session_id: string;
	session_file: string;
}

/** A stored task — the single entity at any granularity (task, module, milestone). */
export interface Task {
	/** kebab-case slug ("task-auth-login"). */
	id: string;
	/** Single-line title. */
	title: string;
	/** Body of .pi/tasks/<id>.description.md — the content contract (acceptance
	 *  criteria, numbered assumptions, interface contracts). Frontmatter stripped. */
	description: string;
	/** Dependency edges (deduplicated, sorted): B.deps = [A] means B depends on A having completed. */
	deps: string[];
	/** Subgraph gates (modules only, deduplicated, sorted). */
	subgraph_deps: string[];
	/** Info refs (content references only — NOT graph edges): ids of `info` nodes
	 *  whose shared description body is injected into THIS item's description at
	 *  read time. Deduplicated, sorted. No dispatch/ready-set impact. */
	info_refs: string[];
	status: TaskStatus;
	kind: TaskKind;
	/** Content revision — +1 on every change to title/description/kind/info_refs (the worker's
	 *  contract). deps/subgraph_deps changes do NOT bump THIS — they bump struct_version.
	 *  This is the value `expected_version` (commit/report) and the report `for_version` anchor against. */
	version: number;
	/** Structural revision — +1 on every deps/subgraph_deps change (including into_* wiring that
	 *  re-commits a parent). Used for write-concurrency on the edge arrays, and exposed as a soft
	 *  signal (struct_changed_at) so a consumer holding a stale content version knows the subgraph
	 *  grew without being forced to re-read. Independent of `version` — wiring never bumps `version`. */
	struct_version: number;
	/** ISO timestamp of the last structural (deps/subgraph_deps) change — the soft signal a consumer
	 *  sees on task_read. Never forces a re-read (content `version` is unchanged), just informs. */
	struct_changed_at: string;
	/** sha256 of the true description.md bytes (frontmatter included). */
	description_sha256: string | null;
	/** sha256 of the true report.md bytes. */
	report_sha256: string | null;
	created_at: string;
	updated_at: string;
	updated_by: string;
	dispatched_to: TaskDispatch | null;
	execution_session: TaskExecutionSession | null;
	/** Body of .pi/tasks/<id>.report.md — the worker's completion record. Null when empty. */
	completion_report: string | null;
	/** Past change traces, newest first. */
	history: TaskHistoryEntry[];
	/** ── transient (never serialized) ── */
	/** Integrity problems found while loading the true copies (hash mismatch / missing file). */
	integrity_warnings?: string[];
	/** The description version the current report is anchored to (report.md frontmatter).
	 *  Always set: a committed report always carries its anchor (the version the worker
	 *  read), and a report against an older contract keeps that older anchor —
	 *  report_for_version < version flags the staleness for the reader. */
	report_for_version: number;
}

/** One row of the task listing. */
export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	kind: TaskKind;
	version: number;
	struct_version: number;
	updated_at: string;
	updated_by: string;
	/** Current responsible agent, when dispatched. */
	dispatched_to: TaskDispatch | null;
	/** Milliseconds since the item entered its CURRENT status (staleness signal). */
	status_since_ms: number;
	/** Number of dependency edges. */
	depCount: number;
	/** Subgraph gate ids declared by this item (modules only). */
	subgraph_deps: string[];
	/** Info refs (content references, not graph edges). */
	info_refs: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max history entries kept (summaries only). */
export const HISTORY_CAP = 10;

/**
 * Milliseconds since the task entered its CURRENT status — derived from the
 * NEWEST history entry that changed status (the transition that set it); if
 * no such entry survives in the capped history, falls back to updated_at.
 * Surfaces staleness: a dispatched/active task sitting too long (no report,
 * no start) is exactly what a manager must notice on a reminder turn, so the
 * read tools expose this age next to the status.
 */
export function statusSinceMs(item: Task, now = Date.now()): number {
	const statusEntry = item.history.find((h) => h.changed_items.includes("status"));
	const at = Date.parse(statusEntry ? statusEntry.updated_at : item.updated_at);
	return Number.isNaN(at) ? 0 : Math.max(0, now - at);
}

// ---------------------------------------------------------------------------
// Paths / ids
// ---------------------------------------------------------------------------

/** Directory holding task files. PI_TASKS_DIR overrides the default. */
export function tasksDir(cwd: string): string {
	return process.env.PI_TASKS_DIR ?? join(cwd, ".pi", "tasks");
}

/** The true metadata file — used by shells to report paths. */
export function taskTomlPath(cwd: string, id: string): string {
	return join(tasksDir(cwd), `${id}.toml`);
}

/** True description body file. */
export function taskDescriptionPath(cwd: string, id: string): string {
	return join(tasksDir(cwd), `${id}.description.md`);
}

/** True report body file. */
export function taskReportPath(cwd: string, id: string): string {
	return join(tasksDir(cwd), `${id}.report.md`);
}

/** Per-agent draft directory (draft/<cname>/). */
export function taskDraftDir(cwd: string, cname: string): string {
	return join(tasksDir(cwd), "draft", sanitizeAgentName(cname));
}

/** Metadata draft file for one task. */
export function taskDraftTomlPath(cwd: string, cname: string, id: string): string {
	return join(taskDraftDir(cwd, cname), `${id}.toml`);
}

/** Description draft file for one task. */
export function taskDraftDescriptionPath(cwd: string, cname: string, id: string): string {
	return join(taskDraftDir(cwd, cname), `${id}.description.md`);
}

/** Report draft file for one task. */
export function taskDraftReportPath(cwd: string, cname: string, id: string): string {
	return join(taskDraftDir(cwd, cname), `${id}.report.md`);
}

/** A draft file's role — also its display order in a pending-draft report. */
export type DraftKind = "metadata" | "description" | "report";

const DRAFT_SUFFIXES: readonly [suffix: string, kind: DraftKind][] = [
	[".toml", "metadata"],
	[".description.md", "description"],
	[".report.md", "report"],
];

/** One task id with the draft files of that id still unconsumed. */
export interface PendingDraft {
	id: string;
	kinds: DraftKind[];
}

/**
 * Draft files left in draft/<cname>/ — a commit's leftovers. Drafts are invisible
 * to the graph (only top-level true copies are scanned), so a commit reports them
 * to keep uncommitted work from being silently forgotten. Unknown file names are
 * skipped: they are not committable as any draft kind.
 */
export function listPendingDrafts(cwd: string, cname: string): PendingDraft[] {
	let names: string[];
	try {
		names = readdirSync(taskDraftDir(cwd, cname));
	} catch {
		return []; // no draft dir — nothing was ever checked out
	}
	const byId = new Map<string, Set<DraftKind>>();
	for (const name of names) {
		const hit = DRAFT_SUFFIXES.find(([suffix]) => name.endsWith(suffix));
		if (!hit) continue;
		const id = name.slice(0, -hit[0].length);
		if (!id) continue;
		const kinds = byId.get(id) ?? new Set<DraftKind>();
		kinds.add(hit[1]);
		byId.set(id, kinds);
	}
	return [...byId.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, kinds]) => ({ id, kinds: DRAFT_SUFFIXES.map(([, k]) => k).filter((k) => kinds.has(k)) }));
}

/** Directory holding archived version snapshots (history/). */
function taskHistoryDir(cwd: string): string {
	return join(tasksDir(cwd), "history");
}

/** Directory of one archived version: history/<id>.v<N>/ — three files inside. */
function taskVersionDir(cwd: string, id: string, version: number): string {
	return join(taskHistoryDir(cwd), `${id}.v${version}`);
}

function versionMetadataPath(cwd: string, id: string, version: number): string {
	return join(taskVersionDir(cwd, id, version), "metadata.toml");
}

function versionDescriptionPath(cwd: string, id: string, version: number): string {
	return join(taskVersionDir(cwd, id, version), "description.md");
}

function versionReportPath(cwd: string, id: string, version: number): string {
	return join(taskVersionDir(cwd, id, version), "report.md");
}

/**
 * Sanitize a user-supplied task id: lowercase; illegal characters become
 * "-" (same convention as before, so "Work Auth!" → "work-auth" keeps
 * kebab-case readability); collapse runs of separators and strip leading/
 * trailing ones. Returns "" when nothing survives (caller decides).
 */
export function sanitizeTaskId(id: string): string {
	return id
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * True if sanitizeTaskId would rewrite the given id — i.e. the raw id the
 * agent supplied is not already clean kebab-case. Tools surface this so a
 * caller always sees when the id they typed was normalized (e.g. "My Task!"
 * → "my-task").
 */
export function taskIdNeedsSanitize(id: string): boolean {
	return id !== sanitizeTaskId(id);
}

/** A one-line note for a tool result when the supplied id was normalized. */
export function sanitizedIdNote(rawId: string): string | null {
	const clean = sanitizeTaskId(rawId);
	if (rawId === clean) return null;
	return `  note: id "${rawId}" was normalized to "${clean}" (kebab-case)`;
}

/** Sanitize an agent identity (--cname) into a safe draft directory name. */
export function sanitizeAgentName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	return cleaned || "unknown";
}

// ---------------------------------------------------------------------------
// Body files: frontmatter + hashing
// ---------------------------------------------------------------------------

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}

/** A parsed body file: frontmatter stripped, full-content hash kept. */
export interface BodyFile {
	body: string;
	hash: string;
	version?: number;
	for_version?: number;
}

/**
 * Split a body file into its frontmatter (a leading `---\nkey: value\n---\n`
 * block) and the body. No frontmatter (or a malformed one) → whole content is
 * the body. Frontmatter keys are parsed leniently (numbers may be absent).
 */
export function parseBodyFile(raw: string): BodyFile {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:[ \t]*\r?\n)?/.exec(raw);
	if (!m) return { body: raw, hash: sha256(raw) };
	const kv: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return {
		body: raw.slice(m[0].length),
		hash: sha256(raw),
		version: kv.version !== undefined ? Number(kv.version) : undefined,
		for_version: kv.for_version !== undefined ? Number(kv.for_version) : undefined,
	};
}

/** Render a body file with machine frontmatter — the canonical true-copy format. */
function renderBodyFile(kv: Record<string, string | number>, body: string): string {
	const head = Object.entries(kv)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	return `---\n${head}\n---\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Escape a string for a TOML basic ("...") string: backslash and the
 * double-quote delimiter plus control characters.
 */
function tomlEscapeBasic(s: string): string {
	let out = "";
	for (const ch of s) {
		if (ch === "\"") out += '\\"';
		else if (ch === "\\") out += "\\\\";
		else if (ch === "\b") out += "\\b";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\f") out += "\\f";
		else if (ch === "\r") out += "\\r";
		else if (ch.charCodeAt(0) < 0x20) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return `"${out}"`;
}

/**
 * Emit one string as a TOML value, staying as close to the original text as
 * possible: multi-line text → literal `'''...'''` block (one leading newline
 * that TOML trims); falls back to a basic `"""..."""` block when the content
 * contains `'''`; single-line → literal `'...'` unless it contains a quote.
 */
function tomlString(s: string): string {
	if (s.includes("\n") || s.includes("\r")) {
		if (s.includes("'''")) {
			const body = s.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
			return `"""\n${body}"""`;
		}
		return `'''\n${s}'''`;
	}
	if (!s.includes("'")) return `'${s}'`;
	return tomlEscapeBasic(s);
}

/** Inline TOML array of simple strings. */
function tomlArray(ids: string[]): string {
	return ids.length ? `[ ${ids.map(tomlString).join(", ")} ]` : "[]";
}

/**
 * Serialize the METADATA record to its file form (no bodies — those live in
 * the .description.md / .report.md true copies). All root scalar keys are
 * emitted before any table header ([...] / [[...]]), which TOML requires.
 * Nullable fields (dispatched_to, execution_session, hashes) are omitted when
 * null. Transient fields (integrity_warnings, report_for_version) are never
 * serialized.
 */
export function serializeMetadata(item: Task): string {
	const L: string[] = [];
	const S = (k: string, v: string) => L.push(`${k} = ${tomlString(v)}`);

	S("id", item.id);
	S("title", item.title);
	L.push(`deps = ${tomlArray(item.deps)}`);
	L.push(`subgraph_deps = ${tomlArray(item.subgraph_deps)}`);
	L.push(`info_refs = ${tomlArray(item.info_refs)}`);
	S("status", item.status);
	S("kind", item.kind);
	L.push(`version = ${item.version}`);
	L.push(`struct_version = ${item.struct_version}`);
	S("struct_changed_at", item.struct_changed_at);
	if (item.description_sha256) L.push(`description_sha256 = '${item.description_sha256}'`);
	if (item.report_sha256) L.push(`report_sha256 = '${item.report_sha256}'`);
	S("created_at", item.created_at);
	S("updated_at", item.updated_at);
	S("updated_by", item.updated_by);

	if (item.dispatched_to) {
		L.push("");
		L.push("[dispatched_to]");
		S("name", item.dispatched_to.name);
		S("dispatched_by", item.dispatched_to.dispatched_by);
		S("dispatch_msg_id", item.dispatched_to.dispatch_msg_id);
	}
	if (item.execution_session) {
		L.push("");
		L.push("[execution_session]");
		S("session_id", item.execution_session.session_id);
		S("session_file", item.execution_session.session_file);
	}
	if (item.history.length) {
		L.push("");
		for (const h of item.history) {
			L.push("[[history]]");
			L.push(`changed_items = ${tomlArray(h.changed_items)}`);
			L.push(`version = ${h.version}`);
			S("event", h.event);
			S("updated_at", h.updated_at);
			S("updated_by", h.updated_by);
			S("change_summary", h.change_summary);
		}
	}
	return L.join("\n") + "\n";
}

/** Lenient dispatch parse: a well-shaped {name} object, else null. */
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

/** Lenient execution-session parse: a well-shaped {session_id} object, else null. */
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
 * Parse the metadata TOML file form. Returns null when the structure is
 * unusable: not an object, missing/empty id or title, unknown status,
 * missing/invalid kind, non-array deps, non-integer version. Bodies are NOT
 * stored in the metadata (they live in the .description.md / .report.md true
 * copies) — description / completion_report are initialized empty and loaded
 * by readTask. Timestamps, hashes and history are lenient; history entries
 * that fail the shape check are dropped.
 */
export function parseTask(raw: string): Task | null {
	let data: unknown;
	try {
		data = parse(raw);
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
		description: "",
		deps: d.deps,
		subgraph_deps: Array.isArray(d.subgraph_deps) ? d.subgraph_deps : [],
		info_refs: Array.isArray(d.info_refs) ? d.info_refs.filter((x): x is string => typeof x === "string") : [],
		status: d.status as TaskStatus,
		kind: d.kind as TaskKind,
		version: d.version,
		/* struct_version: missing in legacy files → 1; struct_changed_at → created_at (or ""). */
		struct_version:
			typeof d.struct_version === "number" && Number.isInteger(d.struct_version) && d.struct_version >= 1
				? d.struct_version
				: 1,
		struct_changed_at: typeof d.struct_changed_at === "string" ? d.struct_changed_at : "",
		report_for_version: d.version,
		description_sha256: typeof d.description_sha256 === "string" ? d.description_sha256 : null,
		report_sha256: typeof d.report_sha256 === "string" ? d.report_sha256 : null,
		created_at: typeof d.created_at === "string" ? d.created_at : "",
		updated_at: typeof d.updated_at === "string" ? d.updated_at : "",
		updated_by: typeof d.updated_by === "string" ? d.updated_by : "unknown",
		dispatched_to: parseDispatch(d.dispatched_to),
		execution_session: parseExecutionSession(d.execution_session),
		completion_report: null,
		history: Array.isArray(d.history)
			? d.history
					.filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
					.map((e) => ({
						changed_items: Array.isArray(e.changed_items)
							? e.changed_items.filter((x): x is string => typeof x === "string")
							: [],
						version:
							typeof e.version === "number" && Number.isInteger(e.version) ? e.version : 0,
						event: typeof e.event === "string" ? e.event : "",
						updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
						updated_by: typeof e.updated_by === "string" ? e.updated_by : "unknown",
						change_summary: typeof e.change_summary === "string" ? e.change_summary : "",
					}))
			: [],
	};
}

// ---------------------------------------------------------------------------
// Store lock — the one-writer-at-a-time mutex
// ---------------------------------------------------------------------------

/**
 * Lock directory under the store: mkdir is the atomic primitive (EEXIST =
 * held) — one lock for the WHOLE store, not per task. A commit also validates
 * the whole graph and rewrites parents' edge arrays (wiring), so the
 * invariants span nodes; per-file locking could not cover them. Commits are
 * milliseconds, so serializing all of them is cheap.
 */
function storeLockDir(cwd: string): string {
	return join(tasksDir(cwd), ".lock");
}

/** A lock younger than this is never broken, even if its owner is unreadable. */
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 15;
/** Give up acquiring after this long and surface a retryable error. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

/** Sleep synchronously without burning CPU — the write path is fully sync. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = alive but owned by another user; anything else = gone.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Break a lock whose holder is demonstrably gone: same host and a dead pid, or
 * older than LOCK_STALE_MS (a crashed holder on an unreadable/foreign host).
 * The removal is best-effort; a racing breaker just loses the next mkdir.
 */
function breakStaleLock(lock: string): void {
	let ownerPid = 0;
	let ownerHost = "";
	try {
		const token = readFileSync(join(lock, "owner"), "utf-8").trim().split(/\s+/)[0] ?? "";
		const at = token.indexOf("@");
		ownerPid = Number(at >= 0 ? token.slice(0, at) : token);
		ownerHost = at >= 0 ? token.slice(at + 1) : "";
	} catch {
		// owner file not written yet (or already gone) — fall back to age alone
	}
	// Same host + a dead pid → the holder is gone; break immediately.
	if (ownerHost === hostname() && ownerPid > 0) {
		if (processAlive(ownerPid)) return;
	} else {
		// Foreign / unreadable owner: only age can prove it is abandoned.
		let ageMs = Number.POSITIVE_INFINITY;
		try {
			ageMs = Date.now() - statSync(lock).mtimeMs;
		} catch {
			return; // vanished — the next loop iteration will just mkdir
		}
		if (ageMs < LOCK_STALE_MS) return;
	}
	try {
		rmSync(lock, { recursive: true, force: true });
	} catch {
		// someone else removed it first
	}
}

function acquireStoreLock(cwd: string, lock: string): void {
	mkdirSync(tasksDir(cwd), { recursive: true });
	// Read per acquisition (not at module load) so tests / a user can tune the
	// wait without reloading the module.
	const timeoutMs = Number(process.env.PI_TASKS_LOCK_TIMEOUT_MS ?? DEFAULT_LOCK_TIMEOUT_MS);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			// recursive:false is load-bearing — recursive mkdir never reports EEXIST.
			mkdirSync(lock);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			breakStaleLock(lock);
			if (Date.now() >= deadline) {
				throw new Error(
					`tasks: could not acquire the task store lock (${relative(cwd, lock)}) within ${timeoutMs}ms — another agent is committing; retry the call`,
				);
			}
			sleepSync(LOCK_POLL_MS);
			continue;
		}
		// Write the owner INSIDE the lock we hold, so a breaker can tell whether the
		// holder is still alive. Failure is non-fatal: age-based breaking still works.
		try {
			writeFileSync(join(lock, "owner"), `${process.pid}@${hostname()} ${new Date().toISOString()}`, "utf-8");
		} catch {
			// ignore — the directory itself is the lock
		}
		return;
	}
}

/**
 * Run `fn` as the store's exclusive writer. Reentrant within one synchronous
 * call chain: a public write entry point that internally calls another
 * (loadGraph, readTask, wiring) must not deadlock on its own lock — since the
 * whole critical section is synchronous, a module-global is enough to detect
 * it.
 */
let heldLockDir: string | null = null;
function withStoreLock<T>(cwd: string, fn: () => T): T {
	const lock = storeLockDir(cwd);
	if (heldLockDir === lock) return fn();
	acquireStoreLock(cwd, lock);
	heldLockDir = lock;
	try {
		return fn();
	} finally {
		heldLockDir = null;
		try {
			rmSync(lock, { recursive: true, force: true });
		} catch {
			// best effort — a leftover lock is broken by the stale-lock rules
		}
	}
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Atomically write one file (tmp + rename), creating parent directories.
 * The tmp name carries pid + a per-process sequence: even under the store lock
 * (which already serializes writers) a stale tmp from a crashed run must never
 * be reused by a different writer.
 */
let tmpSeq = 0;
function atomicWriteFile(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Lenient read: returns null when absent OR corrupted. Writers use this —
 * a write overwrites a corrupted file (last-writer-wins as repair);
 * readTask stays strict so the tool surfaces corruption.
 */
function tryReadTaskFile(cwd: string, id: string): Task | null {
	const tomlPath = taskTomlPath(cwd, id);
	if (!existsSync(tomlPath)) return null;
	return parseTask(readFileSync(tomlPath, "utf-8"));
}

/**
 * Load the body true copies into a parsed record. The sha256 of each file is
 * recomputed and compared against the stored hash — a mismatch or a missing
 * true file yields an integrity warning (transient field) naming the file.
 * There is NO fallback body: bodies live only in the true copy files.
 */
function loadBodies(cwd: string, item: Task): Task {
	const warnings: string[] = [];
	const descPath = taskDescriptionPath(cwd, item.id);
	if (existsSync(descPath)) {
		const pf = parseBodyFile(readFileSync(descPath, "utf-8"));
		item.description = pf.body;
		if (item.description_sha256 !== null && item.description_sha256 !== pf.hash) {
			warnings.push(
				`${item.id}.description.md hash mismatch — stored ${item.description_sha256.slice(0, 8)}…, file ${pf.hash.slice(0, 8)}… (true copy modified outside a commit; restore from history or re-commit)`,
			);
		}
	} else if (item.description_sha256 !== null) {
		warnings.push(`${item.id}.description.md is missing — the true copy was deleted`);
	}
	const reportPath = taskReportPath(cwd, item.id);
	if (existsSync(reportPath)) {
		const pf = parseBodyFile(readFileSync(reportPath, "utf-8"));
		item.completion_report = pf.body.trim() ? pf.body : null;
		item.report_for_version = pf.for_version ?? item.version;
		if (item.report_sha256 !== null && item.report_sha256 !== pf.hash) {
			warnings.push(
				`${item.id}.report.md hash mismatch — stored ${item.report_sha256.slice(0, 8)}…, file ${pf.hash.slice(0, 8)}… (true copy modified outside a commit; restore from history or re-commit)`,
			);
		}
	} else if (item.report_sha256 !== null) {
		warnings.push(`${item.id}.report.md is missing — the true copy was deleted`);
	}
	// Invariant: report_for_version is always set — parseTask seeds it from d.version and the
	// report branch above re-seeds from the body frontmatter (pf.for_version ?? item.version).
	if (warnings.length > 0) item.integrity_warnings = warnings;
	return item;
}

/**
 * Read a task. Returns null when the item does not exist; throws with
 * the list of available ids when the file is corrupted. Body true copies are
 * loaded (frontmatter stripped); integrity warnings are set when a body hash
 * mismatch or a missing body file is found.
 */
export function readTask(cwd: string, id: string): Task | null {
	const clean = sanitizeTaskId(id);
	const tomlPath = taskTomlPath(cwd, clean);
	if (!existsSync(tomlPath)) return null;
	const item = parseTask(readFileSync(tomlPath, "utf-8"));
	if (!item) {
		const available = listTasks(cwd).map((w) => w.id).join(", ") || "(none)";
		throw new Error(
			`tasks: task "${clean}" is corrupted (malformed TOML or missing fields) — available tasks: ${available}`,
		);
	}
	return loadBodies(cwd, item);
}

/**
 * The read-time expansion of a task's `info_refs`: the shared description
 * bodies of every referenced info node, in the refs' (sorted) order, each
 * prefixed with a header naming the info node — so a worker reading a task
 * sees the shared requirements written ONCE, then the task's own specific
 * description below. Returns an empty string when the item has no info_refs.
 *
 * This is a CONTENT expansion only (never a graph edge): info nodes carry no
 * status lifecycle, are never dispatched, and do not affect the ready set.
 * A ref target that vanished is reported inline (tolerant of hand-edits).
 * The item's OWN description is NOT included here — the caller appends it.
 */
export function injectedInfo(cwd: string, item: Task): string {
	if (item.info_refs.length === 0) return "";
	const parts: string[] = [];
	for (const ref of item.info_refs) {
		const src = readTask(cwd, ref);
		if (!src) {
			parts.push(`── shared information: "${ref}" — (missing) ──`);
			continue;
		}
		const srcBody = src.description.trim();
		parts.push(
			`── shared information: "${ref}" (${src.title}) ──` +
				(srcBody ? `\n${srcBody}` : "\n(empty)"),
		);
	}
	return parts.join("\n\n");
}

/**
 * A task's EFFECTIVE description for reading: the injected shared info
 * content (info_refs) followed by the item's own description body. This is
 * what a worker sees when they read the task — the shared requirements are
 * pulled in automatically, so they are written (and updated) in ONE place.
 * Editing (task_checkout) deliberately uses the raw own-description, so a
 * worker edits only the task-specific part and the shared content stays
 * referenced, not duplicated.
 */
export function effectiveDescription(cwd: string, item: Task): string {
	const own = item.description;
	const info = injectedInfo(cwd, item);
	if (!info) return own;
	return info + "\n\n" + (own.trim() ? own : "(no task-specific description)");
}

/**
 * Read the archived snapshot of a past version from history/<id>.v<N>/ —
 * three files (metadata.toml + description.md + report.md), the exact true
 * state at the moment the version was replaced. Returns null when the TASK
 * does not exist (same contract as readTask). Throws for: non-positive
 * version; version >= current (read the live record instead); a version
 * without a snapshot (never committed / snapshot gone); a corrupted snapshot
 * — errors name the archived versions that do exist.
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
	const dir = taskVersionDir(cwd, clean, version);
	if (!existsSync(dir)) {
		const archived = archivedVersions(cwd, clean);
		throw new Error(
			`tasks: "${clean}" has no snapshot for version ${version} — snapshots start at the first change made after this feature shipped` +
				(archived.length > 0 ? ` — archived versions: ${archived.join(", ")}` : ""),
		);
	}
	const metaPath = versionMetadataPath(cwd, clean, version);
	if (!existsSync(metaPath)) {
		throw new Error(
			`tasks: snapshot for "${clean}" v${version} is missing metadata.toml — archived versions: ${archivedVersions(cwd, clean).join(", ") || "(none)"}`,
		);
	}
	const item = parseTask(readFileSync(metaPath, "utf-8"));
	if (!item) {
		throw new Error(
			`tasks: snapshot for "${clean}" v${version} is corrupted (malformed TOML or missing fields) — archived versions: ${archivedVersions(cwd, clean).join(", ") || "(none)"}`,
		);
	}
	const descPath = versionDescriptionPath(cwd, clean, version);
	if (existsSync(descPath)) {
		item.description = parseBodyFile(readFileSync(descPath, "utf-8")).body;
	}
	const reportPath = versionReportPath(cwd, clean, version);
	if (existsSync(reportPath)) {
		const pf = parseBodyFile(readFileSync(reportPath, "utf-8"));
		item.completion_report = pf.body.trim() ? pf.body : null;
		item.report_for_version = pf.for_version ?? item.version;
	}
	// report_for_version is always set by parseTask / the report branch above.
	return item;
}

/** Sorted list of archived version numbers for one id (readdir-based truth). */
function archivedVersions(cwd: string, id: string): number[] {
	const dir = taskHistoryDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.startsWith(`${id}.v`))
		.map((e) => Number(e.name.slice(`${id}.v`.length)))
		.filter((n) => Number.isInteger(n) && n >= 1)
		.sort((a, b) => a - b);
}

/**
 * Archive the current true state as version N's snapshot — three files under
 * history/<id>.v<N>/, written BEFORE the live record changes (the old version
 * must be durable before the new one becomes visible). The snapshot metadata
 * carries the sha256 of its own body files, so every version is independently
 * verifiable.
 */
function writeTaskSnapshot(cwd: string, item: Task): void {
	const descContent = renderBodyFile({ version: item.version }, item.description);
	const reportContent = renderBodyFile({ for_version: item.version }, item.completion_report ?? "");
	const meta: Task = {
		...item,
		description: "",
		completion_report: null,
		description_sha256: sha256(descContent),
		report_sha256: sha256(reportContent),
	};
	delete (meta as Partial<Task>).integrity_warnings;
	delete (meta as Partial<Task>).report_for_version;
	atomicWriteFile(versionMetadataPath(cwd, item.id, item.version), serializeMetadata(meta));
	atomicWriteFile(versionDescriptionPath(cwd, item.id, item.version), descContent);
	atomicWriteFile(versionReportPath(cwd, item.id, item.version), reportContent);
}

/**
 * Write the metadata toml + description.md true copy for a NEW record state.
 * description_sha256 is recomputed from the description.md bytes just written;
 * report_sha256 comes from the caller (the report.md file is NOT touched
 * here — a plain content commit must not disturb an existing report anchor).
 */
function writeMetadataAndDescription(cwd: string, item: Task): void {
	const descContent = renderBodyFile({ version: item.version }, item.description);
	atomicWriteFile(taskTomlPath(cwd, item.id), serializeMetadata({ ...item, description_sha256: sha256(descContent) }));
	atomicWriteFile(taskDescriptionPath(cwd, item.id), descContent);
}

/** Write only the metadata toml (structure-only change: deps/subgraph_deps grew but the
 *  description contract did not). The description.md / report.md true copies are NOT touched,
 *  and description_sha256 is carried over unchanged (the file bytes are identical). */
function writeMetadataOnly(cwd: string, item: Task): void {
	atomicWriteFile(taskTomlPath(cwd, item.id), serializeMetadata(item));
}

/** Delete consumed draft files (best effort). */
function consumeDrafts(paths: string[]): string[] {
	const consumed: string[] = [];
	for (const p of paths) {
		try {
			unlinkSync(p);
			consumed.push(p);
		} catch {
			// best effort — a stray draft must not fail the commit
		}
	}
	return consumed;
}

// ---------------------------------------------------------------------------
// Draft metadata parsing (patch semantics)
// ---------------------------------------------------------------------------

/**
 * Parse a metadata DRAFT toml. Patch semantics: only the fields present in the
 * draft change — title / deps / subgraph_deps / kind / info_refs; absent fields
 * keep their current value (update) or default (create). `into_deps` /
 * `into_subgraph_deps` / `into_info_ref` are COMMIT-TIME DIRECTIVES (see
 * commitTask): they declare which existing parents this node should be wired into
 * (this id appended to the parent's deps / subgraph_deps / info_refs), consumed by
 * the commit and NEVER stored on this node. Machine-managed fields (status,
 * version, struct_version, history, timestamps, hashes, dispatched_to,
 * execution_session) are ignored if present.
 * An `id` in the draft must resolve to the committed task id.
 */
function parseDraftToml(cwd: string, path: string, cleanId: string): {
	title?: string;
	deps?: string[];
	subgraph_deps?: string[];
	kind?: TaskKind;
	info_refs?: string[];
	into_deps?: string[];
	into_subgraph_deps?: string[];
	into_info_ref?: string[];
} {
	let data: unknown;
	try {
		data = parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error(
			`tasks: draft ${relative(cwd, path)} is malformed TOML — fix it and retry`,
		);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`tasks: draft ${relative(cwd, path)} must be a TOML table`);
	}
	const d = data as Record<string, unknown>;
	if (typeof d.id === "string" && sanitizeTaskId(d.id) !== cleanId) {
		throw new Error(
			`tasks: draft id "${d.id}" does not match task "${cleanId}" — fix the draft or the task id`,
		);
	}
	const out: { title?: string; deps?: string[]; subgraph_deps?: string[]; kind?: TaskKind; info_refs?: string[]; into_deps?: string[]; into_subgraph_deps?: string[]; into_info_ref?: string[] } = {};
	if (typeof d.title === "string") out.title = d.title;
	if (Array.isArray(d.deps) && d.deps.every((x) => typeof x === "string")) out.deps = d.deps;
	if (Array.isArray(d.subgraph_deps) && d.subgraph_deps.every((x) => typeof x === "string")) {
		out.subgraph_deps = d.subgraph_deps;
	}
	if (Array.isArray(d.info_refs) && d.info_refs.every((x) => typeof x === "string")) {
		out.info_refs = d.info_refs;
	}
	if (Array.isArray(d.into_deps) && d.into_deps.every((x) => typeof x === "string")) {
		out.into_deps = d.into_deps;
	}
	if (Array.isArray(d.into_subgraph_deps) && d.into_subgraph_deps.every((x) => typeof x === "string")) {
		out.into_subgraph_deps = d.into_subgraph_deps;
	}
	if (Array.isArray(d.into_info_ref) && d.into_info_ref.every((x) => typeof x === "string")) {
		out.into_info_ref = d.into_info_ref;
	}
	if (typeof d.kind === "string") out.kind = d.kind as TaskKind;
	return out;
}

// ---------------------------------------------------------------------------
// Deps / graph validation
// ---------------------------------------------------------------------------

/** Comma-joined ids of a graph snapshot, for the teaching error messages. */
function availableList(graph: Task[]): string {
	return graph.map((i) => i.id).join(", ") || "(none)";
}

/**
 * Normalize a caller-provided dep list: sanitize each id, deduplicate, sort.
 * Every dep must resolve to an item in the graph snapshot; a dep that is the
 * item's own id is a self-loop and rejected with the cycle error format.
 */
function normalizeDeps(graph: Task[], itemId: string, rawDeps: string[]): string[] {
	const deps = [...new Set(rawDeps.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	const ids = new Set(graph.map((i) => i.id));
	for (const dep of deps) {
		if (dep === itemId) {
			throw new Error(`tasks: would create a dependency cycle: ${itemId} → ${itemId}`);
		}
		if (!ids.has(dep)) {
			throw new Error(
				`tasks: dep "${dep}" does not exist — create it first — available tasks: ${availableList(graph)}`,
			);
		}
	}
	return deps;
}

/**
 * Normalize a caller-provided subgraph_deps (subgraph gate) list: sanitize each
 * id, deduplicate, sort. Every gate must resolve to an existing item.
 * The remaining gate constraints — not the module itself, not inside its own
 * subgraph — are checked by assertSubgraphDepOutsideSubgraph; cycles that only
 * arise BETWEEN gates are caught by assertNoCycle.
 */
function normalizeSubgraphDeps(graph: Task[], rawGates: string[]): string[] {
	const gates = [...new Set(rawGates.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	const ids = new Set(graph.map((i) => i.id));
	for (const gate of gates) {
		if (!ids.has(gate)) {
			throw new Error(
				`tasks: subgraph_deps gate "${gate}" does not exist — create it first — available tasks: ${availableList(graph)}`,
			);
		}
	}
	return gates;
}

/**
 * Normalize a caller-provided info_refs list: sanitize each id, deduplicate,
 * sort. Every ref must resolve to an existing item of kind "info" — an info
 * ref is a CONTENT reference (its shared description is injected at read
 * time), so it may not point at a task or module. A ref to the item's own id
 * is rejected as a self-reference.
 */
function normalizeInfoRefs(graph: Task[], itemId: string, rawRefs: string[]): string[] {
	const refs = [...new Set(rawRefs.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	const byId = new Map(graph.map((i) => [i.id, i]));
	for (const ref of refs) {
		if (ref === itemId) {
			throw new Error(
				`tasks: info_ref "${ref}" is the item's own id — an info ref must point at a shared information node, not at itself`,
			);
		}
		const target = byId.get(ref);
		if (!target) {
			throw new Error(
				`tasks: info_ref "${ref}" does not exist — create the shared information node first (kind = "info") — available tasks: ${availableList(graph)}`,
			);
		}
		if (target.kind !== "info") {
			throw new Error(
				`tasks: info_ref "${ref}" is not a shared information node (kind = "${target.kind}") — an info_ref must point at a node with kind = "info"; create one for the shared requirements, then reference it`,
			);
		}
	}
	return refs;
}

/**
 * A gate on the module itself or on anything inside its own subgraph would
 * create a self-loop at expansion time — rejected here with the cycle
 * teaching. Cross-gate cycles are left to assertNoCycle.
 */
function assertSubgraphDepOutsideSubgraph(items: Task[], itemId: string, deps: string[], gates: string[]): void {
	if (gates.length === 0) return;
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

/**
 * The whole stored graph in ONE directory scan — one metadata parse per file,
 * no body reads, sorted by id. The per-invocation read primitive: every write
 * path (validation, wiring, status) loads this ONCE and passes Task[] down
 * instead of re-reading the directory per dep / per check. Bodies are absent
 * — callers that need a description or report read that task via readTask.
 * Corrupted files are skipped (readTask surfaces them on direct access).
 */
export function loadGraph(cwd: string): Task[] {
	const dir = tasksDir(cwd);
	if (!existsSync(dir)) return [];
	const items: Task[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".toml")) continue;
		try {
			const item = parseTask(readFileSync(join(dir, file), "utf-8"));
			if (item) items.push(item);
		} catch {
			// corrupted — skipped, readTask surfaces it on direct access
		}
	}
	return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Reject writes that would close a cycle: build a DepGraph over the existing
 * items with the target item's (new) deps and subgraph_deps overlaid, then run
 * the library's cycle check and translate its error into the friendly form.
 * The graph is built with subgraph_deps expanded, so cross-gate cycles are
 * caught too. The check runs on the in-memory overlay — nothing is written.
 */
function assertNoCycle(items: Task[], itemId: string, deps: string[], moduleDeps: string[] = []): void {
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

/**
 * Resolve the granularity kind: default "unit"; rejects unknown values and
 * the contradiction "unit with subgraph_deps". deps are precedence edges and
 * legal on ANY kind; subgraph_deps (subgraph gates) remain module-only.
 */
function resolveKind(
	raw: TaskKind | undefined,
	deps: string[],
	moduleDeps: string[] = [],
	infoRefs: string[] = [],
): TaskKind {
	const kind = raw ?? "unit";
	if (!(KINDS as readonly string[]).includes(kind)) {
		throw new Error(`tasks: invalid kind "${String(kind)}" — one of: ${KINDS.join(" | ")}`);
	}
	if (kind === "unit" && moduleDeps.length > 0) {
		throw new Error(
			`tasks: kind "unit" cannot declare subgraph_deps — a subgraph_deps gates the module's whole subgraph, and a unit has no subgraph; use kind "module"`,
		);
	}
	if (kind === "info") {
		if (deps.length > 0) {
			throw new Error(
				`tasks: kind "info" cannot declare deps — a shared information node is pure content, it takes no dependency edges and never joins the DAG`,
			);
		}
		if (moduleDeps.length > 0) {
			throw new Error(
				`tasks: kind "info" cannot declare subgraph_deps — a shared information node gates nothing`,
			);
		}
		if (infoRefs.length > 0) {
			throw new Error(
				`tasks: kind "info" cannot declare info_refs — a shared information node references no other information; it is itself the source`,
			);
		}
	}
	return kind;
}

// ---------------------------------------------------------------------------
// Wiring — into_deps / into_subgraph_deps (commit-time directives)
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-provided into_deps list (commit directive): sanitize,
 * deduplicate, sort. Each target must EXIST (it will be re-committed — its
 * deps array grows by this node's id), must not be an `info` node (info carries
 * no deps), and must not equal the child's own id (a child cannot be its own
 * parent). The child itself (and info nodes generally) cannot be a dep of
 * anything except a task/module parent; a `info` child cannot be wired at all.
 */
function normalizeIntoDeps(graph: Task[], childId: string, childKind: TaskKind, rawTargets: string[]): string[] {
	const targets = [...new Set(rawTargets.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	if (targets.length === 0) return targets;
	if (childKind === "info") {
		throw new Error(
			`tasks: kind "info" cannot declare into_deps — a shared information node is pure content, it can never be a task's dependency`,
		);
	}
	const byId = new Map(graph.map((i) => [i.id, i]));
	for (const t of targets) {
		if (t === childId) {
			throw new Error(`tasks: into_deps target "${t}" is the child's own id — a node cannot be its own parent (self-loop)`);
		}
		const target = byId.get(t);
		if (!target) {
			throw new Error(
				`tasks: into_deps target "${t}" does not exist — create it first (a parent must exist before a child wires into it) — available tasks: ${availableList(graph)}`,
			);
		}
		if (target.kind === "info") {
			throw new Error(
				`tasks: into_deps target "${t}" is a shared information node (kind = "info") — info has no deps and cannot be a parent; wire into a task or module`,
			);
		}
	}
	return targets;
}

/**
 * Normalize a caller-provided into_subgraph_deps list (commit directive): the
 * child becomes a GATE of each target module's subgraph. Targets must exist and
 * be kind = "module" (only a module has a subgraph to gate); the child itself
 * cannot be `info`. A gate must sit OUTSIDE the module's own subgraph, so the
 * child may not be the module or within its transitive deps.
 */
function normalizeIntoSubgraphDeps(graph: Task[], childId: string, childKind: TaskKind, rawTargets: string[]): string[] {
	const targets = [...new Set(rawTargets.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	if (targets.length === 0) return targets;
	if (childKind === "info") {
		throw new Error(
			`tasks: kind "info" cannot declare into_subgraph_deps — a shared information node gates nothing`,
		);
	}
	const byId = new Map(graph.map((i) => [i.id, i]));
	for (const t of targets) {
		if (t === childId) {
			throw new Error(`tasks: into_subgraph_deps target "${t}" is the child's own id — a module cannot gate on itself`);
		}
		const target = byId.get(t);
		if (!target) {
			throw new Error(
				`tasks: into_subgraph_deps target "${t}" does not exist — create the module first, then gate it on this node — available tasks: ${availableList(graph)}`,
			);
		}
		if (target.kind !== "module") {
			throw new Error(
				`tasks: into_subgraph_deps target "${t}" is kind "${target.kind}" — only a module has a subgraph to gate; wire into kind "module"`,
			);
		}
	}
	return targets;
}

/**
 * Normalize a caller-provided into_info_ref list (commit directive): the child —
 * which must be a shared information node (kind = "info") — is appended to the
 * `info_refs` of each target task/module, so those tasks inject this info node's
 * shared description at read time. Targets must exist and must NOT be `info`
 * (an info node references no other information — it is itself the source); the
 * child cannot be a target (self-loop, though impossible since targets must not
 * be info). Used on the info node's own draft to wire it INTO already-existing
 * consumers, rather than editing each consumer's info_refs by hand.
 */
function normalizeIntoInfoRefs(graph: Task[], childId: string, childKind: TaskKind, rawTargets: string[]): string[] {
	const targets = [...new Set(rawTargets.map((d) => sanitizeTaskId(d)).filter(Boolean))].sort();
	if (targets.length === 0) return targets;
	if (childKind !== "info") {
		throw new Error(
			`tasks: into_info_ref is only valid for kind "info" — a shared information node declares which tasks consume it; a task/module instead sets its own info_refs directly`,
		);
	}
	const byId = new Map(graph.map((i) => [i.id, i]));
	for (const t of targets) {
		if (t === childId) {
			throw new Error(`tasks: into_info_ref target "${t}" is the child's own id — an info node cannot reference itself`);
		}
		const target = byId.get(t);
		if (!target) {
			throw new Error(
				`tasks: into_info_ref target "${t}" does not exist — create the task/module first, then wire this info node into — available tasks: ${availableList(graph)}`,
			);
		}
		if (target.kind === "info") {
			throw new Error(
				`tasks: into_info_ref target "${t}" is a shared information node (kind = "info") — info references no other info; wire into a task or module`,
			);
		}
	}
	return targets;
}

/**
 * Wire the freshly-committed child into each declared parent: for every into_deps
 * target, append childId to the parent's deps; for every into_subgraph_deps
 * target, append childId to the module's subgraph_deps. Parent writes are
 * STRUCTURE-ONLY: the parent's deps/subgraph_deps array grows, `struct_version`
 * +1 and `struct_changed_at` is refreshed, but the parent's content `version`,
 * description, report and everything a worker anchors on is untouched — so a
 * parent being actively driven is never disturbed by a child joining its subgraph.
 *
 * CONCURRENCY: called only while the store lock is held (from commitTask), so
 * these parent updates are exclusive. The struct_version re-check is kept as a
 * cheap defensive assertion — it should never fire now, and if it does the
 * eager error is better than a silent clobber. The union is idempotent, so a
 * retry merely re-appends this child on top of the competitor's edge.
 *
 * Returns the ids of the parents actually modified (deps/subgraph_deps changed).
 */
function wireIntoParents(
	cwd: string,
	childId: string,
	childKind: TaskKind,
	intoDeps: string[],
	intoSubgraphDeps: string[],
	updatedBy: string,
	changeSummary: string,
): string[] {
	const wired: string[] = [];
	for (const t of intoDeps) {
		if (wireChildIntoParent(cwd, t, childId, "deps", updatedBy, changeSummary)) wired.push(t);
	}
	for (const t of intoSubgraphDeps) {
		if (wireChildIntoParent(cwd, t, childId, "subgraph_deps", updatedBy, changeSummary)) wired.push(t);
	}
	return wired;
}

/**
 * Wire the freshly-committed info node into each declaring consumer's info_refs.
 * Unlike deps/subgraph_deps wiring this is a CONTENT change on the parent: the
 * parent's info_refs array grows, so its content `version` bumps +1, a snapshot
 * is archived and the metadata+description true copies are rewritten — an actively
 * driven consumer that re-reads after this wiring will start seeing the injected
 * shared description (the whole point of the extension). Returns the ids of the
 * consumers modified.
 */
function wireIntoInfoRefs(
	cwd: string,
	childId: string,
	intoInfoRefs: string[],
	updatedBy: string,
	changeSummary: string,
): string[] {
	const wired: string[] = [];
	for (const t of intoInfoRefs) {
		if (wireChildIntoInfoRef(cwd, t, childId, updatedBy, changeSummary)) wired.push(t);
	}
	return wired;
}

/**
 * Optimistically append childId to a single consumer's info_refs. Re-reads fresh,
 * then re-commits guarded by (version, struct_version) as the CAS token — if
 * either moved since our read, another writer changed this consumer, so we
 * re-read and retry. Returns true when this call actually extended the consumer's
 * info_refs (already-present returns false). Checks the same preconditions as
 * normalizeInfoRefs: the running consumer must not be `info` and must not be
 * terminal — a task/module consuming a new shared requirement is exactly what an
 * info_refs grow implies.
 */
function wireChildIntoInfoRef(
	cwd: string,
	consumerId: string,
	childId: string,
	updatedBy: string,
	changeSummary: string,
): boolean {
	for (let attempt = 0; attempt < WIRING_CAS_RETRIES; attempt++) {
		const fresh = tryReadTaskFile(cwd, consumerId);
		if (!fresh) return false; // vanished concurrently — skip (validation passed earlier)
		if (fresh.kind === "info") {
			throw new Error(
				`tasks: into_info_ref target "${consumerId}" is a shared information node (kind = "info") — info references no other info; wire into a task or module`,
			);
		}
		if (fresh.info_refs.includes(childId)) return false; // already wired — idempotent
		const newRefs = [...fresh.info_refs, childId].sort();
		if (writeWiredInfoRefCas(cwd, fresh, newRefs, updatedBy, changeSummary)) return true;
		// (version, struct_version) moved — another writer changed this consumer; re-read and retry
	}
	throw new Error(
		`tasks: could not wire info "${childId}" into "${consumerId}" — the consumer was re-committed ${WIRING_CAS_RETRIES} times while wiring (another agent keeps updating it); retry later`,
	);
}

/**
 * CAS commit of one consumer's info_refs. Re-reads the file and writes only if
 * the on-disk (version, struct_version) still equal the snapshot we computed the
 * candidate from (a content change races on version, a structure change on
 * struct_version; guard both since either could be bumped concurrently).
 * Otherwise returns false so the caller retries on a fresh read.
 */
function writeWiredInfoRefCas(
	cwd: string,
	base: Task,
	newRefs: string[],
	updatedBy: string,
	changeSummary: string,
): boolean {
	const current = tryReadTaskFile(cwd, base.id);
	if (!current || current.version !== base.version || current.struct_version !== base.struct_version) return false;
	writeWiredInfoRef(cwd, current, newRefs, updatedBy, changeSummary);
	return true;
}

/**
 * Re-write ONE consumer's metadata with an info_refs grow — a CONTENT change, so
 * the consumer's content `version` bumps +1 (unlike deps wiring's struct_version
 * only). The old version is snapshotted first (the description contract changed),
 * then the metadata + description true copies are rewritten so the new description
 * body file carries the bumped version frontmatter. History gains a summary entry;
 * the report anchor is untouched (a report for the previous version stays valid
 * for reference).
 */
function writeWiredInfoRef(
	cwd: string,
	fresh: Task,
	newRefs: string[],
	updatedBy: string,
	changeSummary: string,
): void {
	const now = new Date().toISOString();
	const newItem: Task = {
		...fresh,
		info_refs: newRefs,
		version: fresh.version + 1,
		updated_at: now,
		updated_by: updatedBy,
		history: [
			{
				changed_items: ["info_refs"],
				version: fresh.version + 1,
				event: "wiring",
				updated_at: now,
				updated_by: updatedBy,
				change_summary: changeSummary.trim() || "wired: info_refs",
			},
			...fresh.history,
		].slice(0, HISTORY_CAP),
	};
	delete (newItem as Partial<Task>).integrity_warnings;
	delete (newItem as Partial<Task>).report_for_version;
	writeTaskSnapshot(cwd, fresh);
	writeMetadataAndDescription(cwd, newItem);
}

const WIRING_CAS_RETRIES = 5;

/**
 * Optimistically wire childId into a single parent's edge array. Reads fresh,
 * computes the candidate, then re-commits guarded by struct_version as the CAS
 * token: if the on-disk struct_version moved since our read, the edge arrays
 * were changed by another writer, so we re-read and retry. Returns true when
 * this call actually extended the parent (a concurrent retry that found the
 * child already present returns false). Retries give up after a bounded count:
 * a sustained storm means someone keeps committing this parent, which is better
 * surfaced as an error than the child silently dropped.
 */
function wireChildIntoParent(
	cwd: string,
	parentId: string,
	childId: string,
	field: "deps" | "subgraph_deps",
	updatedBy: string,
	changeSummary: string,
): boolean {
	for (let attempt = 0; attempt < WIRING_CAS_RETRIES; attempt++) {
		const fresh = tryReadTaskFile(cwd, parentId);
		if (!fresh) return false; // vanished concurrently — skip (validation passed earlier)
		if (fresh.status === "done" || fresh.status === "cancelled") {
			throw new Error(
				`tasks: into_${field === "deps" ? "deps" : "subgraph_deps"} target "${parentId}" is ${fresh.status} (terminal) — a finished parent cannot gain a new child; reopen/undo it first`,
			);
		}
		const arr = field === "deps" ? fresh.deps : fresh.subgraph_deps;
		if (arr.includes(childId)) return false; // already wired — idempotent
		const newArr = [...arr, childId].sort();
		// The graph snapshot is taken alongside the fresh parent read; a concurrent
		// commit changing OTHER nodes between snapshot and write is caught by the
		// struct_version CAS below (and re-run here on retry).
		const graph = loadGraph(cwd);
		if (field === "deps") {
			assertSubgraphDepOutsideSubgraph(graph, parentId, newArr, fresh.subgraph_deps);
			assertNoCycle(graph, parentId, newArr, fresh.subgraph_deps);
		} else {
			assertSubgraphDepOutsideSubgraph(graph, parentId, fresh.deps, newArr);
			assertNoCycle(graph, parentId, fresh.deps, newArr);
		}
		if (writeWiredParentCas(cwd, fresh, field, newArr, updatedBy, changeSummary)) return true;
		// struct_version moved — another writer changed this parent; re-read and retry
	}
	throw new Error(
		`tasks: could not wire "${childId}" into "${parentId}" — the parent was re-committed ${WIRING_CAS_RETRIES} times while wiring (another agent keeps updating it); retry later`,
	);
}

/**
 * CAS guard for the direct-commit write path: true only when the on-disk
 * (version, struct_version) still equal the base this commit was computed from.
 * `version` guards the logical base the caller's expected_version referred to;
 * `struct_version` guards the edge arrays. The store lock makes a competing
 * writer impossible, so this is a defensive assertion — see `withStoreLock`.
 */
function commitStillCurrent(cwd: string, id: string, base: Task): boolean {
	const current = tryReadTaskFile(cwd, id);
	return !!current && current.version === base.version && current.struct_version === base.struct_version;
}

/**
 * CAS commit of one parent's edge array. Re-reads the file and writes only if
 * the on-disk struct_version still equals the snapshot we computed the candidate
 * from; otherwise returns false so the caller retries on a fresh read.
 *
 * The store lock already makes competing writers impossible, so this is a
 * defensive assertion rather than the real guard (see `withStoreLock`).
 */
function writeWiredParentCas(
	cwd: string,
	base: Task,
	field: "deps" | "subgraph_deps",
	newArr: string[],
	updatedBy: string,
	changeSummary: string,
): boolean {
	const current = tryReadTaskFile(cwd, base.id);
	if (!current || current.struct_version !== base.struct_version) return false;
	writeWiredParent(cwd, current, field === "deps" ? { deps: newArr } : { subgraph_deps: newArr }, updatedBy, changeSummary);
	return true;
}

/**
 * Re-write ONE parent's metadata with a structure change (deps or subgraph_deps
 * array grew). The parent's content `version` is unchanged; only `struct_version`
 * +1 and `struct_changed_at`/`updated_at` refresh. History gains a summary entry
 * (changed_items describes deps/subgraph_deps) so the change is traceable, but
 * no snapshot is written (the description contract did not change).
 */
function writeWiredParent(
	cwd: string,
	fresh: Task,
	patch: { deps?: string[]; subgraph_deps?: string[] },
	updatedBy: string,
	changeSummary: string,
): void {
	const now = new Date().toISOString();
	const changedItems: string[] = [];
	if (patch.deps) changedItems.push("deps");
	if (patch.subgraph_deps) changedItems.push("subgraph_deps");
	const newItem: Task = {
		...fresh,
		deps: patch.deps ?? fresh.deps,
		subgraph_deps: patch.subgraph_deps ?? fresh.subgraph_deps,
		struct_version: fresh.struct_version + 1,
		struct_changed_at: now,
		updated_at: now,
		updated_by: updatedBy,
		history: [
			{
				changed_items: changedItems,
				version: fresh.version,
				event: "wiring",
				updated_at: now,
				updated_by: updatedBy,
				change_summary: changeSummary.trim() || `wired: ${changedItems.join(", ")}`,
			},
			...fresh.history,
		].slice(0, HISTORY_CAP),
	};
	delete (newItem as Partial<Task>).integrity_warnings;
	delete (newItem as Partial<Task>).report_for_version;
	writeMetadataOnly(cwd, newItem);
}

// ---------------------------------------------------------------------------
// Commit (create / content update) — task_commit
// ---------------------------------------------------------------------------

export type SubmitScope = "metadata" | "description" | "all";

/** Options for {@link commitTask} — the committing agent and the base version. */
export interface CommitOptions {
	scope: SubmitScope;
	/** The committing agent's identity (--cname) — locates draft/<cname>/. */
	cname: string;
	change_summary?: string;
	updated_by?: string;
	/** REQUIRED — for an update it is task_read's version; for a create it must be 1 (v1). */
	expected_version: number;
}

/** What a commit consumed / produced — for the shell's result text. */
export interface CommitResult {
	item: Task;
	/** True when this commit CREATED the task (v1) rather than updating it. */
	created: boolean;
	/** The fields this commit changed (title | description | deps | subgraph_deps | kind | info_refs; ["created"] on create). */
	changed_items: string[];
	/** Draft files consumed (deleted) by this commit, cwd-relative. */
	consumed: string[];
}

/**
 * THE single content write: creates or updates a task from the caller's
 * drafts under draft/<cname>/. Patch semantics: the metadata draft carries
 * only the fields to change (absent = keep / default); the description draft
 * (frontmatter tolerated, stripped) is the new description body. Every
 * successful commit is a new version (+1) and archives the replaced version
 * as history/<id>.v<N>/ (three files) BEFORE writing the new true copies.
 *
 * Create (no existing task): the metadata draft is REQUIRED with id/title;
 * deps/subgraph_deps/kind optional. expected_version must be 1 (v1).
 * Update (existing task): expected_version is REQUIRED (= the version
 * task_read returned) — a stale version rejects the write before anything is
 * touched. Nothing changed (no draft, or drafts identical to the true copies)
 * is rejected. Consumed drafts are deleted.
 *
 * Validation mirrors the old create/update tools: deps and gates must exist,
 * gates must sit outside the module's own subgraph, the expanded graph must
 * stay acyclic, kind must be legal and consistent with gates.
 */
export function commitTask(cwd: string, id: string, opts: CommitOptions): CommitResult {
	return withStoreLock(cwd, () => commitTaskLocked(cwd, id, opts));
}

/** `commitTask`'s body — always runs as the store's exclusive writer. */
function commitTaskLocked(cwd: string, id: string, opts: CommitOptions): CommitResult {
	const clean = sanitizeTaskId(id);
	if (!clean) {
		throw new Error(
			`tasks: invalid task id "${id}" — use letters, digits, underscore, hyphen (e.g. "task-auth-login")`,
		);
	}
	const existing = readTask(cwd, clean);
	const draftToml = taskDraftTomlPath(cwd, opts.cname, clean);
	const draftDesc = taskDraftDescriptionPath(cwd, opts.cname, clean);

	// expected_version is MANDATORY and must equal the version the item is at:
	// 1 for a new item (creation always starts at v1), existing.version otherwise
	// (optimistic concurrency — a stale value rejects the write before anything
	// is touched). One unified check covers create and update.
	if (opts.expected_version !== (existing ? existing.version : 1)) {
		throw new Error(
			existing
				? `tasks: conflict on "${clean}" — expected version ${opts.expected_version}, current version ${existing.version} (concurrent commit); re-read the task and merge your changes into your draft, then retry`
				: `tasks: creating "${clean}" must specify expected_version=1 (a new task is always created at v1)`,
		);
	}

	// ── CREATE ────────────────────────────────────────────────────────────────
	if (!existing) {
		if (opts.scope === "description") {
			throw new Error(
				`tasks: cannot create "${clean}" with scope="description" — creation needs the metadata draft (id + title); use scope="all" or scope="metadata"`,
			);
		}
		if (!existsSync(draftToml)) {
			throw new Error(
				`tasks: creating "${clean}" needs a metadata draft at ${relative(cwd, draftToml)} — write it first (id + title required; deps/subgraph_deps/kind optional), then task_commit`,
			);
		}
		const draft = parseDraftToml(cwd, draftToml, clean);
		// Create has no retry loop — one snapshot covers every validation below.
		const graph = loadGraph(cwd);
		const title = draft.title?.trim() ?? "";
		if (!title) {
			throw new Error(
				`tasks: draft ${relative(cwd, draftToml)} is missing title — write title = '...' (required for creation)`,
			);
		}
		const deps = normalizeDeps(graph, clean, draft.deps ?? []);
		const moduleDeps = normalizeSubgraphDeps(graph, draft.subgraph_deps ?? []);
		const infoRefs = normalizeInfoRefs(graph, clean, draft.info_refs ?? []);
		assertSubgraphDepOutsideSubgraph(graph, clean, deps, moduleDeps);
		assertNoCycle(graph, clean, deps, moduleDeps);
		const kind = resolveKind(draft.kind, deps, moduleDeps, infoRefs);
		// Wiring directives: validated before the child exists (parents must exist & be legal), but
		// APPLIED after the child is committed — the child must be a real dep before any parent can
		// reference it.
		const intoDeps = normalizeIntoDeps(graph, clean, kind, draft.into_deps ?? []);
		const intoSubgraphDeps = normalizeIntoSubgraphDeps(graph, clean, kind, draft.into_subgraph_deps ?? []);
		const intoInfoRefs = normalizeIntoInfoRefs(graph, clean, kind, draft.into_info_ref ?? []);
		const description = existsSync(draftDesc)
			? parseBodyFile(readFileSync(draftDesc, "utf-8")).body
			: "";
		const now = new Date().toISOString();
		const item: Task = {
			id: clean,
			title,
			description,
			deps,
			subgraph_deps: moduleDeps,
			info_refs: infoRefs,
			status: "pending",
			kind,
			version: 1,
			struct_version: 1,
			struct_changed_at: now,
			description_sha256: null,
			report_sha256: null,
			created_at: now,
			updated_at: now,
			updated_by: opts.updated_by ?? "unknown",
			dispatched_to: null,
			execution_session: null,
			completion_report: null,
			report_for_version: 1,
			history: [],
		};
		// snapshot v1 (so every version is archivable), then the live true copies. Compute
		// every hash up front so the metadata toml carries the report hash on its single
		// write — no second toml rewrite to patch a hash that wasn't known yet.
		writeTaskSnapshot(cwd, item);
		const descContent = renderBodyFile({ version: 1 }, description);
		const reportContent = renderBodyFile({ for_version: 1 }, "");
		atomicWriteFile(
			taskTomlPath(cwd, clean),
			serializeMetadata({ ...item, description_sha256: sha256(descContent), report_sha256: sha256(reportContent) }),
		);
		atomicWriteFile(taskDescriptionPath(cwd, clean), descContent);
		// empty report stub, uniform three-file layout.
		atomicWriteFile(taskReportPath(cwd, clean), reportContent);
		const consumed = consumeDrafts([draftToml, ...(existsSync(draftDesc) ? [draftDesc] : [])]);
		// Wire the freshly-created child into its declared parents. deps/subgraph_deps wiring is
		// structure-only (no content bump); into_info_ref wiring appends this info node to the
		// consumers' info_refs and DOES bump each consumer's content version.
		wireIntoParents(cwd, clean, kind, intoDeps, intoSubgraphDeps, opts.updated_by ?? "unknown", "wired new child");
		wireIntoInfoRefs(cwd, clean, intoInfoRefs, opts.updated_by ?? "unknown", "wired info into consumer");
		return {
			item: readTask(cwd, clean) ?? item,
			created: true,
			changed_items: ["created", ...(intoInfoRefs.length > 0 ? ["wiring"] : [])],
			consumed: consumed.map((p) => relative(cwd, p)),
		};
	}

	// ── UPDATE ────────────────────────────────────────────────────────────────
	const metaScope = opts.scope === "metadata" || opts.scope === "all";
	const descScope = opts.scope === "description" || opts.scope === "all";
	const draftPresent = existsSync(draftToml);

	// Retained as a defensive assertion: the store lock already serializes writers, so
	// this loop should run exactly once. It guards the LOGICAL base the caller's
	// expected_version was checked against. The lock is the real fix for the
	// cross-process lost-update (see withStoreLock).
	for (let attempt = 0; attempt < WIRING_CAS_RETRIES; attempt++) {
		const base = attempt === 0 ? existing : tryReadTaskFile(cwd, clean);
		if (!base) throw new Error(`tasks: task_commit "${clean}": task disappeared mid-commit`);
		// Each attempt re-loads the graph alongside the fresh base: a concurrent
		// commit may have changed a DIFFERENT node between attempts (an edge that,
		// combined with this commit's new deps, closes a cycle), and
		// commitStillCurrent only re-checks this node's own version — the graph
		// check must see the same moment the base read does.
		const graph = loadGraph(cwd);

		let title = base.title;
		let deps = base.deps;
		let moduleDeps = base.subgraph_deps;
		let infoRefs = base.info_refs;
		let kind = base.kind;
		let intoDeps: string[] = [];
		let intoSubgraphDeps: string[] = [];
		let intoInfoRefs: string[] = [];
		if (metaScope && draftPresent) {
			const patch = parseDraftToml(cwd, draftToml, clean);
			if (patch.title !== undefined) {
				if (!patch.title.trim()) {
					throw new Error(`tasks: draft title for "${clean}" is empty — provide a non-empty title or omit the field`);
				}
				title = patch.title.trim();
			}
			if (patch.deps !== undefined) deps = normalizeDeps(graph, clean, patch.deps);
			if (patch.subgraph_deps !== undefined) moduleDeps = normalizeSubgraphDeps(graph, patch.subgraph_deps);
			if (patch.info_refs !== undefined) infoRefs = normalizeInfoRefs(graph, clean, patch.info_refs);
			if (patch.kind !== undefined) kind = patch.kind;
			if (patch.deps !== undefined || patch.subgraph_deps !== undefined) {
				assertSubgraphDepOutsideSubgraph(graph, clean, deps, moduleDeps);
				assertNoCycle(graph, clean, deps, moduleDeps);
			}
			kind = resolveKind(kind, deps, moduleDeps, infoRefs);
			// Wiring directives on an EXISTING node: parents must exist & be legal; applied after commit.
			intoDeps = normalizeIntoDeps(graph, clean, kind, patch.into_deps ?? []);
			intoSubgraphDeps = normalizeIntoSubgraphDeps(graph, clean, kind, patch.into_subgraph_deps ?? []);
			intoInfoRefs = normalizeIntoInfoRefs(graph, clean, kind, patch.into_info_ref ?? []);
		}

		const description = descScope && existsSync(draftDesc)
			? parseBodyFile(readFileSync(draftDesc, "utf-8")).body
			: base.description;

		const contentChanged: string[] = [];
		const structChanged: string[] = [];
		if (title !== base.title) contentChanged.push("title");
		if (infoRefs.join("|") !== base.info_refs.join("|")) contentChanged.push("info_refs");
		if (kind !== base.kind) contentChanged.push("kind");
		if (description !== base.description) contentChanged.push("description");
		if (deps.join("|") !== base.deps.join("|")) structChanged.push("deps");
		if (moduleDeps.join("|") !== base.subgraph_deps.join("|")) structChanged.push("subgraph_deps");
		// A pure into_* commit (no content/structure change) is a VALID commit: it wires an existing
		// node into a parent. The wiring itself is applied after the child is committed.
		const hasWiring = intoDeps.length > 0 || intoSubgraphDeps.length > 0 || intoInfoRefs.length > 0;
		const changed = [...contentChanged, ...structChanged];
		if (changed.length === 0 && !hasWiring) {
			throw new Error(
				`tasks: task_commit "${clean}": your draft content is identical to v${base.version}, so NOTHING was committed and your draft files were NOT deleted. Edit the draft(s) to change something and commit again, or delete them if you meant to discard your edits.`,
			);
		}

		const now = new Date().toISOString();
		const updatedBy = opts.updated_by ?? "unknown";
		// Content changes bump `version` (the worker's contract anchor); structural changes (deps /
		// subgraph_deps) bump `struct_version` only — wiring never disturbs a consumer holding a
		// stale content version. A mixed commit bumps both. Snapshots (history/<id>.v<N>/) are only
		// written on a content change, since structure-only changes leave the description contract and
		// the report anchor untouched.
		const newVersion = contentChanged.length > 0 ? base.version + 1 : base.version;
		const newStructVersion = structChanged.length > 0 ? base.struct_version + 1 : base.struct_version;
		const newItem: Task = {
			...base,
			title,
			deps,
			subgraph_deps: moduleDeps,
			info_refs: infoRefs,
			kind,
			description,
			version: newVersion,
			struct_version: newStructVersion,
			struct_changed_at: structChanged.length > 0 ? now : base.struct_changed_at,
			updated_at: now,
			updated_by: updatedBy,
			history: [
				{
					changed_items: changed,
					version: newVersion,
					event: "",
					updated_at: now,
					updated_by: updatedBy,
					change_summary: opts.change_summary?.trim() || `updated: ${changed.join(", ")}`,
				},
				...base.history,
			].slice(0, HISTORY_CAP),
		};
		delete (newItem as Partial<Task>).integrity_warnings;
		delete (newItem as Partial<Task>).report_for_version;

		if (commitStillCurrent(cwd, clean, base)) {
			// old version durable before the new one becomes visible — only on a content change (a
			// structure-only change leaves the version and the description.md the same).
			if (contentChanged.length > 0) {
				writeTaskSnapshot(cwd, base);
				writeMetadataAndDescription(cwd, newItem);
			} else {
				writeMetadataOnly(cwd, newItem);
			}

			const consumed = consumeDrafts([
				...(metaScope && draftPresent ? [draftToml] : []),
				...(descScope && existsSync(draftDesc) ? [draftDesc] : []),
			]);
			// Wire this node into its declared parents (structure-only on the parents; this node's own
			// commit, content or not, is already done). Only meaningful when into directives were present.
			if (hasWiring) {
				wireIntoParents(cwd, clean, kind, intoDeps, intoSubgraphDeps, updatedBy, opts.change_summary?.trim() || `updated: ${changed.join(", ")}`);
				wireIntoInfoRefs(cwd, clean, intoInfoRefs, updatedBy, opts.change_summary?.trim() || `updated: ${changed.join(", ")}`);
			}
			return {
				item: readTask(cwd, clean) ?? newItem,
				created: false,
				changed_items: [...changed, ...(hasWiring ? ["wiring"] : [])],
				consumed: consumed.map((p) => relative(cwd, p)),
			};
		}
		// base was stale — re-read and recompute on the next iteration
	}
	throw new Error(`tasks: task_commit "${clean}": base changed ${WIRING_CAS_RETRIES} times while committing; try again`);
}

// ---------------------------------------------------------------------------
// Lifecycle (status) — no version bump
// ---------------------------------------------------------------------------

/** Legal next statuses per current status (see the state machine in the header). */
const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	pending: ["dispatched", "active", "blocked", "done", "cancelled"],
	dispatched: ["active", "pending", "blocked", "done", "cancelled", "worker_offline"],
	active: ["pending", "blocked", "done", "cancelled", "worker_offline"],
	worker_offline: ["dispatched", "pending", "blocked", "done", "cancelled"],
	blocked: ["pending", "dispatched", "active", "done", "cancelled"],
	done: ["active"],
	cancelled: ["pending"],
};

/** Human-readable legal-targets list for error messages. */
const TRANSITION_HINTS: Record<TaskStatus, string> = {
	pending: "dispatched, active, blocked, done (with deps satisfied), cancelled",
	dispatched: "active (start), pending, blocked, done (with deps satisfied), cancelled, worker_offline",
	active: "pending, blocked, done (with deps satisfied), cancelled, worker_offline",
	worker_offline: "dispatched, pending, blocked, done (with deps satisfied), cancelled",
	blocked: "pending, dispatched, active, done (with deps satisfied), cancelled",
	done: "active (reopen)",
	cancelled: "pending (undo)",
};

/**
 * Transition a task's status — a LIFECYCLE event: the version is NOT bumped
 * and no snapshot is written; the transition appends a history entry
 * (changed_items = ["status"], event = the action) and updates
 * updated_at/updated_by. Hard rules:
 * - the transition must be legal (see the state machine in the header);
 * - a node can only be marked done when ALL deps are done/cancelled —
 *   otherwise the error lists the missing deps and teaches the remedies.
 * - dispatched_to is recorded on dispatch, cleared on done/cancelled;
 *   execution_session is recorded on active (start);
 * - reopen (done → active) / undo (cancelled → pending) void the completion
 *   report (the work restarts): the report true copy resets to an empty body
 *   (for_version = the current description version) and the stored hash is
 *   updated to match.
 *
 * Returns the stored item plus one computed (never persisted) result:
 * unlocked — ids that marking this item done (or cancelled) newly makes ready.
 */
/** Options for {@link setTaskStatus}. */
export interface SetStatusOptions {
	change_summary?: string;
	updated_by?: string;
	/** Record the responsible agent when setting dispatched (dispatch). */
	dispatched_to?: TaskDispatch | null;
	/** Record the worker's execution session when setting active (start). */
	execution_session?: TaskExecutionSession | null;
	/** Lifecycle action name for the history entry (dispatch / start / complete / block / cancel / status). */
	event?: string;
}

export function setTaskStatus(
	cwd: string,
	id: string,
	status: TaskStatus,
	opts: SetStatusOptions = {},
): { item: Task; unlocked: string[] } {
	return withStoreLock(cwd, () => setTaskStatusLocked(cwd, id, status, opts));
}

/** `setTaskStatus`'s body — always runs as the store's exclusive writer. */
function setTaskStatusLocked(
	cwd: string,
	id: string,
	status: TaskStatus,
	opts: SetStatusOptions,
): { item: Task; unlocked: string[] } {
	const clean = sanitizeTaskId(id);
	const existing = readTask(cwd, clean);
	if (!existing) {
		throw new Error(`tasks: task "${clean}" does not exist — create it first (write a draft and task_commit)`);
	}
	if (existing.kind === "info") {
		throw new Error(
			`tasks: cannot change the status of "${clean}" — it is a shared information node (kind = "info"), pure content with no lifecycle; it never dispatches, never blocks, and never completes`,
		);
	}
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

	// Snapshot the graph BEFORE the write: the unlocked set is "what THIS
	// change newly unlocks", which requires the pre-change state.
	const preItems = loadGraph(cwd);
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
		patch.dispatched_to = {
			name: opts.dispatched_to.name,
			dispatched_by: opts.dispatched_to.dispatched_by ?? "",
			dispatch_msg_id: opts.dispatched_to.dispatch_msg_id ?? "",
		};
	} else if (status === "done" || status === "cancelled") {
		// terminal states end responsibility — the dispatchee no longer owns the item
		patch.dispatched_to = null;
	}
	if (status === "active" && opts.execution_session) {
		// start records the worker's execution session — kept on terminal
		// states for retrospection; a reopen/undo keeps it until the next start
		patch.execution_session = {
			session_id: opts.execution_session.session_id ?? "",
			session_file: opts.execution_session.session_file ?? "",
		};
	}
	// reopen / undo restart the work — the old completion report no longer applies
	const reopenUndo =
		(existing.status === "done" && status === "active") ||
		(existing.status === "cancelled" && status === "pending");
	if (reopenUndo) patch.completion_report = null;

	// Void the report true copy BEFORE the metadata write so the stored hash
	// matches the file bytes the reader will verify.
	let reportVoidContent: string | null = null;
	if (reopenUndo) {
		reportVoidContent = renderBodyFile({ for_version: existing.version }, "");
		atomicWriteFile(taskReportPath(cwd, clean), reportVoidContent);
	}

	const newItem: Task = {
		...existing,
		...patch,
		report_sha256: reportVoidContent ? sha256(reportVoidContent) : existing.report_sha256,
		updated_at: now,
		updated_by: opts.updated_by || "unknown",
		history: [
			{
				changed_items: ["status"],
				version: existing.version,
				event: opts.event ?? "",
				updated_at: now,
				updated_by: opts.updated_by || "unknown",
				change_summary: opts.change_summary?.trim() || `status: ${status}`,
			},
			...existing.history,
		].slice(0, HISTORY_CAP),
	};
	delete (newItem as Partial<Task>).integrity_warnings;
	delete (newItem as Partial<Task>).report_for_version;
	atomicWriteFile(taskTomlPath(cwd, clean), serializeMetadata(newItem));

	const unlocked = status === "done" || status === "cancelled" ? unlockedBy(preItems, clean) : [];
	return { item: readTask(cwd, clean) ?? newItem, unlocked };
}

// ---------------------------------------------------------------------------
// Completion report — task_submit_report (no version bump)
// ---------------------------------------------------------------------------

/**
 * Commit the worker's completion report FROM ITS REPORT DRAFT
 * (draft/<cname>/<id>.report.md): the body (frontmatter tolerated, stripped)
 * becomes the report true copy anchored to the description version the worker
 * READ (for_version = expected_version, NOT the current version), so every
 * report states which contract it was actually written against — after a
 * replan the anchor makes the staleness visible (report_for_version < version)
 * instead of silently rebasing to the new contract. The version is NOT bumped
 * and no snapshot is written.
 *
 * A STALE expected_version (older than current) is ACCEPTED — the worker
 * legitimately executed the older contract; the report is anchored there and
 * flagged (history line + report_for_version < version) for the reader to
 * judge whether the old-contract work still satisfies the new description.
 *
 * Rejects:
 * - the item does not exist;
 * - expected_version missing / invalid / ahead of the current version (a
 *   version ahead is never readable);
 * - the caller is not the dispatched agent (including terminal states);
 * - the report draft is missing or empty.
 */
/** Options for {@link setCompletionReport}. */
export interface SubmitReportOptions {
	/** The description version the worker read — REQUIRED; a version ahead of
	 *  current is rejected, a stale one is accepted and flagged. */
	expected_version: number;
	/** The worker's identity — locates draft/<cname>/. */
	cname: string;
}

export function setCompletionReport(
	cwd: string,
	id: string,
	updatedBy: string,
	opts: SubmitReportOptions,
): Task {
	return withStoreLock(cwd, () => setCompletionReportLocked(cwd, id, updatedBy, opts));
}

/** `setCompletionReport`'s body — always runs as the store's exclusive writer. */
function setCompletionReportLocked(
	cwd: string,
	id: string,
	updatedBy: string,
	opts: SubmitReportOptions,
): Task {
	const clean = sanitizeTaskId(id);
	const existing = readTask(cwd, clean);
	if (!existing) {
		throw new Error(`tasks: task "${clean}" does not exist — create it first`);
	}
	if (existing.kind === "info") {
		throw new Error(
			`tasks: cannot write a completion report for "${clean}" — it is a shared information node (kind = "info"), pure content that is never dispatched and never completes`,
		);
	}
	// expected_version is MANDATORY and is the report's anchor: the exact
	// description version the worker read. A STALE version (older than current)
	// is VALID — the worker genuinely executed that contract, so the report is
	// anchored there (for_version = expected_version) and the returned item
	// flags the gap (report_for_version < version) for the reader to judge.
	// Only a version AHEAD of current (never readable) is an error.
	if (opts.expected_version === undefined) {
		throw new Error(
			`tasks: task_submit_report on "${clean}" requires expected_version (= the description version you read) — re-read the task first`,
		);
	}
	if (!Number.isInteger(opts.expected_version) || opts.expected_version < 1) {
		throw new Error(
			`tasks: task_submit_report on "${clean}" has an invalid expected_version ${opts.expected_version} — it must be the positive description version you read`,
		);
	}
	if (opts.expected_version > existing.version) {
		throw new Error(
			`tasks: task_submit_report on "${clean}" — expected_version ${opts.expected_version} is ahead of the current version ${existing.version} (that version is not readable); re-read the task and pass the version task_read returned`,
		);
	}
	const stale = opts.expected_version < existing.version;
	if (!existing.dispatched_to || existing.dispatched_to.name !== updatedBy) {
		throw new Error(
			`tasks: cannot write the completion report for "${clean}" — it is dispatched to ${existing.dispatched_to ? existing.dispatched_to.name : "(no one)"}, not to you (${updatedBy}); only the dispatched agent records the completion report`,
		);
	}
	const draftReport = taskDraftReportPath(cwd, opts.cname, clean);
	if (!existsSync(draftReport)) {
		throw new Error(
			`tasks: write your report first to ${relative(cwd, draftReport)} with write/edit, then call task_submit_report`,
		);
	}
	const body = parseBodyFile(readFileSync(draftReport, "utf-8")).body.trim();
	if (!body) {
		throw new Error(
			`tasks: report draft ${relative(cwd, draftReport)} is empty — write what you actually did (brief when it matches the plan, detailed when it deviates)`,
		);
	}
	const now = new Date().toISOString();
	const reportContent = renderBodyFile({ for_version: opts.expected_version }, body);
	const summary = body.split("\n")[0].replace(/\s+/g, " ").trim();
	const newItem: Task = {
		...existing,
		completion_report: body,
		report_sha256: sha256(reportContent),
		updated_at: now,
		updated_by: updatedBy,
		history: [
			{
				changed_items: ["report"],
				version: existing.version,
				event: "",
				updated_at: now,
				updated_by: updatedBy,
				// history keeps one-line summaries only — the report's first line is its digest; a stale anchor is flagged here
				change_summary: stale
					? `[report against v${opts.expected_version}, current v${existing.version}] ${summary}`
					: summary,
			},
			...existing.history,
		].slice(0, HISTORY_CAP),
	};
	delete (newItem as Partial<Task>).integrity_warnings;
	delete (newItem as Partial<Task>).report_for_version;
	atomicWriteFile(taskTomlPath(cwd, clean), serializeMetadata(newItem));
	atomicWriteFile(taskReportPath(cwd, clean), reportContent);
	consumeDrafts([draftReport]);
	return readTask(cwd, clean) ?? newItem;
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
		if (!file.endsWith(".toml")) continue;
		try {
			const item = parseTask(readFileSync(join(dir, file), "utf-8"));
			if (!item) continue;
			out.push({
				id: item.id,
				title: item.title,
				status: item.status,
				kind: item.kind,
				version: item.version,
				struct_version: item.struct_version,
				updated_at: item.updated_at,
				updated_by: item.updated_by,
				dispatched_to: item.dispatched_to,
				status_since_ms: statusSinceMs(item),
				depCount: item.deps.length,
				subgraph_deps: item.subgraph_deps,
				info_refs: item.info_refs,
			});
		} catch {
			// corrupted — skip in the listing
		}
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}
