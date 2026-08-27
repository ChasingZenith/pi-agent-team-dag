/**
 * Dimension B — supplementary TRUE-crash semantics test (SIGKILL).
 *
 * Finding from B-7: `tmux kill-window` (agent_kill) sends SIGHUP, which pi 0.83
 * handles as a GRACEFUL shutdown (comms-log "shutdown" event, clearOwn →
 * profile + name keys deleted immediately). This script verifies the crash
 * semantics the B-7/B-8 brief assumed — lease expiry via bucket TTL (30s) and
 * permanent offline profile — by SIGKILLing the agent process (no handler runs).
 *
 * Run inside a tmux pane of session e2e-b:
 *   tmux send-keys -t e2e-b 'cd <root> && bun run tests/e2e/dim-b-crash.ts --subnet test-b > /tmp/e2e-b-crash.log 2>&1' Enter
 */
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { executeAgentSpawn } from "../../extensions/agent-lifecycle/index.ts";
import * as registry from "../../extensions/lib/comms/registry.ts";
import {
  statusFromLastSeen,
  nowIso,
  DEFAULT_NATS_URL,
  nameKey,
  profileKey,
} from "../../extensions/lib/comms/protocol.ts";
import { connectNats, ensureStream, getKvProfiles, getKvNames } from "../../extensions/lib/comms/nats.ts";
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
    registryTtlMs: 30_000,
    staleAfterMs: 30_000,
    offlineAfterMs: 60_000,
    historyTtlMs: 24 * 60 * 60 * 1000,
  };
  await connectNats(cfg);
  await ensureStream(cfg.messageTtlMs, SUBNET);
  registry.setRegistryTuning(30_000, 60_000);

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

  // +5s: lease (bucket TTL 30s) still alive — last heartbeat ≤10s pre-kill
  await sleep(5_000);
  const sid5 = await registry.resolveName("test-b", "b-crasher");
  check("BC-4", sid5 !== null, `t+5s name lease still resolves (sid=${sid5})`);

  // +35s: lease expired via bucket TTL (30s from last heartbeat put)
  await sleep(30_000);
  const sid35 = await registry.resolveName("test-b", "b-crasher");
  check("BC-5", sid35 === null, `t+35s name lease expired via TTL, resolveName → null (got ${JSON.stringify(sid35)})`);

  // +70s: profile permanent + offline derived
  await sleep(35_000);
  const profile = (await kvRead(getKvProfiles(), profileKey("test-b", "b-crasher"))) as any;
  const st = profile ? statusFromLastSeen(profile.last_seen_at, 30_000, 60_000) : null;
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
  check("BC-8", reregOk, `same-name re-register succeeded after TTL reclaim${reregOk ? "" : ` — ${reregErr}`}`);

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
