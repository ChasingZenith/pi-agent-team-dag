/**
 * lib/role-context/template — Agent context, definitions, and role templates
 *
 * Unified module for everything about "what agents exist and how to set them up":
 * - LLMContext: self-contained initial context for spawned agents
 * - llmContextFromRole: build LLMContext from a role template
 * - Scan agent definition files (.pi/agents/*.md, agents/*.md, .claude/agents/*.md)
 * - Load role templates (built-in lib/role-context/roles/ tree, plus external
 *   dirs: --role-dir flags, <cwd>/.pi/roles, <home>/.pi/agent/roles — highest
 *   priority first; same-named roles are replaced by the first hit)
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
import { homedir } from "node:os";
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

/** A loaded role template (from a role template directory). */
export interface RoleTemplate {
  role: string;
  label: string;
  description: string;
  defaultTools: string;
  /**
   * Absolute skill paths resolved from the frontmatter `skills:` field
   * (skill directory or <name>.md). Empty when nothing was declared.
   */
  skillPaths: string[];
  /**
   * Absolute extension paths resolved from the frontmatter `extensions:`
   * field. Empty when nothing was declared.
   */
  extensionPaths: string[];
  /** Warnings collected while resolving capabilities (unresolved references). */
  capabilityWarnings: string[];
  /** Build a full system prompt for a new agent of this role. */
  buildSystemPrompt: (name: string) => string;
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
  /**
   * Absolute skill paths (skill directory or <name>.md) passed to the spawned
   * pi via `--skill` (repeatable). Set from a role template's `skills:` field.
   */
  skills?: string[];
  /** Absolute extension paths passed via `-e` (repeatable). Set from a role template's `extensions:` field. */
  extensions?: string[];
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

// ---------------------------------------------------------------------------
// Role directory resolution
// ---------------------------------------------------------------------------

/** Options controlling where role templates are loaded from. */
export interface RoleDirOptions {
  /** Anchor for `<cwd>/.pi/roles` and relative path resolution. Defaults to process.cwd(). */
  cwd?: string;
  /** `--role-dir` values (in order). Defaults to roleDirsFromArgv(process.argv). */
  roleDirs?: string[];
  /** Anchor for `<home>/.pi/agent/roles`. Defaults to os.homedir(); tests inject. */
  home?: string;
}

/**
 * Collect every `--role-dir <v>` / `--role-dir=<v>` from argv, in order.
 * Repeatable; values may be relative. Skips a value that starts with "-"
 * (it is a flag, not this flag's value).
 */
export function roleDirsFromArgv(argv: string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--role-dir") {
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) {
        dirs.push(value);
        i++;
      }
    } else if (arg.startsWith("--role-dir=")) {
      dirs.push(arg.slice("--role-dir=".length));
    }
  }
  return dirs;
}

/**
 * Ordered role template directories, highest priority first:
 *   --role-dir values → <cwd>/.pi/roles → <home>/.pi/agent/roles → built-in
 *   lib/role-context/roles/
 *
 * All paths are absolutized against cwd and deduped. Non-existent dirs are
 * skipped; a missing `--role-dir` target warns once (a typo must not silently
 * fall back to the built-ins, while an absent project/user level is normal).
 */
export function resolveRoleDirs(opts?: RoleDirOptions): string[] {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();

  const dirs: string[] = [];
  const pushIfExists = (dir: string, warnOnMissing: boolean) => {
    if (!existsSync(dir)) {
      if (warnOnMissing) roleWarn(`--role-dir "${dir}" does not exist (skipped)`);
      return;
    }
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  for (const d of opts?.roleDirs ?? roleDirsFromArgv(process.argv)) {
    pushIfExists(resolve(cwd, d), true);
  }
  pushIfExists(join(cwd, ".pi", "roles"), false); // project level
  pushIfExists(join(home, ".pi", "agent", "roles"), false); // user level
  dirs.push(rolesDir()); // built-in fallback — always exists, always last

  return dirs;
}

// ---------------------------------------------------------------------------
// Warnings (capability resolution + role dir quirks)
// ---------------------------------------------------------------------------

let _roleWarn: (msg: string) => void = (msg) => console.warn(`[role-context] ${msg}`);

/** Install a warning writer (default console.warn). Extensions wire audit entries here. */
export function setRoleWarn(fn: (msg: string) => void): void {
  _roleWarn = fn;
}

/** Emit a best-effort warning — never throws. */
export function roleWarn(msg: string): void {
  try {
    _roleWarn(msg);
  } catch { /* audit must never break loading */ }
}

// ---------------------------------------------------------------------------
// Role template loading
// ---------------------------------------------------------------------------

const _roleTemplatesCache = new Map<string, RoleTemplate[]>();

/**
 * Load all role templates from the resolved role directory list. Files
 * without a `role` frontmatter field are include fragments, not roles —
 * skipped here, available to {{include:...}}.
 *
 * Default resolution (no opts) uses process.cwd() / process.argv /
 * os.homedir() and is cached per directory set for the process lifetime —
 * adding role files mid-session does not hot-reload. Tests inject opts for
 * an isolated key.
 */
export function loadRoleTemplates(opts?: RoleDirOptions): RoleTemplate[] {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const dirs = resolveRoleDirs({ cwd, roleDirs: opts?.roleDirs, home });
  const key = dirs.join("\0");
  const hit = _roleTemplatesCache.get(key);
  if (hit) return hit;

  const templates: RoleTemplate[] = [];
  const seen = new Set<string>(); // first-wins per role name

  for (const dir of dirs) {
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
        if (seen.has(role)) continue; // higher-priority dir already defined it
        seen.add(role);

        // Expand includes from the referencing file's directory BEFORE
        // interpolation, so fragment placeholders resolve in the same pass.
        const promptTemplate = expandIncludes(match[2].trim(), dirname(file));

        const label = fm.label || role;
        const description = fm.description || "";
        const defaultTools = fm.defaultTools || "read,grep,find,ls";
        const { skillPaths, extensionPaths, capabilityWarnings } =
          resolveCapabilities(fm, { cwd, home });

        templates.push({
          role,
          label,
          description,
          defaultTools,
          skillPaths,
          extensionPaths,
          capabilityWarnings,
          buildSystemPrompt(name) {
            const roleCatalog = buildRoleCatalog();
            return interpolate(promptTemplate, {
              cname: name,
              tp_name: "teammate-provider",
              role_catalog: roleCatalog,
            });
          },
        });
      } catch { /* skip */ }
    }
  }

  _roleTemplatesCache.set(key, templates);
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
export function buildAgentPrompt(role: string, name: string): string | null {
  const template = getRoleTemplate(role);
  if (!template) return null;
  return template.buildSystemPrompt(name);
}

// ---------------------------------------------------------------------------
// Capability references (skills: / extensions: frontmatter fields)
// ---------------------------------------------------------------------------

/** Split a frontmatter list value on commas, trim, drop empties. */
function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a `skills:` reference to an absolute path.
 *
 * Literal paths (`/`, `~` prefixes) are used as-is after an existence check.
 * Bare names search the standard skill locations in order (project first):
 *   <cwd>/.pi/skills/<name> (SKILL.md dir, then <name>.md),
 *   <cwd>/.agents/skills/, <home>/.pi/agent/skills/, <home>/.agents/skills/.
 * Returns null when nothing matched.
 */
export function resolveSkillPath(
  ref: string,
  opts: { cwd: string; home?: string },
): string | null {
  const home = opts.home ?? homedir();
  if (ref.startsWith("/")) return existsSync(ref) ? ref : null;
  if (ref.startsWith("~")) {
    const abs = join(home, ref.slice(1));
    return existsSync(abs) ? abs : null;
  }
  const bases = [
    join(opts.cwd, ".pi", "skills"),
    join(opts.cwd, ".agents", "skills"),
    join(home, ".pi", "agent", "skills"),
    join(home, ".agents", "skills"),
  ];
  for (const base of bases) {
    const dir = join(base, ref);
    if (existsSync(join(dir, "SKILL.md"))) return dir; // <name>/SKILL.md dir wins
    const file = join(base, `${ref}.md`);
    if (existsSync(file)) return file; // <name>.md fallback
  }
  return null;
}

/**
 * Resolve an `extensions:` reference to an absolute path. Relative paths are
 * anchored at cwd (the spawner's working directory); `~` expands to homedir.
 * Returns null when the file/dir does not exist.
 */
export function resolveExtensionPath(ref: string, cwd: string): string | null {
  const abs = ref.startsWith("~") ? join(homedir(), ref.slice(1)) : resolve(cwd, ref);
  return existsSync(abs) ? abs : null;
}

/**
 * Parse the `skills:` / `extensions:` frontmatter lists into absolute paths.
 * Each unresolved reference is collected as a warning (skipped, spawn proceeds
 * with the rest of the capabilities).
 */
function resolveCapabilities(
  fm: Record<string, string>,
  opts: { cwd: string; home: string },
): { skillPaths: string[]; extensionPaths: string[]; capabilityWarnings: string[] } {
  const capabilityWarnings: string[] = [];
  const skillPaths: string[] = [];
  for (const ref of parseList(fm.skills)) {
    const abs = resolveSkillPath(ref, opts);
    if (abs) skillPaths.push(abs);
    else {
      capabilityWarnings.push(`skill "${ref}" not found (project/user skill dirs searched); skipped`);
      roleWarn(`role "${fm.role}": skill "${ref}" not found; skipped`);
    }
  }
  const extensionPaths: string[] = [];
  for (const ref of parseList(fm.extensions)) {
    const abs = resolveExtensionPath(ref, opts.cwd);
    if (abs) extensionPaths.push(abs);
    else {
      capabilityWarnings.push(`extension "${ref}" not found; skipped`);
      roleWarn(`role "${fm.role}": extension "${ref}" not found; skipped`);
    }
  }
  return { skillPaths, extensionPaths, capabilityWarnings };
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
export function llmContextFromRole(role: string, name: string): LLMContext | null {
  const template = getRoleTemplate(role);
  if (!template) return null;

  const systemPrompt = buildAgentPrompt(role, name);

  return {
    systemPrompt: systemPrompt ?? undefined,
    role,
    ...(template.skillPaths.length ? { skills: template.skillPaths } : {}),
    ...(template.extensionPaths.length ? { extensions: template.extensionPaths } : {}),
  };
}

// ---------------------------------------------------------------------------
// Session path template
// ---------------------------------------------------------------------------

/** Template for agent session file path. */
export const SESSION_PATH = "{{sessionDir}}/{{agentName}}.json";
