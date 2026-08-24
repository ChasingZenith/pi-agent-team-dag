/**
 * lib/role-context/template — Agent context, definitions, and role templates
 *
 * Unified module for everything about "what agents exist and how to set them up":
 * - LLMContext: self-contained initial context for spawned agents
 * - llmContextFromRole: build LLMContext from a role template
 * - Scan agent definition files (.pi/agents/*.md, agents/*.md, .claude/agents/*.md)
 * - Load role templates (lib/role-context/roles/ tree: manager/ + specialist/)
 * - Build system prompts from templates
 *
 * Used by: agent-lifecycle, teammate-provider, coordinator
 *
 * Does NOT:
 * - Spawn agents (that's the lifecycle job)
 * - Communicate via comms (that's comms's job)
 * - Orchestrate tasks (that's the Coordinator's job)
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed agent definition from a .md file. */
export interface AgentDef {
  name: string;
  description: string;
  tools: string;
  systemPrompt: string;
  /** Optional role tag from frontmatter. */
  role?: string;
  /** Source file path (empty for dynamic agents). */
  file: string;
}

/** A loaded role template (from lib/role-context/roles/*.md). */
export interface RoleTemplate {
  role: string;
  label: string;
  description: string;
  defaultTools: string;
  /** Build a full system prompt for a new agent of this role. */
  buildSystemPrompt: (name: string, tools: string) => string;
}

/**
 * Self-contained initial LLM context for a spawned agent.
 *
 * agent_spawn applies this context as-is. Use the appropriate builder to
 * construct one:
 *
 * - `llmContextFromRole()`   → template-based (fresh agent from role)
 */
export interface LLMContext {
  /** System prompt. Passed via --system-prompt flag to pi. */
  systemPrompt?: string;
  /**
   * Initial conversation messages, written to the session JSONL via pi's
   * SessionManager (writePreloadedSessionFile). IGNORED when context is
   * "fork" — the task is delivered after spawn via comms_send.
   *
   * No current builder sets this; only set when a caller wants a preloaded
   * conversation (an LLM calling agent_spawn directly, or tests).
   */
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Role template name (e.g. "scout", "worker"). Set at spawn, passed as --role. */
  role?: string;
  /**
   * Context source for the spawned agent's session:
   * - "fresh" (default): clean session — empty (pi bootstraps) or preloaded
   *   from `messages`. Template-built contexts (llmContextFromRole) never set
   *   this, preserving the isolation principle (spawned agents do not inherit
   *   the spawner's conversation).
   * - "fork": inherit the spawner's own session via
   *   SessionManager.createBranchedSession, trimmed to BEFORE the last
   *   comms-inbound (delegation) message — the child sees the task
   *   background, not the delegation dialogue. `messages` is ignored.
   */
  context?: "fresh" | "fork";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function displayName(name: string): string {
  return name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Agent file scanning
// ---------------------------------------------------------------------------

/** Parse a single agent .md file (YAML frontmatter + Markdown body). */
export function parseAgentFile(filePath: string): AgentDef | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;
    const fm: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (!fm.name) return null;
    return {
      name: fm.name,
      description: fm.description || "",
      tools: fm.tools || "read,grep,find,ls",
      systemPrompt: match[2].trim(),
      role: fm.role,
      file: filePath,
    };
  } catch {
    return null;
  }
}

/** Scan all known agent definition directories. */
export function scanAgentDirs(cwd: string): AgentDef[] {
  const dirs = [
    join(cwd, "agents"),
    join(cwd, ".claude", "agents"),
    join(cwd, ".pi", "agents"),
  ];
  const agents: AgentDef[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const def = parseAgentFile(resolve(dir, file));
        if (def && !seen.has(def.name.toLowerCase())) {
          seen.add(def.name.toLowerCase());
          agents.push(def);
        }
      }
    } catch { /* skip */ }
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Role template loading (from the lib/role-context/roles/ tree)
// ---------------------------------------------------------------------------

function rolesDir(): string {
  return resolve(
    import.meta.dirname ?? join(import.meta.url.replace("file://", ""), ".."),
    "roles",
  );
}

/** Recursively collect *.md files under a directory (role templates + include fragments). */
function walkMdFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMdFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

/**
 * Expand {{include:<name>}} references in a template body.
 *
 * The fragment is resolved as <name>.md in the same directory as the
 * referencing template (no cross-directory lookup — fragments live next to
 * the roles that include them). Inlined before {{placeholder}} interpolation,
 * so fragments may use placeholders themselves; nested includes are expanded
 * recursively, with a cycle guard that drops re-entrant tokens.
 */
function expandIncludes(template: string, dir: string, seen = new Set<string>()): string {
  return template.replace(/\{\{include:([a-zA-Z0-9_-]+)\}\}/g, (_m, name: string) => {
    if (seen.has(name)) return "";
    try {
      const raw = readFileSync(join(dir, `${name}.md`), "utf-8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const body = match ? match[2].trim() : raw.trim();
      const next = new Set(seen);
      next.add(name);
      return expandIncludes(body, dir, next);
    } catch {
      // Fragment missing — leave the token inert (it matches no placeholder key).
      return `{{include:${name}}}`;
    }
  });
}

let _roleTemplates: RoleTemplate[] | null = null;

/**
 * Load all role templates from the lib/role-context/roles/ tree
 * (manager/ + specialist/). Files without a `role` frontmatter field are
 * include fragments, not roles — skipped here, available to {{include:...}}.
 */
export function loadRoleTemplates(): RoleTemplate[] {
  if (_roleTemplates) return _roleTemplates;

  const dir = rolesDir();
  const templates: RoleTemplate[] = [];

  for (const file of walkMdFiles(dir)) {
    try {
      const raw = readFileSync(file, "utf-8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) continue;

      const fm: Record<string, string> = {};
      for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }

      const role = fm.role;
      if (!role) continue;

      // Expand includes from the referencing file's directory BEFORE
      // interpolation, so fragment placeholders resolve in the same pass.
      const promptTemplate = expandIncludes(match[2].trim(), dirname(file));

      const label = fm.label || role;
      const description = fm.description || "";
      const defaultTools = fm.defaultTools || "read,grep,find,ls";

      templates.push({
        role,
        label,
        description,
        defaultTools,
        buildSystemPrompt(name, toolsOverride) {
          const tools = toolsOverride || defaultTools;
          const roleCatalog = buildRoleCatalog();
          return interpolate(promptTemplate, {
            displayName: displayName(name),
            name,
            tools,
            tp_name: "teammate-provider",
            role_catalog: roleCatalog,
          });
        },
      });
    } catch { /* skip */ }
  }

  _roleTemplates = templates;
  return templates;
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Role name → template lookup. */
export function getRoleTemplate(role: string): RoleTemplate | undefined {
  return loadRoleTemplates().find((t) => t.role === role);
}

/** Ordered role name list. */
export function listRoleNames(): string[] {
  return loadRoleTemplates().map((t) => t.role);
}

/** Human-readable role catalog for system prompts. */
export function buildRoleCatalog(): string {
  return loadRoleTemplates()
    // The TP is the registry itself, not a spawnable teammate — it must not
    // appear in the catalog the TP uses to pick spawn roles (it must never
    // spawn a second TP).
    .filter((t) => t.role !== "teammate-provider")
    .map(
      (t) =>
        `- **${t.label}** (\`${t.role}\`): ${t.description}\n  Default tools: ${t.defaultTools}`,
    )
    .join("\n");
}

/** Build a system prompt for a new agent from a role template. */
export function buildAgentPrompt(
  role: string,
  name: string,
  toolsOverride?: string,
): string | null {
  const template = getRoleTemplate(role);
  if (!template) return null;
  const tools = toolsOverride || template.defaultTools;
  return template.buildSystemPrompt(name, tools);
}

// ---------------------------------------------------------------------------
// Generic {{placeholder}} interpolation
// ---------------------------------------------------------------------------

/**
 * Replace {{placeholders}} in a template string.
 *
 *   interpolate("{{greeting}}, {{name}}!", { greeting: "Hello", name: "World" })
 *   // => "Hello, World!"
 *
 * Values are inserted literally via split/join — String.replace's
 * replacement-string semantics ($&, $', $$) are never interpreted, so
 * LLM-controlled values like a name "Foo$'" stay intact instead of echoing
 * the template tail into the prompt.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLMContext builders
// ---------------------------------------------------------------------------

/**
 * Build an LLMContext from a role template: a clean, template-based context
 * for a new agent with the given role. No task message is preloaded — the
 * task is delivered after spawn via comms_send.
 *
 * Used by: Teammate Provider when spawning new agents.
 */
export function llmContextFromRole(
  role: string,
  name: string,
  tools?: string,
): LLMContext | null {
  const template = getRoleTemplate(role);
  if (!template) return null;

  const systemPrompt = buildAgentPrompt(role, name, tools);

  return {
    systemPrompt: systemPrompt ?? undefined,
    role,
  };
}

// ---------------------------------------------------------------------------
// Session path template
// ---------------------------------------------------------------------------

/** Template for agent session file path. */
export const SESSION_PATH = "{{sessionDir}}/{{agentName}}.json";
