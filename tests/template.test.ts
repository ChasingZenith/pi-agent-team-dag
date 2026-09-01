/**
 * Unit tests for lib/role-context/template — placeholder interpolation,
 * external role dir resolution, and capability references.
 *
 * The core regression: values are inserted literally. String.replace's
 * replacement-string semantics ($&, $', $`, $$) must never be interpreted,
 * since LLM-controlled values (agent names) flow straight into interpolate.
 *
 * External-dir tests inject RoleDirOptions (isolated cache key per dir set),
 * so no test touches the process's real cwd/home.
 *
 * Run: bun test tests/template.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  interpolate,
  listRoleNames,
  loadRoleTemplates,
  llmContextFromRole,
  resolveExtensionPath,
  resolveRoleDirs,
  resolveSkillPath,
  roleDirsFromArgv,
} from "../extensions/lib/role-context/template.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* never fail the suite on cleanup */ }
  }
});

/** Write a role template file with the given frontmatter fields. */
function writeRole(dir: string, file: string, fm: Record<string, string>, body = "You are {{displayName}}.") {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, file), `---\n${lines.join("\n")}\n---\n${body}\n`);
}

describe("interpolate", () => {
  it("replaces all occurrences of a placeholder", () => {
    expect(interpolate("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("{{a}} {{b}}", { a: "x" })).toBe("x {{b}}");
  });

  it("inserts dollar-containing values literally", () => {
    const t = "You are {{displayName}} ({{name}}), in region {{region}}";
    const vars = { displayName: "Foo$'", name: "Foo$'", region: "us-east-1" };
    expect(interpolate(t, vars)).toBe(
      "You are Foo$' (Foo$'), in region us-east-1",
    );
  });

  it("never interprets replacement-string sequences", () => {
    const t = "X{{name}}Y";
    for (const [name, want] of [
      ["A$&B", "XA$&BY"],
      ["A$$B", "XA$$BY"],
      ["A$'B", "XA$'BY"],
      ["A$`B", "XA$`BY"],
      ["A$1B", "XA$1BY"],
    ]) {
      expect(interpolate(t, { name })).toBe(want);
    }
  });
});

// ---------------------------------------------------------------------------
// Role directory resolution
// ---------------------------------------------------------------------------

describe("roleDirsFromArgv", () => {
  it("collects repeated flags in both --flag value and --flag=value forms", () => {
    expect(roleDirsFromArgv(["--role-dir", "a", "--role-dir=b", "--cname", "x", "--role-dir", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips a value that looks like a flag (it does not consume the next token)", () => {
    expect(roleDirsFromArgv(["--role-dir", "--other", "--role-dir", "x"])).toEqual(["x"]);
  });

  it("returns empty when absent", () => {
    expect(roleDirsFromArgv(["pi", "--role", "scout"])).toEqual([]);
  });
});

describe("resolveRoleDirs", () => {
  it("orders project, user, and built-in dirs with --role-dir first", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "roles"), { recursive: true });
    const dirs = resolveRoleDirs({ cwd, home });
    expect(dirs).toEqual([join(cwd, ".pi", "roles"), join(home, ".pi", "agent", "roles"), expect.stringMatching(/[\\/]roles$/)] );
  });

  it("absolutizes and dedupes --role-dir values, skipping missing ones", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    const drop = join(cwd, ".pi", "roles");
    mkdirSync(drop, { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "roles"), { recursive: true });
    const dirs = resolveRoleDirs({ cwd, home, roleDirs: ["/missing/dir", drop, join(cwd, ".", ".pi", "roles"), "rel-path"] });
    expect(dirs).toEqual([drop, join(home, ".pi", "agent", "roles"), expect.stringMatching(/[\\/]roles$/)]);
  });
});

// ---------------------------------------------------------------------------
// External role templates
// ---------------------------------------------------------------------------

describe("loadRoleTemplates with external dirs", () => {
  it("first-hit wins on the same role name, highest priority first", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    const extra = tmpDir("rc-extra-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "roles"), { recursive: true });
    // Same role in all three layers — lowest priority (user) first so each
    // layer proves it beats the next.
    writeRole(join(home, ".pi", "agent", "roles"), "web-searcher.md", {
      role: "web-searcher",
      label: "User Layer",
      defaultTools: "read",
    });
    writeRole(join(cwd, ".pi", "roles"), "web-searcher.md", {
      role: "web-searcher",
      label: "Project Layer",
      defaultTools: "read,grep",
    });
    writeRole(extra, "web-searcher.md", {
      role: "web-searcher",
      label: "Role-dir Layer",
      defaultTools: "read,grep,find",
    });

    const templates = loadRoleTemplates({ cwd, home, roleDirs: [extra] });
    const hit = templates.find((t) => t.role === "web-searcher")!;
    expect(hit.label).toBe("Role-dir Layer");
    expect(hit.defaultTools).toBe("read,grep,find");
    // The role appears exactly once in the catalog.
    expect(templates.filter((t) => t.role === "web-searcher").length).toBe(1);
    expect(listRoleNames().length).toBeGreaterThan(0); // default catalog still loads standalone
  });

  it("merges external-only roles into the catalog (teammate-provider still filtered from role_dirs)", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    writeRole(join(cwd, ".pi", "roles"), "night-shift.md", {
      role: "night-shift",
      label: "Night Shift",
      description: "Works while everyone sleeps.",
      defaultTools: "read",
    });
    const templates = loadRoleTemplates({ cwd, home });
    expect(templates.some((t) => t.role === "night-shift")).toBe(true);
  });

  it("expands {{include:frag}} from the external template's own directory", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "roles", "protocol.md"), "## Shared Protocol\nDo things in order.");
    writeRole(
      join(cwd, ".pi", "roles"),
      "reader.md",
      { role: "reader", defaultTools: "read" },
      "You are {{displayName}}.\n{{include:protocol}}",
    );
    const [t] = loadRoleTemplates({ cwd, home }).filter((t) => t.role === "reader");
    expect(t.buildSystemPrompt("reader")).toContain("## Shared Protocol");
  });

  it("caches per directory set (same opts share an instance, different opts do not)", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    writeRole(join(cwd, ".pi", "roles"), "reader.md", { role: "reader", defaultTools: "read" });
    const opts = { cwd, home };
    expect(loadRoleTemplates(opts)).toBe(loadRoleTemplates(opts));
    expect(loadRoleTemplates(opts)).not.toBe(loadRoleTemplates());
  });
});

// ---------------------------------------------------------------------------
// Capability references (skills: / extensions:)
// ---------------------------------------------------------------------------

describe("resolveSkillPath", () => {
  it("resolves bare names through the four skill locations (project first)", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "skills", "alpha"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", "alpha", "SKILL.md"), "alpha root");
    mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "beta.md"), "beta as file");
    mkdirSync(join(home, ".pi", "agent", "skills", "gamma"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "skills", "gamma", "SKILL.md"), "gamma");
    mkdirSync(join(home, ".agents", "skills", "delta"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "delta", "SKILL.md"), "delta nested");

    expect(resolveSkillPath("alpha", { cwd, home })).toBe(join(cwd, ".pi", "skills", "alpha"));
    expect(resolveSkillPath("beta", { cwd, home })).toBe(join(cwd, ".agents", "skills", "beta.md"));
    expect(resolveSkillPath("gamma", { cwd, home })).toBe(join(home, ".pi", "agent", "skills", "gamma"));
    expect(resolveSkillPath("delta", { cwd, home })).toBe(join(home, ".agents", "skills", "delta"));
    expect(resolveSkillPath("missing", { cwd, home })).toBe(null);
  });

  it("prefers <name>/SKILL.md over <name>.md in the same location", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "skills", "both"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", "both", "SKILL.md"), "dir wins");
    writeFileSync(join(cwd, ".pi", "skills", "both.md"), "file loses");
    expect(resolveSkillPath("both", { cwd, home })).toBe(join(cwd, ".pi", "skills", "both"));
  });

  it("accepts literal paths (/ and ~) with an existence check", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    const abs = join(cwd, "my-skill");
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(home, "mine"), { recursive: true });
    expect(resolveSkillPath(abs, { cwd, home })).toBe(abs);
    expect(resolveSkillPath("~/mine", { cwd, home })).toBe(join(home, "mine"));
    expect(resolveSkillPath("/nope", { cwd, home })).toBe(null);
  });
});

describe("resolveExtensionPath", () => {
  it("resolves relative refs against cwd and rejects missing files", () => {
    const cwd = tmpDir("rc-cwd-");
    writeFileSync(join(cwd, "ext.ts"), "export default () => {}");
    expect(resolveExtensionPath("./ext.ts", cwd)).toBe(join(cwd, "ext.ts"));
    expect(resolveExtensionPath("ext.ts", cwd)).toBe(join(cwd, "ext.ts"));
    expect(resolveExtensionPath("missing.ts", cwd)).toBe(null);
    expect(resolveExtensionPath("/abs/thing.ts", cwd)).toBe(null); // literal, but absent
  });
});

describe("role template capability fields", () => {
  it("populates skillPaths/extensionPaths and warns for unresolved refs", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "skills", "playwright"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", "playwright", "SKILL.md"), "pw");
    writeFileSync(join(cwd, "ext.ts"), "export default () => {}");

    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    writeRole(join(cwd, ".pi", "roles"), "sweeper.md", {
      role: "sweeper",
      skills: "playwright, absent-skill",
      extensions: "./ext.ts,/absent",
    });

    const [t] = loadRoleTemplates({ cwd, home }).filter((t) => t.role === "sweeper");
    expect(t.skillPaths).toEqual([join(cwd, ".pi", "skills", "playwright")]);
    expect(t.extensionPaths).toEqual([join(cwd, "ext.ts")]);
    expect(t.capabilityWarnings.length).toBe(2);
    expect(t.capabilityWarnings[0]).toContain("absent-skill");
    expect(t.capabilityWarnings[1]).toContain("/absent");
  });

  it("leaves capability fields absent when nothing is declared", () => {
    const cwd = tmpDir("rc-cwd-");
    const home = tmpDir("rc-home-");
    mkdirSync(join(cwd, ".pi", "roles"), { recursive: true });
    writeRole(join(cwd, ".pi", "roles"), "plain.md", { role: "plain", defaultTools: "read" });
    const [t] = loadRoleTemplates({ cwd, home }).filter((t) => t.role === "plain");
    expect(t.skillPaths).toEqual([]);
    expect(t.extensionPaths).toEqual([]);
    expect(t.capabilityWarnings).toEqual([]);
  });
});
