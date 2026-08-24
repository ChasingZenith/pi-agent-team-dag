/**
 * lib/tmux — Tmux window operations for agent lifecycle management.
 *
 * Low-level tmux primitives used by agent-lifecycle to create and destroy
 * agent windows. All functions are synchronous (execFileSync).
 */

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the current process is inside a tmux session. Returns the
 * parent pane ID — every live tmux process runs in a pane, so TMUX_PANE
 * doubles as the "inside tmux" marker and as the target for resolving the
 * session the agent window should join.
 */
export function checkTmux(): string {
  const pane = process.env.TMUX_PANE;
  if (!pane) {
    throw new Error(
      "agent-lifecycle requires a tmux session. " +
        "Please run pi inside tmux (TMUX_PANE is not set).",
    );
  }
  return pane;
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

/**
 * Explicit `env: process.env` on every execFileSync call: bun resolves the
 * command path from the passed env's PATH rather than a cached snapshot, so
 * tests that prepend a fake tmux to PATH actually take effect (bun ignores
 * later process.env.PATH mutations otherwise). No behavior change under node.
 */
const TMUX_ENV = (): { env: Record<string, string> } => ({ env: process.env as Record<string, string> });

/**
 * Create a new tmux window in the same session as `parentPane`. Returns the
 * window ID (e.g. "@42").
 *
 * `new-window -t` only accepts a window/session target ("can't specify pane
 * here"), so the parent's session is resolved first via display-message —
 * the spawner's own pane lives in the session the agent window belongs to.
 */
export function tmuxNewWindow(cwd: string, parentPane: string): string {
  const session = execFileSync(
    "tmux",
    ["display-message", "-p", "-F", "#{session_id}", "-t", parentPane],
    { encoding: "utf8", ...TMUX_ENV() },
  ).trim();
  if (!session.startsWith("$")) {
    throw new Error(`Unexpected tmux display-message output: ${session}`);
  }

  const win = execFileSync(
    "tmux",
    ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-c", cwd],
    { encoding: "utf8", ...TMUX_ENV() },
  ).trim();
  if (!win.startsWith("@")) {
    throw new Error(`Unexpected tmux new-window output: ${win}`);
  }
  return win;
}

/** Send a bash script path to a tmux window for execution (targets its active pane). */
export function tmuxSendScript(windowId: string, scriptPath: string): void {
  execFileSync("tmux", [
    "send-keys",
    "-t",
    windowId,
    "-l",
    `exec bash ${scriptPath}`,
  ], TMUX_ENV());
  execFileSync("tmux", ["send-keys", "-t", windowId, "Enter"], TMUX_ENV());
}

/** Kill a tmux window. No-ops silently if the window is already dead. */
export function tmuxKillWindow(windowId: string): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", windowId], { encoding: "utf8", ...TMUX_ENV() });
  } catch {
    // Window may already be dead — that's fine.
  }
}
