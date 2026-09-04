/**
 * task-comms-ops — Comms-coordinated task graph operations for management roles.
 *
 * Encapsulates the multi-step coordination actions (dispatch delegation →
 * record the dispatch; mark done/cancelled → notify unlocked dependents; block
 * → notify waiters) into single high-level tools, so the role prompts stay
 * short and the LLM calls ONE tool per action instead of hand-wiring several
 * comms + task calls. Architecture principle: the LLM produces CONTENT
 * (delegation messages, classification decisions, contract arbitration), this
 * extension produces ACTIONS (dispatching, recording dispatches, notifying).
 *
 * Tools: task_dispatch, task_start, task_submit_report, task_complete,
 * task_block, task_cancel.
 *
 * Session naming: comms owns the session display name (the profile's
 * current_task drives it — "worker-3 [Implement auth]" via
 * lib/comms/session-name); this extension only pushes current_task through
 * the same updateProfile path as comms_update_profile — task_start sets the
 * task title, task_submit_report clears it; dispatch / complete / block /
 * cancel are management actions on other agents' tasks and never touch it.
 *
 * Dependencies: comms (identity + messaging), tasks (store + graph), loaded
 * via the launch script (extension list) or package.json pi.extensions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import type { Identity } from "./lib/comms/protocol";
import { COMMS_RUNTIME_EVENT } from "./lib/comms/runtime";
import type { CommsRuntime } from "./lib/comms/runtime";
import * as store from "./lib/tasks/store";
import type { TaskStatus } from "./lib/tasks/store";
import { availableIds, loadAllItems, notFoundError } from "./lib/tasks/shell";
import { dispatcheesOf, waitingDispatchees } from "./lib/task-comms-ops/core";

// Expanded (ctrl+O) rendering: show the full call args / result content —
// the same information the LLM sees in its context.
function fmtArgs(a: Record<string, unknown>): string {
	return Object.entries(a)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
		.join("\n");
}

// =============================================================================
// Comms runtime access
// =============================================================================

/**
 * The comms runtime published by extensions/comms.ts on session_start via
 * pi's SHARED event bus (pi.events — the sanctioned inter-extension
 * channel). The subscription below runs at factory time: all extension
 * factories execute BEFORE any session_start event, so the listener is
 * always live when comms.ts emits. The bus is what makes this work across
 * extension instances — pi loads each -e extension as its own module
 * graph, so module state (like this handle) is never shared, while
 * pi.events genuinely is. The channel name is a plain string constant
 * every instance compiles identically.
 */
let commsRuntimeHandle: CommsRuntime | null = null;

function commsRuntime(): CommsRuntime {
	if (!commsRuntimeHandle) {
		throw new Error("task-comms-ops: comms runtime not available — load extensions/comms.ts first");
	}
	return commsRuntimeHandle;
}

// =============================================================================
// Constants
// =============================================================================

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Subscribe at factory time (load time): all extension factories run
	// before any session_start event, so this listener is guaranteed to
	// receive comms' emit during session_start — no ordering race with
	// the tool calls that read the handle.
	pi.events.on(COMMS_RUNTIME_EVENT, (rt) => {
		commsRuntimeHandle = rt as CommsRuntime;
	});

	let cwd = process.cwd();

	function audit(event: string, extra: Record<string, unknown>): void {
		try {
			pi.appendEntry("task-comms-ops-log", { event, ts: new Date().toISOString(), ...extra });
		} catch {
			// best effort — auditing must never fail a tool call
		}
	}

	/** Comms identity accessor — task-comms-ops writes depend on comms being up.
	 *  The runtime handle is non-nullable (CommsRuntime.identity: Identity),
	 *  so commsRuntime()'s null check is the only guard needed. */
	function commsIdentity(): Identity {
		return commsRuntime().identity;
	}

	// ━━ Profile sync ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// The comms profile's current_task is the single source of truth for
	// "what am I doing" — peers see it, and comms drives the session display
	// name from it (`<agent> [<current_task>]`). Task tools never touch the
	// session name directly; they push the profile via the runtime handle
	// (the SAME implementation as the comms_update_profile tool).

	/** Push the "currently working on" profile field — task_start sets it,
	 *  task_submit_report clears it. dispatch / complete / block / cancel are
	 *  management actions on other agents' tasks and deliberately leave it
	 *  alone.
	 *  Best effort: a failed profile write must never fail the task tool call. */
	async function syncProfile(patch: { current_task?: string | undefined }): Promise<void> {
		try {
			await commsRuntime().updateProfile(patch);
		} catch {
			// best effort — profile sync must not break a tool call
		}
	}

	/** Peers whose next action just changed — see lib/task-comms-ops/core. */
	function dependentsWithDispatchee(itemId: string): string[] {
		return waitingDispatchees([...loadAllItems(cwd).values()], itemId);
	}

	/** One message send through comms — the single access point to messaging.send.
	 *  Errors propagate: a failed dispatch must fail the tool call (announce
	 *  catches per target for best-effort fan-out). */
	async function sendMessage(
		target: string,
		body: string,
		remindS: number,
		replyToMsgId?: string,
	): Promise<Awaited<ReturnType<CommsRuntime["messaging"]["send"]>>> {
		return commsRuntime().messaging.send(commsIdentity(), target, body, {
			remindS,
			...(replyToMsgId ? { replyToMsgId } : {}),
		});
	}

	/** Fire-and-forget [Task Update] announcement to the given peers. */
	async function announce(targets: string[], id: string, status: string, change: string): Promise<string[]> {
		const idt = commsIdentity();
		const sent: string[] = [];
		for (const target of targets) {
			try {
				await sendMessage(target, announcementBody(id, status, change, idt.name), 0);
				sent.push(target);
			} catch {
				// best effort — one dead peer must not fail the whole action
			}
		}
		return sent;
	}

	function announcementBody(id: string, status: string, change: string, by: string): string {
		return (
			`[Task Update] ${id} ${status} — updated by ${by}\n` +
			`Change: ${change}\n` +
			`Read: task_read(id="${id}")\n` +
			`No reply needed.`
		);
	}

	// =============================================================================
	// task_dispatch
	// =============================================================================

	pi.registerTool({
		name: "task_dispatch",
		label: "Dispatch Task",
		description:
			"Dispatch a task to an agent: sends your delegation message and records the dispatch in one step — " +
			"the task becomes dispatched (not yet started) with dispatched_to=<agent>. The worker flips the item " +
			"to active via task_start when it starts; task_submit_report replies to your delegation message when " +
			"it finishes (your reminder for the delegation stops).",
		parameters: Type.Object({
			task_id: Type.String({
				description: "Id of the task to dispatch (must be ready: pending with all deps satisfied).",
			}),
			agent: Type.String({
				description: "The agent to delegate to — the name from the Teammate Provider's reply to your comms_send.",
			}),
			message: Type.String({
				description: "Supplemental info to help the worker execute (a constant dispatch header is always placed first automatically). ONLY information not already in the task's description — e.g. peer names to collaborate with. The dispatch header instructs the worker to task_read the task itself, so the description, goals, background and acceptance criteria are already at its side; do NOT restate them here (two copies drift). Pass \"\" if there is nothing to add.",
			}),
			remind_s: Type.Number({
				description:
					"Reminder interval in seconds for the delegation message (minimum 1 — the dispatch always needs a reminder, it cannot be 0). " +
					"This is the ONLY reminder for the task: while the worker is dispatched/active and you wait for its task_start / task_submit_report, the reminder turn is your scheduled check-in to detect a missing/offline worker, re-dispatch, or escalate.",
				minimum: 1,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as { task_id: string; agent: string; message: string; remind_s: number };
			const idt = commsIdentity();
			const item = store.readTask(cwd, p.task_id);
			if (!item) throw notFoundError(cwd, p.task_id);
			// remind_s is mandatory and pageable at min 1 (cannot be 0) — the
			// schema enforces minimum:1, but guard a non-number / >0 anyway.
			if (!Number.isFinite(p.remind_s) || p.remind_s <= 0) {
				throw new Error("tasks: task_dispatch requires remind_s > 0 (the delegation always needs a reminder; use e.g. 300 = every 5 min)");
			}
			// A dispatch SENDS a message BEFORE marking dispatched — so an
			// invalid target must be rejected HERE, before any side effect.
			// info nodes are pure shared content: never dispatchable (the store
			// would refuse the status write, but only AFTER the message went
			// out — an orphaned delegation).
			if (item.kind === "info") {
				throw new Error(
					`tasks: cannot dispatch "${p.task_id}" — it is a shared information node (kind = "info"), pure content that is never dispatched; dispatch a real task (unit/module) instead`,
				);
			}

			// The dispatch header is a constant protocol prefix, independent of
			// what the LLM wrote, so it can never be lost or diluted (duplicating
			// an LLM-written pointer is harmless). It must be self-sufficient:
			// the receiver may get several dispatches over time, so the header
			// says WHAT to do (imperative: complete it), WHICH item (the id —
			// the ONE thing the receiver cannot discover on its own, since
			// dispatched_to is management-side state and the worker is told not
			// to read the whole graph), the RULE (each dispatch is its own
			// task — complete every one received), the START DECLARATION
			// (task_start moves the item from dispatched to active — the status
			// machine only advances when the worker declares its start), and —
			// at the END, so the receiver reads it last — the REPLY GUIDE
			// (answer via task_submit_report, which records the completion on
			// the node and automatically replies to this dispatch message —
			// inbound framing no longer injects a generic reply-with-comms_send
			// hint, so the delegation message itself must say how to answer it).
			const extra = p.message.trimEnd();
			const body =
				`Complete task ${p.task_id} — read it with tool call task_read(id="${p.task_id}", fields="description").\n` +
				`When you begin work, declare it: task_start(id="${p.task_id}") — it moves the item from dispatched to active.\n` +
				`Each dispatch is one task; complete every task you receive.` +
				(extra ? `\n\n${extra}` : "") +
				`\n\nWhen you finish (or when reality stops part of the work), do it in two steps: ` +
				`(1) task_checkout(id="${p.task_id}", scope="report") — this tool call creates an empty file where you should write the report; ` +
				`(2) write/edit the draft body, then reply with ` +
				`task_submit_report(id="${p.task_id}", expected_version=${item.version}) — it commits your report (anchored to description version ${item.version}), replies to this dispatch message, and stops the reminder. `;
			const sendResult = await sendMessage(p.agent, body, p.remind_s);
			// dispatched_to records the agent NAME — the comms identity, which is
			// exactly what the send just addressed (stable across restarts).
			const r = store.setTaskStatus(cwd, p.task_id, "dispatched", {
				// dispatched_by / dispatch_msg_id record who delegated the item
				// and the delegation message — task_start notifies the
				// dispatcher, task_submit_report replies to the message.
				dispatched_to: { name: p.agent, dispatched_by: idt.name, dispatch_msg_id: sendResult.msg_id },
				change_summary: `dispatched to ${p.agent}`,
				updated_by: idt.name,
				event: "dispatch",
			});
			audit("task_dispatch", {
				item_id: r.item.id,
				agent: p.agent,
				msg_id: sendResult.msg_id,
				target_status: sendResult.target_status,
			});
			const idNote = store.sanitizedIdNote(p.task_id);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`task_dispatch: "${r.item.id}" → ${p.agent} (msg ${sendResult.msg_id.slice(-8)}, target ${sendResult.target_status})\n` +
							`  status: dispatched, dispatched_to: ${p.agent}\n` +
							` reminders fire every ${p.remind_s} s.` +
							(idNote ? `\n${idNote}` : ""),
					},
				],
				details: {
					task_id: r.item.id,
					agent: p.agent,
					msg_id: sendResult.msg_id,
					target_status: sendResult.target_status,
					status: r.item.status,
					dispatched_to: { name: p.agent },
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("dispatch ")) +
				theme.fg("accent", `${(a.task_id as string) || "?"} → ${(a.agent as string) || "?"}`);
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args (including the delegation message), as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
	});

	// =============================================================================
	// task_start
	// =============================================================================

	pi.registerTool({
		name: "task_start",
		label: "Task Start",
		description:
			"The worker's start declaration: moves task status from dispatched to active. Call it when you begin " +
			"work — after task_read, before execution. Only the dispatched worker can start its item (the tool " +
			"verifies it is dispatched AND dispatched_to is your agent name); the dispatcher is notified " +
			"automatically that you have started, via an injected inbound turn that wakes it. The tool also " +
			"records YOUR execution session (session id + JSONL transcript) on the item, so the manager can " +
			"open it later and review how the work was done.\n\n" +
			"This tool automatically sets your comms profile current_task to the task title, so you do NOT need to " +
			"also call comms_update_profile to announce that you are working on this item — doing so would just " +
			"overwrite the same value with redundant or more transient wording. Reserve comms_update_profile for " +
			"availability declarations that matter to the Teammate Provider (free reusable agents); a dispatched " +
			"worker/coordinator is not reusable and should not call it to log transient states.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the item you were dispatched (must be status dispatched and dispatched to you).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { id: string };
			if (!p.id || !p.id.trim()) {
				throw new Error("tasks: task_start requires an id");
			}
			// Identity comes from the comms runtime (the --cname CLI flag) —
			// task-comms-ops requires comms anyway, so no "unknown" fallback.
			const me = commsIdentity().name;
			const target = store.readTask(cwd, p.id);
			if (!target) throw notFoundError(cwd, p.id);
			if (target.status !== "dispatched") {
				throw new Error(
					`tasks: cannot start "${p.id}" — its status is "${target.status}"; only dispatched items (yours, not yet started) can be started`,
				);
			}
			if (!target.dispatched_to || target.dispatched_to.name !== me) {
				throw new Error(
					`tasks: cannot start "${p.id}" — it is dispatched to ${target.dispatched_to ? target.dispatched_to.name : "(no one)"}, not to you (${me})`,
				);
			}
			// Record the worker's OWN execution session — the pi session that
			// actually executes this item (only the worker knows it): the
			// manager later opens the JSONL transcript to see how it was done.
			// Best effort: no session (e.g. unknown runtime) → empty strings,
			// still recorded; the item stays fully readable either way.
			const sm = (ctx as ExtensionContext)?.sessionManager;
			const sessionId = sm?.getSessionId() ?? "";
			const sessionFile = sm?.getSessionFile();
			const r = store.setTaskStatus(cwd, p.id, "active", {
				change_summary: `started by ${me}`,
				updated_by: me,
				event: "start",
				execution_session: {
					session_id: sessionId,
					session_file: sessionFile ? relative(cwd, sessionFile) : "",
				},
			});
			// Notify the dispatcher that work has begun — one line, no
			// announcement boilerplate; no reminder, best effort.
			const dispatcher = target.dispatched_to.dispatched_by;
			const lines = [`task_start: "${r.item.id}" → active (by ${r.item.updated_by})`];
			if (sessionId) {
				lines.push(
					`  session: ${sessionId}${sessionFile ? ` (${relative(cwd, sessionFile)})` : ""} — recorded on the node, open it to review this execution`,
				);
			}
			if (dispatcher) {
				try {
					await sendMessage(dispatcher, `${me} begin to work on task ${r.item.id} dispatched by you`, 0);
					lines.push(`  notified: ${dispatcher}`);
				} catch {
					// best effort — a failed notice must not fail the start declaration
				}
			}
			audit("task_start", {
				item_id: r.item.id,
				status: r.item.status,
				version: r.item.version,
				session_id: sessionId,
				notified: dispatcher,
			});
			await syncProfile({ current_task: r.item.title });
			const idNote = store.sanitizedIdNote(p.id);
			if (idNote) lines.push(idNote);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					id: r.item.id,
					status: r.item.status,
					version: r.item.version,
					unlocked: [],
					notified: dispatcher ? [dispatcher] : [],
					item: r.item,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("task_start ")) + theme.fg("accent", (a.id as string) || "?");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
	});

	// =============================================================================
	// task_submit_report
	// =============================================================================

	pi.registerTool({
		name: "task_submit_report",
		label: "Submit Report",
		description:
			"Two-step worker report flow. Step 1: run task_checkout(id, scope=\"report\") — it creates YOUR report draft as an EMPTY scaffold. Step 2: write/edit the draft body — report what you actually did: briefly confirm " +
        "when execution closely matched the plan; otherwise document every deviation in detail, including failed " +
        "assumptions, changes in approach, verification differences, and newly uncovered work — then call this tool. " +
        "It verifies that dispatched_to matches your agent name, commits the report anchored to the description version " +
        "you read (expected_version — the exact contract you worked against; a report against an older version is accepted but " +
        "flagged stale for the manager to judge), consumes the draft, and automatically replies to your dispatch message. " + +
        "This stops the dispatcher's reminder and wakes the dispatcher via an injected inbound turn. " +
        "This tool is the designated way to reply to a dispatch message.",
		parameters: Type.Object({
			id: Type.String({
				description: "Id of the task you were dispatched (must be dispatched to you).",
			}),
			expected_version: Type.Number({
				description:
					"REQUIRED: the description version you read (task_read's version; the dispatch header carries it). A report at a " +
					"version AHEAD of the current one is rejected (never readable). A version BEHIND the current one is accepted and anchored " +
					"there — the report is flagged stale so the manager decides whether executing the older contract still satisfies the new " +
					"description. The report is always anchored to this version.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const p = params as { id: string; expected_version: number };
			if (!p.id || !p.id.trim()) {
				throw new Error("tasks: task_submit_report requires an id");
			}
			// Identity comes from the comms runtime (the --cname CLI flag) —
			// task-comms-ops requires comms anyway, so no "unknown" fallback.
			const me = commsIdentity().name;
			const target = store.readTask(cwd, p.id);
			if (!target) throw notFoundError(cwd, p.id);
			if (!target.dispatched_to || target.dispatched_to.name !== me) {
				throw new Error(
					`tasks: cannot write the completion report for "${p.id}" — it is dispatched to ${target.dispatched_to ? target.dispatched_to.name : "(no one)"}, not to you (${me}); only the dispatched agent records the completion report`,
				);
			}
			const item = store.setCompletionReport(cwd, p.id, me, {
				expected_version: p.expected_version,
				cname: me,
			});
			// Reply to the dispatch message recorded on the dispatch — the
			// dispatcher's reminder for the delegation stops and the notice
			// lands as its reply. Best effort: a failed reply must not fail the
			// record write (the worker can still notify via comms_send).
			const { dispatched_by, dispatch_msg_id } = target.dispatched_to;
			const stale = item.report_for_version < item.version;
			const lines = [
				`task_submit_report: "${item.id}" — completion report committed (for description v${item.report_for_version}, by ${item.updated_by}; version unchanged)`,
			];
			if (stale) {
				lines.push(
					`  ⚠ stale: the report is anchored to description v${item.report_for_version}, but the task is now v${item.version} — the manager must decide whether this old-contract work still satisfies the new description`,
				);
			}
			let repliedTo = "";
			if (dispatch_msg_id && dispatched_by) {
				try {
					await sendMessage(dispatched_by, `${me} finished task ${item.id}`, 0, dispatch_msg_id);
					repliedTo = dispatched_by;
					lines.push(`  replied to dispatch ${dispatch_msg_id.slice(-8)} (${dispatched_by})`);
				} catch {
					lines.push(`  reply failed (${dispatched_by}) — notify your manager via comms_send instead`);
				}
			}
			audit("task_submit_report", {
				item_id: item.id,
				version: item.version,
				for_version: item.report_for_version,
				stale,
				replied_to: repliedTo,
			});
			await syncProfile({ current_task: undefined });
			const idNote = store.sanitizedIdNote(p.id);
			if (idNote) lines.push(idNote);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					id: item.id,
					version: item.version,
					for_version: item.report_for_version,
					stale,
					updated_at: item.updated_at,
					updated_by: item.updated_by,
					replied_to: repliedTo || null,
					item,
				},
			};
		},
		renderCall(args, theme, context) {
			const a = args as Record<string, unknown>;
			const text =
				theme.fg("toolTitle", theme.bold("report ")) + theme.fg("accent", (a.id as string) || "?");
			if (!context.expanded) return new Text(text, 0, 0);
			// Expanded: the full call args, as the LLM saw them.
			return new Text(text + "\n" + fmtArgs(a), 0, 0);
		},
	});

	// =============================================================================
	// task_complete / task_block / task_cancel
	// =============================================================================

	function statusChangeTool(
		name: string,
		label: string,
		status: TaskStatus,
		description: string,
		summaryParam: string,
		changeSummary: (p: { change_summary?: string }) => string,
	) {
		return {
			name,
			label,
			description,
			parameters: Type.Object({
				id: Type.String({ description: "Id of the task to change." }),
				change_summary: Type.Optional(
					Type.String({ description: summaryParam }),
				),
			}),
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const p = params as { id: string; change_summary?: string };
				const idt = commsIdentity();
				const item = store.readTask(cwd, p.id);
				if (!item) throw notFoundError(cwd, p.id);

				const summary = changeSummary(p);
			const r = store.setTaskStatus(cwd, p.id, status, {
					change_summary: summary,
					updated_by: idt.name,
					event: name.replace("task_", ""),
				});
				audit(name, {
					item_id: r.item.id,
					status: r.item.status,
					unlocked: r.unlocked,
					change_summary: summary,
				});

				const lines = [
					`${name}: "${r.item.id}" → ${r.item.status} (by ${r.item.updated_by})`,
				];
				// Notify the peers whose next action just changed:
				// - blocked: dependents with a dispatchee (their dep stopped progressing)
				// - done/cancelled: dispatchees of the newly unlocked items themselves
				//   (their deps just got satisfied — they can start)
				const waiters = status === "blocked"
					? dependentsWithDispatchee(r.item.id)
					: dispatcheesOf([...loadAllItems(cwd).values()], r.unlocked);
				if (waiters.length > 0) {
					const sent = await announce(waiters, r.item.id, r.item.status, summary);
					lines.push(`  notified: ${sent.join(", ")}`);
				}
				if (r.unlocked.length > 0) {
					lines.push(`  unlocked: ${r.unlocked.join(", ")} — deps now satisfied (dispatch the newly ready ones)`);
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						id: r.item.id,
						status: r.item.status,
						version: r.item.version,
						unlocked: r.unlocked,
						notified: waiters,
						item: r.item,
					},
				};
			},
			renderCall(args: Record<string, unknown>, theme: any, context: any) {
				const text =
					theme.fg("toolTitle", theme.bold(`${name.replace("task_", "")} `)) +
					theme.fg("accent", (args.id as string) || "?");
				if (!context.expanded) return new Text(text, 0, 0);
				// Expanded: the full call args (change_summary), as the LLM saw them.
				return new Text(text + "\n" + fmtArgs(args), 0, 0);
			},
		};
	}

	pi.registerTool(statusChangeTool(
		"task_complete",
		"Complete Task",
		"done",
		"Mark a task done. Rejected while any dep is unsatisfied (the error lists the missing deps) — complete " +
		"bottom-up, children first. Returns the newly unlocked dependents (dispatch each as its agent name arrives) and " +
		"automatically notifies their dispatched agents. " +
		"Before completing, read the completion report's anchor (task_read fields=\"report\" shows report_for_version). " +
		"If report_for_version is BEHIND the current version, a NEW plan replaced the one the worker executed — judge which case applies: " +
		"(1) the report shows the CURRENT plan's assumptions can't be met — DO NOT complete; mark it blocked (task_block) and hand it " +
		"to a planner to replan; " +
		"(2) the old description / report don't materially conflict with the current plan — re-dispatch to the original or another " +
		"worker to redo against the current plan.",
		"Why this task is complete — goes into the item's change history.",
		(p) => p.change_summary?.trim() || `completed`,
	));

	pi.registerTool(statusChangeTool(
		"task_block",
		"Block Task",
		"blocked",
		"Mark a task blocked — reality is blocking progress (failed assumption, unavailable resource, blocked dep). " +
		"The item leaves the ready set, its dependents stay locked, and dependents with a dispatchee are notified. " +
		"Also use this when a stale completion report shows the CURRENT plan's assumptions can't be met — instead of " +
		"task_complete, mark it blocked and hand it to a planner to replan. " +
		"To unblock after a replan: fix the graph (metadata draft + task_commit) and set the item back to pending/active.",
		"Why the task is blocked — the failed assumption / blocker, in one line.",
		(p) => p.change_summary?.trim() || `blocked`,
	));

	pi.registerTool(statusChangeTool(
		"task_cancel",
		"Cancel Task",
		"cancelled",
		"Cancel a task — abandoned, out of scope. Cancelled counts as satisfied for dependents (they unlock), so " +
		"removing a node from scope is done by cancelling, not deleting. Notifies the unlocked items' dispatched " +
		"agents. To undo a mistaken cancel, set it back to pending.",
		"Why this task is cancelled — out of scope / superseded, in one line.",
		(p) => p.change_summary?.trim() || `cancelled`,
	));

	// =============================================================================
	// session_start: activate tools
	// =============================================================================

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd || process.cwd();

		const ourTools = [
			"task_dispatch",
			"task_start",
			"task_submit_report",
			"task_complete",
			"task_block",
			"task_cancel",
		];
		const currentActive = pi.getActiveTools?.() || [];
		pi.setActiveTools([...new Set([...currentActive, ...ourTools])]);
	});
}
