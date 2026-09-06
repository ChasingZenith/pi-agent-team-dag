/**
 * Dimension B — supplementary TRUE-crash semantics test (SIGKILL).
 *
 * Finding from B-7: `tmux kill-window` (agent_kill) sends SIGHUP, which pi 0.83
 * handles as a GRACEFUL shutdown (comms-log "shutdown" event, clearOwn →
 * terminal tombstone written immediately). This script verifies the crash
 * semantics the B-7/B-8 brief assumed — the living-labeled entry remains with
 * a stale last_seen_at (presumed crashed) and the name becomes stealable via
 * the reclaim threshold — by SIGKILLing the agent process (no handler runs).
 *
 * Run inside a tmux pane of session e2e-b:
 *   tmux send-keys -t e2e-b 'cd <root> && bun run tests/e2e/dim-b-crash.ts --subnet test-b > /tmp/e2e-b-crash.log 2>&1' Enter
 */
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeAgentSpawn } from "../../extensions/agent-lifecycle/index.ts";
import { createRegistry } from "../../extensions/lib/comms/registry.ts";
import { connectNats, ensureStream, getKvProfiles } from "../../extensions/lib/comms/nats.ts";
import {
  statusFromLastSeen,
  nowIso,
  DEFAULT_NATS_URL,
  profileKey,
} from "../../extensions/lib/comms/protocol.ts";
import { resolveToken, waitFor, sleep, readJsonl, kvRead } from "./helpers.ts";

const ROOT = process.cwd();
const SUBNET = "test-b";
const results: { id: string; pass: boolean; note: string }[] = [];

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}
function check(id: string, pass: boolean, note: string): void {
  results.push({ id, pass, note });
  console.log(`${pass ? "[PASS]" : "[FAIL]"} ${id} ${note}`);
}

async function main(): Promise<void> {
  log(`dim-b-crash start — root=${ROOT} tmux_pane=${process.env.TMUX_PANE ?? "(none!)"}`);
  const cfg = {
    natsUrl: process.env.PI_COMMS_NATS_URL || DEFAULT_NATS_URL,
    authToken: resolveToken(),
    subnet: SUBNET,
    heartbeatMs: 10_000,
    messageTtlMs: 1_800_000,
    offlineAfterMs: 60_000,
    reclaimAfterMs: 30_000,
    historyTtlMs: 24 * 60 * 60 * 1000,
  };
  await connectNats(cfg);
  await ensureStream(cfg.messageTtlMs, SUBNET);
  const registry = createRegistry({
    offlineAfterMs: 60_000,
    reclaimAfterMs: 30_000,
    kvProfiles: () => getKvProfiles(),
  });

  const fakeCtx = { model: { provider: "deepseek", id: "deepseek-v4-flash" }, thinkingLevel: "off" } as any;
  const spawnRes = await executeAgentSpawn(
    { name: "b-crasher", llmContext: { systemPrompt: "You are a test agent. Do nothing and wait." } },
    ROOT,
    fakeCtx,
  );
  const sessionFile = (spawnRes.details.sessionFile as string) ?? "";
  const windowId = (spawnRes.details.windowId as string) ?? "";
  check("BC-1", !!windowId && !!sessionFile, `spawned b-crasher window=${windowId} session=${sessionFile}`);

  const reg = await waitFor(
    () =>
      readJsonl(sessionFile).find(
        (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
      ) ?? null,
    { timeoutMs: 90_000, stepMs: 1_000, label: "b-crasher register" },
  );
  check("BC-2", !!reg, `b-crasher registered @${reg?.data?.subnet}`);

  // Find the pi process: the launch script is `exec pi --session <file>`.
  const stem = sessionFile.split("/").pop() ?? "";
  let pid = "";
  try {
    pid = execSync(`pgrep -f "${stem}" | head -1`, { encoding: "utf8" }).trim();
  } catch {
    pid = "";
  }
  log(`b-crasher pi pid=${pid} (session ${stem})`);
  check("BC-3", pid.length > 0 && /^\d+$/.test(pid), `found pi pid ${pid}`);

  // TRUE crash: SIGKILL — no handler, no clearOwn.
  execSync(`kill -9 ${pid}`);
  log(`SIGKILL ${pid} sent at ${new Date().toISOString()}`);
  const t0 = Date.now();

  // +5s: holder presumed alive — last heartbeat ≤10s pre-kill
  await sleep(5_000);
  const sid5 = await registry.resolveName("test-b", "b-crasher");
  check("BC-4", sid5 !== null, `t+5s profile still resolves (got ${JSON.stringify(sid5)})`);

  // +35s: the crashed holder's entry persists (living-labeled, stale
  // last_seen_at); name stealable (reclaim threshold 30s in this harness)
  await sleep(30_000);
  const sid35 = await registry.resolveName("test-b", "b-crasher");
  check(
    "BC-5",
    sid35 !== null && sid35.lifecycle === "living",
    `t+35s crashed entry remains, lifecycle=living (got ${JSON.stringify(sid35)})`,
  );

  // +70s: profile permanent + offline derived
  await sleep(35_000);
  const profile = (await kvRead(getKvProfiles(), profileKey("test-b", "b-crasher"))) as any;
  const st = profile ? statusFromLastSeen(profile.last_seen_at, 60_000) : null;
  check("BC-6", !!profile, `t+70s profile a.test-b.b-crasher still present (profile=null? ${profile === null})`);
  check("BC-7", st === "offline", `t+70s profile statusFromLastSeen → offline (got ${st})`);

  // Name reclaim: same-name re-register succeeds
  let reregOk = false;
  let reregErr = "";
  for (let i = 0; i < 6 && !reregOk; i++) {
    try {
      await registry.register(
        {
          name: "b-crasher",
          subnet: "test-b",
          cwd: ROOT,
          model: "deepseek-v4-flash",
          started_at: nowIso(),
        },
        { context_used_pct: 0, model: "deepseek-v4-flash" },
      );
      reregOk = true;
    } catch (err: any) {
      reregErr = err?.message ?? String(err);
      await sleep(2_000);
    }
  }
  check("BC-8", reregOk, `same-name re-register succeeded by stealing the dead claim${reregOk ? "" : ` — ${reregErr}`}`);

  // Evidence
  const evidence = {
    session_file: sessionFile,
    window: windowId,
    pid,
    timeline: { kill_at: new Date(t0).toISOString(), plus_5s_sid: sid5, plus_35s_sid: sid35, profile_plus_70s: profile },
    session_log: readJsonl(sessionFile).slice(-4),
  };
  writeFileSync(join(ROOT, ".pi", "e2e-reports", "crash-sigkill-evidence.json"), JSON.stringify(evidence, null, 2));

  const passed = results.filter((r) => r.pass).length;
  log(`=== crash semantics (SIGKILL): ${passed}/${results.length} passed ===`);
  for (const r of results) log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.note}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[CRASH_HARNESS_ERROR]", err);
  process.exit(1);
});
