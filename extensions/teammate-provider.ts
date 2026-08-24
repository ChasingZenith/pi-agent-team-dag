/**
 * teammate-provider — Network-wide Teammate Provider agent
 *
 * The Teammate Provider (TP) is a standalone agent on comms — the unique,
 * central registry for finding or creating agents in the network.
 *
 * Architecture:
 * - TP runs as a comms agent registered as "teammate-provider"
 * - Other agents send it structured requests (Role, Task, Collaborators, Context)
 * - TP's LLM reads the request, scans available agents, decides: match or spawn
 * - TP responds with the agent name to the caller
 * - Caller cannot tell whether the agent was found or created
 *
 * Dependencies: TP builds on agent-lifecycle (executeAgentSpawnByRole +
 * re-exported role queries) — it never imports lib/role-context directly.
 *
 * Launch (agent-lifecycle must be loaded too — its role-aware spawn and
 * registry back tp_spawn_agent):
 *   pi -e extensions/comms.ts \
 *      -e extensions/agent-lifecycle.ts \
 *      -e extensions/teammate-provider.ts \
 *      --cname teammate-provider
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  executeAgentSpawnByRole,
  getRoleTemplate,
  listRoleNames,
} from "./agent-lifecycle";

// Expanded (ctrl+O) rendering: show the full call args / result content —
// the same information the LLM sees in its context.
function fmtArgs(a: Record<string, unknown>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

function expandedContent(
  result: { content?: Array<{ type: string; text?: string }> },
  fallback: string,
): string {
  const t = result.content?.[0];
  return t?.type === "text" && t.text ? t.text : fallback;
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ======================================================================
  // tp_spawn_agent
  // ======================================================================

  pi.registerTool({
    name: "tp_spawn_agent",
    label: "TP Spawn Agent",
    description:
      "Create and spawn a new agent from a role template. Use when no existing " +
      "agent fits. The agent is spawned in tmux, registers in comms, and stays alive.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role: " + listRoleNames().join(", "),
      }),
      tools: Type.Optional(
        Type.String({
          description: "Optional tool override. Defaults to the role's standard tools.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Optional custom name. Defaults to the role name.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { role, tools, name } = params as {
        role: string;
        tools?: string;
        name?: string;
      };

      try {
        // Role validation, unique naming, context build and spawn are all
        // owned by agent-lifecycle's role-aware spawn.
        return await executeAgentSpawnByRole(
          { role, tools, name },
          process.cwd(),
          ctx as any,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `tp_spawn_agent error: ${message}` },
          ],
          details: {
            agentName: "",
            role,
            error: message,
          },
        };
      }
    },
    renderCall(args, theme, context) {
      const a = args as Record<string, unknown>;
      const role = (a.role as string) || "?";
      const text =
        theme.fg("toolTitle", theme.bold("tp_spawn ")) +
        theme.fg("accent", `[${role}]`);
      if (!context.expanded) return new Text(text, 0, 0);
      // Expanded: the full call args (role/tools/name), as the LLM saw them.
      return new Text(text + "\n" + fmtArgs(a), 0, 0);
    },
    renderResult(result, options, theme) {
      const d = result.details as Record<string, unknown> | undefined;
      let text: string;
      if (d?.error)
        text = theme.fg("error", "✗ " + (d.error as string));
      else if (d?.alreadyExists)
        text = theme.fg("success", "● " + (d.agentName as string) + " already online");
      else
        text =
          theme.fg("success", (d?.error ? "⚠" : "➕") + " " + ((d?.agentName as string) || "?")) +
          theme.fg("dim", ` [${(d?.role as string) || "?"}]`);
      if (!options.expanded) return new Text(text, 0, 0);
      // Expanded: the full result content (role, tools, window), as the LLM saw it.
      return new Text(expandedContent(result, text), 0, 0);
    },
  });

  // ======================================================================
  // Hooks
  // ======================================================================

  pi.on("session_start", async (_event, _ctx) => {
    // Note: no explicit template warm-up needed — listRoleNames() already
    // runs at registerTool time, which triggers the lazy role-template load.

    // Whitelist replace (NOT additive), sourced from the role template's
    // defaultTools (single source of truth): the TP's role is match / spawn /
    // reply — tp_ + comms_ only, never task_* — so it is physically unable
    // to execute the requested work itself (no bash, no read/write/edit, and
    // no touch of the task graph; the task is work for the agent it finds).
    // The template is in-repo and always loads; a missing template is a
    // startup bug and should fail loudly, not boot the TP tool-less.
    const ourTools = getRoleTemplate("teammate-provider")!.defaultTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    pi.setActiveTools(ourTools);

    _ctx.ui.notify(
      "🤝 Teammate Provider ready. Central agent registry — I find or create the right person.",
      "info",
    );
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    // Load the TP's system prompt from the role template
    // (roles/manager/teammate-provider.md) — the same role-context machinery
    // every other role uses; buildSystemPrompt injects {{role_catalog}} and
    // {{tools}} from the template.
    const template = getRoleTemplate("teammate-provider");
    if (!template) return;
    return {
      systemPrompt: template.buildSystemPrompt("teammate-provider", template.defaultTools),
    };
  });
}
