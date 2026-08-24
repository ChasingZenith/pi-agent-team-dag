/**
 * Shared fake SessionManager for tests driving executeAgentSpawn outside a pi
 * process (bun test / e2e harness).
 *
 * The real runtime resolves the session engine via
 * `(ctx.sessionManager as any).constructor` — ReadonlySessionManager's
 * instance constructor IS SessionManager. These fakes provide that seam:
 *
 *   - `fakeSessionManagerCtor` — used as the `constructor` of a fresh ctx
 *     sessionManager; its `open()` returns an in-memory handle mirroring pi's
 *     entry shapes (v3 header, model_change root, thinking_level_change,
 *     message with parentId chain), enough for writePreloadedSessionFile.
 *   - `freshSessionManager()` / `forkSessionManager()` — ctx.sessionManager
 *     stubs for fresh and fork spawns respectively.
 *
 * Forking itself (findForkTargetId, fallback materialization, sanitize) is
 * covered by tests/fork.test.ts with hand-rolled engines; here the fork stub
 * simply yields a pre-created file so spawn integration can be exercised.
 */

export const fakeSessionManagerCtor = {
  open(_path: string, _sessionDir: string, cwd: string) {
    const header = {
      type: "session",
      version: 3,
      id: "test-session-id",
      timestamp: new Date().toISOString(),
      cwd,
    };
    const entries: any[] = [];
    let lastId: string | null = null;
    return {
      appendModelChange(provider: string, modelId: string): string {
        const id = `mc-${entries.length}`;
        entries.push({ type: "model_change", id, parentId: null, timestamp: new Date().toISOString(), provider, modelId });
        lastId = id;
        return id;
      },
      appendThinkingLevelChange(level: string): string {
        const id = `tl-${entries.length}`;
        entries.push({ type: "thinking_level_change", id, parentId: lastId, timestamp: new Date().toISOString(), thinkingLevel: level });
        lastId = id;
        return id;
      },
      appendMessage(message: unknown): string {
        const id = `msg-${entries.length}`;
        entries.push({ type: "message", id, parentId: lastId, timestamp: new Date().toISOString(), message });
        lastId = id;
        return id;
      },
      getHeader: () => header,
      getEntries: () => entries,
    };
  },
};

/** ctx.sessionManager stub for FRESH spawns (preload path uses constructor). */
export function freshSessionManager(): any {
  return {
    getSessionFile: () => undefined,
    getLeafId: () => null,
    constructor: fakeSessionManagerCtor,
  };
}

/**
 * ctx.sessionManager stub for FORK spawns: a parent session file on disk plus
 * an openSession yielding a branch engine that returns a PRE-CREATED fork
 * file. `entries` feeds findForkTargetId — pass the parent's real entries
 * (with a comms-inbound tail) so the trim logic runs for real; when
 * omitted the engine sees no inbound and inherits fully. (Fork materialization
 * itself is covered by tests/fork.test.ts.)
 */
export function forkSessionManager(
  parentFile: string,
  forkFile: string,
  entries?: any[],
  leafId: string = "leaf-1",
): any {
  return {
    getSessionFile: () => parentFile,
    getLeafId: () => leafId,
    openSession: () => ({
      createBranchedSession: () => forkFile,
      getHeader: () => null,
      getEntries: () => entries ?? [],
    }),
  };
}
