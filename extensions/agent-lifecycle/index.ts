/**
 * agent-lifecycle — Interactive agent lifecycle management via tmux.
 *
 * Manages spawning and killing agents in tmux windows. The spawned agents
 * auto-connect to the comms hub (via comms.ts loaded in their launch
 * script); all messaging is handled through comms tools (comms_send,
 * comms_outbox, comms_remind, etc.) — this extension does NOT
 * re-implement any comms client logic.
 *
 * Role/context capability (LLMContext builders, session files, role
 * templates) comes from the role-context module (lib/role-context/), loaded
 * as a dependency — role-context.ts is also added to spawned agents' launch
 * scripts so their --role flag is registered.
 *
 * Role-aware spawn is exposed as executeAgentSpawnByRole() (validate role →
 * unique name → build context → spawn), so consumers like teammate-provider
 * build on agent-lifecycle instead of reaching into lib/role-context.
 * listRoleNames / buildRoleCatalog / getRoleTemplate / interpolate are
 * re-exported for the same reason.
 *
 * Tools:
 *   agent_spawn — Launch an agent in a tmux window with a given LLMContext
 *   agent_kill  — Kill an agent by closing its tmux window
 *
 * Usage:
 *   pi -e extensions/agent-lifecycle
 *   (comms is declared in this extension's package.json pi.extensions and
 *   loaded first — spawned agents join the comms hub via its launch script)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  displayName,
  getRoleTemplate,
  interpolate,
  listRoleNames,
  llmContextFromRole,
  roleDirsFromArgv,
  SESSION_PATH,
  setRoleWarn,
  type LLMContext,
} from "../lib/role-context/template";
import { checkTmux, tmuxNewWindow, tmuxKillWindow } from "../lib/tmux";
import { agentFileStem, writeAndSendScript } from "../lib/launch-script";
import { forkSession, writePreloadedSessionFile } from "../lib/role-context/fork";

// Expanded (ctrl+O) rendering: show the full call args — the same information
// the LLM sees in its context.
function fmtArgs(a: Record<string, unknown>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

// Role queries re-exported so consumers (teammate-provider) build on
// agent-lifecycle instead of reaching into lib/role-context directly.
export {
  buildRoleCatalog,
  getRoleTemplate,
  listRoleNames,
  interpolate,
} from "../lib/role-context/template";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentState {
  name: string;
  windowId: string;
  sessionFile: string;
  status: "spawning" | "online" | "offline" | "error";
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Tool result shape (reused by exported functions and tool execute)
// ---------------------------------------------------------------------------

export interface SpawnResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module-level agent registry — shared between exported functions and the
// extension instance so that other extensions (teammate-provider) calling
// executeAgentSpawn / executeAgentKill use the same Map. session_shutdown
// kills everything regardless of who spawned it.
// ---------------------------------------------------------------------------

const moduleAgents = new Map<string, AgentState>();

// ---------------------------------------------------------------------------
// Exported functions — callable from other extensions (teammate-provider etc.)
// ---------------------------------------------------------------------------

/**
 * Resolve the comms subnet from this process's command line.
 *
 * The spawner is started with `--subnet <name>` (default "subnet0" in
 * comms when absent). Spawned agents must join the same subnet to be
 * visible to the spawner, so we inherit it. Handles both `--subnet foo`
 * and `--subnet=foo` forms; returns undefined when absent.
 */
function subnetFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subnet") {
      const value = argv[i + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (arg.startsWith("--subnet=")) {
      return arg.slice("--subnet=".length) || undefined;
    }
  }
  return undefined;
}

/**
 * Core spawn logic, extracted so other extensions can call it directly
 * instead of going through the (nonexistent) pi.api.getTool() API.
 *
 * Uses the module-level agent registry — shared with the extension instance,
 * so session_shutdown cleans up agents regardless of who spawned them.
 *
 * @param params - Spawn parameters (name, llmContext, optional model)
 * @param cwd    - Working directory
 * @param ctx    - ExtensionContext (for model info etc.)
 */
export async function executeAgentSpawn(
  params: {
    name: string;
    llmContext: LLMContext;
    model?: string;
    /**
     * Auto-exit once the work is fully done (default false). Only for very
     * simple one-shot tasks — see the agent_spawn tool's autoExit parameter
     * for the full contract.
     */
    autoExit?: boolean;
  },
  cwd: string,
  ctx: ExtensionContext,
): Promise<SpawnResult> {
  const { name } = params;
  const llmCtx: LLMContext = params.llmContext ?? {};

  // Model: explicit param > spawner's model > empty (pi default)
  const model: string =
    params.model ||
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");

  // Subnet: inherit the spawner's comms subnet so the spawned agent lands
  // in the same communication domain and we can see each other. Resolved from
  // our own command line (--subnet flag); undefined keeps comms's default.
  const subnet = subnetFromArgv(process.argv);

  // Role dirs: inherit the spawner's --role-dir flags so the spawned agent's
  // role-context extension resolves the SAME external templates (its
  // setActiveTools whitelist must match the spawner's view). Absolutized
  // against cwd — the launch script cd's there, and relative flags never
  // survive across processes.
  const roleDirs = roleDirsFromArgv(process.argv).map((d) => resolve(cwd, d));

  const parentPane = checkTmux();

  // Session file. agentFileStem sanitizes the name (same charset as comms's
  // registry) and appends a stable hash, so two different names that sanitize
  // to the same stem ("Foo Bar" vs "foo-bar") never share a session file.
  const sessionDir = join(cwd, ".pi", "agent-sessions");
  mkdirSync(sessionDir, { recursive: true });
  // Fresh spawns keep a stable name (<stem>-<hash>.json); fork spawns
  // REPLACE this with the library-generated branch path (<ts>_<uuid>.jsonl).
  let sessionFile = interpolate(SESSION_PATH, {
    sessionDir,
    agentName: agentFileStem(name),
  });

  // Dedupe check — BEFORE any file write: a retried spawn of a live agent
  // must fail without touching its session file on disk. Truncating the file
  // first would corrupt the running agent's conversation (the live pi process
  // keeps appending to it, and a restart would recover a mixed/truncated
  // session), and the write would be thrown away anyway when this throws.
  if (moduleAgents.has(name.toLowerCase())) {
    const existing = moduleAgents.get(name.toLowerCase())!;
    throw new Error(
      `Agent "${name}" is already running (status: ${existing.status}). ` +
        "Use agent_kill first if you need to restart it.",
    );
  }

  // Session file, three modes:
  //   1. context "fork" — branch the spawner's own session, trimmed to before
  //      the last delegation (comms-inbound) message. Format, ids, history
  //      are all pi SessionManager-generated. messages is ignored (the task is
  //      delivered after spawn via comms_send).
  //   2. messages present — preload them into a fresh session via pi's
  //      SessionManager (writePreloadedSessionFile; format is library-generated).
  //   3. otherwise — an empty file; pi bootstraps the header on startup.
  // Writes are atomic (temp + rename), so a failed write never leaves a
  // truncated file and a live agent's fd never observes one.
  let forkInfo: { trimmed: boolean; fullInherit: boolean; materializedByFallback: boolean } | null = null;
  if (llmCtx.context === "fork") {
    // ctx.sessionManager is the read-only view of the SPAWNER's own session —
    // forkSession opens a separate manager instance on it (never mutates the
    // live session). The default openSession resolves SessionManager via the
    // instance constructor: ReadonlySessionManager is a type-level Pick, the
    // instance constructor IS SessionManager.
    const forkResult = forkSession(ctx.sessionManager, sessionDir, { cwd });
    if (forkResult) {
      sessionFile = forkResult.sessionFile;
      forkInfo = forkResult;
    } else {
      // Whole active path is delegation traffic — nothing to inherit; fall
      // back to an empty bootstrap session.
      writeFileSync(`${sessionFile}.tmp`, "");
      renameSync(`${sessionFile}.tmp`, sessionFile);
    }
  } else if (llmCtx.messages && llmCtx.messages.length > 0) {
    sessionFile = writePreloadedSessionFile(
      sessionFile,
      {
        cwd,
        model: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : { provider: "unknown", id: "unknown" },
        thinkingLevel: (ctx as any).thinkingLevel ?? "off",
        messages: llmCtx.messages,
      },
      (ctx.sessionManager as any).constructor,
    );
  } else {
    // Let pi bootstrap an empty session
    writeFileSync(`${sessionFile}.tmp`, "");
    renameSync(`${sessionFile}.tmp`, sessionFile);
  }

  let windowId: string | null = null;

  try {
    // Create tmux window and launch
    windowId = tmuxNewWindow(cwd, parentPane);
    writeAndSendScript(windowId, {
      cwd,
      agentName: name,
      systemPrompt: llmCtx.systemPrompt || undefined,
      model,
      sessionFile,
      // Default: stay alive until explicitly managed (agent_kill /
      // session_shutdown); auto-exit is only for spawner-opted simple
      // one-shot tasks (see the autoExit parameter).
      autoExit: params.autoExit === true,
      role: llmCtx.role,
      subnet,
      skills: llmCtx.skills,
      extensions: llmCtx.extensions,
      roleDirs: roleDirs.length ? roleDirs : undefined,
    });

    // Track state — only on full success
    const state: AgentState = {
      name,
      windowId,
      sessionFile,
      status: "spawning",
      startedAt: new Date().toISOString(),
    };
    moduleAgents.set(name.toLowerCase(), state);

    return {
      content: [
        {
          type: "text",
          text: [
            `Agent "${name}" spawned.`,
            `  tmux window: ${windowId}`,
            `  session:   ${sessionFile}`,
            `  status:    spawning`,
            "",
            "Use comms_list_peer to confirm the agent is online, then",
            "comms_send to send the initial message.",
          ].join("\n"),
        },
      ],
      details: {
        name,
        windowId,
        sessionFile,
        status: "spawning",
        context: llmCtx.context ?? "fresh",
        ...(forkInfo
          ? {
              forked: true,
              trimmed: forkInfo.trimmed,
              fullInherit: forkInfo.fullInherit,
              materializedByFallback: forkInfo.materializedByFallback,
            }
          : {}),
      },
    };
  } catch (err) {
    // Auto-cleanup on failure: kill window, remove stale state
    if (windowId) {
      try { tmuxKillWindow(windowId); } catch { /* window may already be dead */ }
    }
    moduleAgents.delete(name.toLowerCase());
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Role-aware spawn — "role → agent" lives here, not in consumers
// ---------------------------------------------------------------------------

/** Parameters for role-aware spawn (executeAgentSpawnByRole). */
export interface SpawnByRoleParams {
  /** Role template name (e.g. "scout", "worker"). */
  role: string;
  /** Optional custom name. Defaults to a unique variant of the role name. */
  name?: string;
  /** Auto-exit after the first finished turn (default false) — see executeAgentSpawn. */
  autoExit?: boolean;
  /**
   * Context source, forwarded to the spawned LLMContext. Defaults to "fresh".
   * Teammate-provider does NOT set this (isolation principle — spawned agents
   * get clean template-driven contexts); reserved for callers that want a
   * child to inherit this process's session via fork.
   */
  context?: "fresh" | "fork";
}

/**
 * Generate a unique agent name for a role, avoiding collisions with
 * already-spawned agents and the reserved "teammate-provider" name.
 */
function uniqueName(role: string): string {
  const lower = role.toLowerCase();
  if (!isAgentNameTaken(lower) && lower !== "teammate-provider") return role;
  for (let i = 2; i < 100; i++) {
    const c = `${role}-${i}`;
    if (!isAgentNameTaken(c.toLowerCase()) && c.toLowerCase() !== "teammate-provider")
      return c;
  }
  return `${role}-${Date.now().toString(36)}`;
}

/**
 * Role-aware spawn: validate the role against the template catalog, pick a
 * unique name, build the LLMContext from the role template, and spawn. The
 * whole "role → agent" transformation is owned here so consumers
 * (teammate-provider) build on agent-lifecycle instead of lib/role-context.
 *
 * @param params - { role, name?, autoExit? }
 * @param cwd    - Working directory
 * @param ctx    - ExtensionContext (for model info etc.)
 * @returns SpawnResult with details { agentName, role, tools, windowId,
 *          sessionFile, status } — or an error result (details.error) for an
 *          unknown role / failed context build.
 */
export async function executeAgentSpawnByRole(
  params: SpawnByRoleParams,
  cwd: string,
  ctx: ExtensionContext,
): Promise<SpawnResult> {
  const { role, name } = params;

  // Validate the role against the template catalog
  const template = getRoleTemplate(role);
  if (!template) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Unknown role "${role}". Available: ${listRoleNames().join(", ")}.`,
        },
      ],
      details: { agentName: "", role, error: "Unknown role" },
    };
  }

  const agentName = name || uniqueName(role);

  // Build the self-contained context from the role template
  const llmCtx = llmContextFromRole(role, agentName);
  if (!llmCtx) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to build context for role "${role}".`,
        },
      ],
      details: { agentName, role, error: "llmContextFromRole returned null" },
    };
  }

  const spawnResult = await executeAgentSpawn(
    {
      name: agentName,
      llmContext: { ...llmCtx, context: params.context ?? llmCtx.context },
      autoExit: params.autoExit,
    },
    cwd,
    ctx,
  );

  const spawnDetails = (spawnResult?.details ?? {}) as Record<string, unknown>;
  const windowId = (spawnDetails.windowId as string) || null;

  return {
    content: [
      {
        type: "text" as const,
        text:
          `✅ Spawned "${displayName(agentName)}" (${template.label})\n` +
          `- Role: ${role}\n` +
          `- Tools: ${template.defaultTools}\n` +
          `- Window: ${windowId || "unknown"}\n\n` +
          `Give this agent name to the caller.`,
      },
    ],
    details: {
      agentName,
      role,
      tools: template.defaultTools,
      windowId,
      sessionFile: spawnDetails.sessionFile,
      status: spawnDetails.status,
      ...(template.skillPaths.length ? { skills: template.skillPaths } : {}),
      ...(template.extensionPaths.length ? { extensions: template.extensionPaths } : {}),
      ...(template.capabilityWarnings.length
        ? { capabilityWarnings: template.capabilityWarnings }
        : {}),
    },
  };
}

/**
 * Core kill logic, extracted so other extensions can call it directly.
 *
 * Uses the module-level agent registry.
 *
 * @param params - Kill parameters (name)
 */
export function executeAgentKill(
  params: { name: string },
): SpawnResult {
  const { name } = params;
  const key = name.toLowerCase();
  const state = moduleAgents.get(key);

  if (!state) {
    return {
      content: [
        {
          type: "text",
          text: `Agent "${name}" is not managed by this spawner. It may have already been killed or was spawned by another session.`,
        },
      ],
      details: { name, status: "not_found" },
    };
  }

  // Kill window (ok if already dead — tmuxKillWindow catches internally)
  try {
    tmuxKillWindow(state.windowId);
  } catch {
    // Already dead, just clean up state
  }
  moduleAgents.delete(key);

  return {
    content: [
      {
        type: "text",
        text: `Agent "${name}" killed (window ${state.windowId} closed).`,
      },
    ],
    details: { name, status: "killed", windowId: state.windowId },
  };
}

/**
 * Check whether an agent name is already taken (case-insensitive).
 *
 * @param name - Agent name to check
 * @returns true if an agent with this name is already in the registry
 */
export function isAgentNameTaken(name: string): boolean {
  return moduleAgents.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- State ----
  let cwd = process.cwd();

  // ---- Flags ----
  // --role-dir registers extra role template directories (repeatable, highest
  // priority). Read directly from argv by roleDirsFromArgv — pi.getFlag only
  // surfaces the LAST value of a repeated flag. Registration is for --help
  // visibility; unknown --flags are tolerated by pi anyway.
  pi.registerFlag("role-dir", {
    description: "Additional role template directory (repeatable, highest priority)",
    type: "string",
  });

  // Route capability-resolution warnings (unresolved skills/extensions in
  // role frontmatter) into the audit log. roleWarn swallows writer errors.
  setRoleWarn((msg) => {
    try {
      pi.appendEntry("role-context", { event: "capability_skip", message: msg });
    } catch { /* not active yet — keep the console fallback silent */ }
  });

  // ---- Tools ----

  // --- agent_spawn ---
  pi.registerTool({
    name: "agent_spawn",
    label: "Agent Spawn",
    description:
      "Launch a new interactive agent in a tmux window connected to the comms hub. " +
      "Receives a self-contained LLMContext that defines the agent's initial " +
      "system prompt and conversation. After spawning, use comms_list_peer to " +
      "confirm the agent is online, then comms_send to send tasks.",
    promptSnippet: "agent_spawn name=<name> llmContext={systemPrompt: \"<system prompt text>\"}",
    promptGuidelines: [
      "Construct llmContext as { systemPrompt: \"<full guidance for the agent>\" } — the agent's instructions go in the system prompt. The agent's first turn starts when its first comms message arrives — deliver the task via comms_send after spawn, no initial user message needed.",
      "Default context is fresh. Set llmContext.context: \"fork\" only to inherit THIS conversation's working context (trimmed to before the last delegation message) — never to spawn a different persona: the inherited history would contradict the new system prompt.",
      "autoExit defaults to false — set it only for very simple one-shot tasks that finish without waiting for replies; never for agents that wait for replies or take multiple turns.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Agent name displayed on the comms pool. Also used as --cname.",
      }),
      llmContext: Type.Object({
        systemPrompt: Type.Optional(Type.String({
          description: "System prompt for the agent. Passed via --system-prompt.",
        })),
        messages: Type.Optional(Type.Array(Type.Object({
          role: Type.Enum({ user: "user", assistant: "assistant" }),
          content: Type.String(),
        }), {
          description: "Initial conversation messages. Ignored when context is \"fork\". Preloaded messages do NOT start the agent's first turn at boot — the first turn is triggered by the first comms message that arrives.",
        })),
        context: Type.Optional(Type.Enum({ fresh: "fresh", fork: "fork" }, {
          description:
            "Context source (default \"fresh\"): \"fresh\" starts a clean " +
            "session (empty, or preloaded from messages); \"fork\" inherits " +
            "THIS process's session, trimmed to before the last comms-inbound " +
            "(delegation) message — the child sees the task background, not " +
            "the delegation dialogue.",
        })),
        skills: Type.Optional(Type.Array(Type.String(), {
          description:
            "Absolute skill paths passed to the spawned pi via --skill " +
            "(repeatable). Set automatically when spawning from a role " +
            "template that declares skills: in its frontmatter.",
        })),
        extensions: Type.Optional(Type.Array(Type.String(), {
          description:
            "Absolute extension paths passed to the spawned pi via -e " +
            "(repeatable). Set automatically when spawning from a role " +
            "template that declares extensions: in its frontmatter.",
        })),
      }, {
        description:
          "Self-contained LLM context: { systemPrompt: \"...\" }, optionally " +
          "messages for a preloaded initial conversation, and the context " +
          "source — see each field's description.",
      }),
      model: Type.Optional(
        Type.String({
          description:
            "Model override (provider/model format). " +
            "Defaults to the spawner's model.",
        }),
      ),
      autoExit: Type.Optional(Type.Boolean({
        description:
          "Auto-exit once the work is fully done (default false): shuts down " +
          "at agent_settled, after any retries / queued follow-up messages " +
          "are processed. ONLY set for very simple one-shot tasks " +
          "(single-turn Q&A, no waiting for external replies). Never for " +
          "multi-turn or conversation agents — a turn's stopReason \"stop\" " +
          "is indistinguishable from task completion, so auto-exit would kill " +
          "the agent mid-conversation while it waits for a reply. Even when " +
          "enabled, the agent refuses to exit while it has pending comms " +
          "sends.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeAgentSpawn(
        {
          name: params.name,
          llmContext: (params as any).llmContext ?? {},
          model: params.model,
          autoExit: params.autoExit === true,
        },
        cwd,
        ctx as ExtensionContext,
      );
    },
    renderCall(args, theme, context) {
      const a = args as Record<string, unknown>;
      const text =
        theme.fg("toolTitle", theme.bold("agent_spawn ")) +
        theme.fg("accent", (a.name as string) || "?");
      if (!context.expanded) return new Text(text, 0, 0);
      // Expanded: the full call args (llmContext/model/autoExit), as the LLM saw them.
      return new Text(text + "\n" + fmtArgs(a), 0, 0);
    },
  });

  // --- agent_kill ---
  pi.registerTool({
    name: "agent_kill",
    label: "Agent Kill",
    description:
      "Kill a spawned agent by closing its tmux window. " +
      "The agent will be deregistered from comms automatically.",
    promptSnippet: "agent_kill name=<name>",
    promptGuidelines: [
      "Use agent_kill to stop an agent that was previously spawned with agent_spawn.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Name of the agent to kill.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return executeAgentKill({ name: params.name });
    },
    renderCall(args, theme, context) {
      const a = args as Record<string, unknown>;
      const text =
        theme.fg("toolTitle", theme.bold("agent_kill ")) +
        theme.fg("accent", (a.name as string) || "?");
      if (!context.expanded) return new Text(text, 0, 0);
      // Expanded: the full call args, as the LLM saw them.
      return new Text(text + "\n" + fmtArgs(a), 0, 0);
    },
  });

  // ---- Lifecycle events ----

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd || process.cwd();

    // Ensure session directory exists
    const sessionDir = join(cwd, ".pi", "agent-sessions");
    mkdirSync(sessionDir, { recursive: true });
  });

  pi.on("session_shutdown", async () => {
    // Kill all managed agent windows
    for (const [, state] of moduleAgents) {
      try {
        tmuxKillWindow(state.windowId);
      } catch {
        // Best effort.
      }
    }
    moduleAgents.clear();
  });
}
