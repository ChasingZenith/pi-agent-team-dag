/**
 * Shared E2E test helpers — NATS connection, KV reads, tmux window queries,
 * session-JSONL polling, waitFor. Mirrors comms's own config resolution
 * (token from PI_COMMS_AUTH_TOKEN or ~/.pi/comms/server.secret.json).
 *
 * Usage: run inside a real tmux session (checkTmux in agent-lifecycle requires
 * TMUX_PANE) — e.g. tmux send-keys 'bun run tests/e2e/dim-a.ts --subnet test-a
 * > /tmp/e2e-a.log 2>&1' Enter.
 */
import {
  connect,
  type NatsConnection,
  type KV,
} from "nats";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_NATS_URL,
  KV_BUCKET_PROFILES,
  KV_BUCKET_HISTORY,
} from "../../extensions/lib/comms/protocol.ts";
import { SECRET_FILE } from "../../extensions/lib/comms/paths.ts";

export const BUCKETS = { profiles: KV_BUCKET_PROFILES, history: KV_BUCKET_HISTORY };

const textDecoder = new TextDecoder();

// ━━ timing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll fn until it returns a truthy value, then return it. Throws on timeout. */
export async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  opts: { timeoutMs?: number; stepMs?: number; label: string },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const stepMs = opts.stepMs ?? 1_000;
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(stepMs);
  }
  throw new Error(
    `waitFor timeout (${opts.label}) after ${timeoutMs}ms` +
      (lastErr ? ` — last error: ${String(lastErr)}` : ""),
  );
}

// ━━ NATS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Resolve the comms auth token exactly like extensions/lib/comms/config.ts. */
export function resolveToken(): string | null {
  if (process.env.PI_COMMS_AUTH_TOKEN && process.env.PI_COMMS_AUTH_TOKEN.length > 0) {
    return process.env.PI_COMMS_AUTH_TOKEN;
  }
  try {
    if (existsSync(SECRET_FILE)) {
      const mode = execFileSync("stat", ["-c", "%a", SECRET_FILE], { encoding: "utf8" }).trim();
      if (mode === "600") {
        const parsed = JSON.parse(readFileSync(SECRET_FILE, "utf8")) as { token?: string };
        if (parsed && typeof parsed.token === "string" && parsed.token.length > 0) return parsed.token;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

export async function connectE2e(): Promise<NatsConnection> {
  const opts: Record<string, unknown> = {
    servers: process.env.PI_COMMS_NATS_URL || DEFAULT_NATS_URL,
    reconnect: true,
    maxReconnectAttempts: -1,
  };
  const token = resolveToken();
  if (token) opts.token = token;
  return await connect(opts);
}

/** Read a KV entry; returns parsed JSON when the value parses, raw string otherwise, null when absent. */
export async function kvRead(kv: KV, key: string): Promise<unknown | null> {
  try {
    const e = await kv.get(key);
    if (!e || !e.value) return null;
    const raw = textDecoder.decode(e.value);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

// ━━ tmux ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** List "window_id\twindow_name" lines in a tmux session. Empty on unknown session. */
export function tmuxWindows(session: string): string[] {
  try {
    const out = execFileSync(
      "tmux",
      ["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}"],
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function tmuxWindowCount(session: string): number {
  return tmuxWindows(session).length;
}

/** Send literal text + Enter to a tmux target (pane or window). */
export function tmuxSend(session: string, target: string, text: string): void {
  execFileSync("tmux", ["send-keys", "-t", target, "-l", text]);
  execFileSync("tmux", ["send-keys", "-t", target, "Enter"]);
}

// ━━ session JSONL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Read all parseable JSONL entries from a session file. Empty on missing file. */
export function readJsonl(path: string): any[] {
  try {
    const text = readFileSync(path, "utf8");
    const out: any[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // unparseable line — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Poll a session JSONL file until an entry matches pred; returns the entry. */
export function waitForJsonl(
  path: string,
  pred: (e: any) => boolean,
  opts: { timeoutMs?: number; stepMs?: number; label?: string } = {},
): Promise<any> {
  return waitFor(() => readJsonl(path).find(pred) ?? null, {
    timeoutMs: opts.timeoutMs,
    stepMs: opts.stepMs,
    label: opts.label ?? `jsonl predicate in ${path}`,
  });
}

/** First line of a session file (v3 header), or null. */
export function sessionHeader(path: string): any | null {
  try {
    const first = readFileSync(path, "utf8").split("\n").find((l) => l.trim().length > 0);
    return first ? JSON.parse(first) : null;
  } catch {
    return null;
  }
}
