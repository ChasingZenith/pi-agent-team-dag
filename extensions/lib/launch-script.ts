/**
 * lib/launch-script — Agent launch script builder.
 *
 * Builds a self-contained bash script that starts a Pi agent inside a tmux
 * window. The script sets up environment variables and `exec`s pi with the
 * right extension flags so the agent process chain terminates cleanly.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { sanitizeAgentName } from "./comms/protocol";
import { tmuxSendScript } from "./tmux";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCRIPT_DIR = join(tmpdir(), "pi-agent-lifecycle");

/**
 * Project root, derived from THIS module's own location
 * (extensions/lib/launch-script.ts → repo root) — NOT from process.cwd().
 *
 * The spawned pi resolves relative -e paths against ITS OWN working
 * directory (the spawner's cwd). When the spawner was started from anywhere
 * but the project root — e.g. a tmux session opened in $HOME — relative
 * extension paths like "extensions/comms.ts" fail to resolve and the agent
 * dies at boot without ever registering on the comms hub. Absolute paths
 * make spawn location-independent.
 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Script builder
// ---------------------------------------------------------------------------

export interface LaunchScriptParams {
  /** Working directory for the spawned agent. */
  cwd: string;
  /** Agent name (used as --cname). */
  agentName: string;
  /** Model override in provider/model format. */
  model: string;
  /** Path to the session .jsonl file. */
  sessionFile: string;
  /** Whether to set PI_AGENT_AUTO_EXIT=1. */
  autoExit: boolean;
  /** Optional system prompt to inject. Passed as --system-prompt to pi. */
  systemPrompt?: string;
  /** Role template name (e.g. "scout"). Passed as --role. */
  role?: string;
  /** Coms-net subnet the spawned agent joins. Passed as --subnet to pi. */
  subnet?: string;
  /**
   * Absolute skill paths (role-declared) passed as --skill, appended after
   * the project .pi/skills flag. Deduped against it.
   */
  skills?: string[];
  /** Absolute extension paths (role-declared) passed as -e, appended after the plugin chain. */
  extensions?: string[];
  /**
   * Explicit tool whitelist (role-declared defaultTools − excluded ∪ added,
   * computed by agent-lifecycle at spawn time). Passed as `--role-tools` so
   * the spawned pi's role-context overrides its defaultTools with this set.
   */
  tools?: string[];
  /**
   * External role template dirs (inherited from the spawner's --role-dir,
   * already absolutized). Passed verbatim so the spawned agent resolves the
   * SAME role catalog as the spawner.
   */
  roleDirs?: string[];
}

/** Single-quote escape for bash strings. */
function sq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Filesystem-safe, stable stem for per-agent files (session files, launch
 * scripts). sanitizeAgentName keeps the name inside [A-Za-z0-9_-] — the same
 * charset comms uses for the registry — and a short stable hash of the
 * ORIGINAL name disambiguates names that sanitize to the same stem
 * ("Foo Bar" vs "foo-bar" vs "foo--bar"): two live agents must never share a
 * session file. Stable (not random), so respawning a killed agent under the
 * same name keeps its file instead of leaking a new one per spawn.
 */
export function agentFileStem(name: string): string {
  const tag = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const base = sanitizeAgentName(name).toLowerCase().slice(0, 40);
  return `${base}-${tag}`;
}

/**
 * Build the content of the launch bash script.
 *
 * The script structure:
 *   1. cd to the spawner's working directory
 *   2. Export environment variables (PI_AGENT_AUTO_EXIT, PI_AGENT_NAME)
 *   3. exec pi with the team extensions (absolute paths) + identity flags
 *
 * Using `exec pi` ensures that when pi exits (e.g. via auto-exit shutdown),
 * the bash process is replaced and the tmux window closes automatically.
 */
export function buildLaunchScript(params: LaunchScriptParams): string {
  const lines: string[] = [
    "#!/bin/bash",
    "set -e",
    `cd ${sq(params.cwd)}`,
  ];

  if (params.autoExit) {
    lines.push(`export PI_AGENT_AUTO_EXIT=1`);
  }
  lines.push(`export PI_AGENT_NAME=${sq(params.agentName)}`);

  // Extension flags are absolute (PROJECT_ROOT-resolved): the spawned pi
  // resolves relative -e paths against its own cwd, which is the spawner's
  // cwd and may be anywhere (see PROJECT_ROOT above).
  const extArgs = [
    "exec",
    "pi",
    "-e", join(PROJECT_ROOT, "extensions", "comms.ts"),
    // tasks after comms: task tools read comms's identity
    // accessor (updated_by stamp) — load order is the dependency order.
    "-e", join(PROJECT_ROOT, "extensions", "task-graph.ts"),
    // task-comms-ops after task-graph: comms-coordinated graph operations
    // build on tasks' store/graph and comms' identity/messaging.
    "-e", join(PROJECT_ROOT, "extensions", "task-comms-ops.ts"),
    "-e", join(PROJECT_ROOT, "extensions", "role-context.ts"),
    "-e", join(PROJECT_ROOT, "extensions", "auto-exit.ts"),
    // Role-declared extensions (--extensions frontmatter) append after the
    // plugin chain. Their tool names must appear in the role's defaultTools
    // or role-context's setActiveTools whitelist removes them.
    ...(params.extensions ?? []).flatMap((e) => ["-e", sq(e)]),
    // Skills are project-level (.pi/skills/) and the spawned pi resolves
    // them against its own cwd (the spawner's) — same absolute-path fix as
    // the -e flags above, so skill docs like task-lifecycle-reporting stay
    // available no matter where the spawner was started.
    "--skill", join(PROJECT_ROOT, ".pi", "skills"),
    // Role-declared skills append after the project dir; dedupe exact
    // duplicates of it (resolved) so the dir is not loaded twice.
    ...(params.skills ?? [])
      .filter((s) => resolve(s) !== join(PROJECT_ROOT, ".pi", "skills"))
      .flatMap((s) => ["--skill", sq(s)]),
    "--cname", sq(params.agentName),
    ...(params.subnet ? ["--subnet", sq(params.subnet)] : []),
    ...(params.roleDirs ?? []).flatMap((d) => ["--role-dir", sq(d)]),
    ...(params.systemPrompt ? ["--system-prompt", sq(params.systemPrompt)] : []),
    ...(params.role ? ["--role", sq(params.role)] : []),
    ...(params.tools && params.tools.length ? ["--role-tools", sq(params.tools.join(","))] : []),
    ...(params.model ? ["--model", sq(params.model)] : []),
    "--session", sq(params.sessionFile),
  ];

  lines.push(extArgs.join(" "));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Write + send
// ---------------------------------------------------------------------------

/**
 * Write the launch script to a temp file and send it to a tmux window.
 * The window will execute `exec bash <script>` which starts the agent.
 */
export function writeAndSendScript(
  windowId: string,
  params: LaunchScriptParams,
): void {
  mkdirSync(SCRIPT_DIR, { recursive: true });
  const scriptPath = join(
    SCRIPT_DIR,
    `launch-${agentFileStem(params.agentName)}.sh`,
  );
  writeFileSync(scriptPath, buildLaunchScript(params), { mode: 0o755 });
  tmuxSendScript(windowId, scriptPath);
}
