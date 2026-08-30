---
name: waiting-protocol
description: "Defines how to wait for asynchronous communication between agent turns. Use when you have sent a comms_send, dispatched a task, or expressed a delegate and are now waiting for the reply, the completion report, or a reminder turn."
---

# Waiting Protocol

When you send a message or dispatch work to another agent and only need to wait for a response, **do not look for it or perform dummy work just to extend the wait**. The response is automatically **injected as an inbound comms message**, which wakes you.

## The Rule

When waiting, output one line stating that you are waiting, then **end your turn** until you are woken.

## What Wakes You (Nothing Else Does)

1. **Inbound comms message** — automatically injected (steer: at the next LLM-call boundary; followUp: after the current turn ends). This includes:
   - a peer's reply to your `comms_send` (using `reply_to_msg_id`).
   - a dispatched worker's `task_start` / `task_submit_report` completion notification.
2. **Reminder turn** — when `remind_s > 0`, a consolidated reminder is injected every `remind_s` seconds, listing pending items, elapsed time, peer status, and TTL expiry. This is your only scheduled check-in. Use it to act on pending work: resend expired requests, choose another approach, re-request from an offline peer, or escalate.

## What NOT to Do While Waiting

Do not use query commands to check for replies. Don't use bash sleep function.

## When Checking Is Allowed

* **A reminder turn fires**: Re-evaluate the pending work—resend an expired request, contact another peer, or cancel the reminder once the wait is over.
* **After a restart or context compaction**: Re-read pending requests and their `msg_id`s via `comms_outbox`, `comms_inbox`, or `task_read`. These tools are for recovery, **not polling**.
* **The wait is over**: Once you receive a reply or resolve the issue another way, cancel the reminder with `comms_remind(msg_id, remind_s=0)`.
