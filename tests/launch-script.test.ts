/**
 * Unit tests for lib/launch-script — the bash script builder that boots
 * spawned pi agents in tmux windows.
 *
 * Regression focus: the spawned pi resolves relative -e paths against ITS
 * OWN cwd (the spawner's), so extension flags must be absolute — otherwise
 * spawning from outside the project root (e.g. a tmux session opened in
 * $HOME) boots agents that die before ever registering on the comms hub.
 *
 * Run: bun test tests/launch-script.test.ts
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunchScript } from "../extensions/lib/launch-script";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Spawner cwd deliberately OUTSIDE the repo — the failure mode under test. */
const SPAWNER_CWD = "/tmp/not-the-repo";

function build(overrides: Record<string, unknown> = {}) {
  return buildLaunchScript({
    cwd: SPAWNER_CWD,
    agentName: "worker-1",
    model: "deepseek-v4-flash/chat",
    sessionFile: "/tmp/agent-sessions/worker-1.json",
    autoExit: false,
    ...overrides,
  } as never);
}

/** Strip one layer of single quotes (sq()-generated values). */
function unquote(t: string): string {
  return t.startsWith("'") && t.endsWith("'") && t.length >= 2 ? t.slice(1, -1) : t;
}

/** Extract the values of every `-e <path>` flag from the exec line. */
function extensionFlags(script: string): string[] {
  const tokens = script.trim().split(" ");
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-e") flags.push(unquote(tokens[i + 1]));
  }
  return flags;
}

/** Extract the value of the FIRST `--skill <path>` flag from the exec line. */
function skillFlag(script: string): string | undefined {
  return skillFlags(script)[0];
}

/** Extract the values of every `--skill <path>` flag, in order. */
function skillFlags(script: string): string[] {
  const tokens = script.trim().split(" ");
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--skill") flags.push(unquote(tokens[i + 1]));
  }
  return flags;
}

/** Extract the values of every `--role-dir <path>` flag, in order. */
function roleDirFlags(script: string): string[] {
  const tokens = script.trim().split(" ");
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--role-dir") flags.push(unquote(tokens[i + 1]));
  }
  return flags;
}

describe("buildLaunchScript", () => {
  it("cds to the spawner's working directory", () => {
    const script = build();
    expect(script.split("\n")[2]).toBe(`cd '${SPAWNER_CWD}'`);
  });

  it("passes every extension as an absolute path inside the repo", () => {
    const flags = extensionFlags(build());
    expect(flags.length).toBe(5);
    for (const flag of flags) {
      expect(flag.startsWith("/")).toBe(true);
      expect(flag.startsWith(REPO_ROOT)).toBe(true);
      // The absolute path must actually resolve — a wrong base dir would
      // still be absolute but would boot a broken agent.
      expect(existsSync(flag)).toBe(true);
    }
  });

  it("keeps the extension load order (dependency order)", () => {
    const flags = extensionFlags(build());
    expect(flags.map((f) => f.replace(`${REPO_ROOT}/extensions/`, ""))).toEqual([
      "comms.ts",
      "task-graph.ts",
      "task-comms-ops.ts",
      "role-context.ts",
      "auto-exit.ts",
    ]);
  });

  it("passes --skill as an absolute path inside the repo", () => {
    const flag = skillFlag(build());
    expect(flag).toBeDefined();
    expect(flag!.startsWith("/")).toBe(true);
    expect(flag!.startsWith(REPO_ROOT)).toBe(true);
    expect(existsSync(flag!)).toBe(true);
  });

  it("still passes identity/session/model flags", () => {
    const script = build({
      autoExit: true,
      subnet: "subnet0",
      systemPrompt: "you are a worker",
      role: "worker",
    });
    expect(script).toContain("--cname 'worker-1'");
    expect(script).toContain("--session '/tmp/agent-sessions/worker-1.json'");
    expect(script).toContain("--model 'deepseek-v4-flash/chat'");
    expect(script).toContain("--subnet 'subnet0'");
    expect(script).toContain("--system-prompt 'you are a worker'");
    expect(script).toContain("--role 'worker'");
    expect(script).toContain("PI_AGENT_AUTO_EXIT=1");
    expect(script).toContain("PI_AGENT_NAME='worker-1'");
  });

  it("appends role-declared skills after the project --skill, in order", () => {
    const script = build({ skills: ["/abs/s1", "/abs/s2"] });
    const flags = skillFlags(script);
    expect(flags).toEqual([join(REPO_ROOT, ".pi", "skills"), "/abs/s1", "/abs/s2"]);
    for (const flag of flags) expect(flag.startsWith("/")).toBe(true);
  });

  it("omits role skills when none are declared", () => {
    expect(skillFlags(build())).toEqual([join(REPO_ROOT, ".pi", "skills")]);
  });

  it("dedupes a role skill that resolves to the project skills dir", () => {
    const projectSkills = join(REPO_ROOT, ".pi", "skills");
    expect(skillFlags(build({ skills: [projectSkills] })).length).toBe(1);
  });

  it("appends role-declared extensions after the plugin chain", () => {
    const script = build({ extensions: ["/abs/ext.ts", "/abs/ext-2.ts"] });
    const flags = extensionFlags(script);
    expect(flags.length).toBe(7);
    expect(flags.slice(-2)).toEqual(["/abs/ext.ts", "/abs/ext-2.ts"]);
    for (const flag of flags) expect(flag.startsWith("/")).toBe(true);
  });

  it("keeps exactly the 5 plugin -e flags when no role extensions are declared", () => {
    expect(extensionFlags(build()).length).toBe(5);
  });

  it("passes --role-dir flags verbatim after --subnet", () => {
    const script = build({ roleDirs: ["/abs/roles-a", "/abs/roles-b"] });
    expect(roleDirFlags(script)).toEqual(["/abs/roles-a", "/abs/roles-b"]);
    for (const flag of roleDirFlags(script)) expect(flag.startsWith("/")).toBe(true);
    // Order: --subnet (absent here) block precedes the role-dir group.
    expect(script.indexOf("--role-dir")).toBeGreaterThan(script.indexOf("--cname"));
  });

  it("omits --role-dir flags when absent", () => {
    expect(roleDirFlags(build())).toEqual([]);
  });

  it("emits --role-tools as a csv when a computed whitelist is provided", () => {
    const script = build({ role: "worker", tools: ["read", "write", "bash", "comms_send"] });
    expect(script).toContain("--role-tools 'read,write,bash,comms_send'");
  });

  it("omits --role-tools when no explicit whitelist is provided", () => {
    const script = build({ role: "worker" });
    expect(script).not.toContain("--role-tools");
  });
});
