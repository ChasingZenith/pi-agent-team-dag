/**
 * lib/role-context/fork — Session creation and forking via pi's SessionManager
 *
 * All session format work (ULID ids, version 3 header, id chains) is
 * delegated to pi's official SessionManager API; this module only adds the
 * parts pi doesn't do:
 *
 *   - forkSession:      branch the spawner's own session, trimmed to BEFORE
 *                       the last delegation message (comms-inbound), so a
 *                       spawned agent inherits the task background without the
 *                       spawn dialogue tail. Mirrors pi-subagents' fork-context.
 *   - writePreloadedSessionFile: preload an initial conversation into a fresh
 *                       session file (used when llmContext.messages is set).
 *
 * Zero pi dependency: this module never value-imports the pi package. The
 * engine is injected by the caller, which obtains it from the runtime
 * `ctx.sessionManager.constructor` (the read-only view's instance constructor
 * IS SessionManager — ReadonlySessionManager is a type-level Pick, not a
 * wrapper). Tests inject fakes.
 *
 * Known pi SDK facts relied on (v0.84.0):
 *   - SessionManager.open(path, sessionDir, cwdOverride) on a NON-existent
 *     path performs a newSession with sessionFile pinned to that path.
 *   - createBranchedSession(entryId) branches root→entryId, returns
 *     <sessionDir>/<ISO-ts(:.→-)>_<uuid>.jsonl, and does NOT write the file
 *     when the branch has no assistant message (deferred persist).
 *   - After createBranchedSession the manager instance points at the new
 *     session, so getHeader()/getEntries() return the branched content —
 *     which is what the fallback materialization serializes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types — local duck-typed subset of pi's session entries (zero dependency)
// ---------------------------------------------------------------------------

/** A pi session entry, reduced to the fields this module touches. */
export interface BranchEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    api?: string;
    model?: string;
  };
  thinkingLevel?: string;
  [key: string]: unknown;
}

/** A SessionManager-like object opened on the parent session file. */
export interface BranchEngine {
  createBranchedSession(entryId: string): string | undefined;
  getHeader(): unknown;
  getEntries(): BranchEntry[];
}

/** Minimal read-only view of the spawner's own session (ctx.sessionManager). */
export interface ParentSessionRef {
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  /**
   * Test injection point. Defaults to (parent as any).constructor.open —
   * i.e. SessionManager.open on the real runtime instance.
   */
  openSession?(file: string, sessionDir?: string): BranchEngine;
}

/** A SessionManager-like object for preloading a fresh session file. */
export interface PreloadEngine {
  open(path: string, sessionDir?: string, cwdOverride?: string): PreloadHandle;
}

export interface PreloadHandle {
  appendModelChange(provider: string, modelId: string): string;
  appendThinkingLevelChange(level: string): string;
  appendMessage(message: unknown): string;
  getHeader(): unknown;
  getEntries(): BranchEntry[];
}

export interface ForkSessionResult {
  /** Forked session file path — guaranteed to exist on disk. */
  sessionFile: string;
  /** True when the delegation tail was trimmed (an inbound entry existed). */
  trimmed: boolean;
  /** True when no inbound entry existed — full leaf inheritance. */
  fullInherit: boolean;
  /** True when the branch had no assistant message and we materialized it. */
  materializedByFallback: boolean;
}

/** Preload input for a fresh session file. */
export interface PreloadedSessionInput {
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// ---------------------------------------------------------------------------
// Delegation detection
// ---------------------------------------------------------------------------

/** customType of comms inbound messages — the delegation dialogue marker. */
export const DELEGATION_CUSTOM_TYPE = "comms-inbound";

function isDelegationEntry(entry: BranchEntry): boolean {
  return entry.type === "custom_message" && entry.customType === DELEGATION_CUSTOM_TYPE;
}

/**
 * Find the fork target entry id: the last entry BEFORE the last delegation
 * (comms-inbound) message on the active path, walking parentId back from
 * the leaf. Consecutive inbound entries are all trimmed (we skip back past
 * them to the last non-delegation ancestor).
 *
 * @returns
 *   - an entry id — fork to here (everything up to and including it inherits)
 *   - `null`     — the whole active path is delegation traffic: nothing to
 *                  inherit (caller falls back to a fresh empty session)
 *   - `leafId`   — no inbound entry at all: full inheritance
 */
export function findForkTargetId(entries: BranchEntry[], leafId: string): string | null {
  const index = new Map<string, BranchEntry>();
  for (const entry of entries) {
    if (entry.id) index.set(entry.id, entry);
  }

  // Collect the active path root→leaf by walking parentId back from the leaf.
  const path: BranchEntry[] = [];
  let cur: string | null = leafId;
  while (cur && index.has(cur)) {
    path.unshift(index.get(cur)!);
    cur = index.get(cur)!.parentId ?? null;
  }
  if (path.length === 0) return leafId; // leaf not in this snapshot — let the engine resolve it

  // Find the LAST (in time) delegation entry, scanning from the leaf end.
  for (let i = path.length - 1; i >= 0; i--) {
    if (!isDelegationEntry(path[i])) continue;
    // Skip back past any consecutive inbound entries to the last
    // non-delegation ancestor.
    let j = i - 1;
    while (j >= 0 && isDelegationEntry(path[j])) j--;
    if (j < 0) return null; // whole path is delegation traffic
    // Nothing worth inheriting when the kept prefix holds no real message
    // history (only structural entries like model_change / thinking) — fall
    // back to a fresh empty session instead of forking structure-only.
    const hasMessage = path.slice(0, j + 1).some((e) => e.type === "message");
    return hasMessage ? path[j].id : null;
  }
  return leafId; // no delegation entry on the path — full inheritance
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

/**
 * Fork the spawner's own session into a new session file, trimmed to before
 * the last delegation message. The result file is ready to be passed to the
 * spawned agent via `--session`.
 *
 * Errors (all throw, no silent degradation):
 *   - no persisted parent session / missing file / no leaf — the spawner has
 *     not persisted enough history to fork from yet.
 *
 * @param parent     Read-only view of the spawner's session (ctx.sessionManager)
 * @param sessionDir Directory for the forked file (.pi/agent-sessions)
 * @param opts.cwd   cwd override passed to SessionManager.open
 * @returns          Fork result, or null when the whole active path is
 *                   delegation traffic (nothing to inherit).
 */
export function forkSession(
  parent: ParentSessionRef,
  sessionDir: string,
  opts?: { cwd?: string },
): ForkSessionResult | null {
  const parentFile = parent.getSessionFile();
  if (!parentFile) {
    throw new Error(
      "fork requires a persisted parent session: the current process has no session file",
    );
  }
  if (!existsSync(parentFile)) {
    throw new Error(
      `Parent session file does not exist: ${parentFile} — not enough history persisted to fork yet`,
    );
  }
  const leafId = parent.getLeafId();
  if (!leafId) {
    throw new Error("fork requires a current leaf entry");
  }

  // Open a SEPARATE manager instance: createBranchedSession switches the
  // instance's sessionFile/sessionId to the new branch (side effect), and the
  // parent's live session must not be touched.
  const engine =
    parent.openSession?.(parentFile, sessionDir) ??
    (parent as any).constructor.open(parentFile, sessionDir, opts?.cwd);

  const target = findForkTargetId(engine.getEntries(), leafId);
  if (target === null) return null; // nothing to inherit — caller falls back

  const forkedPath = engine.createBranchedSession(target);
  if (!forkedPath) {
    throw new Error("Session manager did not return a forked session file.");
  }

  let materializedByFallback = false;
  if (!existsSync(forkedPath)) {
    // Branch contains no assistant message — pi defers the persist. Materialize
    // it ourselves from the manager's now-branched state (getHeader/getEntries
    // return the NEW session after createBranchedSession).
    const header = engine.getHeader();
    const entries = engine.getEntries();
    if (!header) {
      throw new Error(
        `Session manager returned a forked session file that cannot be persisted: ${forkedPath}`,
      );
    }
    if (sanitizeUnsafeThinkingBlocks(entries)) {
      appendThinkingOffEntry(entries);
    }
    mkdirSync(dirname(forkedPath), { recursive: true });
    writeFileSync(
      forkedPath,
      [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    );
    materializedByFallback = true;
  }

  const trimmed = target !== leafId;
  return { sessionFile: forkedPath, trimmed, fullInherit: !trimmed, materializedByFallback };
}

// ---------------------------------------------------------------------------
// Fresh session preloading
// ---------------------------------------------------------------------------

/**
 * Write a fresh session file with a preloaded conversation, using pi's
 * SessionManager so the format (header, id chain, model/thinking entries) is
 * library-generated.
 *
 * The stable path (`<stem>-<hash>.json`) is preserved: SessionManager.open
 * on a non-existent path performs a newSession pinned to that exact file.
 * The write is atomic (temp + rename) — a failed write never leaves a
 * truncated session and a live agent's fd never observes a half-written state.
 *
 * @returns The file path (same as input).
 */
export function writePreloadedSessionFile(
  filePath: string,
  input: PreloadedSessionInput,
  engine: PreloadEngine,
): string {
  if (existsSync(filePath)) {
    unlinkSync(filePath); // full-file replace semantics on re-spawn
  }
  mkdirSync(dirname(filePath), { recursive: true });

  const sm = engine.open(filePath, dirname(filePath), input.cwd);
  sm.appendModelChange(input.model.provider, input.model.id);
  sm.appendThinkingLevelChange(input.thinkingLevel ?? "off");
  for (const m of input.messages) {
    sm.appendMessage({ role: m.role, content: [{ type: "text", text: m.content }] });
  }

  // Force persist (pi defers when no assistant message) and make it atomic.
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(
    tmpPath,
    [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
  renameSync(tmpPath, filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Anthropic thinking sanitize (defensive parity with pi-subagents)
// ---------------------------------------------------------------------------

/**
 * True when a content block is unsafe to carry into a forked session:
 * redacted Anthropic thinking, or signed thinking from an Anthropic-sourced
 * message. DeepSeek's `reasoning_content` (thinkingSignature
 * "reasoning_content") is NOT matched — pi round-trips it natively.
 */
function isUnsafeAnthropicThinkingBlock(entry: BranchEntry, block: unknown): boolean {
  if (!entry.message || !block || typeof block !== "object" || !("type" in block)) return false;
  const provider = entry.message.provider?.toLowerCase() ?? "";
  const api = entry.message.api?.toLowerCase() ?? "";
  const model = entry.message.model?.toLowerCase() ?? "";
  const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
  const b = block as { type?: string; [key: string]: unknown };
  if (b.type === "redacted_thinking") return true;
  if (b.type !== "thinking" || !isAnthropic) return false;
  const signature =
    "thinkingSignature" in b ? b.thinkingSignature : "signature" in b ? b.signature : undefined;
  return b.redacted === true || (typeof signature === "string" && signature.length > 0);
}

/** Strip unsafe thinking blocks from assistant messages. Returns true if changed. */
export function sanitizeUnsafeThinkingBlocks(entries: BranchEntry[]): boolean {
  let sanitized = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (!Array.isArray(entry.message.content)) continue;
    const filtered = entry.message.content.filter(
      (block) => !isUnsafeAnthropicThinkingBlock(entry, block),
    );
    if (filtered.length === entry.message.content.length) continue;
    entry.message.content = filtered;
    sanitized = true;
  }
  return sanitized;
}

/** Append a thinking_level_change("off") entry chained to the last id'd entry. */
function appendThinkingOffEntry(entries: BranchEntry[]): void {
  const last = entries[entries.length - 1];
  if (last?.type === "thinking_level_change" && last.thinkingLevel === "off") return;
  const parent = [...entries].reverse().find((e) => typeof e.id === "string");
  entries.push({
    type: "thinking_level_change",
    id: newEntryId(entries),
    parentId: parent?.id ?? null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "off",
  });
}

/** 8-char hex entry id, unique within the entry list. */
function newEntryId(entries: BranchEntry[]): string {
  const ids = new Set(entries.map((e) => e.id).filter((id): id is string => typeof id === "string"));
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomBytes(4).toString("hex"); // 8 hex chars
    if (!ids.has(id)) return id;
  }
  return randomBytes(4).toString("hex");
}
