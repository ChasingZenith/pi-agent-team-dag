/**
 * role-context — Role templates and agent context setup.
 *
 * Standalone extension for role-setting and context-setting, independent of
 * comms:
 *   - Registers the --role CLI flag (role template name, e.g. scout, worker,
 *     coordinator)
 *   - Injects the role template into the system prompt on before_agent_start
 *     (chained append — never clobbers an explicit --system-prompt)
 *
 * The context capability (LLMContext builders, session file writing) lives in
 * lib/role-context/, consumed by agent-lifecycle as a dependency.
 *
 * Usage:
 *   pi -e extensions/comms.ts \
 *      -e extensions/role-context.ts \
 *      --role coordinator \
 *      --cname coordinator-main
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRoleTemplate, setRoleWarn, type RoleTemplate } from "./lib/role-context/template";

/** Value of `--<name> <value>` (or `--<name>=<value>`) in argv, if present. */
function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v && !v.startsWith("-")) return v;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

export default function (pi: ExtensionAPI) {
  // pi.getFlag() quirks:
  //   - inside before_agent_start it returns null for every flag;
  //   - outside session_start it only returns values for flags THIS extension
  //     registered (`--cname` belongs to comms → null here).
  // So: capture our own flag during session_start, read `--cname` from argv.
  let roleFlag: string | undefined;

  pi.registerFlag("role", {
    description: "Role template name (e.g. scout, worker, coordinator)",
    type: "string",
    default: undefined,
  });

  // --role-dir registers extra role template directories (repeatable, highest
  // priority). Read directly from argv by roleDirsFromArgv — pi.getFlag only
  // surfaces the LAST value of a repeated flag, and the values must apply to
  // every template lookup in this process (spawned agents inherit the flag via
  // their launch script). Registration is for --help visibility; unknown
  // --flags are tolerated by pi anyway.
  pi.registerFlag("role-dir", {
    description: "Additional role template directory (repeatable, highest priority)",
    type: "string",
  });

  // --role-tools is an explicit, complete tool whitelist (csv) that overrides
  // the role template's defaultTools. It is produced by agent-lifecycle when a
  // spawner adds/excludes tools (teammate-provider's add_tools/exclude_tools):
  // the effective whitelist (defaultTools − exclude ∪ add) is computed once at
  // spawn time and shipped to the spawned pi, so role-context just honors it.
  pi.registerFlag("role-tools", {
    description: "Explicit tool whitelist (csv) overriding the role's defaultTools",
    type: "string",
  });

  // Route capability-resolution warnings (unresolved skills/extensions in role
  // frontmatter) into the audit log. Failure must never break template loading
  // — roleWarn already swallows writer errors.
  setRoleWarn((msg) => {
    try {
      pi.appendEntry("role-context", { event: "capability_skip", message: msg });
    } catch { /* not active yet — keep the console fallback silent */ }
  });

  pi.on("session_start", async () => {
    roleFlag = pi.getFlag("role") as string | undefined;

    // Enforce the role's tool whitelist: pi activates its default tools
    // (read/write/edit/bash/grep/find/ls) for every session, and
    // setActiveTools is additive in the other extensions — so without this,
    // every role can call bash regardless of its defaultTools, letting e.g.
    // a Coordinator "not execute" yet run commands. Replace the active set
    // with exactly the role's defaultTools (load order puts this extension
    // last, so the whitelist wins over the additive merges).
    // Applies to spawned agents too (they also pass --role) — the tool
    // constraint is independent of the prompt injection below.
    // An explicit --role-tools (computed by agent-lifecycle at spawn time from
    // defaultTools − exclude ∪ add) fully overrides the template's defaultTools.
    const roleTools = argValue(process.argv, "role-tools");
    if (!roleFlag && !roleTools) return;
    let tools: string[];
    if (roleTools) {
      tools = roleTools.split(",").map((t) => t.trim()).filter(Boolean);
    } else {
      const template = getRoleTemplate(roleFlag!);
      if (!template) return;
      tools = template.defaultTools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    pi.setActiveTools(tools);
    pi.appendEntry("role-context", { event: "tools_whitelisted", role: roleFlag, tools });
  });

  // ━━ Role template injection (--role) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Inject the role template as a chained append to the current system prompt.
  // Guard rails:
  //   - An explicit --system-prompt on the command line wins (spawned agents
  //     pass the interpolated template this way) — never double-inject.
  //     (systemPromptOptions.customPrompt is NOT a reliable guard: it is
  //     always populated with pi's own default template from
  //     ~/.pi/agent/SYSTEM.md, so it cannot distinguish explicit prompts.)
  //   - Unknown role → no-op (appendEntry records it), boot still succeeds.
  //   - Every decision is recorded via appendEntry so injection is observable.

  pi.on("before_agent_start", async (event) => {
    const role = roleFlag;
    if (!role) return; // no --role: leave the prompt untouched

    // The spawn path (agent-lifecycle's launch script) already carries the
    // interpolated role template as --system-prompt, so skip it.
    if (process.argv.some((a) => a === "--system-prompt" || a.startsWith("--system-prompt="))) {
      pi.appendEntry("role-context", {
        event: "role_skip",
        role,
        reason: "system_prompt_flag",
      });
      return;
    }

    let template: RoleTemplate | undefined;
    try {
      template = getRoleTemplate(role);
    } catch (err) {
      pi.appendEntry("role-context", {
        event: "role_skip",
        role,
        reason: "load_error",
        error: String(err),
      });
      return;
    }
    if (!template) {
      pi.appendEntry("role-context", { event: "role_skip", role, reason: "unknown_role" });
      return;
    }

    const name = argValue(process.argv, "cname") || "agent";
    const rolePrompt = template.buildSystemPrompt(name);
    pi.appendEntry("role-context", {
      event: "role_injected",
      role,
      name,
      chars: rolePrompt.length,
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${rolePrompt}` };
  });
}
