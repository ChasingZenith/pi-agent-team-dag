/**
 * tasks — Task graph system (pure-DAG tracked work).
 *
 * A task is the unit of tracked work. It unifily represent task at any granularity
 * module, unit task, subtask. Items form a pure dependency DAG: deps are the edges
 * (B.deps=[A] means A completes before B can complete), validated at commit
 * time — cycles and dangling deps are rejected, so the graph is always a DAG.
 *
 * Status machine: pending → dispatched → active / blocked → done; done →
 * active (reopen); cancelled → pending (undo); cancelled counts as satisfied
 * for dependents. A node can only be marked done when ALL its deps are
 * done/cancelled (task_set_status rejects with the missing deps listed). The
 * READY SET — pending items with all deps satisfied — is the parallel
 * dispatch list managers delegate from (task_ready_set); marking done unlocks
 * dependents that became newly ready (dispatch them in parallel).
 *
 * A THIRD kind — "info" (shared information node) — is NOT a DAG node:
 * pure content with no deps/gate/status lifecycle, never in the ready set,
 * never dispatched. Tasks reference it via info_refs (content references,
 * not graph edges): the info node's description body is injected into the
 * task's description at read time (task_read fields=description). This is how
 * repeated requirements are written ONCE and shared by many tasks — e.g. the
 * same audit applied to 100 sites.
 *
 * CONTENT IS FILE-DRIVEN: the plan is edited as FILES. Each task is three
 * true copies (metadata toml + description.md + report.md) plus per-agent
 * drafts under .pi/tasks/draft/<cname>/. Agents write/edit DRAFTS and
 * task_commit is the single content write: it validates (deps existence, cycles, kind), forms a
 * new version (+1 on any change to title/description/kind/info_refs — the worker's contract),
 * and rewrites the true copies, consuming the drafts it used. deps/subgraph_deps changes do NOT
 * bump that content `version` — they bump `struct_version` (and behind it a `struct_changed_at`
 * soft signal, surfaced on task_read), so wiring a child into a parent never disturbs a consumer
 * holding a content version. task_checkout
 * initializes the caller's draft BODY-ONLY (frontmatter is never handed to
 * the draft; commit re-adds it). Lifecycle events (status
 * transitions) and completion reports do NOT bump the version — version counts
 * content revisions only. The commit directive fields into_deps /
 * into_subgraph_deps (draft-only, never stored) wire the committed node into an existing parent's
 * deps / subgraph_deps atomically, re-committing the parent structure-only. into_info_ref
 * (draft-only, info-kind node) wires it into each consumer's info_refs — a content change that
 * bumps each consumer's version.
 *
 * Tools: task_commit, task_checkout, task_set_status,
 * task_read, task_list,
 * task_ready_set.
 *
 * Implementation: storage in lib/tasks/store.ts (filesystem under
 * .pi/tasks/, PI_TASKS_DIR override), graph semantics in
 * lib/tasks/graph.ts (ready set, DAG validation, tree rendering). The
 * shell wires the tools to them, audits writes on the "tasks-log"
 * channel, and enforces the teaching rules with errors that teach the
 * model instead of failing silently.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import * as store from "./lib/tasks/store";
import type { Task, TaskDispatch, TaskKind, TaskPlanning, TaskStatus } from "./lib/tasks/store";
import * as graph from "./lib/tasks/graph";
import {
	availableIds,
	broadcastLine,
	loadAllItems,
	notFoundError,
} from "./lib/tasks/shell";

// Expanded (ctrl+O) rendering: show the full call args / result content —
// the same information the LLM sees in its context.
function fmtArgs(a: Record<string, unknown>): string {
	return Object.entries(a)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
		.join("\n");
}

function expandedContent(result: { content?: Array<{ type: string; text?: string }> }, fallback: string): string {
	const t = result.content?.[0];
	return t?.type === "text" && t.text ? t.text : fallback;
}

/** Human age of a ms duration — "45 s" up to a minute, then "N min", then "N h". */
function fmtAge(ms: number): string {
	const sec = Math.floor(ms / 1_000);
	if (sec < 60) return `${Math.max(0, sec)} s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} min`;
	const hr = Math.floor(min / 60);
	return `${hr} h`;
}

/**
 * The post-commit "pending drafts" line: the draft files this commit did NOT
 * consume. Drafts are invisible to the graph (only true copies are scanned), so
 * naming them — with their kind, hence which tool submits them — is the only
 * signal that work is still sitting unsubmitted in draft/<cname>/.
 */
function pendingDraftLine(pending: store.PendingDraft[]): string {
	const total = pending.reduce((n, d) => n + d.kinds.length, 0);
	if (total === 0) return "  No pending draft.";
	const shown = pending.slice(0, 5).map((d) => `${d.id}: ${d.kinds.join(", ")}`);
	if (pending.length > 5) shown.push(`and ${pending.length - 5} more`);
	return `  pending drafts: ${total} (${shown.join("; ")})`;
}

/** TOML-inline array of simple ids (for metadata draft templates). */
function tomlInlineArray(ids: string[]): string {
	return ids.length ? `[ ${ids.map((x) => `"${x}"`).join(", ")} ]` : "[]";
}

/**
 * The metadata draft template for an EXISTING task (patch semantics): every
 * changeable field is written as a COMMENT line carrying the CURRENT value,
 * so the LLM uncomments (and edits) only the field(s) it wants to change —
 * absent fields keep their current value when committed. `id` stays active so
 * commit can validate the match; `title` notes it is required if kept.
 */
function metadataDraftForUpdate(item: Task): string {
	const kindHint = "unit | module | info";
	return [
		// `id` is not commented — commit validates it matches the target task.
		`id = "${item.id}"`,
		`# title = "${item.title.replace(/"/g, "\\\"")}"    # current — uncomment to change`,
		`# deps = ${tomlInlineArray(item.deps)}    # current — dependency edges (deps complete before this)`,
		`# subgraph_deps = ${tomlInlineArray(item.subgraph_deps)}    # current — subgraph gates (modules only)`,
		`# info_refs = ${tomlInlineArray(item.info_refs)}    # current — ids of shared info nodes (kind = \"info\") to inject`,
		`# kind = "${item.kind}"    # current — choose ${kindHint}`,
		``,
	].join("\n");
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	/**
	 * Agent name for the updated_by stamp and the draft directory — read from
	 * the --cname CLI flag (spawned agents always carry it). Both "--cname
	 * <value>" and "--cname=<value>" forms are accepted; anything else yields
	 * "unknown". task-graph.ts has NO comms dependency: the name comes from
	 * the CLI, not from any comms runtime.
	 */
	function commsName(): string {
		const argv = process.argv;
		for (let i = 0; i < argv.length; i++) {
			const a = argv[i];
			if (a.startsWith("--cname=")) {
				const value = a.slice("--cname=".length);
				if (value) return value;
			} else if (a === "--cname") {
				const value = argv[i + 1];
				if (value !== undefined && !value.startsWith("-")) return value;
			}
		}
		return "unknown";
	}

	/**
	 * The planner identity recorded as planned_by on every commit: the committing
	 * agent's name plus its OWN pi session (id + JSONL transcript), mirroring the
	 * worker's execution_session. null when the runtime exposes no session.
	 */
	function planningIdentity(dir: string, name: string, ctx: unknown): TaskPlanning | null {
		const sm = (ctx as ExtensionContext | undefined)?.sessionManager;
		const sessionId = sm?.getSessionId() ?? "";
		if (!sessionId) return null;
		const file = sm?.getSessionFile();
		return { name, session_id: sessionId, session_file: file ? relative(dir, file) : "" };
	}

	function audit(event: string, extra: Record<string, unknown>): void {
		try {
			pi.appendEntry("tasks-log", { event, ts: new Date().toISOString(), ...extra });
		} catch {
			// best effort — auditing must never fail a tool call
		}
	}

	// ---------------------------------------------------------------------------
	// Shared helpers
	// ---------------------------------------------------------------------------

	const STATUSES: TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled", "worker_offline"];
	/** Which long-form content task_read loads; mirrors the TypeBox union on fields. */
	type ReadFields = "description" | "report" | "full";
	// Shared with renderGraph — one glyph set, not two.
	const STATUS_GLYPH = graph.STATUS_GLYPHS;

	/** Number of the caller's existing draft files. Used to indicate "you have N uncommitted
	 *  draft(s) for this task" in task_read. */
	function callerDraftCount(id: string): number {
		const me = commsName();
		return [
			store.taskDraftTomlPath(cwd, me, id),
			store.taskDraftDescriptionPath(cwd, me, id),
			store.taskDraftReportPath(cwd, me, id),
		].filter((p) => existsSync(p)).length;
	}

	/**
	 * One renderer for the task_read VIEW of a single task — shared by the live
	 * record and the archived snapshot. Only the live record has live-graph
	 * facts (readiness, dependents, drafts, integrity, injected-info
	 * description) and the stale-report marker; those are gated on `live`, which
	 * is omitted for an archived read. Everything else (structure lines,
	 * on-demand field loading, report digest, history) is identical — and must
	 * STAY identical, or the two read paths drift.
	 */
	function renderTaskView(
		item: Task,
		opts: {
			archived: boolean;
			fields?: ReadFields;
			/** The id the caller actually supplied — the sanitize note compares it to the stored id. */
			requestedId: string;
			live?: { dependents: string[]; isReady: boolean; missing: string[] };
		},
	): string {
		const { archived, fields, live } = opts;
		const glyph = STATUS_GLYPH[item.status] ?? "◻";
		const statusLine = `${glyph} ${item.status}`;
		// Staleness signal: how long the item has sat in its CURRENT status. A
		// dispatched/active task with no report for a long age is exactly what a
		// manager must notice on a reminder turn, so surface both the age and the
		// timestamp the status was entered.
		const statusAgeMs = store.statusSinceMs(item);
		const statusSinceIso = new Date(Date.now() - statusAgeMs).toISOString();
		const lines: string[] = [
			archived
				? `task_read: ${item.id} v${item.version} — ARCHIVED SNAPSHOT — ${statusLine} — by ${item.updated_by} at ${item.updated_at}`
				: `id: ${item.id} v${item.version} — ${statusLine} — updated by ${item.updated_by} at ${item.updated_at}`,
			`title: ${item.title}`,
			`kind: ${item.kind}`,
			`in status: ${fmtAge(statusAgeMs)} (since ${statusSinceIso})`,
			`deps: ${item.deps.length > 0 ? item.deps.join(", ") : "(none)"}`,
		];
		// Live-only: the soft structural signal — tells a consumer the subgraph
		// grew WITHOUT forcing a re-read (content `version` is unchanged, so any
		// report anchor still holds). Past versions need no such signal.
		if (live && item.struct_version > 1 && item.struct_changed_at) {
			lines.push(`subgraph changed (struct v${item.struct_version}) @ ${item.struct_changed_at} — deps/subgraph_deps grew; content version ${item.version} unchanged`);
		}
		if (item.subgraph_deps.length > 0) {
			lines.push(`subgraph_deps: ${item.subgraph_deps.join(", ")} (subgraph gates — the whole subgraph waits for these)`);
		}
		if (item.info_refs.length > 0) {
			lines.push(`info_refs: ${item.info_refs.join(", ")} (shared information injected into this item's description)`);
		}
		lines.push(
			`dispatched_to: ${item.dispatched_to ? item.dispatched_to.name : "(none)"}`,
			`execution_session: ${item.execution_session ? item.execution_session.session_id : "(none — the worker records it at task_start)"}`,
			`planned_by: ${item.planned_by ? `${item.planned_by.name} (${item.planned_by.session_id}${item.planned_by.session_file ? `, ${item.planned_by.session_file}` : ""})` : "(none — recorded at task_commit)"}`,
		);
		const descLen = item.description?.length ?? 0;
		const reportLen = item.completion_report?.length ?? 0;
		const isInfo = item.kind === "info";
		if (live) {
			let readyLine: string;
			if (item.status === "done") {
				readyLine = "ready: no — already done";
			} else if (live.isReady) {
				readyLine = "ready: yes — dispatchable in parallel";
			} else if (live.missing.length > 0) {
				readyLine = `ready: no — missing deps: ${live.missing.join(", ")}`;
			} else {
				readyLine = "ready: no";
			}
			lines.push(
				`dependents: ${live.dependents.length > 0 ? live.dependents.join(", ") : "(none)"}`,
				isInfo ? "ready: none — shared information (pure content, never dispatched)" : readyLine,
				`description (v${item.version}): ${descLen} chars`,
				`completion report (for description v${item.report_for_version ?? "?"}): ${reportLen} chars`,
			);
			const draftCount = callerDraftCount(item.id);
			if (draftCount > 0) {
				lines.push(`you have ${draftCount} uncommitted draft(s) for this task`);
			}
			if (item.integrity_warnings && item.integrity_warnings.length > 0) {
				for (const w of item.integrity_warnings) lines.push(`⚠ integrity: ${w}`);
			}
		}
		// Long bodies — loaded on demand. The live description is the EFFECTIVE
		// one: shared info (info_refs) injected, then the item's own body. (Editing
		// via task_checkout uses the raw own-description, keeping shared content
		// referenced, not copied.) An archived snapshot reads its own stored body.
		// Lazy: each call re-reads every info_ref from disk, so views that don't
		// show the description (summary / fields="report") must not pay for it.
		const shownDescription = () => (live ? store.effectiveDescription(cwd, item) : item.description);
		const versionSuffix = archived ? `, version=${item.version}` : "";
		if (fields === "description") {
			const d = shownDescription();
			lines.push(d ? `description: ${d}` : "description: (none)");
			if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${item.id}"${versionSuffix}, fields="report")`);
		} else if (fields === "report") {
			if (item.completion_report) {
				const stale = !archived && (item.report_for_version ?? item.version) < item.version;
				const flagged = archived
					? ""
					: ` — ⚠ STALE: the task is now v${item.version}`;
				lines.push(
					`── Completion report (for description v${item.report_for_version ?? "?"}${stale ? flagged : ""}) ──`,
					item.completion_report,
				);
			} else {
				lines.push("completion report: (none)");
			}
			if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${item.id}"${versionSuffix}, fields="description")`);
		} else if (fields === "full") {
			const d = shownDescription();
			if (d) lines.push(`description: ${d}`);
			if (item.completion_report) {
				const stale = !archived && (item.report_for_version ?? item.version) < item.version;
				const flagged = archived
					? ""
					: ` — ⚠ STALE: the task is now v${item.version}`;
				lines.push(
					`── Completion report (for description v${item.report_for_version ?? "?"}${stale ? flagged : ""}${live ? " — written by the dispatched agent; the manager reads it before task_complete)" : ""}) ──`,
					item.completion_report,
				);
			}
		} else {
			if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${item.id}"${versionSuffix}, fields="description")`);
			if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${item.id}"${versionSuffix}, fields="report")`);
		}
		// The store digests the completion report by its first line (the history
		// entry that wrote it repeats that text).
		const reportShown = fields === "report" || fields === "full";
		const reportDigest =
			reportShown && item.completion_report
				? item.completion_report.split("\n")[0].replace(/\s+/g, " ").trim()
				: null;
		const historyLines = item.history.map((h) => {
			const summary =
				reportDigest && h.change_summary === reportDigest
					? "(completion report digest — see the report above)"
					: h.change_summary;
			return `  v${h.version} [${h.changed_items.join(", ") || h.event || "update"}] ${h.updated_at} by ${h.updated_by} — ${summary}`;
		});
		lines.push(
			archived ? `── Change history (as of v${item.version}) ──` : "── Change history ──",
			historyLines.length > 0 ? historyLines.join("\n") : "  (none)",
		);
		if (!archived && item.version > 1) {
			lines.push(`archived snapshots: v1..v${item.version - 1} — task_read(id, version=<n>) to read one`);
		}
		const idNote = store.sanitizedIdNote(opts.requestedId);
		if (idNote) lines.push(idNote);
		return lines.join("\n");
	}

	/**
	 * Full-graph health check — the SAME check task_list runs, extracted so any
	 * tool can surface structure problems next to its own result: every cycle,
	 * every dangling dep (dep or subgraph gate id with no item), and every
	 * orphan item (a task with no dependents, outside every module subgraph).
	 *
	 * Returns `text` — the COMPLETE warning block, header ("⚠ graph warnings:")
	 * included, exactly as task_list renders it; empty ("") when the graph is
	 * clean — so a caller appends it after its own result only when non-empty.
	 * Also returns the individual warning `lines` and the structured `warnings`
	 * for a details block.
	 */
	function graphWarnings(): {
		text: string;
		lines: string[];
		warnings: {
			cycles: string[][];
			dangling: Array<{ id: string; dep: string }>;
			orphans: Task[];
			components: string[][];
		};
	} {
		const byId = loadAllItems(cwd);
		const itemsArr = [...byId.values()];
		const { cycles, dangling } = graph.validateGraph(itemsArr);
		const orphans = graph.orphanItems(itemsArr);
		const components = graph.disconnectedComponents(itemsArr);
		const lines: string[] = [];
		for (const cyc of cycles) lines.push(`  ⚠ cycle: ${cyc.join(" -> ")}`);
		for (const d of dangling) lines.push(`  ⚠ dangling dep: ${d.id} → ${d.dep} (missing)`);
		for (const o of orphans) {
			lines.push(
				o.kind === "module"
					? `  ⚠ orphan: ${o.id} (${o.status}) — module with no deps or gates, and nothing depends on it`
					: `  ⚠ orphan: ${o.id} (${o.status}) — no dependents, outside every module subgraph`,
			);
		}
		if (components.length > 1)
			lines.push(
				`  ⚠ disconnected graph: ${components.length} separate pieces — ${components.map((c) => `[${c.join(", ")}]`).join(" ")}`,
			);
		return {
			text: lines.length > 0 ? `⚠ graph warnings:\n${lines.join("\n")}` : "",
			lines,
			warnings: { cycles, dangling, orphans, components },
		};
	}

	// =============================================================================
	// task_commit
	// =============================================================================

	pi.registerTool({
		name: "task_commit",
		label: "Task Commit",
		description:
			"The single content write: commits YOUR drafts into the true copies and forms a new version. " +
			"For NODE CREATION or SUBGRAPH EMBEDDING / REFINEMENT, prepare a draft via task_checkout, read and edit it as FILES with write/edit, then task_commit — this the only way content becomes visible in the task graph. " +
			"The metadata draft is a PATCH: only the fields present change — title / deps / subgraph_deps / kind / info_refs; absent fields keep their current value (status / version / history are machine-managed and ignored in drafts). " +
			"WIRING — a METADATA DRAFT FIELD of the .toml, NOT a parameter of this tool call: put `into_deps = [<parent ids>]` inside the metadata draft file (never in the call arguments) to make THIS node a dep/member of each existing parent (appended to the parent's deps); put `into_subgraph_deps = [<module ids>]` there to make THIS node a gate of each module's subgraph. The parents must already exist and are re-committed structure-only (their content version is untouched — an actively driven parent is never disturbed). " +
			"`into_info_ref = [<task/module ids>]` (valid only when THIS node is kind = \"info\") appends THIS info node's id to each listed consumer's info_refs — the inverse of writing info_refs by hand, wiring a shared requirement into already-existing tasks; this DOES bump each consumer's content version (it now starts injecting the new shared content). " +
			"Clear gates from a module by putting subgraph_deps = [] in the draft. " +
			"info_refs = [<ids>] references shared information nodes (kind = \"info\") whose description is injected into this task at read time — write common requirements ONCE, reference them from many tasks (e.g. the same audit applied to 100 sites). " +
			"Strict Acyclicity: The store validates every write against the live graph. Any `task_commit` that would form a cycle (evaluating expanded gates alongside standard `deps`) is rejected with a cycle path trace in the error." +
			"This is the tool for GRAPH STRUCTURE — deps / subgraph_deps (each bump the task's struct_version, NOT its content version), plus content metadata — title / kind / description (which bump the content version). This tool does NOT change status (the lifecycle): to set pending / dispatched / active / done / blocked / cancelled use task_set_status, which is a lifecycle event and does NOT bump the version.",
		parameters: Type.Object({
			id: Type.String({
				description:
					"Id of the task to create or update (kebab-case). For CREATE it must not exist yet; for UPDATE it must already exist.",
			}),
			scope: Type.Optional(
				Type.Union(
					[
						Type.Literal("metadata"),
						Type.Literal("description"),
						Type.Literal("all"),
					],
					{
						description:
							'Which drafts to commit: "metadata" (only the metadata draft patch), "description" (only the description draft), "all" (default — commit whatever drafts exist).',
					},
				),
			),
			change_summary: Type.Optional(
				Type.String({
					description:
						"Why this commit happens — goes into the item's change history (required practice: name the deviation / assumption you corrected).",
				}),
			),
			expected_version: Type.Number({
				description:
					"The version of the task you are committing against. For CREATE pass 1 — a new task is always created at v1. " +
					"For UPDATE pass the version task_read returned (REQUIRED): a concurrent commit makes it stale and the write is rejected — " +
					"re-read, merge your changes into your draft, retry.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as {
				id: string;
				scope?: string;
				change_summary?: string;
				expected_version: number;
			};
			if (!p.id || !p.id.trim()) {
				throw new Error("tasks: task_commit requires an id");
			}
			const me = commsName();
			const r = store.commitTask(cwd, p.id, {
				scope: (p.scope as store.SubmitScope) ?? "all",
				cname: me,
				change_summary: p.change_summary,
				updated_by: me,
				planned_by: planningIdentity(cwd, me, ctx),
				expected_version: p.expected_version,
			});
			audit("task_commit", {
				item_id: r.item.id,
				created: r.created,
				version: r.item.version,
				kind: r.item.kind,
				changed_items: r.changed_items,
				change_summary: p.change_summary,
				consumed: r.consumed,
			});
			const summary = p.change_summary?.trim() || (r.created ? "created" : `updated: ${r.changed_items.join(", ")}`);
			const lines = r.created
				? [`task_commit: "${r.item.id}" created v1 (${r.item.kind}, by ${r.item.updated_by})`]
				: [
						`task_commit: "${r.item.id}" → v${r.item.version} (changed: ${r.changed_items.join(", ")}, by ${r.item.updated_by})`,
						`  consumed drafts: ${r.consumed.length > 0 ? r.consumed.join(", ") : "(none)"}`,
					];
			// What is left to commit (task_commit / task_submit_report) after this one.
			const pending = store.listPendingDrafts(cwd, me);
			lines.push(pendingDraftLine(pending));
			const idNote = store.sanitizedIdNote(p.id);
			if (idNote) lines.push(idNote);
			// Post-commit structure health check: surface orphan nodes, dangling
			// deps / subgraph gates, and cycles — EXACTLY as task_list reports them
			// ("⚠ graph warnings:" block, header included). Empty when the graph is
			// clean; present only when a structural problem exists (e.g. you freed
			// a node from every subgraph).
			const warned = graphWarnings();
			const text = warned.text
				? `${lines.join("\n")}\n\n${warned.text}`
				: lines.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					id: r.item.id,
					title: r.item.title,
					status: r.item.status,
					kind: r.item.kind,
					deps: r.item.deps,
					subgraph_deps: r.item.subgraph_deps,
					info_refs: r.item.info_refs,
					version: r.item.version,
					created: r.created,
					changed_items: r.changed_items,
					consumed: r.consumed,
					pending_drafts: pending,
					updated_at: r.item.updated_at,
					updated_by: r.item.updated_by,
					planned_by: r.item.planned_by,
					change_summary: summary,
					graph_warnings: warned.warnings,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("task_commit ")) + theme.fg("accent", (a.id as string) || "?");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
	});

	// =============================================================================
	// task_checkout
	// =============================================================================

	pi.registerTool({
		name: "task_checkout",
		label: "Task Checkout",
		description: `Check out a working copy of a task's content for editing — Step 1 of any content change. For METADATA changes to an existing task, use scope="metadata" — it scaffolds a metadata draft carrying the CURRENT title / deps / subgraph_deps / info_refs / kind as COMMENTED templates; uncomment-and-edit only the field(s) you want to change (patch semantics), then task_commit(id, expected_version, scope="metadata"). Creating a NEW task: task_checkout(id=<new-id>, version=0) scaffolds the metadata draft (with \`id\`) and the empty description draft — the scaffold format is fixed and self-evident (you read the resulting draft before filling it), so fill both with write/edit, then task_commit(id=<new-id>, expected_version=1). Checking out a HISTORICAL version of an existing task's description: pass version=<n> (n < current).An existing draft is kept untouched (check out a fresh task id, or clear it manually). The description draft copies the task's OWN body only: content shared via info_refs is NOT copied into the draft (it stays referenced and is injected automatically when the task is READ) — so editing and committing never duplicates shared requirements into the task.
# Task Dependence Graph

Task Dependence are modeled as a Directed Acyclic Graph (DAG) over a single task, with two graph relationships (\`deps\` and \`subgraph_deps\`), plus a non-graph \`info\` kind.

## 1. Task Kind

- Unit: A concrete work item scoped to be resolvable by a single agent within a 400k token budget.
- Module: A higher-level objective that encompasses sub-goals or multiple execution phases. Modules act as containers.
  - They do not specify atomic inner details up front; their subgraphs are layer-by-layer decomposiion of its execution progresses.
- Info: A shared information node — NOT a DAG node. Pure content with no deps, no subgraph gate, no status lifecycle; never in the ready set, never dispatched, excluded from orphans. Tasks reference it via \`info_refs\` (content references, not graph edges): the info node's description body is injected into the referencing task's description when task_read. It is used to write common information ONCE and share them across many tasks.

## 2. Dependency Edge Types

### A. \`deps\` — precedence to a single node
- Units and modules carry \`deps\`. \`B.deps = [A]\` means A must be done (or cancelled) before B itself can start. This is the node-level precedence edge.
- A module's \`deps\` are also used to represent the sub-goals it decomposes into. A module is finished only when all of its subtask reach a terminal state. So naturally on a module, \`deps\` carries a subtask meaning in addition to the precedence meaning.

### B. \`subgraph_deps\` — precedence to an entire subgraph
- Modules only. \`B.subgraph_deps = [A]\` means B itself plus all its children, grandchildren, and downstream nodes wait for A to finish before any of them starts. It is the same precedence idea, just applied to the whole subtree instead of one node.
- Dynamic Expansion: the gate is stored once on the parent module and expanded automatically at read time — any child/grandchild later added under B inherits the gate without being enumerated into each node's own \`deps\`.
`,
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the task whose body to prepare in your draft.",
			}),
			scope: Type.Optional(
				Type.String({
					description:
						'Which draft to prepare. "description" (default): copies the TRUE description BODY (frontmatter STRIPPED) into your draft — ' +
						'then edit with write/edit (Step 2) and commit it with task_commit(id=..., expected_version=..., scope="description") — commit re-adds the frontmatter. ' +
						'"report": creates YOUR report draft as a FRESH EMPTY scaffold (no frontmatter) — the old report is never copied or edited; ' +
						'then write/edit the body (Step 2) and submit it with ' +
						'task_submit_report(id=..., expected_version=...) — it commits the report (re-adding the for_version anchor), replies to the dispatcher and stops the reminder. ' +
						'"metadata": scaffolds the metadata draft for an EXISTING task as a PATCH — the current title / deps / subgraph_deps / info_refs / kind are written as COMMENTED templates; uncomment and edit only the field(s) you want to change, then task_commit(id=..., expected_version=..., scope="metadata") (absent fields keep their current value). Not valid with version (no historical metadata).',
				}),
			),
			version: Type.Optional(
				Type.Number({
					description:
						'Which version to check out. Omit = the CURRENT version of an existing task. A positive integer n < current = that HISTORICAL snapshot\'s description. version=0 = the id does not exist yet — scaffold the creation drafts (metadata draft with `id` + empty description draft) to fill and commit with task_commit(id=..., expected_version=1). Not valid with scope="metadata" (no historical metadata).',
				}),
			),
					}),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const p = params as { id: string; scope?: string; version?: number };
			if (!p.id || !p.id.trim()) {
				throw new Error("tasks: task_checkout requires an id");
			}
			const isMeta = p.scope === "metadata";
			const isReport = p.scope === "report";
			const isDesc = !isMeta && !isReport;
			const dstFn = isDesc ? store.taskDraftDescriptionPath : store.taskDraftReportPath;
			const commitHint = (id: string, v: number) =>
				isMeta
					? `task_commit(id="${id}", expected_version=${v}, scope="metadata")`
					: isDesc
						? `task_commit(id="${id}", expected_version=${v}, scope="description")`
						: `task_submit_report(id="${id}", expected_version=${v})`;
			const me = commsName();
			const target = store.readTask(cwd, p.id);
			const requested = p.version;
			let version: number;
			let content = "";

			if (target) {
				// EXISTING task — description copies the live or a historical body; report is always a fresh empty scaffold; metadata is a current-value comment template.
				version = requested ?? target.version;
				if (isMeta) {
					if (requested !== undefined) {
						throw new Error(
							`tasks: scope="metadata" checks out the CURRENT metadata — pass no version (historical metadata is not stored)`,
						);
					}
				} else if (!Number.isInteger(version) || version < 1) {
					throw new Error(
						`tasks: invalid version "${version}" — use a positive integer for an existing task (version=0 is only for creating a NEW task)`,
					);
				}
				if (isDesc) {
					if (version === target.version) {
						content = target.description;
					} else {
						const hist = store.readTaskVersion(cwd, p.id, version); // throws for n >= current or missing snapshot
						content = hist?.description ?? "";
					}
				}
			} else {
				// NEW task — version must be 0 (explicit or omitted): scaffold the creation drafts.
				if (requested !== undefined && requested !== 0) {
					throw new Error(
						`tasks: "${p.id}" does not exist yet — creating it requires version=0 (leave version unset to create)`,
					);
				}
				version = 0;
			}

			const dst = dstFn(cwd, me, p.id);
			// Drafts are BODY-ONLY (frontmatter is added by commit, never by checkout).
			const writes: { path: string; content: string; label: string }[] = [];
			if (target && isMeta) {
				// Metadata patch scaffold for an existing task: current values as commented templates.
				writes.push({
					path: store.taskDraftTomlPath(cwd, me, p.id),
					content: metadataDraftForUpdate(target),
					label: "metadata",
				});
			} else if (target) {
				writes.push({ path: dst, content, label: isDesc ? "description" : "report" });
			} else {
				// Creation: scaffold the metadata draft (id) + empty description draft.
				const cleanId = store.sanitizeTaskId(p.id) ?? p.id;
				const metaPath = store.taskDraftTomlPath(cwd, me, p.id);
				writes.push(
					{
						path: metaPath,
						content: `id = "${cleanId}"\n# title = "..."    # REQUIRED for creation\n# deps = []\n# subgraph_deps = []\n# into_deps = []    # wiring: write a parent id here to become its child (appended to that parent's deps) — a draft-field, never a tool-call arg\n# into_subgraph_deps = []    # wiring: write a module id here to gate that module's subgraph (appended to its subgraph_deps) — a draft-field, never a tool-call arg\n# into_info_ref = []    # wiring (kind = \"info\"): write a task/module id here to inject THIS shared info into that consumer's info_refs — a draft-field, never a tool-call arg\n# info_refs = []    # ids of shared info nodes (kind = \"info\") to inject\n# kind = "unit"     # or "module", or "info" (shared information: pure content)\n`,
						label: "metadata",
					},
					{ path: dst, content: "", label: "description" },
				);
			}

			for (const w of writes) {
				if (existsSync(w.path)) {
					const existing = readFileSync(w.path, "utf-8");
					if (existing !== w.content) {
						throw new Error(
							`tasks: you already have a draft at ${relative(cwd, w.path)} — it differs from the current content; edit it with write/edit, or clear it manually to re-create it`,
						);
					}
					// Identical to what checkout would create — treat as a successful no-op.
				} else {
					mkdirSync(dirname(w.path), { recursive: true });
					writeFileSync(w.path, w.content, "utf-8");
				}
			}

			const paths = writes.map((w) => relative(cwd, w.path)).join(", ");
			const lines = [
				`task_checkout: draft ready at ${paths}` +
					(target
						? isMeta
							? " (metadata scaffold — current title / deps / subgraph_deps / info_refs / kind are COMMENTED templates; uncomment and edit only the field(s) to change, then task_commit(id=..., expected_version=..., scope=\"metadata\"))"
							: isDesc
								? ` (description body from v${version})`
								: " (empty report scaffold — commit adds the for_version anchor)"
						: " (creation scaffold — fill `title` in the metadata draft and the description body, then task_commit(id=..., expected_version=1))"),
			];
			if (target) lines[0] += `\n  edit it with write/edit, then ${commitHint(p.id, version)}`;
			const idNote = store.sanitizedIdNote(p.id);
			if (idNote) lines.push(idNote);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					id: p.id,
					scope: isMeta ? "metadata" : isDesc ? "description" : "report",
					creating: !target,
					draft: paths,
					version,
					chars: writes.reduce((s, w) => s + w.content.length, 0),
				},
			};
		},
		renderCall(args: Record<string, unknown>, theme: any, context: any) {
			const a = args as Record<string, unknown>;
			const scope = (a.scope as string) === "report" ? " report" : (a.scope as string) === "metadata" ? " metadata" : "";
			const text =
				theme.fg("toolTitle", theme.bold("task_checkout ")) +
				theme.fg("accent", `${(a.id as string) || "?"}${scope}`);
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
});

// =============================================================================
// task_set_status
// =============================================================================


// =============================================================================
// task_set_status
// =============================================================================

pi.registerTool({
	name: "task_set_status",
	label: "Task Set Status",
	description:
		"Set a task's raw status. cancelled counts as satisfied for dependents. " +
		"A LIFECYCLE event: the version is NOT bumped (versions count content commits only) and no " +
		"snapshot is written — the transition is recorded in the change history (change_summary) and updates " +
		"updated_at/updated_by. Note: this tool only changes the status — it sends no delegation and notifies no one " +
		"(the task-comms-ops tools do both).",
	parameters: Type.Object({
		id: Type.String({
			description: "Id of the item to change (must already exist).",
		}),
		status: Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("dispatched"),
				Type.Literal("active"),
				Type.Literal("done"),
				Type.Literal("blocked"),
				Type.Literal("cancelled"),
				Type.Literal("worker_offline"),
			],
			{
				description:
					"New status to set. pending; dispatched (delegation sent, owner recorded, work not yet started — " +
					"set together with dispatched_to); active (in progress — the dispatched worker moves its item here via task_start); " +
					"done; blocked (reality is blocking progress); cancelled; worker_offline (the executing worker went offline/dead mid-flight, or is online but unresponsive after a status probe — " +
					"a recoverable failure distinct from blocked: the coordinator re-dispatches to a restarted agent after restart. " +
					"Write the recovery rung reached (session_resume / fresh_spawn) into change_summary — it is the durable probe state on the node's history). " +
					"done can be reopened (done → active); cancelled can be undone (cancelled → pending). " +
					"A task can only be marked done when all deps are done/cancelled — otherwise the transition is rejected with the missing deps listed.",
			},
		),
		dispatched_to: Type.Optional(
			Type.String({
				description:
					"Agent name to record as the item's responsible owner — only valid when setting dispatched " +
					"(dispatch). Cleared automatically on done/cancelled.",
			}),
		),
		change_summary: Type.Optional(
			Type.String({
				description:
					"Why this transition happens — goes into the item's change history.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate) {
		const p = params as {
			id: string;
			status: string;
			dispatched_to?: string;
			change_summary?: string;
		};
		if (!p.id || !p.id.trim()) {
			throw new Error("tasks: task_set_status requires an id");
		}
		if (!STATUSES.includes(p.status as TaskStatus)) {
			throw new Error(
				`tasks: invalid status "${p.status}" — one of: ${STATUSES.join(" | ")}`,
			);
		}
		const target = store.readTask(cwd, p.id);
		if (!target) throw notFoundError(cwd, p.id);
		let dispatch: TaskDispatch | null = null;
		if (p.dispatched_to && p.dispatched_to.trim()) {
			if (p.status !== "dispatched") {
				throw new Error(
					`tasks: dispatch records the agent — set status to "dispatched" together with dispatched_to (got "${p.status}")`,
				);
			}
			const name = p.dispatched_to.trim();
			dispatch = { name, dispatched_by: "", dispatch_msg_id: "" };
		}
		const r = store.setTaskStatus(cwd, p.id, p.status as TaskStatus, {
			change_summary: p.change_summary,
			updated_by: commsName(),
			event: p.status,
			...(dispatch ? { dispatched_to: dispatch } : {}),
			});
			audit("task_set_status", {
				item_id: r.item.id,
				status: r.item.status,
				version: r.item.version,
				unlocked: r.unlocked,
				change_summary: p.change_summary,
			});
			const summary = p.change_summary?.trim() || `set to ${r.item.status}`;
			const lines = [
				`task_set_status: "${r.item.id}" → ${r.item.status} (by ${r.item.updated_by}; version unchanged — lifecycle event recorded in history)`,
			];
			if (dispatch) {
				lines.push(`  dispatched to ${dispatch.name}`);
			} else if (target.dispatched_to && (r.item.status === "done" || r.item.status === "cancelled")) {
				lines.push(`  undispatched: ${target.dispatched_to.name} — responsibility ended`);
			}
			if (r.unlocked.length > 0) {
				lines.push(`  unlocked: ${r.unlocked.join(", ")} — deps now satisfied (dispatch the newly ready ones)`);
			}
			lines.push(broadcastLine("update", r.item.id, r.item.status, summary));
			const idNote = store.sanitizedIdNote(p.id);
			if (idNote) lines.push(idNote);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					id: r.item.id,
					title: r.item.title,
					status: r.item.status,
					version: r.item.version,
					unlocked: r.unlocked,
					item: r.item,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("task_set_status ")) +
				theme.fg("accent", `${(a.id as string) || "?"} → ${(a.status as string) || "?"}`);
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
	});

	// =============================================================================
	// task_read
	// =============================================================================

	pi.registerTool({
		name: "task_read",
		label: "Task Read",
		description:
			"Read one task: metadata + graph context (deps, subgraph_deps, dispatched_to, execution_session, planned_by, " +
			"dependents, readiness, change history) plus optionally " +
			"the long-form content. Reading and editing are separate: READ here (fields= loads the content); to EDIT, task_checkout prepares your draft, write/edit modifies it, and task_commit / task_submit_report commit it — content is changed ONLY through those tools, never by touching task storage directly. " +
			"The description loaded via fields=\"description\" is the EFFECTIVE description: content shared via info_refs is injected before the task's own body — your checkout draft will contain only the task's own body, without the injected shared content.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the item to read (use task_list to see all items).",
			}),
			version: Type.Optional(
				Type.Number({
					description:
						"Read the archived snapshot of this past version (a positive integer, less than the current version) instead of the current record.",
				}),
			),
			fields: Type.Optional(
				Type.Union(
					[
						Type.Literal("description"),
						Type.Literal("report"),
						Type.Literal("full"),
					],					{
						description:
							'Which long-form content to load in addition to the metadata. If the fields parameter is ' +
							'omitted, returns only the metadata + graph context — no long-form content (the omitted ' +
							'content is reported by size in chars). "description" = the task ' +
							'instructions; "report" = the completion report; "full" = both.',
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as { id: string; version?: number; fields?: ReadFields };
			const fields = p.fields;
			const me = commsName();
			const item = store.readTask(cwd, p.id);
			if (!item) {
				return {
					content: [
						{
							type: "text" as const,
							text: `task_read: "${p.id}" not found — available items: ${availableIds(cwd)}`,
						},
					],
					details: { id: p.id, found: false },
				};
			}
			if (p.version !== undefined) {
				// Archived snapshot read — the item's past version as it was
				// before it was replaced. Live-graph facts (dependents,
				// readiness) do not apply to old versions, so they are not
				// computed.
				const snap = store.readTaskVersion(cwd, p.id, p.version);
				if (!snap) {
					return {
						content: [
							{
								type: "text" as const,
								text: `task_read: "${p.id}" not found — available items: ${availableIds(cwd)}`,
							},
						],
						details: { id: p.id, found: false },
					};
				}
				const text = renderTaskView(snap, { archived: true, fields, requestedId: p.id });
				return {
					content: [{ type: "text" as const, text }],
					details: {
						found: true,
						archived: true,
						version: snap.version,
						item: { id: snap.id, status: snap.status, version: snap.version },
					},
				};
			}
			const byId = loadAllItems(cwd);
			const itemsArr = [...byId.values()];
			const dependents = graph.dependentsOf(itemsArr, item.id);
			const rs = graph.readySet(itemsArr);
			const isReady = rs.ready.some((x) => x.id === item.id);
			const notReadyInfo = rs.notReady.find((x) => x.item.id === item.id);
			const missing = notReadyInfo ? notReadyInfo.missing : [];
			const text = renderTaskView(item, { archived: false, fields, requestedId: p.id, live: { dependents, isReady, missing } });
			return {
				content: [{ type: "text" as const, text }],
				details: {
					found: true,
					item: { id: item.id, status: item.status, version: item.version, struct_version: item.struct_version },
					dependents,
					missing,
					ready: isReady,
					integrity_warnings: item.integrity_warnings ?? [],
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("task_read ")) + theme.fg("accent", (a.id as string) || "?");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const text = !d?.found
				? theme.fg("error", "✗ not found")
				: theme.fg((d.item as Task).status === "done" ? "success" : "accent",
					`${STATUS_GLYPH[(d.item as Task).status] ?? "◻"} ${(d.item as Task).id}`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full record, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// task_list
	// =============================================================================

	pi.registerTool({
		name: "task_list",
		label: "Task List",
		description:
			"Overview of the whole task graph as an indented tree: roots are the deliverables, each node's " +
			"children are its deps, with status marks and the [module] marker — plus a status-count line, the " +
			"Ready: frontier, a separate 'Shared information' section (kind=\"info\" nodes, with their referenced-by " +
			"count), and graph warnings (dependency cycles, dangling deps, orphan items — tasks with no dependents, " +
			"outside every module subgraph). Use it to discover existing items, to read the plan structure, and to " +
			"find the id referenced in a task message.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			const itemsArr = [...loadAllItems(cwd).values()];
			if (itemsArr.length === 0) {
				return {
					content: [{ type: "text" as const, text: "task_list: no tasks yet" }],
					details: {
						count: 0,
						ready: 0,
						graph: "",
						warnings: { cycles: [], dangling: [], orphans: [], components: [] },
					},
				};
			}
			// Full-graph health check (cycles / dangling deps / orphans / disconnected),
			// appended after the tree only when a structural problem exists.
			const { text: warningBlock, warnings } = graphWarnings();
			const tree = graph.renderGraph(itemsArr);
			const text = warningBlock ? `${tree}\n${warningBlock}` : tree;
			const ready = graph.readySet(itemsArr).ready.length;
			return {
				content: [{ type: "text" as const, text }],
				details: { count: itemsArr.length, ready, graph: tree, warnings },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list")), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const n = (d?.count as number) || 0;
			const ready = (d?.ready as number) || 0;
			const text = theme.fg("accent", `🌳 ${n} item(s) · ${ready} ready`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full graph tree, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// task_ready_set
	// =============================================================================

	pi.registerTool({
		name: "task_ready_set",
		label: "Task Ready Set",
		description:
			"The dispatch query for managers: the READY SET — pending items with all deps satisfied, dispatchable " +
			"in parallel, grouped by granularity kind (unit; module) — " +
			"plus each pending item that is not ready, with its missing deps, and overall progress (done/total, " +
			"blocked count). Run it before delegating the next batch of work. " +
			"Optional for=<item id> scopes the query to that item's subgraph — the item itself plus its dependency " +
			"closure (see the parameter). The ready items in scope, the scoped item itself included when ready, " +
			"are the prerequisites of the subgraph you are about to advance.",
		parameters: Type.Object({
			for: Type.Optional(
				Type.String({
					description:
						"Optional: scope the query to this item and its dependency closure — the item itself and everything it depends on (directly or transitively) are reported.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as { for?: string };
			const byId = loadAllItems(cwd);
			const itemsArr = [...byId.values()];
			let scope = itemsArr;
			if (p.for) {
				const root = byId.get(p.for);
				if (!root) throw notFoundError(cwd, p.for);
				// The item itself joins its dependency closure — a ready root is
				// dispatchable right now, so it belongs in the scoped query.
				const inScope = new Set([p.for, ...graph.dependencyClosure(itemsArr, p.for)]);
				scope = itemsArr.filter((i) => inScope.has(i.id));
			}
			const { ready, notReady } = graph.readySet(scope);
			const { execute, modules } = graph.readyBuckets(ready);
			const taskScope = scope.filter((i) => i.kind !== "info"); // shared info counts out
			const progress: Record<string, number> = {
				done: 0,
				total: taskScope.length,
				blocked: 0,
				dispatched: 0,
				active: 0,
				pending: 0,
				cancelled: 0,
				ready: ready.length,
			};
			for (const i of taskScope) {
				if (i.status === "done") progress.done++;
				else if (i.status === "blocked") progress.blocked++;
				else if (i.status === "dispatched") progress.dispatched++;
				else if (i.status === "active") progress.active++;
				else if (i.status === "cancelled") progress.cancelled++;
				else progress.pending++;
			}
			const lines = [
				`task_ready_set${p.for ? ` (for ${p.for})` : ""}: ${progress.done}/${progress.total} done — ${progress.blocked} blocked — ` +
					`${progress.dispatched} dispatched — ${ready.length} ready to dispatch`,
				`Ready for execution (unit):`,
			];
			if (execute.length > 0) {
				lines.push(...execute.map((i) => `  ◻ ${i.id} (${i.title})`));
			} else {
				lines.push("  (none)");
			}
			lines.push(`Ready (module — delegate to sub-Coordinator):`);
			if (modules.length > 0) {
				lines.push(...modules.map((i) => `  ◻ ${i.id} (${i.title})`));
			} else {
				lines.push("  (none)");
			}
			lines.push(`Pending (deps not yet satisfied):`);
			if (notReady.length > 0) {
				lines.push(...notReady.map((x) => `  ◻ ${x.item.id} — missing: ${x.missing.join(", ")}`));
			} else {
				lines.push("  (none)");
			}
			// In-flight but possibly stalled: dispatched/active items in scope with
			// no report. Their age is the staleness signal — a worker that went
			// offline or is silently wedged gives no progress, so the manager sees
			// exactly which live task has gone quiet.
			const stalled = scope
				.filter((i) => i.status === "dispatched" || i.status === "active")
				.map((i) => ({ id: i.id, title: i.title, status: i.status, age: store.statusSinceMs(i) }))
				.sort((a, b) => b.age - a.age);
			lines.push(`In-flight (dispatched/active) — age = time in current status:`);
			if (stalled.length > 0) {
				lines.push(...stalled.map((x) => `  ${x.status === "active" ? "●" : "◻"} ${x.id} (${x.title}) · ${fmtAge(x.age)} in ${x.status}`));
			} else {
				lines.push("  (none)");
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { ready, notReady, progress },
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const scope = (a.for as string) || "";
			const text =
				theme.fg("toolTitle", theme.bold("task_ready_set")) +
				(scope ? ` ${theme.fg("accent", `for ${scope}`)}` : "");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const ready = (d?.ready as unknown[]) ?? [];
			const progress = (d?.progress as Record<string, number>) ?? {};
			const n = ready.length;
			const blocked = progress.blocked ?? 0;
			let text = `◻ ${n} ready`;
			if (n > 0) {
				const ids = (ready as { id: string }[]).slice(0, 3).map((i) => i.id);
				text += ` (${ids.join(", ")}${n > 3 ? ", …" : ""})`;
			}
			text += ` · ${progress.done ?? 0}/${progress.total ?? 0}`;
			if (blocked > 0) text += ` · ⛔ ${blocked} blocked`;
			const colored = theme.fg(n > 0 ? "success" : "accent", text);
			if (!options.expanded) return new Text(colored, 0, 0);
			// Expanded: the full ready set / missing deps, as the LLM saw it.
			return new Text(expandedContent(result, colored), 0, 0);
		},
	});

	// =============================================================================
	// Hooks
	// =============================================================================

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd || process.cwd();

		const ourTools = [
			"task_commit",
			"task_checkout",
			"task_set_status",
			"task_read",
			"task_list",
			"task_ready_set",
		];
		const currentActive = pi.getActiveTools?.() || [];
		pi.setActiveTools([...new Set([...currentActive, ...ourTools])]);

		audit("ready", {});
	});
}
