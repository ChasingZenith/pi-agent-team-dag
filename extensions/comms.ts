/**
 * comms — Pi Agent communication network on NATS + JetStream.
 *
 *   stream  COMMS_<subnet>    durable per-agent prompt consumer
 *   bucket  comms_profiles       permanent agent profiles (a.<subnet>.<name>; offline stays visible)
 *   bucket  comms_names       name lease (n.<subnet>.<name>, TTL lease — releases on crash)
 *   bucket  comms_history     message content history (h.<subnet>.<name>.<out|in>.<msg_id>, TTL default 24h)
 *
 * Identity: the agent NAME is the comms identity and the address for every
 * durable construct (message subjects, prompt consumer, history keys). It is
 * stable across restarts — a restarted agent under the same name resumes its
 * consumer queue (crash redelivery), its history (outbox/inbox re-read) and
 * its task assignments. There is deliberately no per-process session id.
 *
 * Messaging model:
 *   - send: comms_send(target|targets, message, [remind_s], [reply_to_msg_id], [deliver_as]) — a
 *     REPLY is a send carrying reply_to_msg_id=<the msg_id you received>; the
 *     sender resolves it and stops the reminder.
 *   - delivery: replies arrive automatically as an inbound turn; there is no
 *     blocking await and no auto-reply. deliver_as (steer / follow-up /
 *     next turn) selects how a send is injected at the target — mapped 1:1
 *     to pi.sendMessage's deliverAs; a batch of messages is split by
 *     deliver_as and each group injected with its own mode (no promotion).
 *     "next turn" bypasses the batch: it is routed straight to pi's
 *     next-turn queue (injected at the target's next turn; it never
 *     triggers a turn).
 *   - remind: a reminder is per-message. comms_send(remind_s)
 *     arms it inline; comms_remind(msg_id, remind_s) sets, adjusts or (0)
 *     cancels it afterwards, for any msg_id. While reminders are active, ONE
 *     consolidated reminder turn is injected per interval covering all items
 *     (with direction, peer status + TTL countdown); out items expire at the
 *     stream TTL. Default 0 = no reminder. Reminders are scheduling state
 *     only — cancelling one changes nothing about the message itself.
 *   - history: every outbound and inbound message content is persisted to the
 *     comms_history KV bucket (TTL default 24h) — comms_outbox / comms_inbox
 *     re-read content after a compact or restart, when the in-memory reminder
 *     table and the context are both gone.
 *
 * Consumer surface (agent-lifecycle, teammate-provider):
 *
 *   tools         comms_list_peer / comms_send / comms_outbox / comms_inbox / comms_remind / comms_update_profile
 *   audit channel "comms-log"
 *   customType    "comms-inbound" / "comms-reminder"
 *   status key    "comms"
 *   flags         --cname --nats-url --subnet
 *
 * NATS URL flag: --nats-url (default nats://127.0.0.1:4222).
 * NATS token auth comes from PI_COMMS_AUTH_TOKEN (env) or
 * ~/.pi/comms/server.secret.json (mode 0600) written by scripts/comms-nats/up.sh.
 *
 * Usage:
 *   just comms-server                                             # start NATS server
 *   pi -e extensions/comms.ts                                  # auto-connect local
 *   pi -e extensions/comms.ts --nats-url nats://host:4222 --cname planner
 *
 * Note: the agent name flag is `--cname` (not `--name`). pi's own harness owns
 * `--name` and resumes it across sessions.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { DeliverAsValue, Identity } from "./lib/comms/protocol.ts";
import { nowIso, ulid, sanitizeAgentName } from "./lib/comms/protocol.ts";
import { readConfig, readFrontmatterFromArgv } from "./lib/comms/config.ts";
import { connectNats, ensureStream, closeNats } from "./lib/comms/nats.ts";
import * as registry from "./lib/comms/registry.ts";
import * as messaging from "./lib/comms/messaging.ts";
import type { ActiveReminder } from "./lib/comms/messaging.ts";
import { setAudit, audit } from "./lib/comms/audit.ts";
import * as batch from "./lib/comms/batch.ts";
import * as history from "./lib/comms/history.ts";
import { COMMS_RUNTIME_EVENT } from "./lib/comms/runtime";
import { displayName, shouldOwnName } from "./lib/comms/session-name";
import { abbreviateModel, statusDot } from "./lib/comms/ui/display.ts";

// ━━ Identity flags ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Module-level comms identity — set by session_start; the closure reassigns
 * it (registry.register's in-place name-collision suffix). Shared with sibling
 * extensions via pi's event bus (COMMS_RUNTIME_EVENT) — consumers hold the
 * object reference, so the reassignment is visible to them too (each -e
 * extension is its own module graph; pi.events is the only cross-instance
 * channel).
 */
let identity: Identity | null = null;

export default function (pi: ExtensionAPI) {
	// Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
	pi.registerFlag("cname", {
		description: "Override comms agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("nats-url", {
		description: "NATS server URL (overrides env PI_COMMS_NATS_URL; default nats://127.0.0.1:4222)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("subnet", {
		description: "Comms communication domain (subnet) to join. Agents in different subnets are isolated (separate streams/subjects/KV keys). Default: subnet0",
		type: "string",
		default: undefined,
	});

	// ━━ Module state ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// (identity itself lives at module scope — it reaches sibling extensions
	// through the pi.events bus (COMMS_RUNTIME_EVENT, see the session_start
	// publish below); the closure references it directly.)

	let currentCtx: ExtensionContext | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let uiRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let shuttingDown = false;
	let bootFailed = false;

	// UI re-render interval: well below the default stale/offline thresholds
	// (30 s / 60 s) so derived peer statuses surface within ~75 s of a peer
	// going away, and below any heartbeat-driven event gap.
	const UI_REFRESH_MS = 15_000;

	function fmtMs(ms: number): string {
		const minutes = Math.round(ms / 60_000);
		return minutes >= 1 ? `${minutes} min` : `${Math.max(1, Math.round(ms / 1_000))} s`;
	}

	/**
	 * Every other agent on the subnet (self excluded), compactly as
	 * "● name" / "~ name" / "✗ name" (status dot + name — no model/pct/task,
	 * details stay in comms_list_peer).
	 */
	function peerList(): string[] {
		if (!identity) return [];
		return registry
			.getPeers()
			.filter((p) => p.name !== identity!.name)
			.map((p) => `${statusDot(p.status)} ${p.name}`);
	}

	/**
	 * Footer status line: 📡 self@subnet plus a compact peer count. Kept short
	 * on purpose — the footer row truncates long text, so the full list lives
	 * in the belowEditor widget (renderPeersWidget) which word-wraps.
	 */
	function renderStatus(): string {
		if (!identity) return "";
		const base = `It's ${identity.name} @${identity.subnet}`;
		const n = peerList().length;
		return n > 0 ? `${base} · ${n} peer${n > 1 ? "s" : ""}` : base;
	}

	/**
	 * belowEditor widget: the full peer list as ONE line — the TUI word-wraps
	 * it to the terminal width, so every peer stays visible even in a narrow
	 * window. Empty array = no widget. No table/columns: compact by design.
	 */
	function renderPeersWidget(): string[] {
		const peers = peerList();
		return peers.length > 0 ? [`Peers: ${peers.join(", ")}`] : [];
	}

	/**
	 * Re-render the footer status + belowEditor peers widget. Called on watch
	 * events and on a fixed interval — peer status is derived from
	 * last_seen_at, so a crashed peer (no DEL event) or a NATS outage (no
	 * events at all) only surfaces on a timer-driven re-render.
	 */
	function refreshPeersUi(): void {
		if (!identity || shuttingDown) return;
		try {
			const ui = currentCtx?.ui;
			if (!ui) return;
			ui.setStatus("comms", renderStatus());
			const lines = renderPeersWidget();
			if (lines.length > 0) {
				ui.setWidget("comms-peers", lines, { placement: "belowEditor" });
			} else {
				ui.setWidget("comms-peers", undefined);
			}
		} catch {
			// hasUI may be false in some contexts.
		}
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		setAudit((event, extra) => {
			pi.appendEntry("comms-log", { event, ts: nowIso(), ...extra });
		});

		// Runtime config + identity (CLI > frontmatter > defaults).
		const cfg = readConfig(pi);
		const fm = readFrontmatterFromArgv(process.argv);

		// The name is the identity — the stable address for everything durable.
		// The auto-generated default name uses a random tag (not an id that
		// anything else depends on), so two anonymous agents never collide.
		const defaultName = `agent-${ulid().slice(-6)}`;
		const desiredName = sanitizeAgentName(
			(pi.getFlag("cname") as string | undefined) || fm.name || defaultName,
		);

		identity = {
			name: desiredName,
			subnet: cfg.subnet,
			cwd: ctx.cwd || process.cwd(),
			model: ctx.model?.id ?? "unknown",
			started_at: nowIso(),
			current_task: undefined,
		};

		// Publish the comms runtime (identity + messaging + updateProfile) on
		// pi's shared event bus for sibling extensions in OTHER module
		// instances (pi isolates each -e extension's module graph). Fires
		// before the NATS connect, so a failed boot still publishes the handle
		// — consumers see the identity while messaging.send throws
		// "comms: not connected".
		pi.events.emit(COMMS_RUNTIME_EVENT, { identity, messaging, updateProfile });

		// Connect to NATS.
		try {
			await connectNats(cfg);
		} catch (err: any) {
			bootFailed = true;
			ctx.ui?.notify?.(
				`📡 comms: ${err?.message ?? String(err)}. Start the server with: just comms-server`,
				"error",
			);
			audit("boot_failed", { reason: "connect_failed", error: err?.message ?? String(err) });
			return;
		}

		// Ensure the subnet stream exists (idempotent).
		try {
			await ensureStream(cfg.messageTtlMs, identity.subnet);
		} catch (err: any) {
			bootFailed = true;
			ctx.ui?.notify?.(`📡 comms: ${err?.message ?? String(err)}`, "error");
			audit("boot_failed", { reason: "ensure_stream_failed", error: err?.message ?? String(err) });
			return;
		}

		// Registry tuning.
		registry.setRegistryTuning(cfg.staleAfterMs, cfg.offlineAfterMs);

		// Register (name claim + initial profile).
		try {
			identity = await registry.register(identity, {
				context_used_pct: 0,
				model: ctx.model?.id ?? identity.model,
			});
		} catch (err: any) {
			bootFailed = true;
			ctx.ui?.notify?.(`📡 comms: register failed — ${err?.message ?? String(err)}`, "error");
			audit("boot_failed", { reason: "register_failed", error: err?.message ?? String(err) });
			return;
		}

		// Session display name: the profile drives it — boot claims the bare
		// identity name (current_task unset); every updateProfile push applies
		// the display again (applySessionName). After register, so a collision
		// suffix is included. A manual --name / /name always wins
		// (shouldOwnName).
		applySessionName(identity.current_task);

		// Batch injector (pi.sendMessage wrapper) + consolidated reminder
		//    injector + messaging config + consumers. The deliverAs comes from
		//    batch.ts: it splits the batch by deliver_as and injects each
		//    group with its OWN mode ("steer" then "followUp" — no promotion);
		//    "next turn" messages are routed by batch.enqueue straight to
		//    pi's "nextTurn" (see batch.ts injectNextTurn).
		batch.setBatchInjector((inboundBatch, message, deliverAs) => {
			if (!pi.sendMessage) throw new Error("no session to inject into");
			pi.sendMessage(
				{
					customType: "comms-inbound",
					content: message,
					display: true,
					details: {
						msg_ids: inboundBatch.map((i) => i.msg_id),
						sender_names: inboundBatch.map((i) => i.sender_name),
					},
				},
				{ deliverAs, triggerTurn: true },
			);
		});
		messaging.setRemindInjector((pending: ActiveReminder[]) => {
			if (!pi.sendMessage) return; // is it really needed?
			const lines = pending.map((x) =>
				`  ${x.dir === "in" ? "from" : "to"} ${x.target} (${x.target_status}) — ${x.summary}` +
				`\n    msg_id ${x.msg_id} · remind every ${fmtMs(x.remind_s * 1000)} · ${fmtMs(x.elapsed_ms)} elapsed` +
				(x.expires_in_ms !== null
					? x.expires_in_ms > 0
						? ` · expires in ${fmtMs(x.expires_in_ms)}`
						: " · expired — resend or cancel"
					: ""));
			pi.sendMessage(
				{
					customType: "comms-reminder",
					content:
						`[comms reminder] ${pending.length} active reminder(s):\n` +
						lines.join("\n"),
					display: true,
					details: { reminders: pending },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		});
		messaging.setMessageTtlMs(cfg.messageTtlMs);
		history.setHistoryMessageTtlMs(cfg.messageTtlMs); // same TTL drives outbox expired status
		await messaging.startConsumers(identity, (inbound) => batch.enqueue(inbound));

		// Watch the registry (peer cache), re-rendering the footer status and
		// the belowEditor peers widget whenever the peer set changes
		// (peers join / leave / go stale). The widget word-wraps at the
		// terminal width, so all peers stay visible even in a narrow window.
		// The watch loop self-heals after NATS outages (registry.startWatch).
		registry.startWatch(identity.subnet);
		registry.setCacheChangeListener(refreshPeersUi);

		// Status + peers widget (initial render).
		refreshPeersUi();

		// Heartbeat loop (TTL lease refresh).
		heartbeatTimer = setInterval(() => {
			if (!identity || shuttingDown) return;
			const ctxNow = currentCtx;
			const pct = Math.round(ctxNow?.getContextUsage()?.percent ?? 0);
			registry.heartbeat(identity, {
				context_used_pct: pct,
				model: ctxNow?.model?.id ?? identity.model,
			}).catch((err) => {
				audit("heartbeat_failed", { reason: err?.message ?? String(err) });
			});
		}, cfg.heartbeatMs);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }

		// Time-driven UI refresh — a crashed peer emits no DEL and a NATS
		// outage emits nothing at all, so re-render on a timer to surface
		// derived statuses (online → stale → offline) within ~offlineAfterMs +
		// this interval. unref'd: pure UI, must not hold the process open.
		uiRefreshTimer = setInterval(refreshPeersUi, UI_REFRESH_MS);
		try { (uiRefreshTimer as any).unref?.(); } catch { /* ignore */ }

		audit("boot", {
			name: identity.name,
			subnet: identity.subnet,
			started_at: identity.started_at,
			nats_url: cfg.natsUrl,
		});
	});

	// ━━ Session display name ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// The session name follows the comms profile: `<agent> [<current_task>]`
	// (bare name when nothing declared). Boot claims it and every updateProfile
	// push (the implementation behind comms_update_profile) reapplies it. A
	// manual --name / /name takes precedence permanently (shouldOwnName).

	let sessionNameOwner: string | null = null;

	/** Apply the profile-driven display name when the auto-name still owns it.
	 *  Never throws: naming is cosmetic, so a failure must not fail a boot or
	 *  a tool call. */
	function applySessionName(currentTask: string | undefined): void {
		try {
			const current = pi.getSessionName();
			if (!shouldOwnName(current, sessionNameOwner, identity!.name)) {
				// A manual name took over (--name / /name) — stand down.
				sessionNameOwner = null;
				return;
			}
			const desired = displayName(identity!.name, currentTask);
			if (desired !== current) {
				pi.setSessionName(desired);
				sessionNameOwner = desired;
			}
		} catch {
			// best effort — naming must never break a boot or a tool call
		}
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	/**
	 * The one profile-update implementation — used by the comms_update_profile
	 * tool AND published on the runtime handle for sibling extensions
	 * (task-comms-ops auto-tracks current_task). Immediate KV put (not the
	 * next heartbeat tick) carrying the caller's live metrics — pushing
	 * context_used_pct 0 would show peers a bogus "idle". The session display
	 * name follows the profile (applySessionName).
	 */
	const updateProfile = async (patch: { current_task?: string | undefined }) => {
		const stored = await registry.updateOwnProfile(identity!, patch, {
			context_used_pct: Math.round(currentCtx?.getContextUsage()?.percent ?? 0),
			model: currentCtx?.model?.id ?? identity!.model,
		});
		applySessionName(stored.current_task);
		return stored;
	};

	pi.registerTool({
		name: "comms_list_peer",
		label: "Comms List Peers",
		description:
			"List peer agents on the comms hub for YOUR subnet: each peer's name, status, model, " +
			"live context-window usage, and current task. Your own entry is marked with a \"(you)\" suffix. " +
			"Status symbols: ● online · ~ stale (no heartbeat for 30-60 s) · ✗ offline (no heartbeat for 60+ s).",
		parameters: Type.Object({}),
		async execute(_callId, _params) {
			if (!identity) throw new Error("comms not initialised");
			const selfIdentity = identity; // narrowed const: usable inside the .map() closure below
			const peers = registry.getPeers();

			const lines = peers.length === 0
				? "No peer agents found."
				: peers.map((a) => {
					const live = statusDot(a.status);
					const isSelf = a.name === selfIdentity.name;
					const selfTag = isSelf ? " (you)" : "";
					const ctxStr = typeof a.context_used_pct === "number" ? ` ${a.context_used_pct}%` : " ?%";
					const task = a.current_task || "";
					return `${live} ${a.name}${selfTag} (${abbreviateModel(a.model)})${ctxStr}${task ? ` — ${task}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${peers.length} peer(s):\n${lines}` }],
				details: { agents: peers, subnet: selfIdentity.subnet, self: { name: selfIdentity.name } },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("comms_list_peer")), 0, 0);
		},
	});

	pi.registerTool({
		name: "comms_send",
		label: "Comms Send",
		description:
			"Send a message to one or more peers on the comms hub.\n\n" +
			"Calling this function sends the message to the specified peer(s). Each receiver automatically receives the message as an inbound turn or injection — the receiver does NOT need to poll or check an inbox. The exact time and way the message is injected depends on `deliver_as`.\n\n" +
			"This tool call returns immediately after sending the message and does NOT wait for the receiver to receive, read, process, or reply to it. The result includes a `msg_id` for each recipient. Because the sender does not wait for the receiver's response, you can optionally use `remind_s` to remind yourself if a reply has not arrived.\n\n" +
			"REMINDERS AND REPLIES (`remind_s`, seconds; defaults to 0)\n" +
			"`remind_s = 0` (the default): no reminder; `remind_s > 0`: arm a reminder for this send — while it is active, a reminder turn is periodically injected to you. Same reminder semantics as comms_remind.\n\n" +
			"You may also use this function to reply to a message received from another peer. Set `reply_to_msg_id` to the `msg_id` of the inbound message you are answering. This explicitly identifies which message your response is replying to. When the original sender receives the reply, their reminder for that message is automatically stopped, so they no longer receive reminders for it.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Peer name (CASE-SENSITIVE, scoped to your subnet; unique per subnet). Set either target or targets." })),
			targets: Type.Optional(Type.Array(Type.String(), { description: "Group send: multiple peer names (CASE-SENSITIVE). Set either target or targets; one msg_id is returned per recipient." })),
			message: Type.String({ description: "The message to send (or your reply content when reply_to_msg_id is set)." }),
			remind_s: Type.Optional(Type.Number({
				minimum: 0,
				maximum: 3600,
				description: "Reminder interval in seconds, default 0. 0: no reminder (one-way send) — still recorded in comms_history; no reminder, auto-exit not blocked; arm one later with comms_remind. 1–3600: arm the reminder.",
			})),
			reply_to_msg_id: Type.Optional(Type.String({
				description: "Reply mode: the msg_id of the message you are answering (an inbound msg_id you received). Marks this send as a reply; the sender stops its reminder and records your message as the reply.",
			})),
			deliver_as: Type.Optional(Type.Union([
				Type.Literal("steer", { description: "The message will be injected at the target's next LLM-call boundary (after its current turn's tool calls, before the next response — does not interrupt mid-stream); triggers a turn when idle." }),
				Type.Literal("follow-up", { description: "The message will be injected after the target's current turn fully ends (immediate when idle)." }),
				Type.Literal("next turn", { description: "The message will be injected at the start of the target's NEXT turn (pi's nextTurn): enters the target's next-turn queue and is injected when the next turn starts — waits while the target is busy; never triggers a turn itself (an idle target sees it on its next user input or other injection)." }),
			], { description: "Delivery mode at the target (default \"steer\")." })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("comms not initialised");
			const p = params as any;
			const targets = Array.isArray(p.targets) && p.targets.length > 0
				? p.targets.map((s: unknown) => String(s).trim()).filter(Boolean)
				: typeof p.target === "string" && p.target.length > 0
					? [p.target]
					: [];
			if (targets.length === 0) throw new Error("comms_send: provide either target or targets");

			const replyToMsgId = typeof p.reply_to_msg_id === "string" && p.reply_to_msg_id.length > 0 ? p.reply_to_msg_id : undefined;
			// Default 0 = no reminder; only remind_s > 0 arms one. (A later
			// comms_remind can still arm a reminder on the sent message.)
			const remindS = typeof p.remind_s === "number" ? p.remind_s : 0;
			// Delivery mode at the target (schema-enforced union; omitted → target default "steer").
			const deliverAs = typeof p.deliver_as === "string" ? p.deliver_as as DeliverAsValue : undefined;

			const results: Array<{ target: string; msg_id: string; target_status: string }> = [];
			const errors: Array<{ target: string; error: string }> = [];
			for (const t of targets) {
				try {
					const res = await messaging.send(identity, t, p.message, { replyToMsgId, remindS, deliverAs });
					results.push({ target: t, msg_id: res.msg_id, target_status: res.target_status });
				} catch (err: any) {
					errors.push({ target: t, error: err?.message ?? String(err) });
				}
			}
			if (results.length === 0) throw new Error(errors[0]?.error ?? "send failed");

			const notes: string[] = [];
			if (p.reply_to_msg_id) notes.push(`reply to ${p.reply_to_msg_id}`);
			if (p.remind_s) notes.push(`remind every ${p.remind_s} s`);
			if (p.deliver_as) notes.push(`deliver as ${p.deliver_as}`);
			const lines = results.map((r) => `comms_send to ${r.target} (${r.target_status})\nmsg_id ${r.msg_id}`);
			const errLines = errors.map((e) => `comms_send to ${e.target}: FAILED — ${e.error}`);
			const text = [...lines, ...errLines].join("\n") + (notes.length ? "\n" + notes.join(" · ") : "");

			return {
				content: [{ type: "text" as const, text }],
				details: { results, errors, reply_to_msg_id: p.reply_to_msg_id ?? null, remind_s: p.remind_s ?? null, deliver_as: p.deliver_as ?? null },
			};
		},
		renderCall(args, theme, context) {
			const a = args as any;
			const targets = Array.isArray(a.targets) && a.targets.length ? a.targets : a.target ? [a.target] : [];
			const tgt = targets && targets.length > 0 ? targets.join(", ") : "?";
			const msg = a.message ?? "";
			const preview = msg && msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
			const text =
				theme.fg("toolTitle", theme.bold("comms_send ")) +
				theme.fg("accent", `to ${tgt}`) +
				(preview ? ` — ${theme.fg("dim", preview)}` : "");
			if (!context.expanded) {
				return new Text(text, 0, 0);
			}
			// Expanded: full message and every option.
			const opts: string[] = [];
			if (typeof a.remind_s === "number") opts.push(`remind_s ${a.remind_s}`);
			if (a.reply_to_msg_id) opts.push(`reply_to_msg_id ${a.reply_to_msg_id}`);
			if (a.deliver_as) opts.push(`deliver_as ${a.deliver_as}`);
			const full = text + (msg ? `\nmessage: ${msg}` : "") + (opts.length ? "\n" + opts.join(" · ") : "");
			return new Text(full, 0, 0);
		},
	});

	pi.registerTool({
		name: "comms_outbox",
		label: "Comms Outbox",
		description:
			"Re-read the messages YOU sent (comms_send), with status and any reply — from the persistent " +
			"message history (comms_history KV bucket, default TTL 24h), so it works even after a compact or restart.\n\n" +
			"With no msg_id: list your recent sends, newest first (status + content summary; limit defaults to 10).\n" +
			"With msg_id: full detail — sent content, state (waiting / ended: replied / expired), the live remind " +
			"marker if a reminder is active, and the reply content when replied. A reply also lands in comms_inbox.\n\n" +
			"Reminder state is per-process memory; after a restart the status is derived from the " +
			"persisted history instead.",
		parameters: Type.Object({
			msg_id: Type.Optional(Type.String({ description: "msg_id returned by comms_send. Omit to list your recent sends (newest first)." })),
			limit: Type.Optional(Type.Number({
				minimum: 1,
				maximum: 100,
				description: "Max entries in the list mode (default 10).",
			})),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("comms not initialised");
			const p = params as any;
			const self = identity;
			const msgId = typeof p.msg_id === "string" && p.msg_id.length > 0 ? p.msg_id : undefined;
			const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 100) : 10;

			// List mode: recent sends (newest first). Status derives from the
			// persisted record (survives restarts); the live reminder table only
			// overlays the remind marker on top.
			if (!msgId) {
				const records = await history.listOutbound(self.subnet, self.name, limit);
				const live = new Map<string, ActiveReminder>();
				for (const x of messaging.listActiveReminders()) live.set(x.msg_id, x);

				const lines: string[] = [];
				for (const rec of records) {
					const rm = live.get(rec.msg_id);
					const s = history.deriveOutStatus(rec);
					const status = (s.reason ? `ended/${s.reason}` : s.state) +
						(rm ? ` · remind ${fmtMs(rm.remind_s * 1000)}` : "");
					lines.push(`  ${rec.msg_id} to ${rec.target} — ${status} — "${history.flatten(rec.message)}"`);
				}
				// Active reminders with no history record yet (sent before this
				// session's first successful write) — show with a placeholder.
				for (const [id, li] of live) {
					if (records.some((r) => r.msg_id === id)) continue;
					lines.push(`  ${id} to ${li.target} — ${li.summary} — "(content not recorded)"`);
				}
				const text = lines.length > 0
					? `comms_outbox: ${lines.length} send(s)\n${lines.join("\n")}`
					: "comms_outbox: no sends recorded";
				return { content: [{ type: "text" as const, text }] };
			}

			// Detail mode: status derives from the persisted record (survives
			// restarts); the live reminder table only overlays the remind marker.
			const rec = await history.getOutbound(self.subnet, self.name, msgId);
			if (!rec) {
				return {
					content: [{ type: "text" as const, text: "comms_outbox: unknown msg_id — no history record (never sent, or evicted from the history bucket)" }],
				};
			}
			const s = history.deriveOutStatus(rec);
			const remindS = messaging.getActiveRemindS(msgId) ?? 0;
			const statusLabel = s.reason ? `${s.state}/${s.reason}` : s.state;
			let text = `comms_outbox: ${msgId} to ${rec.target} — ${statusLabel}`;
			text += `\nsent at ${new Date(rec.ts).toISOString()}`;
			if (s.state === "waiting") {
				text += `\nno reply yet${remindS > 0 ? ` · remind ${fmtMs(remindS * 1000)}` : ""}`;
			} else if (s.reason === "expired") {
				text += "\nthe message TTL passed with no reply — the target likely never received it. Resend, or solve it another way.";
			}
			text += `\nmessage: ${rec.message}`;
			if (s.reason === "replied" && rec.reply) {
				const response = rec.reply.message;
				text += `\nreply: ${typeof response === "string" ? response : JSON.stringify(response, null, 2)}`;
			}
			return { content: [{ type: "text" as const, text }] };
		},
		renderCall(args, theme) {
			const a = args as any;
			const msgId = typeof a.msg_id === "string" && a.msg_id ? a.msg_id : "(recent)";
			return new Text(theme.fg("toolTitle", theme.bold("comms_outbox ")) + theme.fg("accent", msgId), 0, 0);
		},
	});

	pi.registerTool({
		name: "comms_inbox",
		label: "Comms Inbox",
		description:
			"List or re-read messages you RECEIVED from other peers.\n\n" +
			"With no msg_id: list your recent received messages, newest first (sender and content summary; default limit: 10).\n" +
			"With msg_id: retrieve the full details of that specific message, including the sender, timestamp, reply linkage, and full content.\n\n" +
			"Normally, inbound messages are automatically delivered to you as inbound turns or injections. You do NOT need to poll this inbox to check for new messages; they are automatically disclosed in your LLM context when delivered.\n\n" +
			"This tool is primarily for recovering or re-reading past communication when the current context is no longer sufficient — for example, after context compaction or a restart, when communication with peers appears inconsistent, or when you need to recover a previous message or its msg_id. Received-message history is kept separately in persistent message history for up to 24 hours.\n\n" +
			"Use this tool to look up or recover past inbound messages, not as a polling mechanism for new messages.",
		parameters: Type.Object({
			msg_id: Type.Optional(Type.String({ description: "msg_id of a received message. Omit to list your recent received messages (newest first)." })),
			limit: Type.Optional(Type.Number({
				minimum: 1,
				maximum: 100,
				description: "Max entries in the list mode (default 10).",
			})),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("comms not initialised");
			const p = params as any;
			const self = identity;
			const msgId = typeof p.msg_id === "string" && p.msg_id.length > 0 ? p.msg_id : undefined;
			const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 100) : 10;

			// List mode: recent received messages, newest first.
			if (!msgId) {
				const records = await history.listInbound(self.subnet, self.name, limit);
				if (records.length === 0) {
					return {
						content: [{ type: "text" as const, text: "comms_inbox: no received messages recorded" }],
					};
				}
				const lines = records.map((r) =>
					`  ${r.msg_id} from ${r.sender}` +
					(r.reply_to_msg_id ? ` (reply to ${r.reply_to_msg_id})` : "") +
					` — "${history.flatten(r.message)}"`);
				return {
					content: [{ type: "text" as const, text: `comms_inbox: ${records.length} message(s)\n${lines.join("\n")}` }],
				};
			}

			const rec = await history.getInbound(self.subnet, self.name, msgId);
			if (!rec) {
				return {
					content: [{ type: "text" as const, text: "comms_inbox: unknown msg_id — no history record (never received, or evicted from the history bucket)" }],
				};
			}
			let text = `comms_inbox: ${msgId} from ${rec.sender}`;
			if (rec.reply_to_msg_id) {
				const answered = await history.getOutbound(self.subnet, self.name, rec.reply_to_msg_id);
				text += ` (reply to ${rec.reply_to_msg_id}${answered ? ", your send" : ""})`;
			}
			text += `\nreceived at ${new Date(rec.ts).toISOString()}`;
			text += `\nmessage: ${rec.message}`;
			return { content: [{ type: "text" as const, text }] };
		},
		renderCall(args, theme) {
			const a = args as any;
			const msgId = typeof a.msg_id === "string" && a.msg_id ? a.msg_id : "(recent)";
			return new Text(theme.fg("toolTitle", theme.bold("comms_inbox ")) + theme.fg("accent", msgId), 0, 0);
		},
	});


pi.registerTool({
	name: "comms_remind",
	label: "Comms Remind",
	description:
		"Set, adjust, or cancel a reminder for a message\n\n" +
		"`remind_s > 0` (1–3600): Set or adjust the reminder interval for this message. While the reminder is active, a reminder turn is periodically injected to YOU. " +
		"Use this to follow up on a message you received, or to (re)arm the wait for a reply to a message you sent. " +
		"`remind_s = 0`: Cancel the reminder. This simply removes the reminder — or confirms none is armed — and " +
		"does not modify the message itself. Use this when the peer has replied without a `reply_to_msg_id` and " +
		"you already have your answer, when the peer is offline or no longer relevant, or when you decide to " +
		"resolve the issue another way.\n\n" +
		"Each message can have only one reminder; calling this tool again updates its interval. A reply to an " +
		"outgoing message automatically cancels its reminder (an already-replied message is fine to re-arm). Reminders exist only for the " +
		"current session and are not persisted.",
	parameters: Type.Object({
		msg_id: Type.String({ description: "The msg_id of the message to remind about — one you sent or received." }),
		remind_s: Type.Number({
			minimum: 0,
			maximum: 3600,
			description:
				"Reminder interval in seconds. Use 1–3600 to set or adjust the reminder; use 0 to cancel it. " +
				"For example, 300 = every 5 minutes.",
		}),
	}),
		async execute(_callId, params) {
			if (!identity) throw new Error("comms not initialised");
			const msgId = (params as any).msg_id as string;
			const remindS = Math.floor((params as any).remind_s as number);
			const res = await messaging.remind(identity, msgId, remindS);
			const outcome = res.outcome;
			const text = outcome === "reminded"
				? `${msgId} reminded every ${remindS} s`
				: outcome === "stopped"
					? res.wasArmed
						? `${msgId} reminder stopped`
						: `${msgId} reminder not armed — nothing to stop`
					: `unknown msg_id — never sent/received here, or evicted from the history bucket`;
			return {
				content: [{ type: "text" as const, text }],
				details: { msg_id: msgId, remind_s: remindS, outcome },
			};
		},
		renderCall(args, theme) {
			const a = args as any;
			const msgId = a.msg_id ?? "?";
			// Wording mirrors the result content ("remind every 300 s").
			const s = typeof a.remind_s === "number" && a.remind_s > 0
				? ` · remind every ${a.remind_s} s`
				: " · stop";
			return new Text(theme.fg("toolTitle", theme.bold("comms_remind ")) + theme.fg("accent", msgId + s), 0, 0);
		},
	});

	pi.registerTool({
		name: "comms_update_profile",
		label: "Comms Update Profile",
		description:
			"Declare what you are currently working on to the comms hub. Peers — especially the Teammate Provider " +
			"when matching you to incoming work — use it to decide whether you are available for reuse. " +
			"Only the fields you pass are updated; visible to peers immediately.",
		parameters: Type.Object({
			current_task: Type.Optional(Type.String({
				description: "What you are currently working on. Shown in comms_list_peer.",
			})),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("comms not initialised");

			const stored = await updateProfile({ current_task: (params as any).current_task });

			const updated: string[] = [];
			if ((params as any).current_task !== undefined) updated.push("current_task");

			return {
				content: [{
					type: "text" as const,
					text: `comms_update_profile: updated ${updated.join(", ") || "(no fields)"}`,
				}],
				details: { updated, current_task: stored.current_task ?? null },
			};
		},
		renderCall(args, theme, context) {
			const fields: string[] = [];
			if ((args as any).current_task) fields.push("task");
			const tags = fields && fields.length > 0 ? fields.join(", ") : "?";
			const text =
				theme.fg("toolTitle", theme.bold("comms_update_profile ")) + theme.fg("accent", tags);
			if (!context.expanded) {
				return new Text(text, 0, 0);
			}
			// Expanded: the declared current_task value.
			const task = (args as any).current_task as string | undefined;
			return new Text(text + (task ? `\ncurrent_task: ${task}` : ""), 0, 0);
		},
	});

	// ━━ agent_settled: settle the answered batch ━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Replies are explicit (comms_send + reply_to_msg_id) — nothing is auto-
	// submitted here.
	//
	// This runs at pi's agent_settled — NOT agent_end: a batch steered into
	// the run that just ended is acked only after it was really consumed —
	// any continuation run that drains pi's steering queue runs before
	// agent_settled, so there is no acked-but-unseen window (an agent_end
	// settle would ack while the steer still sat in pi's queue).
	// ("next turn" messages never reach this path — they are acked when pi's
	// queue accepts them, see batch.enqueue → injectNextTurn.)
	// Ordering contract: auto-exit's shutdown decision also happens at
	// agent_settled; comms is loaded before auto-exit, so this handler runs
	// first and the answered batch is acked before the process exits.

	pi.on("agent_settled", async () => {
		if (!identity || bootFailed) return;
		const answered = batch.getActiveBatch();
		if (answered && answered.length > 0) {
			batch.settleBatch(answered);
		}
		// The answered batch is settled; release the turn gate and immediately
		// drain anything that queued up during the turn.
		batch.releaseTurn();
	});

	// ━━ Clean shutdown (idempotent) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// The prompt durable consumer is deliberately NOT deleted here: it persists
	// across restarts, so a restart under the same name resumes the same cursor
	// (unacked prompts redeliver, acked ones are not replayed, and messages
	// queued while offline deliver on return). Deleting it would make the
	// recreated consumer replay the whole stream (deliver_policy: All).

	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;

		if (heartbeatTimer) {
			try { clearInterval(heartbeatTimer); } catch { /* ignore */ }
			heartbeatTimer = null;
		}
		if (uiRefreshTimer) {
			try { clearInterval(uiRefreshTimer); } catch { /* ignore */ }
			uiRefreshTimer = null;
		}

		messaging.setMessagingShuttingDown(true);
		messaging.clearAllReminders();

		if (identity && !bootFailed) {
			await registry.clearOwn(identity);
		}

		if (identity) {
			audit("shutdown", { name: identity.name, started_at: identity.started_at });
		}

		registry.stopWatch();
		registry.setCacheChangeListener(null);
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setStatus("comms", ""); } catch { /* ignore */ }
			try { currentCtx.ui.setWidget("comms-peers", undefined); } catch { /* ignore */ }
		}

		await closeNats();
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
