/**
 * Tests for role-aware spawn capability overrides (executeAgentSpawnByRole):
 * add_tools / exclude_tools / extra skills / exclude_default_skills / extra
 * extensions. Verifies the effective tool whitelist and the resolved skill /
 * extension paths are baked into the spawn result AND the launch script the
 * spawned agent runs (--role-tools, --skill, -e).
 *
 * Drives the real executeAgentSpawnByRole with a fake `tmux` on PATH (and
 * TMUX_PANE set) so the full spawn path runs without a real tmux session.
 * The fake tmux captures the `send-keys` payload (`exec bash <launch>`), so
 * the test reads the generated launch script and inspects its flags.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAgentSpawnByRole } from "../extensions/agent-lifecycle";
import { freshSessionManager } from "./helpers/fake-session-manager";

const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE;
const ORIGINAL_PATH = process.env.PATH;
let captureFile: string | null = null;

function installFakeTmux(): string {
  captureFile = join(mkdtempSync(join(tmpdir(), "cap-")), "cmd.txt");
  const bin = mkdtempSync(join(tmpdir(), "fake-tmux-"));
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/bash
if [ "$1" = "display-message" ]; then
  echo '$0'; exit 0
fi
if [ "$1" = "new-window" ]; then
  echo "@999"; exit 0
fi
if [ "$1" = "send-keys" ] && [ "$4" = "-l" ]; then
  # $5 is the 'exec bash <launch>' payload; record the launch path.
  echo "$5" > '${captureFile}'
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${ORIGINAL_PATH ?? ""}`;
  process.env.TMUX_PANE = "%0";
  return bin;
}

function uninstallFakeTmux(bin: string): void {
  process.env.PATH = ORIGINAL_PATH ?? "";
  if (ORIGINAL_TMUX_PANE === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = ORIGINAL_TMUX_PANE;
  if (captureFile) {
    try {
      rmSync(join(captureFile, ".."), { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/** Read the launch script the spawn produced (via the fake tmux capture). */
function lastLaunchScript(): string {
  const raw = readFileSync(captureFile!, "utf-8").trim();
  // "exec bash /tmp/.../launch-xxx.sh"
  const path = raw.split(" ").pop()!;
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf-8");
}

function fakeCtx(): any {
  return {
    model: { provider: "test", id: "test" },
    thinkingLevel: "off",
    sessionManager: freshSessionManager(),
  };
}

/** Build a temp repo with a role template and a skill dir. */
function buildFixture(): { cwd: string; home: string; skill: string; ext: string } {
  const cwd = mkdtempSync(join(tmpdir(), "role-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "role-home-"));
  fixtureDirs.push(cwd, home);
  const skill = join(cwd, ".pi", "skills", "demo-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "demo");
  const ext = join(cwd, "tool-ext.ts");
  writeFileSync(ext, "export default () => {}");
  const roles = join(cwd, ".pi", "roles");
  mkdirSync(roles, { recursive: true });
  // A role whose default tools include bash + read + comms_send and which
  // declares one skill and one extension. The test overrides these at spawn.
  writeFileSync(
    join(roles, "worker.md"),
    [
      "---",
      "role: worker",
      "label: Worker",
      "description: hands-on",
      "defaultTools: read,bash,comms_send",
      `skills: demo-skill`,
      `extensions: ./tool-ext.ts`,
      "---",
      "You are {{cname}}.",
      "",
    ].join("\n"),
  );
  return { cwd, home, skill, ext };
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const fixtureDirs: string[] = [];

describe("executeAgentSpawnByRole capability overrides", () => {
  test("computes effective whitelist = (defaultTools − exclude) ∪ add", async () => {
    const bin = installFakeTmux();
    try {
      const { cwd } = buildFixture();
      // CD so resolveRoleDirs picks up the fixture's .pi/roles via cwd.
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        const res = await executeAgentSpawnByRole(
          {
            role: "worker",
            name: "worker-x",
            excludeTools: ["bash"],
            addTools: ["write", "edit"],
          },
          cwd,
          fakeCtx(),
        );
        const details = res.details as Record<string, unknown>;
        expect(details.tools).toBe("read,comms_send,write,edit");
        // The launch script ships the SAME computed whitelist as --role-tools.
        const script = lastLaunchScript();
        expect(script).toContain("--role-tools 'read,comms_send,write,edit'");
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("adds extra skills and keeps role-declared ones by default", async () => {
    const bin = installFakeTmux();
    try {
      const { cwd } = buildFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        // The extra skill must exist on disk to resolve to an absolute path.
        mkdirSync(join(cwd, "extra-skill"), { recursive: true });
        writeFileSync(join(cwd, "extra-skill", "SKILL.md"), "extra");
        const res = await executeAgentSpawnByRole(
          { role: "worker", name: "worker-y", addSkills: [join(cwd, "extra-skill")] },
          cwd,
          fakeCtx(),
        );
        const details = res.details as Record<string, unknown>;
        const skills = details.skills as string[];
        expect(skills).toContain(join(cwd, ".pi", "skills", "demo-skill"));
        expect(skills).toContain(join(cwd, "extra-skill"));
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("excludeSkills drops the role-declared skills", async () => {
    const bin = installFakeTmux();
    try {
      const { cwd } = buildFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        const res = await executeAgentSpawnByRole(
          { role: "worker", name: "worker-z", excludeSkills: true },
          cwd,
          fakeCtx(),
        );
        const details = res.details as Record<string, unknown>;
        expect((details.skills as string[] | undefined) ?? []).not.toContain(
          join(cwd, ".pi", "skills", "demo-skill"),
        );
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("excludeExtensions drops the role-declared extensions but keeps added ones", async () => {
    const bin = installFakeTmux();
    try {
      const { cwd, ext } = buildFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        const addedExt = join(cwd, "added-ext.ts");
        writeFileSync(addedExt, "export default () => {}");
        const res = await executeAgentSpawnByRole(
          {
            role: "worker",
            name: "worker-e",
            excludeExtensions: true,
            addExtensions: [addedExt],
          },
          cwd,
          fakeCtx(),
        );
        const details = res.details as Record<string, unknown>;
        const exts = (details.extensions as string[] | undefined) ?? [];
        expect(exts).not.toContain(ext);
        expect(exts).toContain(addedExt);
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });
});
