---
name: waiting-protocol
description: "Defines how to wait for asynchronous communication between agent turns. Use when you have sent a comms_send and are waiting for the reply or a reminder turn."
---

# Waiting Protocol

When you send a message to another agent and only need to wait for a response, do NOT perform dummy work just to extend the wait. The reply arrives as an automatically injected inbound comms message, which wakes you.

## The Rule

When waiting, output one line stating that you are waiting, then end your turn until you are woken.

## What Wakes You

1. Inbound comms message — automatically injected (steer: at the next LLM-call boundary; followUp: after the current turn ends) — a peer's reply to your `comms_send` (using `reply_to_msg_id`).
2. Reminder turn — when `remind_s > 0`, a consolidated reminder is injected every `remind_s` seconds. This is your only scheduled verification turn (a reminder wake-up on YOUR side to check the peer's status — the peer does not actively report back on this cadence). Use it to act on pending work (see "When a Reminder Fires" below).

## What NOT to Do While Waiting

Do not use query commands to check for replies. Don't use bash sleep function.

## When Checking Is Allowed

* A reminder turn fires: Decide per the branches below, then end your turn again.
* After a restart or context compaction: Re-read pending requests and their `msg_id`s via `comms_outbox`, `comms_inbox`, or `task_read`. These tools are for recovery, not polling.
* The wait is over: Once you receive a reply or resolve the issue another way, cancel the reminder with `comms_remind(msg_id, remind_s=0)`.

## When a Reminder Fires

* Peer is marked offline: Decide whether to keep waiting (retain the reminder), route the request to another peer, or escalate.
* Peer is online but the expected reply time has passed by roughly 3x: send a simple message to the peer asking for their status, referencing the original `msg_id` inline — e.g. "Still working on <topic> (re: msg_id <id>)? Any blockers?" Keep the reminder running and wait for their answer.
* Still no response after the status ping, or the peer reports a blocker you cannot wait on: the peer is stuck on something that cannot be resolved through comms alone. Report the status if needed, then route the work to another peer or escalate.
