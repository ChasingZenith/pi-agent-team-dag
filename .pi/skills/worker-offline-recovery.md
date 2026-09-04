---
name: worker-offline-recovery
description: "Defines how to recover a task whose executing worker went offline/dead mid-flight (status worker_offline). Use when a dispatch message's reminder reports the recipient IS offline, or when the Teammate Provider is asked to restart a dead agent. Distinguishes worker_offline from blocked and drives the re-dispatch-after-restart loop."
---

# Worker Offline Recovery

A dispatched/active task can lose its worker (crash, SIGKILL, machine dies). This skill defines Coordinator and Teammate Provider's responsibilities in the recovery loop — the Coordinator drives it, the Teammate Provider (TP) executes the restart half. Read the section that applies to you.

## What it is and what it is NOT

`worker_offline` is a task status meaning **the executor disappeared** — a *recoverable* failure, not a plan contradiction.

- **`worker_offline` ≠ `blocked`**: `blocked` is reality blocking the *plan* (failed assumption, unavailable resource). `worker_offline` is the *executor* going away. They live on different axes; a task in `worker_offline` is not blocked on the plan, it is missing its hands.
- **`worker_offline` locks dependents** (like `blocked`): it is not `done`/`cancelled`, so downstream nodes never unlock while it is unresolved.
- **It is recoverable**: `worker_offline → dispatched` is a legal transition, so after restarting the worker the SAME task can be re-dispatched to the SAME agent name (the comms identity, stable across restarts).
- **Only manually marked** — the system never auto-detects offline. Detection is the Coordinator's job, from a comms reminder.


# Coordinator's role

You own the task and its graph. You detect, you orchestrate, you decide. You never restart the agent yourself.

## How Coordinator detect it

A comms **reminder turn** (the consolidated `[comms reminder]` injected every `remind_s`) reports the peer status. When a dispatch message you sent shows `to <worker> (offline)` — `⚠ <worker> is OFFLINE — their reply won't arrive until they're back` — the worker executing that task is gone. That is the signal to start recovery.

> Do not mistake a merely *unanswered* dispatch for an offline worker. Only act when the reminder explicitly marks the target **offline**.
> 
## When a reminder reports the recipient offline

1. **Mark the executor gone.** `task_set_status(id, "worker_offline")`. This puts the task in a recognizable recoverable state (dependents stay locked) instead of silently hanging in `active`/`dispatched`.
   - If the task was `active` (worker started then died) or `dispatched` (died before starting) — both legally transition to `worker_offline`.
   - If the node has **no `execution_session`** recorded (the worker never `task_start`ed), there is nothing to resume — set `worker_offline` then `task_block` and take the ordinary reality-beats-plan path.

2. **Ask TP to restart the worker.** Send `comms_send(target="teammate-provider", message="Restart the agent <name> that was running task <id> — it went offline; resume its execution_session", remind_s=300)`. The TP calls its `tp_restart_agent` tool: it reads the task's `execution_session` (recorded on the node) and re-spawns the SAME agent name with that JSONL, preserving the prior context. Await the reply (waiting-protocol: end your turn; the reply is injected).

3. **On the TP's reply (worker is restarted), re-dispatch the SAME agent.** `task_dispatch(id, <name>, message="You were restarted — first submit a report of where you are (task_checkout + task_submit_report); then wait for my decision to continue.")`. The `worker_offline → dispatched` transition is legal, so `task_dispatch` works unchanged.

4. **The worker submits a report, then waits.** Review the report (task_read `fields="report"`): 
   - To continue the work → `comms_send` the agent telling it to proceed; the worker `task_start`s and resumes.
   - To stop it → `task_block` (replan) / `task_complete` (it actually finished) / `task_cancel` (out of scope), whatever the report warrants.

When to just `task_block` instead of recovering: the worker is gone **and** re-spawning is futile — no `execution_session` to resume, or the task's assumptions that the dead worker was executing are themselves invalidated. Then `worker_offline` → mark `blocked` and escalate through reality-beats-plan.

# Teammate Provider's role

You are asked to restart a dead agent. You **do not** decide whether to recover the task (that is the Coordinator's call) — you provide the hands back.

When a caller sends `Restart the agent <name> that was running task <id>`:

1. **Call `tp_restart_agent(agent=<name>, task_id=<id>)** — it reads the task's `execution_session` (the JSONL transcript path recorded on the node), then kills any stale window/state and re-spawns the SAME name with that session file. The agent is rebuilt from its recorded spawn manifest (same role / tools / skills), so its capabilities are restored exactly.
2. **Reply to the caller** that the agent is restarted (`comms_send`, `reply_to_msg_id` = the caller's request). Keep it short — the caller only needs confirmation, then it re-dispatches the task to that name.

> The restarted agent reuses the same name, so it picks up the same durable consumer and message history — undelivered prompts redeliver, and the caller's re-dispatch reaches it.


