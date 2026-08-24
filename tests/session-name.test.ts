/**
 * Unit tests for lib/comms/session-name — the pure session-name logic
 * behind the profile-driven display name (comms identity + current task).
 *
 * Run: bun test tests/session-name.test.ts
 */
import { describe, it, expect } from "bun:test";
import { TITLE_MAX, displayName, shouldOwnName } from "../extensions/lib/comms/session-name";

// ━━ displayName ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("displayName", () => {
  it("returns the bare agent name when nothing is declared", () => {
    expect(displayName("worker-1", undefined)).toBe("worker-1");
  });

  it("shows the declared task as <agent> [<title>]", () => {
    expect(displayName("worker-1", "Implement auth")).toBe("worker-1 [Implement auth]");
  });

  it("truncates long titles to TITLE_MAX characters", () => {
    const longTitle = "x".repeat(TITLE_MAX + 20);
    const name = displayName("worker-1", longTitle);
    expect(name).toBe(`worker-1 [${"x".repeat(TITLE_MAX)}]`);
    expect(name.length).toBe(`worker-1 [${"x".repeat(TITLE_MAX)}]`.length);
  });

  it("falls back to the bare agent name for an empty title", () => {
    expect(displayName("worker-1", "   ")).toBe("worker-1");
  });
});

// ━━ shouldOwnName ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("shouldOwnName", () => {
  const base = "worker-1";

  it("claims an unset name", () => {
    expect(shouldOwnName(undefined, null, base)).toBe(true);
    // re-claim after we released (e.g. the user cleared the name)
    expect(shouldOwnName(undefined, "worker-1 [X]", base)).toBe(true);
  });

  it("keeps ownership while the name is still ours", () => {
    expect(shouldOwnName("worker-1 [X]", "worker-1 [X]", base)).toBe(true);
  });

  it("takes over the base identity name comms claimed (upgrade to <agent> [<task>])", () => {
    // comms.ts claims the bare identity name on boot when the session name
    // was unset; a later profile update may upgrade it to the full display
    // name.
    expect(shouldOwnName("worker-1", null, base)).toBe(true);
    expect(shouldOwnName("worker-1", "worker-1", base)).toBe(true);
  });

  it("releases ownership on a foreign name (manual --name / /name)", () => {
    expect(shouldOwnName("my custom name", "worker-1 [X]", base)).toBe(false);
    expect(shouldOwnName("worker-1 [stale task]", null, base)).toBe(false);
  });
});
