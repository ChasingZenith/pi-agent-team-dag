/**
 * Unit tests for lib/role-context/fork — the SessionManager-backed session
 * fork/preload module. Pure logic is tested with hand-built entry fixtures;
 * forkSession's engine (SessionManager) is injected as a fake, so these tests
 * cover OUR code (trim targeting, fallback materialization, sanitize, error
 * paths) — the real pi SessionManager integration is covered by the e2e
 * fork-probe and manual verification.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findForkTargetId,
  forkSession,
  writePreloadedSessionFile,
  type BranchEngine,
  type BranchEntry,
  type ParentSessionRef,
} from "../extensions/lib/role-context/fork";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal structural entry (model_change etc.). */
function structEntry(type: string, id: string, parentId: string | null): BranchEntry {
  return { type, id, parentId };
}

/** Message entry with optional content blocks / source. */
function msgEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: unknown[],
  source?: { provider?: string; api?: string; model?: string },
): BranchEntry {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content, ...source },
  };
}

/** comms inbound (delegation) entry. */
function inboundEntry(id: string, parentId: string | null): BranchEntry {
  return { type: "custom_message", id, parentId, customType: "comms-inbound" };
}

/** A typical delegating parent session: background → task → reply → latest. */
function parentFixture(): BranchEntry[] {
  return [
    structEntry("model_change", "mc", null),
    structEntry("thinking_level_change", "tl", "mc"),
    msgEntry("asst1", "tl", "assistant", [{ type: "text", text: "background work" }], { provider: "deepseek", model: "deepseek-v4-flash" }),
    structEntry("custom", "log1", "asst1"),
    inboundEntry("inbound1", "log1"),
    msgEntry("asst2", "inbound1", "assistant", [{ type: "text", text: "delegation reply" }]),
    inboundEntry("inbound2", "asst2"),
  ];
}

const HEADER = { type: "session", version: 3, id: "h", timestamp: "2026-08-08T00:00:00.000Z", cwd: "/tmp" };

// ---------------------------------------------------------------------------
// findForkTargetId
// ---------------------------------------------------------------------------

describe("findForkTargetId", () => {
  test("no inbound on the path → full inheritance (leafId)", () => {
    const entries = parentFixture().slice(0, 3); // mc, tl, asst1
    expect(findForkTargetId(entries, "asst1")).toBe("asst1");
  });

  test("last inbound trimmed → target is its last non-delegation ancestor", () => {
    const entries = parentFixture();
    // Last inbound is inbound2; its predecessor asst2 is kept (inbound1 is
    // older delegation history and remains — consistent with the cut-last-TP-
    // interaction semantics of the old fork-task-inject).
    expect(findForkTargetId(entries, "inbound2")).toBe("asst2");
  });

  test("single inbound at the end of the path → fork to before it (its predecessor)", () => {
    const entries = parentFixture().slice(0, 5); // mc, tl, asst1, log1, inbound1
    // inbound1's predecessor is the audit entry log1 — audit entries copy
    // into the fork (harmless: pi returns empty context for type "custom").
    expect(findForkTargetId(entries, "inbound1")).toBe("log1");
  });

  test("consecutive inbound entries are all trimmed together", () => {
    const entries = [
      ...parentFixture().slice(0, 3),
      inboundEntry("inbound1", "asst1"),
      inboundEntry("inbound2", "inbound1"),
    ];
    expect(findForkTargetId(entries, "inbound2")).toBe("asst1");
  });

  test("inbound is the first real entry (no message history) → null", () => {
    const entries = [
      structEntry("model_change", "mc", null),
      inboundEntry("inbound1", "mc"),
    ];
    expect(findForkTargetId(entries, "inbound1")).toBe(null);
  });

  test("whole path is delegation traffic → null", () => {
    const entries = [
      structEntry("model_change", "mc", null),
      inboundEntry("inbound1", "mc"),
      inboundEntry("inbound2", "inbound1"),
    ];
    expect(findForkTargetId(entries, "inbound2")).toBe(null);
  });

  test("leaf id not in the snapshot → leafId (let the engine resolve it)", () => {
    expect(findForkTargetId(parentFixture(), "ghost")).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// forkSession
// ---------------------------------------------------------------------------

function makeParent(opts: {
  file?: string;
  leafId?: string | null;
  engine?: BranchEngine;
}): ParentSessionRef {
  const base: ParentSessionRef = {
    getSessionFile: () => opts.file,
    getLeafId: () => opts.leafId ?? null,
  };
  if (opts.engine) base.openSession = () => opts.engine;
  return base;
}

/** Fake branch engine with a real on-disk forked file (or a controlled result). */
function makeEngine(opts: {
  entries: BranchEntry[];
  header?: unknown;
  /** Pre-write this file and return its path from createBranchedSession. */
  forkedFile?: string;
  /** Return this path WITHOUT writing it — pi defers persist → fallback path. */
  fallbackFile?: string;
  onBranch?: (target: string) => void;
}): BranchEngine & { branchedTargets: string[] } {
  const branchedTargets: string[] = [];
  const engine: BranchEngine = {
    createBranchedSession(target: string) {
      branchedTargets.push(target);
      if (opts.forkedFile) {
        writeFileSync(opts.forkedFile, "");
        return opts.forkedFile;
      }
      // pi returns the path string even when it defers the persist — the
      // FILE may be missing (branch without assistant message). Fallback
      // materialization triggers on !existsSync, not on undefined.
      return opts.fallbackFile ?? undefined;
    },
    getHeader: () => opts.header ?? HEADER,
    getEntries: () => opts.entries,
  };
  return Object.assign(engine, { branchedTargets });
}

describe("forkSession", () => {
  test("trims to before the last inbound and reports trimmed=true", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    const forkedFile = join(dir, "forked.jsonl");
    const engine = makeEngine({ entries: parentFixture(), forkedFile });
    const parent = makeParent({ file: parentFile, leafId: "inbound2", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    expect(result).not.toBeNull();
    expect(engine.branchedTargets).toEqual(["asst2"]);
    expect(result!.sessionFile).toBe(forkedFile);
    expect(result!.trimmed).toBe(true);
    expect(result!.fullInherit).toBe(false);
    expect(result!.materializedByFallback).toBe(false);
  });

  test("no inbound → full inheritance (leaf as target)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    const forkedFile = join(dir, "forked.jsonl");
    const engine = makeEngine({ entries: parentFixture().slice(0, 3), forkedFile });
    const parent = makeParent({ file: parentFile, leafId: "asst1", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    expect(engine.branchedTargets).toEqual(["asst1"]);
    expect(result!.fullInherit).toBe(true);
    expect(result!.trimmed).toBe(false);
  });

  test("nothing to inherit (whole path is delegation) → returns null, no branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    const engine = makeEngine({
      entries: [structEntry("model_change", "mc", null), inboundEntry("inbound1", "mc")],
    });
    const parent = makeParent({ file: parentFile, leafId: "inbound1", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    expect(result).toBeNull();
    expect(engine.branchedTargets).toEqual([]);
  });

  test("fallback materializes when the branch file was not written", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    // pi returns the path but defers the persist (no assistant in branch) →
    // file missing on disk → fallback materialization.
    const engine = makeEngine({
      entries: parentFixture().slice(0, 3),
      fallbackFile: join(dir, "not-materialized.jsonl"),
    });
    const parent = makeParent({ file: parentFile, leafId: "asst1", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    expect(result).not.toBeNull();
    expect(result!.materializedByFallback).toBe(true);
    expect(existsSync(result!.sessionFile)).toBe(true);
    const out = readFileSync(result!.sessionFile, "utf-8");
    const lines = out.trimEnd().split("\n");
    // header + model_change + thinking_level_change + asst1
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('"type":"session"');
    // pi's model_change is the tree root (parentId null); the rest chain.
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[1].parentId).toBeNull();
    for (let i = 2; i < parsed.length; i++) {
      expect(parsed[i].parentId).toBe(parsed[i - 1].id);
    }
  });

  test("fallback strips anthropic thinking blocks and appends thinking off", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    const entries: BranchEntry[] = [
      msgEntry("asstA", null, "assistant", [
        { type: "thinking", thinking: "secret", signature: "sig123" },
        { type: "text", text: "visible" },
      ], { provider: "anthropic", api: "anthropic-messages" }),
    ];
    const engine = makeEngine({ entries, fallbackFile: join(dir, "sanitized.jsonl") });
    const parent = makeParent({ file: parentFile, leafId: "asstA", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    const out = readFileSync(result!.sessionFile, "utf-8");
    const parsed = out.trimEnd().split("\n").map((l) => JSON.parse(l));
    const asst = parsed.find((e) => e.type === "message");
    expect(asst.message.content.map((b: any) => b.type)).toEqual(["text"]);
    // trailing thinking_level_change off entry
    const last = parsed[parsed.length - 1];
    expect(last.type).toBe("thinking_level_change");
    expect(last.thinkingLevel).toBe("off");
  });

  test("fallback keeps deepseek reasoning blocks untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const parentFile = join(dir, "parent.json");
    writeFileSync(parentFile, '{"type":"session"}\n');
    const entries: BranchEntry[] = [
      msgEntry("asstA", null, "assistant", [
        { type: "thinking", thinking: "reasoning...", thinkingSignature: "reasoning_content" },
        { type: "text", text: "answer" },
      ], { provider: "deepseek", api: "openai-completions" }),
    ];
    const engine = makeEngine({ entries, fallbackFile: join(dir, "deepseek.jsonl") });
    const parent = makeParent({ file: parentFile, leafId: "asstA", engine });

    const result = forkSession(parent, dir, { cwd: dir });
    const out = readFileSync(result!.sessionFile, "utf-8");
    const parsed = out.trimEnd().split("\n").map((l) => JSON.parse(l));
    const asst = parsed.find((e) => e.type === "message");
    expect(asst.message.content.map((b: any) => b.type)).toEqual(["thinking", "text"]);
  });

  test("errors: no session file / file missing / no leaf", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-test-"));
    const missingFile = join(dir, "missing.json");
    const existingFile = join(dir, "existing.json");
    writeFileSync(existingFile, '{"type":"session"}\n');

    expect(() =>
      forkSession(makeParent({ file: undefined, leafId: "x" }), dir, { cwd: dir }),
    ).toThrow(/no session file/);

    expect(() =>
      forkSession(makeParent({ file: missingFile, leafId: "x" }), dir, { cwd: dir }),
    ).toThrow(/does not exist/);

    expect(() =>
      forkSession(makeParent({ file: existingFile, leafId: null }), dir, { cwd: dir }),
    ).toThrow(/current leaf/);
  });
});

// ---------------------------------------------------------------------------
// writePreloadedSessionFile
// ---------------------------------------------------------------------------

/** Fake PreloadEngine recording append calls into memory, flushed by caller. */
function makePreloadEngine() {
  const calls: string[] = [];
  const entries: BranchEntry[] = [];
  const engine = {
    calls,
    open(_path: string, _sessionDir: string, cwd: string) {
      entries.length = 0;
      return {
        appendModelChange(provider: string, modelId: string): string {
          calls.push("model");
          entries.push({ type: "model_change", id: "mc", parentId: null, provider, modelId });
          return "mc";
        },
        appendThinkingLevelChange(level: string): string {
          calls.push("thinking");
          entries.push({ type: "thinking_level_change", id: "tl", parentId: "mc", thinkingLevel: level });
          return "tl";
        },
        appendMessage(message: unknown): string {
          calls.push("message");
          entries.push({ type: "message", id: `m${entries.length}`, parentId: "tl", message });
          return `m${entries.length}`;
        },
        getHeader: () => ({ type: "session", version: 3, id: "s", cwd }),
        getEntries: () => entries,
      };
    },
  };
  return engine;
}

describe("writePreloadedSessionFile", () => {
  test("writes v3 structure in append order, atomically, no .tmp residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "preload-test-"));
    const filePath = join(dir, "agent.json");
    writeFileSync(filePath, '{"type":"old"}\n'); // pre-existing → replaced

    const engine = makePreloadEngine();
    const out = writePreloadedSessionFile(
      filePath,
      {
        cwd: dir,
        model: { provider: "test", id: "test" },
        messages: [{ role: "user", content: "hello" }],
      },
      engine,
    );

    expect(out).toBe(filePath);
    expect(engine.calls).toEqual(["model", "thinking", "message"]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).not.toContain('"type":"old"');
    const lines = content.trimEnd().split("\n");
    expect(lines.length).toBe(4); // header + model + thinking + message
    expect(lines[0].startsWith('{"type":"session"')).toBe(true);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[1].type).toBe("model_change");
    expect(parsed[1].parentId).toBeNull(); // pi's model_change is the tree root
    expect(parsed[2].type).toBe("thinking_level_change");
    expect(parsed[3].message.content[0].text).toBe("hello");
    // id chain continuity (model_change root exempt)
    for (let i = 2; i < parsed.length; i++) {
      expect(parsed[i].parentId).toBe(parsed[i - 1].id);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("multiple messages append in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "preload-test-"));
    const filePath = join(dir, "agent.json");
    const engine = makePreloadEngine();
    writePreloadedSessionFile(
      filePath,
      {
        cwd: dir,
        model: { provider: "test", id: "test" },
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
      },
      engine,
    );
    expect(engine.calls).toEqual(["model", "thinking", "message", "message"]);
    const lines = readFileSync(filePath, "utf-8").trimEnd().split("\n");
    expect(lines.length).toBe(5); // header + model + thinking + 2 messages
  });
});
