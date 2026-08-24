/**
 * auto-exit — Pi extension loaded into spawned agents.
 *
 * When PI_AGENT_AUTO_EXIT=1 is set, the agent shuts down once its work is
 * fully done. The decision is made at agent_settled — NOT agent_end: pi's
 * agent_end fires when a low-level run ends, but Pi may still auto-retry,
 * auto-compact and retry, or continue with queued follow-up messages (e.g. a
 * comms batch that arrived during the turn). agent_settled fires only when
 * none of that is left — exactly the "will Pi continue automatically?"
 * question auto-exit needs to answer. The last run's messages are recorded at
 * agent_end (agent_settled carries no messages), and shutdown happens at
 * agent_settled if that run actually finished:
 *
 *   - last assistant stopReason "stop" (final answer) or "error" (provider
 *     error, exhausted retries, etc.) → exit
 *   - run ended right after a terminating tool batch (execute returned
 *     terminate: true — pi emits agent_end without a trailing assistant
 *     message in that case) → exit
 *   - "toolUse" (mid-workflow, another turn would follow), "length" (output
 *     truncated — Pi may still auto-compact and retry) and "aborted"
 *     (user/caller stopped it — keep listening) → stay alive
 *
 * Internal defense: even with auto-exit enabled, the agent NEVER exits while
 * it has pending comms sends (listPendingReplies non-empty) — a send whose
 * reply has not arrived yet means the agent is mid-conversation, not done.
 * Auto-exit is only safe for spawner-declared simple one-shot tasks
 * (agent_spawn autoExit: true); this defense is the second layer.
 *
 * Usage:
 *   PI_AGENT_AUTO_EXIT=1 pi -e extensions/auto-exit.ts -e extensions/comms.ts ...
 *
 * Load this AFTER comms.ts so comms's agent_settled handler (which settles
 * — acks — the answered batch and drains anything that queued during the
 * turn) runs before the auto-exit decision at the same agent_settled.
 *
 * Note: ctx.shutdown() is a no-op in print mode — this extension targets
 * interactive sessions (spawned agents run interactively via the tmux launch
 * script).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listPendingReplies } from "./lib/comms/messaging";

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * stopReason values that mean "this run produced a final answer / crashed".
 * These are pi's unified message values: provider-level reasons (e.g.
 * Anthropic's "end_turn") are already mapped to "stop" by pi, so "end_turn"
 * never appears on a pi message.
 */
const FINAL_STOP_REASONS = new Set(["stop", "error"]);

/**
 * Decide whether the last agent run finished its work and may exit.
 * `messages` is the CURRENT run's messages only (pi's agent_end payload, not
 * the whole session history), so the last entry decides: a trailing assistant
 * message with stopReason "stop"/"error", or a toolResult with no assistant
 * message after it (terminating tool batch) → finished; "toolUse"/"length"/
 * "aborted" → not finished. See the module header for the full rationale.
 */
export function shouldAutoExitOnAgentEnd(messages: any[] | undefined): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      return FINAL_STOP_REASONS.has(msg.stopReason);
    }
    // No assistant message after the last tool result: the run was ended by
    // a terminating tool batch (terminate: true) — the work is done.
    if (msg?.role === "toolResult") return true;
    // user / custom entries: keep scanning backwards.
  }

  // No assistant message and no tool result — nothing meaningful ran:
  // conservative, don't exit.
  return false;
}

/**
 * If the last assistant message of a run ended with stopReason "error",
 * extract its error details so the exit reason can be recorded. Returns null
 * when the run did not end in an error.
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): { errorMessage: string; stopReason: "error" } | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw =
      typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage:
        raw ||
        "Agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const autoExit = process.env.PI_AGENT_AUTO_EXIT === "1";
  if (!autoExit) return; // Nothing to do — agent stays interactive.

  /** The last run's messages. agent_settled carries no messages, so they are
   *  recorded at every agent_end; runs happen sequentially, so by the time
   *  agent_settled fires this is always the FINAL run (any retry / compaction
   *  / follow-up run overwrites it first). */
  let lastRunMessages: any[] | undefined;

  pi.on("agent_end", (event) => {
    lastRunMessages = (event as any).messages as any[] | undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    // agent_settled fires after every run; without a recorded run there is
    // nothing to decide on.
    if (!lastRunMessages) return;
    if (!shouldAutoExitOnAgentEnd(lastRunMessages)) return;

    // Internal defense: pending comms sends mean the agent is waiting for
    // external replies — mid-conversation, not done. Never exit while any
    // pending send exists (listPendingReplies skips answered/dismissed ones).
    if (listPendingReplies().length > 0) return;

    // Record why we exit (visible in the session JSONL for later debugging).
    const error = findLatestAssistantError(lastRunMessages);
    try {
      pi.appendEntry("auto-exit-log", {
        event: "auto_exit",
        reason: error ? "error" : "finished",
        ...(error ? { error_message: error.errorMessage } : {}),
        ts: new Date().toISOString(),
      });
    } catch {
      // best-effort — the exit must not depend on logging
    }

    ctx.shutdown();
  });
}
