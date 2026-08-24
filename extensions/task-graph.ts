/**
 * tasks — Task graph system (pure-DAG tracked work).
 *
 * A task is the unit of tracked work. It unifily represent task at any granularity
 * module, unit task, subtask. Items form a pure dependency DAG: deps are the edges
 * (B.deps=[A] means A completes before B can complete), validated at write
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
 * Tools: task_create, task_update, task_set_status, task_read, task_list,
 * task_ready_set, task_render.
 *
 * Implementation: storage in lib/tasks/store.ts (filesystem under
 * .pi/tasks/, PI_TASKS_DIR override), graph semantics in
 * lib/tasks/graph.ts (ready set, DAG validation, tree rendering). The
 * shell wires the tools to them, audits writes on the "tasks-log"
 * channel, and enforces the teaching rules (dep existence, cycles, deps
 * satisfied before done) with errors that teach the model instead of failing
 * silently.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import * as store from "./lib/tasks/store";
import type { Task, TaskDispatch, TaskKind, TaskStatus } from "./lib/tasks/store";
import * as graph from "./lib/tasks/graph";
import {
	availableIds,
	broadcastLine,
	cycleError,
	loadAllItems,
	missingDepsError,
	missingSubgraphDepsError,
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

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();

	/**
	 * Agent name for the updated_by stamp — read from the --cname CLI flag
	 * (spawned agents always carry it). Both "--cname <value>" and
	 * "--cname=<value>" forms are accepted; anything else yields "unknown".
	 * task-graph.ts has NO comms dependency: the name comes from the CLI, not from
	 * any comms runtime.
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

	const STATUSES: TaskStatus[] = ["pending", "dispatched", "active", "done", "blocked", "cancelled"];
	const STATUS_GLYPH: Record<TaskStatus, string> = {
		pending: "◻",
		dispatched: "◔",
		active: "▶",
		done: "✓",
		blocked: "⛔",
		cancelled: "⊘",
	};

	// =============================================================================
	// task_create
	// =============================================================================

	pi.registerTool({
		name: "task_create",
		label: "Task Create",
		description:
			"Create a task — the unified unit of tracked work at any granularity (module, task, subtask). " +
			"deps are this item's completion prerequisites: deps=[A] means A completes before this item can complete. " +
			"deps must ALREADY exist — create the child items first, then link them via deps; a missing dep is " +
			"rejected with the list of available items. " +
			"subgraph_deps declares SUBGRAPH GATES (modules only): the module AND its whole subgraph — everything " +
			"it depends on, transitively — additionally wait for these ids (full semantics in the parameter). " +
			"id is a kebab-case slug; omit it for an auto-generated one (task-<ulid8>). " +
			"kind: unit (directly executable, no children — the default) or module (aggregation node — may have " +
			"a subgraph; review nodes are modules too). Both kinds may carry deps (a unit with deps waits for its " +
			"prerequisites, still executed directly); subgraph_deps stay module-only.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"Task id (kebab-case, lowercase letters/digits/_/-). Omitted = auto-generated (task-<ulid8>).",
				}),
			),
			title: Type.String({
				description: "Short title of the item (what the work is). Required.",
			}),
			description: Type.Optional(
				Type.String({
					description: "Optional detail: scope, acceptance criteria, context.",
				}),
			),
			deps: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Completion prerequisites — item ids that must complete before this one can complete. All must already exist (create them first). Legal on any kind: a unit with deps waits for its prerequisites but is still executed directly (no delegation); modules use deps to hold their subgraph.",
					}),
				),
			),
			subgraph_deps: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Subgraph gates (modules only) — item ids that this module's WHOLE subgraph waits for: the module itself and every task under it (its deps, transitively) become ready only after these complete. An ordering edge, not a data dependency. Stored once on the module and applied to the whole subgraph at read time — tasks added to the subgraph later are gated automatically. Every gate must already exist and must NOT be inside this module's own subgraph.",
					}),
				),
			),
			kind: Type.Optional(
				Type.String({
					description:
						'Granularity kind: "unit" (directly executable — default; may still carry deps as ordering edges) or "module" (aggregation node — may have a subgraph; review nodes are modules).',
				}),
			),
			change_summary: Type.Optional(
				Type.String({
					description:
						"Why this create happens — goes into the item's change history.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as {
				id?: string;
				title: string;
				description?: string;
				deps?: string[];
				subgraph_deps?: string[];
				kind?: string;
				change_summary?: string;
			};
			if (!p.title || !p.title.trim()) {
				throw new Error("tasks: task_create requires a title — name the item so it is traceable");
			}
			const deps = p.deps ?? [];
			if (deps.length > 0) {
				const byId = loadAllItems(cwd);
				const missing = deps.filter((d) => !byId.has(d));
				if (missing.length > 0) throw missingDepsError(cwd, missing);
			}
			const moduleDeps = p.subgraph_deps ?? [];
			if (moduleDeps.length > 0) {
				const byId = loadAllItems(cwd);
				const missing = moduleDeps.filter((d) => !byId.has(d));
				if (missing.length > 0) throw missingSubgraphDepsError(cwd, missing);
			}
			const item = store.createTask(cwd, {
				id: p.id,
				title: p.title,
				description: p.description,
				deps,
				subgraph_deps: moduleDeps,
				kind: p.kind as TaskKind | undefined,
				change_summary: p.change_summary,
				updated_by: commsName(),
			});
			audit("task_create", {
				item_id: item.id,
				title: item.title,
				kind: item.kind,
				deps: item.deps,
				subgraph_deps: item.subgraph_deps,
				version: item.version,
				change_summary: p.change_summary,
			});
			const summary = p.change_summary?.trim() || "created";
			const text =
				`task_create: "${item.id}" v${item.version} (${item.kind}, by ${item.updated_by})\n` +
				`deps: ${item.deps.length > 0 ? item.deps.join(", ") : "(none)"}\n` +
				`subgraph_deps: ${item.subgraph_deps.length > 0 ? item.subgraph_deps.join(", ") : "(none)"}\n` +
				broadcastLine("created", item.id, item.status, summary);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					id: item.id,
					title: item.title,
					status: item.status,
					kind: item.kind,
					deps: item.deps,
					subgraph_deps: item.subgraph_deps,
					version: item.version,
					created: true,
					updated_at: item.updated_at,
					updated_by: item.updated_by,
					change_summary: summary,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const id = (a.id as string) || "(auto)";
			const text =
				theme.fg("toolTitle", theme.bold("task_create ")) + theme.fg("accent", id);
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const id = (d?.id as string) || "?";
			const text = theme.fg("success", `✎ new ${id}`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full result content, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// task_update
	// =============================================================================

	pi.registerTool({
		name: "task_update",
		label: "Task Update",
		description:
			"Update a task: title, description, kind, deps or subgraph_deps (omit a field to keep its current value). " +
			"Changing deps re-validates the graph: every dep must already exist and the result must stay acyclic — " +
			"a cycle is rejected with the cycle path in the error. subgraph_deps (modules only) sets the subgraph " +
			"gates — the ids this module's whole subgraph additionally waits for; [] clears them; a gate must not lie " +
			"inside the module's own subgraph, and a unit cannot declare gates. kind can flip a unit to module when " +
			"execution reveals the item needs decomposition. Read the item first (task_read) to see its current " +
			"values; pass its version as expected_version to make the write conditional (optimistic concurrency) — " +
			"a stale version fails with a conflict error, re-read and retry.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the item to update (must already exist).",
			}),
			title: Type.Optional(
				Type.String({
					description: "New title.",
				}),
			),
			description: Type.Optional(
				Type.String({
					description: "New description.",
				}),
			),
			deps: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"New full deps list (replaces the stored one) — all must already exist and the result must stay acyclic. Legal on any kind: a unit with deps waits for its prerequisites but is still executed directly.",
					}),
				),
			),
			subgraph_deps: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"New full subgraph-gates list (replaces the stored one; modules only) — the ids this module's whole subgraph additionally waits for; [] clears the gates. Every gate must already exist and must not be inside this module's own subgraph; the expanded graph (gates included) must stay acyclic.",
					}),
				),
			),
			kind: Type.Optional(
				Type.String({
					description:
						'New granularity kind: "unit" (directly executable — may still carry deps as ordering edges) or "module" (aggregation — may have a subgraph).',
				}),
			),
			change_summary: Type.Optional(
				Type.String({
					description:
						"Why this update happens — goes into the item's change history.",
				}),
			),
			expected_version: Type.Optional(
				Type.Number({
					description:
						"Optional expected version (optimistic concurrency): the write fails with a conflict error if the node has moved past it since you read it — re-read (task_read returns version) and retry.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as {
				id: string;
				title?: string;
				description?: string;
				deps?: string[];
				subgraph_deps?: string[];
				kind?: string;
				change_summary?: string;
				expected_version?: number;
			};
			if (!p.id || !p.id.trim()) {
				throw new Error("tasks: task_update requires an id");
			}
			const byId = loadAllItems(cwd);
			const target = byId.get(p.id);
			if (!target) throw notFoundError(cwd, p.id);
			const newDeps = p.deps !== undefined ? p.deps : target.deps;
			if (p.deps !== undefined && newDeps.length > 0) {
				const missing = newDeps.filter((d) => !byId.has(d));
				if (missing.length > 0) throw missingDepsError(cwd, missing);
			}
			const newGates =
				p.subgraph_deps !== undefined ? p.subgraph_deps : target.subgraph_deps;
			if (p.subgraph_deps !== undefined && newGates.length > 0) {
				const missing = newGates.filter((d) => !byId.has(d));
				if (missing.length > 0) throw missingSubgraphDepsError(cwd, missing);
			}
			if (p.deps !== undefined || p.subgraph_deps !== undefined) {
				// Would-be graph cycle check (dangling is impossible here — all deps
				// and gates exist). validateGraph checks the EXPANDED graph, so
				// gate-created cycles surface here too.
				const wouldBe = [...byId.values()].map((i) =>
					i.id === p.id ? { ...i, deps: newDeps, subgraph_deps: newGates } : i,
				);
				const { cycles } = graph.validateGraph(wouldBe);
				if (cycles.length > 0) throw cycleError(cycles[0]);
			}
			const item = store.updateTask(cwd, p.id, {
				title: p.title,
				description: p.description,
				deps: p.deps,
				subgraph_deps: p.subgraph_deps,
				kind: p.kind as TaskKind | undefined,
				change_summary: p.change_summary,
				expected_version: p.expected_version,
				updated_by: commsName(),
			});
			audit("task_update", {
				item_id: item.id,
				kind: item.kind,
				version: item.version,
				subgraph_deps: item.subgraph_deps,
				change_summary: p.change_summary,
			});
			const summary = p.change_summary?.trim() || "updated";
			const text =
				`task_update: "${item.id}" → v${item.version} (${item.kind}, by ${item.updated_by})\n` +
				broadcastLine("update", item.id, item.status, summary);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					id: item.id,
					title: item.title,
					status: item.status,
					kind: item.kind,
					deps: item.deps,
					subgraph_deps: item.subgraph_deps,
					version: item.version,
					created: false,
					updated_at: item.updated_at,
					updated_by: item.updated_by,
					change_summary: summary,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("task_update ")) + theme.fg("accent", (a.id as string) || "?");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const id = (d?.id as string) || "?";
			const v = d?.version as number;
			const text = theme.fg("accent", `✎ v${v} ${id}`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full result content, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// task_set_status
	// =============================================================================

	pi.registerTool({
		name: "task_set_status",
		label: "Task Set Status",
		description:
			"Set a task's raw status: pending (not started), dispatched (delegation sent, owner recorded, work " +
			"not yet started), active (in progress), done (finished), blocked (reality is blocking progress), " +
			"cancelled (abandoned). The dispatched worker moves its item to active with task_start. done can be " +
			"reopened (done → active); cancelled can be undone (cancelled → pending). cancelled counts as satisfied " +
			"for dependents. Note: this tool only changes the status — it sends no delegation and notifies no one " +
			"(the task-comms-ops tools do both). Read the item first (task_read) to see its current status and " +
			"version; pass the version as expected_version to make the transition conditional (optimistic " +
			"concurrency) — a stale version fails with a conflict error, re-read and retry.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the item to change (must already exist).",
			}),
			status: Type.String({
				description: "New status: pending | dispatched | active | done | blocked | cancelled.",
			}),
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
			expected_version: Type.Optional(
				Type.Number({
					description:
						"Optional expected version (optimistic concurrency): the write fails with a conflict error if the node has moved past it since you read it — re-read (task_read returns version) and retry.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as {
				id: string;
				status: string;
				dispatched_to?: string;
				change_summary?: string;
				expected_version?: number;
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
				// The dispatch records the agent NAME — the comms identity, the
				// address comms delivers to (stable across restarts).
				// no dispatcher nor delegation message on a bare dispatch —
				// task_start stays quiet, task_submit_report has nothing to reply to
				dispatch = { name, dispatched_by: "", dispatch_msg_id: "" };
			}
			const r = store.setTaskStatus(cwd, p.id, p.status as TaskStatus, {
				change_summary: p.change_summary,
				updated_by: commsName(),
				expected_version: p.expected_version,
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
				`task_set_status: "${r.item.id}" → ${r.item.status} (by ${r.item.updated_by})`,
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
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const id = (d?.id as string) || "?";
			const st = (d?.status as string) || "?";
			const unlocked = (d?.unlocked as string[]) ?? [];
			const color = st === "done" ? "success" : st === "blocked" ? "error" : "accent";
			const glyph = STATUS_GLYPH[st as TaskStatus] ?? "◻";
			const extra = unlocked.length > 0 ? ` +${unlocked.length}` : "";
			const text = theme.fg(color, `${glyph} ${st} ${id}${extra}`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full result content, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// task_read
	// =============================================================================

	pi.registerTool({
		name: "task_read",
		label: "Task Read",
		description:
			"Read one task: metadata + graph context (deps, subgraph_deps, dispatched_to, execution_session, " +
			"dependents, readiness, change history) plus optionally the long bodies. Default returns the metadata WITHOUT " +
			"the description / completion report bodies. Load a body on demand: fields=\"description\" adds " +
			"the task instructions, fields=\"report\" adds the completion report (avoids re-reading the " +
			"instructions when verifying a finished item), fields=\"full\" adds both. Omitted bodies are " +
			"reported with their size in chars, so you can judge whether a follow-up read is worth it. " +
			"Optional version=<n>: read the archived full-content snapshot of that past version instead of " +
			"the current record.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the item to read (use task_list to see all items).",
			}),
			version: Type.Optional(
				Type.Number({
					description:
						"Optional: read the archived full-content snapshot of this past version (a positive integer, less than the current version) instead of the current record.",
				}),
			),
			fields: Type.Optional(
				Type.Union(
					[
						Type.Literal("description"),
						Type.Literal("report"),
						Type.Literal("full"),
					],
					{
						description:
							'Optional: which long body to load in addition to the metadata. "description" = the task ' +
							'instructions body; "report" = the completion report body; "full" = both bodies. ' +
							'Default (omitted): metadata + graph context only; omitted bodies are reported with their size.',
					},
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as { id: string; version?: number; fields?: string };
			const fields = p.fields ?? "core";
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
				// computed. Errors from the store (invalid / out-of-range
				// version, missing or corrupted snapshot) propagate.
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
				const glyph = STATUS_GLYPH[snap.status] ?? "◻";
				const statusLine = `${glyph} ${snap.status}`;
				const lines = [
					`task_read: ${snap.id} v${snap.version} — ARCHIVED SNAPSHOT — ${statusLine} — by ${snap.updated_by} at ${snap.updated_at}`,
					`title: ${snap.title}`,
					`kind: ${snap.kind}`,
					`deps: ${snap.deps.length > 0 ? snap.deps.join(", ") : "(none)"}`,
				];
				if (snap.subgraph_deps.length > 0) {
					lines.push(`subgraph_deps: ${snap.subgraph_deps.join(", ")} (subgraph gates — whole subgraph waits for these)`);
				}
				if (snap.dispatched_to) {
					lines.push(`dispatched_to: ${snap.dispatched_to.name}`);
				}
				if (snap.execution_session) {
					lines.push(
						`execution_session: ${snap.execution_session.session_id} (${snap.execution_session.session_file || "no file"}) — the worker's transcript, open it to review this execution`,
					);
				}
				// Long bodies — loaded on demand; each read reports what was
				// omitted and how large it is, so the caller can decide whether
				// a follow-up read is worth it.
				const descLen = snap.description?.length;
				const reportLen = snap.completion_report?.length;
				if (fields === "description") {
					lines.push(snap.description ? `description: ${snap.description}` : "description: (none)");
					if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${snap.id}", version=${snap.version}, fields="report")`);
				} else if (fields === "report") {
					if (snap.completion_report) lines.push(`── Completion report ──`, snap.completion_report);
					else lines.push("completion report: (none)");
					if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${snap.id}", version=${snap.version}, fields="description")`);
				} else if (fields === "full") {
					if (snap.description) lines.push(`description: ${snap.description}`);
					if (snap.completion_report) lines.push(`── Completion report ──`, snap.completion_report);
				} else {
					if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${snap.id}", version=${snap.version}, fields="description")`);
					if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${snap.id}", version=${snap.version}, fields="report")`);
				}
				// The store digests the completion report by its first line (the
				// history entry that wrote it repeats that text) — when the report
				// body is shown above, echoing the digest again is pure duplication.
				const reportShown = fields === "report" || fields === "full";
				const reportDigest =
					reportShown && snap.completion_report
						? snap.completion_report.split("\n")[0].replace(/\s+/g, " ").trim()
						: null;
				const historyLines = snap.history.map((h) => {
					const summary =
						reportDigest && h.change_summary === reportDigest
							? "(completion report digest — see the report above)"
							: h.change_summary;
					return `  v${h.version} ${h.updated_at} by ${h.updated_by} — ${summary}`;
				});
				lines.push(
					`── Change history (as of v${snap.version}) ──`,
					historyLines.length > 0 ? historyLines.join("\n") : "  (none)",
				);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					// item trimmed to the fields the TUI render reads — the full
					// record would duplicate the content text in stored messages.
					details: {
						found: true,
						archived: true,
						version: snap.version,
						item: { id: snap.id, status: snap.status, version: snap.version },
					},
				};
			}
			const glyph = STATUS_GLYPH[item.status] ?? "◻";
			const statusLine = `${glyph} ${item.status}`;
			const byId = loadAllItems(cwd);
			const itemsArr = [...byId.values()];
			const dependents = graph.dependentsOf(itemsArr, item.id);
			const rs = graph.readySet(itemsArr);
			const isReady = rs.ready.some((x) => x.id === item.id);
			const notReadyInfo = rs.notReady.find((x) => x.item.id === item.id);
			const missing = notReadyInfo ? notReadyInfo.missing : [];

			let readyLine: string;
			if (item.status === "done") {
				readyLine = "ready: no — already done";
			} else if (isReady) {
				readyLine = "ready: yes — dispatchable in parallel";
			} else if (missing.length > 0) {
				readyLine = `ready: no — missing deps: ${missing.join(", ")}`;
			} else {
				readyLine = "ready: no";
			}
			const lines = [
				`task_read: ${item.id} v${item.version} — ${statusLine} — by ${item.updated_by} at ${item.updated_at}`,
				`title: ${item.title}`,
				`kind: ${item.kind}`,
				`deps: ${item.deps.length > 0 ? item.deps.join(", ") : "(none)"}`,
			];
			if (item.subgraph_deps.length > 0) {
				lines.push(`subgraph_deps: ${item.subgraph_deps.join(", ")} (subgraph gates — the whole subgraph waits for these)`);
			}
			lines.push(
				`dispatched_to: ${item.dispatched_to ? item.dispatched_to.name : "(none)"}`,
				`execution_session: ${item.execution_session ? `${item.execution_session.session_id} (${item.execution_session.session_file || "no file"}) — open the transcript to review how it was executed` : "(none — the worker records it at task_start)"}`,
				`dependents: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`,
				readyLine,
			);
			// Long bodies — loaded on demand; each read reports what was
			// omitted and how large it is, so the caller can decide whether a
			// follow-up read is worth it.
			const descLen = item.description?.length;
			const reportLen = item.completion_report?.length;
			if (fields === "description") {
				lines.push(item.description ? `description: ${item.description}` : "description: (none)");
				if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${item.id}", fields="report")`);
			} else if (fields === "report") {
				if (item.completion_report) lines.push(`── Completion report ──`, item.completion_report);
				else lines.push("completion report: (none)");
				if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${item.id}", fields="description")`);
			} else if (fields === "full") {
				if (item.description) lines.push(`description: ${item.description}`);
				if (item.completion_report) {
					lines.push(
						`── Completion report (written by the dispatched agent; the manager reads it before task_complete) ──`,
						item.completion_report,
					);
				}
			} else {
				if (descLen) lines.push(`description: omitted (${descLen} chars) — load with task_read(id="${item.id}", fields="description")`);
				if (reportLen) lines.push(`completion report: omitted (${reportLen} chars) — load with task_read(id="${item.id}", fields="report")`);
			}
			// The store digests the completion report by its first line (the
			// history entry that wrote it repeats that text) — when the report
			// body is shown above, echoing the digest again is pure duplication.
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
				return `  v${h.version} ${h.updated_at} by ${h.updated_by} — ${summary}`;
			});
			lines.push(
				`── Change history ──`,
				historyLines.length > 0 ? historyLines.join("\n") : "  (none)",
			);
			if (item.version > 1) {
				lines.push(
					`archived snapshots: v1..v${item.version - 1} — task_read(id, version=<n>) to read one`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				// item trimmed to the fields the TUI render reads — the full
				// record would duplicate the content text in stored messages.
				details: {
					found: true,
					item: { id: item.id, status: item.status, version: item.version },
					dependents,
					missing,
					ready: isReady,
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
			"List all tasks as a flat table: id, title, status, version, last update, ready mark — plus " +
			"status counts and graph warnings (dependency cycles, dangling deps, orphan items — free-floating " +
			"tasks with no dependents, outside every module subgraph). Use it to discover existing " +
			"items and to find the id referenced in a task message.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			const summaries = store.listTasks(cwd);
			if (summaries.length === 0) {
				return {
					content: [{ type: "text" as const, text: "task_list: no tasks yet" }],
					details: { count: 0, items: [], warnings: { cycles: [], dangling: [], orphans: [] }, counts: {} },
				};
			}
			const byId = loadAllItems(cwd);
			const itemsArr = [...byId.values()];
			const rs = graph.readySet(itemsArr);
			const readyIds = new Set(rs.ready.map((i) => i.id));
			const { cycles, dangling } = graph.validateGraph(itemsArr);
			const orphans = graph.orphanItems(itemsArr);
			const counts: Record<TaskStatus, number> = {
				pending: 0,
				dispatched: 0,
				active: 0,
				done: 0,
				blocked: 0,
				cancelled: 0,
			};
			for (const i of itemsArr) counts[i.status]++;

			const row = (s: (typeof summaries)[number]) => {
				const glyph = STATUS_GLYPH[s.status] ?? "◻";
				const parts = [
					`${glyph} ${s.id} ${s.title}`,
					`v${s.version}`,
					s.updated_by,
					s.updated_at.slice(0, 10),
				];
				if (s.depCount > 0) parts.push(`${s.depCount} dep(s)`);
				if (s.dispatched_to) parts.push(`dispatched: ${s.dispatched_to.name}`);
				if (readyIds.has(s.id)) parts.push("ready");
				if (s.kind === "module") parts.push("[module]");
				if (s.subgraph_deps.length > 0) parts.push(`subgraph_deps: ${s.subgraph_deps.join(", ")}`);
				return `  ${parts.join(" · ")}`;
			};
			const warningLines: string[] = [];
			for (const cyc of cycles) warningLines.push(`  ⚠ cycle: ${cyc.join(" -> ")}`);
			for (const d of dangling) warningLines.push(`  ⚠ dangling dep: ${d.id} → ${d.dep} (missing)`);
			for (const o of orphans)
				warningLines.push(`  ⚠ orphan: ${o.id} (${o.status}) — no dependents, outside every module subgraph`);
			const header =
				`task_list: ${summaries.length} item(s) — ${counts.done} done · ${counts.blocked} blocked · ` +
				`${counts.pending} pending · ${counts.dispatched} dispatched`;
			const body = summaries.map(row).join("\n");
			const text =
				header +
				"\n" +
				body +
				(warningLines.length > 0 ? `\n⚠ graph warnings:\n${warningLines.join("\n")}` : "");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					count: summaries.length,
					items: summaries,
					warnings: { cycles, dangling, orphans },
					counts,
				},
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list")), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const n = (d?.count as number) || 0;
			const text = theme.fg("accent", `${n} item(s)`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full table, as the LLM saw it.
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
			"in parallel, grouped by granularity kind (unit — directly executable; module — may need delegation) — " +
			"plus each pending item that is not ready with its missing deps, and overall progress (done/total, " +
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
			const progress: Record<string, number> = {
				done: 0,
				total: scope.length,
				blocked: 0,
				dispatched: 0,
				active: 0,
				pending: 0,
				cancelled: 0,
				ready: ready.length,
			};
			for (const i of scope) {
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
			lines.push(`Ready (module — may need delegation):`);
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
			// Compact: the ready ids matter more than the raw count — the
			// dispatch list is what the manager acts on.
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
	// task_render
	// =============================================================================

	pi.registerTool({
		name: "task_render",
		label: "Task Render",
		description:
			"Render the whole task graph as an indented tree (dependencies first, dependents nested under " +
			"their deps) with status marks and ready markers — a quick visual overview of the plan structure and " +
			"current progress.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			const byId = loadAllItems(cwd);
			const itemsArr = [...byId.values()];
			const text = graph.renderGraph(itemsArr, { showReady: true });
			return {
				content: [{ type: "text" as const, text }],
				details: { graph: text, count: itemsArr.length },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_render")), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as Record<string, unknown>;
			const n = (d?.count as number) || 0;
			const text = theme.fg("accent", `🌳 ${n} item(s)`);
			if (!options.expanded) return new Text(text, 0, 0);
			// Expanded: the full graph tree, as the LLM saw it.
			return new Text(expandedContent(result, text), 0, 0);
		},
	});

	// =============================================================================
	// Hooks
	// =============================================================================

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd || process.cwd();

		const ourTools = [
			"task_create",
			"task_update",
			"task_set_status",
			"task_read",
			"task_list",
			"task_ready_set",
			"task_render",
		];
		const currentActive = pi.getActiveTools?.() || [];
		pi.setActiveTools([...new Set([...currentActive, ...ourTools])]);

		audit("ready", {});
	});
}
