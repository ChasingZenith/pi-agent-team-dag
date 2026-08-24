/**
 * lib/comms/session-name — Pure session-name logic
 *
 * The session display name follows the comms profile: the identity name,
 * or `<agent> [<current_task>]` while the agent declares work. comms.ts
 * owns the session name — every updateProfile push (the same
 * implementation behind comms_update_profile) applies it, and boot claims
 * the bare identity name. Task lifecycle tools never touch the session
 * name directly; they update current_task via the runtime handle, and the
 * display follows.
 *
 * Ownership model: the auto-name is only applied while the session name is
 * unset or still the value WE last set. A manual `--name` / `/name` (or any
 * name we did not set) takes precedence permanently — the auto-name yields
 * instead of fighting the user.
 *
 * Pure functions only — unit-tested without pi / comms / filesystem.
 */

/** Max characters of the task title shown in the display name. */
export const TITLE_MAX = 40;

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

/**
 * The display name for a session: the comms identity (agent name) alone, or
 * with the declared current task — `<agent> [<title>]`. No declared task →
 * the bare agent name.
 */
export function displayName(agentName: string, currentTask: string | undefined): string {
  if (!currentTask) return agentName;
  const title = [...currentTask.trim()].slice(0, TITLE_MAX).join("").trim();
  return title ? `${agentName} [${title}]` : agentName;
}

// ---------------------------------------------------------------------------
// shouldOwnName
// ---------------------------------------------------------------------------

/**
 * Whether the auto-name still has the right to write the session name.
 *
 * @param current  The name pi currently has (undefined when unset — empty
 *                 names are reported as undefined by pi.getSessionName).
 * @param owned    The name WE last set (null before the first write).
 * @param baseName The agent's comms identity name — the base name claimed
 *                 on boot when the session name was unset.
 *
 * true  — name unset (we may claim it), still our own value (we may update
 *         it), or still the base identity name (we may upgrade it to
 *         `<agent> [<task>]`).
 * false — someone else's name is showing (manual --name / /name) — the
 *         auto-name releases ownership and stays out of the way.
 */
export function shouldOwnName(
  current: string | undefined,
  owned: string | null,
  baseName: string,
): boolean {
  return current === undefined || current === owned || current === baseName;
}
