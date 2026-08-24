/**
 * Regression test: a retried spawn of a live agent must fail BEFORE touching
 * its session file on disk.
 *
 * Old bug: executeAgentSpawn wrote the session file (truncating 'w' mode)
 * first, then ran the moduleAgents dedupe check. A same-name retry therefore
 * corrupted the live agent's session JSONL before throwing — the live pi
 * process keeps appending to that file, and a restart would recover a
 * truncated/mixed conversation.
 *
 * The test drives the real executeAgentSpawn with a fake `tmux` on PATH (and
 * TMUX_PANE set) so the full spawn path runs without a real tmux session.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAgentSpawn } from "../extensions/agent-lifecycle";
import { fakeSessionManagerCtor, forkSessionManager, freshSessionManager } from "./helpers/fake-session-manager";

const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE;
const ORIGINAL_PATH = process.env.PATH;

/**
 * Fake `tmux` binary: display-message echoes a session id (new-window's -t
 * target), new-window echoes a window id, everything else no-ops.
 */
function installFakeTmux(): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-tmux-"));
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/bash
if [ "$1" = "display-message" ]; then
  echo '$0'
  exit 0
fi
if [ "$1" = "new-window" ]; then
  echo "@999"
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
  try {
    // Fake tmux never created real windows, but clean the temp dir anyway.
    require("node:fs").rmSync(bin, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function fakeCtx(): any {
  return {
    model: { provider: "test", id: "test" },
    thinkingLevel: "off",
    sessionManager: freshSessionManager(),
  };
}

describe("executeAgentSpawn dedupe order", () => {
  afterEach(() => {
    // moduleAgents is module-level; a fresh process per test file, but be
    // explicit that later spawns here would see earlier ones.
  });

  test("same-name retry throws and does NOT touch the live session file", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = mkdtempSync(join(tmpdir(), "spawn-cwd-"));

      // First spawn WITH messages — writes a real session JSONL.
      const first = await executeAgentSpawn(
        {
          name: "worker-a",
          llmContext: {
            systemPrompt: "you are a worker",
            messages: [{ role: "user", content: "first task" }],
          },
        },
        cwd,
        fakeCtx(),
      );
      const sessionFile = (first.details as any).sessionFile as string;
      expect(existsSync(sessionFile)).toBe(true);
      const before = readFileSync(sessionFile, "utf-8");
      expect(before).toContain('"type":"session"');

      // Same-name retry with DIFFERENT messages must throw BEFORE any write.
      await expect(
        executeAgentSpawn(
          {
            name: "worker-a",
            llmContext: {
              systemPrompt: "you are a worker",
              messages: [{ role: "user", content: "overwrite attempt" }],
            },
          },
          cwd,
          fakeCtx(),
        ),
      ).rejects.toThrow(/already running/);

      // The live agent's session file is untouched (old bug: it would have
      // been overwritten with the retry's messages, or truncated to "").
      expect(readFileSync(sessionFile, "utf-8")).toBe(before);
      expect(before).toContain("first task");
      expect(before).not.toContain("overwrite attempt");

      // No .tmp residue from either spawn.
      const dir = readdirSync(join(cwd, ".pi", "agent-sessions"));
      expect(dir.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      uninstallFakeTmux(bin);
    }
  });

  test("same-name retry without messages also leaves the file intact", async () => {
    const bin = installFakeTmux();
    try {
      const cwd = mkdtempSync(join(tmpdir(), "spawn-cwd-"));

      // First spawn with messages (non-empty file), so a truncate would show.
      const first = await executeAgentSpawn(
        {
          name: "worker-b",
          llmContext: {
            systemPrompt: "you are a worker",
            messages: [{ role: "user", content: "keep me" }],
          },
        },
        cwd,
        fakeCtx(),
      );
      const sessionFile = (first.details as any).sessionFile as string;
      const before = readFileSync(sessionFile, "utf-8");

      // Retry with NO messages (the production TP path — llmContextFromRole
      // never preloads messages). Old bug: truncated the file to "" first.
      await expect(
        executeAgentSpawn({ name: "worker-b", llmContext: {} }, cwd, fakeCtx()),
      ).rejects.toThrow(/already running/);

      expect(readFileSync(sessionFile, "utf-8")).toBe(before);
    } finally {
      uninstallFakeTmux(bin);
    }
  });
});

test("fork spawn uses the forked session file; retry throws and adds no files", async () => {
  const bin = installFakeTmux();
  try {
    const cwd = mkdtempSync(join(tmpdir(), "spawn-fork-"));
    const sessionDir = join(cwd, ".pi", "agent-sessions");
    mkdirSync(sessionDir, { recursive: true });

    // Parent session fixture + a pre-created fork file the fake engine yields.
    const parentFile = join(sessionDir, "parent.json");
    writeFileSync(parentFile, '{"type":"session","version":3,"id":"p","cwd":"' + cwd + '"}\n');
    const forkFile = join(sessionDir, "forked.jsonl");
    writeFileSync(forkFile, '{"type":"session","version":3,"id":"f","cwd":"' + cwd + '"}\n');

    const ctx = { model: { provider: "test", id: "test" }, thinkingLevel: "off", sessionManager: forkSessionManager(parentFile, forkFile) };
    const first = await executeAgentSpawn(
      { name: "fork-worker", llmContext: { context: "fork", systemPrompt: "you are a fork" } },
      cwd,
      ctx,
    );
    const details = first.details as any;
    expect(details.sessionFile).toBe(forkFile);
    expect(details.forked).toBe(true);
    expect(details.context).toBe("fork");
    expect(existsSync(forkFile)).toBe(true);

    // Same-name retry must throw BEFORE creating anything new.
    const filesBefore = readdirSync(sessionDir).sort();
    await expect(
      executeAgentSpawn({ name: "fork-worker", llmContext: { context: "fork" } }, cwd, ctx),
    ).rejects.toThrow(/already running/);
    expect(readdirSync(sessionDir).sort()).toEqual(filesBefore);
  } finally {
    uninstallFakeTmux(bin);
  }
});

describe("writePreloadedSessionFile (fresh preload via SessionManager)", () => {
  test("preloads a v3 session with id chain, atomically, leaving no .tmp residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-file-"));
    const filePath = join(dir, "agent.json");

    // Pre-existing content (as if a dead agent's history or a live agent's
    // file was left behind).
    writeFileSync(filePath, '{"type":"old"}\n');

    const { writePreloadedSessionFile } = require("../extensions/lib/role-context/fork");
    writePreloadedSessionFile(
      filePath,
      {
        cwd: dir,
        model: { provider: "test", id: "test" },
        messages: [{ role: "user", content: "hello" }],
      },
      fakeSessionManagerCtor,
    );

    const out = readFileSync(filePath, "utf-8");
    // Fully replaced — no old content remains.
    expect(out).not.toContain('"type":"old"');
    expect(out.startsWith('{"type":"session"')).toBe(true);
    expect(out.trimEnd().split("\n").length).toBe(4); // header + model + thinking + 1 message

    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
