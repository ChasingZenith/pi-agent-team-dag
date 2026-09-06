---
name: recover-worker
description: "Defines how to recover a task whose executing worker is lost mid-flight (status worker_offline): the worker died (reminder reports it offline) OR is unresponsive — it may still show online but stopped answering. Covers detection (offline marker or probe-confirmed silence), the restart ladder (reuse session → probe → fresh agent), and the re-dispatch-after-recovery loop. Distinguishes worker_offline from blocked."
---

# Recover Worker

A dispatched/active task can lose its worker mid-flight (crash, SIGKILL, machine dies) — or the worker can stop responding while still showing online (dead session, wedged process, hung tool call). Both are the same failure for the task: there are hands recorded on it that no longer do work. This skill defines Coordinator and Teammate Provider's responsibilities in the recovery loop — the Coordinator drives it, the Teammate Provider (TP) executes the restart half. Read the section that applies to you.

## What it is and what it is NOT

`worker_offline` is a task status meaning **the executor disappeared or stopped responding** — a *recoverable* failure, not a plan contradiction. Despite the name, the worker does NOT have to be marked offline by comms to be `worker_offline` — an online-but-unresponsive agent qualifies too.

- **`worker_offline` ≠ `blocked`**: `blocked` is reality blocking the *plan* (failed assumption, unavailable resource). `worker_offline` is the *executor* going away. They live on different axes; a task in `worker_offline` is not blocked on the plan, it is missing its hands.
- **`worker_offline` locks dependents** (like `blocked`): it is not `done`/`cancelled`, so downstream nodes never unlock while it is unresolved.
- **It is recoverable**: `worker_offline → dispatched` is a legal transition, so after restarting the worker the SAME task can be re-dispatched to the SAME agent name (the comms identity, stable across restarts).
- **Only manually marked** — the system never auto-detects offline. Detection is the Coordinator's job, from a comms reminder.


# Coordinator's role

You own the task and its graph. You detect, you orchestrate, you decide. You never restart the agent yourself.

## How Coordinator detect it

A comms **reminder turn** (the consolidated `[comms reminder]` injected every `remind_s`) reports the peer status. Two signals, both read on reminder turns:

* A dispatch message you sent shows `to <worker> (offline)` — `⚠ <worker> is OFFLINE — their reply won't arrive until they're back` — the worker executing that task is gone. That is the signal to start recovery.
* The worker still shows **online** but is unresponsive: long no reply, no report, no `task_start`. Online status only means the comms consumer is alive, not that the agent is working — it may be wedged. Probe with `comms_send` asking for status; if the probe is also unanswered by the next reminder, treat it as `worker_offline`.

> Do not mistake a merely *unanswered* dispatch for a lost worker — probe first; only act on an explicit `(offline)` marker or a probe that also goes unanswered.
## How long is "too long"

Anchor it to the reminder you already set — `remind_s` is the dispatcher's expected max wait per rung. 

- A dispatched/active task that has sat **> 3 × remind_s** without a report / `task_start` is stalled — probe it.
- If the probe is still unanswered **one more remind_s later**, escalate (the rung below).

## When a reminder reports the recipient offline

1. **Mark the executor gone AND record the rung.** `task_set_status(id, "worker_offline", change_summary="worker_offline …")`. The `change_summary` is the durable probe state — it is written to the node's change history and survives YOUR restart/context-compaction, so on recovery you resume the ladder where you left off instead of re-detecting. This puts the task in a recognizable recoverable state (dependents stay locked) instead of silently hanging in `active`/`dispatched`.
   - If the task was `active` (worker started then died) or `dispatched` (died before starting) — both legally transition to `worker_offline`.
   - If the node has **no `execution_session`** recorded (the worker never `task_start`ed), there is nothing to resume — set `worker_offline` then `task_block` and take the ordinary reality-beats-plan path.

2. **Ask TP to restart the worker.** Send `comms_send(target="teammate-provider", message="Restart the agent <name> that was running task <id> — it went offline; resume its execution_session", remind_s=300)`. The TP calls its `tp_restart_agent` tool: it reads the task's `execution_session` (recorded on the node) and re-spawns the SAME agent name with that JSONL, preserving the prior context. Await the reply (waiting-protocol: end your turn; the reply is injected).

3. **On the TP's reply (worker is restarted), re-dispatch the SAME agent.** `task_dispatch(id, <name>, message="You were restarted — first submit a report of where you are (task_checkout + task_submit_report); then wait for my decision to continue.")`. The `worker_offline → dispatched` transition is legal, so `task_dispatch` works unchanged.

4. **The worker submits a report, then waits.** Review the report (task_read `fields="report"`):
   - To continue the work → `comms_send` the agent telling it to proceed; the worker `task_start`s and resumes.
   - To stop it → `task_block` (replan) / `task_complete` (it actually finished) / `task_cancel` (out of scope), whatever the report warrants.

## Durable probe state: the `change_summary` stage marker

Each rung of the escalation ladder is recorded in the node's change history via the `worker_offline` `change_summary`. Use a stable prefix that states which rung was reached:

| Stage marker in `change_summary` | Means the coordinator is now… |
|------|------|
| `worker_offline: rung=session_resume` | Marked the worker gone and asked TP to resume the SAME session. Waiting for the restarted worker's `task_start`. |
| `worker_offline: rung=fresh_spawn` | The resumed session stayed silent (or was never resumable), so the coordinator asked TP for a NEW agent with a clean session. Waiting for the new worker's `task_start`. |

On any recovery reminder turn, `task_read` the node's change history to see which rung was last reached, then continue from there — never re-run a completed rung, never assume you are on the first rung after your own restart.

## Escalation ladder (the rungs)

Reusing the old session file is an attempt, not a guarantee — the file itself may be corrupt/truncated and the restarted agent may boot but never respond. You move DOWN this ladder one rung per unresolved reminder:

1. **Rung `session_resume`** (worker detected offline, session resumed): re-dispatch the SAME agent; if it does not `task_start` within the threshold (> 3 × remind_s), `comms_send` it asking to confirm it is alive and to `task_start`.
2. **Rung `fresh_spawn`** (probe also unanswered, one remind_s later): conclude the session file is the problem. Do NOT restart that session again. Ask TP for a **fresh agent** (`comms_send(target="teammate-provider", message="Spawn a NEW agent for task <id> — do NOT reuse the session of <dead-name>; start from a clean session", remind_s=300)`), then `task_dispatch(id, <new-name>, ...)`. The new worker's `task_start` overwrites the node's `execution_session`.

> A worker that shows **online but never `task_start`s** after a resume is the same as a dead one — its session is unusable — so the same ladder applies; the distinction is only in HOW it was detected, not in which rung it enters at.

# Teammate Provider's role

You are asked to either restart a lost agent or spawn a fresh one for an unusable session (the lost agent may be marked offline, or online-but-unresponsive — recovery is the same either way). You **do not** decide whether to recover the task (that is the Coordinator's call) — you provide the hands back.

When a caller sends `Restart the agent <name> that was running task <id>`, or asks for a **fresh agent** ("do NOT reuse the session of <name>" — the coordinator concluded the old session file is broken):

1. **Rebuild the hands.**
   - Restart request: call `tp_restart_agent(agent=<name>, task_id=<id>)` — it reads the task's `execution_session` (the JSONL transcript path recorded on the node), then kills any stale window/state and re-spawns the SAME name with that session file. The agent is rebuilt from its recorded spawn manifest (same role / tools / skills), so its capabilities are restored exactly.
   - Fresh-agent request: run the ordinary spawn path (`tp_spawn_agent`) with a NEW session — the old session file is considered unusable.
2. **Reply to the caller** that the agent is ready (`comms_send`, `reply_to_msg_id` = the caller's request). Keep it short — the caller only needs confirmation, then it re-dispatches the task to that name.

> The restarted agent reuses the same name, so it picks up the same durable consumer and message history — undelivered prompts redeliver, and the caller's re-dispatch reaches it. A fresh agent has a NEW name and a clean inbox — only the caller's `task_dispatch` (sent after your reply) reaches it.


