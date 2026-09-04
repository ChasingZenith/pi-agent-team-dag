/**
 * Tests for the agent restart path (executeAgentRestart): resuming a dead
 * agent from its recorded execution_session JSONL, rebuilt from the spawn
 * manifest (role/tools/skills/extensions/model). Exercises:
 *   - spawn-by-role writes a spawn manifest beside the session;
 *   - executeAgentRestart reads the manifest, kills any stale window, and
 *     re-spawns the SAME name with `resumeFrom` pointing at the existing
 *     session (which is NOT truncated);
 *   - restart fails cleanly when the manifest or the session file is missing.
 *
 * Drives the real spawn/restart with a fake `tmux` on PATH (and TMUX_PANE set)
 * so the full path runs without a real tmux session; the fake captures the
 * `send-keys` `exec bash <launch>` payload so the launch script can be
 * inspected for `--role`, `--role-tools`, and `--session <existing>`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAgentRestart, executeAgentSpawnByRole } from "../extensions/agent-lifecycle";
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

function lastLaunchScript(): string {
  const raw = readFileSync(captureFile!, "utf-8").trim();
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

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A temp repo with a `worker` role so role-aware spawn works. */
function buildWorkerFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "restart-cwd-"));
  fixtureDirs.push(cwd);
  const roles = join(cwd, ".pi", "roles");
  mkdirSync(roles, { recursive: true });
  writeFileSync(
    join(roles, "worker.md"),
    [
      "---",
      "role: worker",
      "label: Worker",
      "description: hands-on",
      "defaultTools: read,write,bash,comms_send,task_read,task_start,task_submit_report",
      "---",
      "You are {{cname}}.",
      "",
    ].join("\n"),
  );
  return cwd;
}

describe("executeAgentRestart — resume a dead agent from its execution_session", () => {
  // All tests chdir into the fixture cwd so the role / skill / extension
  // resolution (which anchors <cwd>/.pi/roles) picks up the fixture's worker role.
  test("restarts the SAME name from the existing session, rebuilt from the spawn manifest", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = buildWorkerFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        // Pre-existing session JSONL (the dead agent's recorded execution_session).
        const sessionDir = join(cwd, ".pi", "agent-sessions");
        mkdirSync(sessionDir, { recursive: true });
        const recordedSession = join(sessionDir, "worker-1-xxxx.jsonl");
        const history = '{"type":"session","version":3,"id":"orig","cwd":"' + cwd + '"}\n';
        writeFileSync(recordedSession, history);

        // First spawn by role — writes the spawn manifest beside the session.
        const first = await executeAgentSpawnByRole(
          { role: "worker", name: "worker-1", addTools: ["tp_restart_agent"] },
          cwd,
          fakeCtx(),
        );
        // The spawn manifest is written at <agentFileStem(name)>.manifest.json —
        // discover it from the session dir rather than hardcoding the hash stem.
        const dirFiles = readdirSync(sessionDir);
        const manifestName = dirFiles.find((f) => f.endsWith(".manifest.json"))!;
        const manifestPath = join(sessionDir, manifestName);
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        expect(manifest.role).toBe("worker");
        expect(manifest.name).toBe("worker-1");
        expect(manifest.tools).toContain("tp_restart_agent");

        // Now simulate the worker dying: restart path kills stale state and
        // re-spawns the SAME name with resumeFrom = the recorded session.
        const res = await executeAgentRestart(
          { name: "worker-1", resumeFrom: recordedSession },
          cwd,
          fakeCtx(),
        );
        expect((res.details as any).restarted).toBe(true);
        expect((res.details as any).role).toBe("worker");
        expect((res.details as any).session_resumed_from).toBe(recordedSession);

        // The re-spawn launched with `--session <the recorded, UNTRUNCATED
        // history>`, `--role worker`, and the manifest's tool whitelist.
        const launch = lastLaunchScript();
        expect(launch).toContain("--role 'worker'");
        const sessionLine = launch.split(/\s+/).find((x) => x.includes("worker-1-xxxx.jsonl"));
        expect(sessionLine).toBeDefined();
        // The recorded session file was NOT truncated/replaced.
        expect(readFileSync(recordedSession, "utf-8")).toBe(history);
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("restart with add_tool not in the template keeps the override whitelist", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = buildWorkerFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        const sessionDir = join(cwd, ".pi", "agent-sessions");
        mkdirSync(sessionDir, { recursive: true });
        const recordedSession = join(sessionDir, "worker-2-xxxx.jsonl");
        writeFileSync(recordedSession, '{"type":"session"}\n');

        await executeAgentSpawnByRole(
          { role: "worker", name: "worker-2", addTools: ["tp_restart_agent"] },
          cwd,
          fakeCtx(),
        );

        const res = await executeAgentRestart(
          { name: "worker-2", resumeFrom: recordedSession },
          cwd,
          fakeCtx(),
        );
        expect((res.details as any).restarted).toBe(true);
        // The manifest's computed whitelist (with the added tool) survives.
        expect((res.details as any).tools).toContain("tp_restart_agent");
        const launch = lastLaunchScript();
        expect(launch).toContain("tp_restart_agent");
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("fails cleanly when there is no recorded spawn manifest", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = buildWorkerFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        const sessionDir = join(cwd, ".pi", "agent-sessions");
        mkdirSync(sessionDir, { recursive: true });
        const recordedSession = join(sessionDir, "nobody-xxxx.jsonl");
        writeFileSync(recordedSession, '{"type":"session"}\n');

        const res = await executeAgentRestart(
          { name: "nobody", resumeFrom: recordedSession },
          cwd,
          fakeCtx(),
        );
        expect((res.details as any).status).toBe("error");
        expect((res.content[0] as { text: string }).text).toMatch(/no spawn manifest/);
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("fails cleanly when the recorded session file is missing", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = buildWorkerFixture();
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        await executeAgentSpawnByRole({ role: "worker", name: "worker-3" }, cwd, fakeCtx());

        // Attempt a restart pointing at a session file that no longer exists.
        const missing = join(cwd, ".pi", "agent-sessions", "worker-3-xxxx.jsonl");
        expect(existsSync(missing)).toBe(false);
        await expect(
          executeAgentRestart({ name: "worker-3", resumeFrom: missing }, cwd, fakeCtx()),
        ).rejects.toThrow(/does not exist/);
      } finally {
        process.chdir(prev);
      }
    } finally {
      uninstallFakeTmux(bin);
    }
  });
});
