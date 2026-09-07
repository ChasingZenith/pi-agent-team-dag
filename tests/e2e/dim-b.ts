/**
 * Dimension B E2E harness — comms mechanism layer (B-6..B-10) plus the
 * long-lived b-harness / b-noreply identities that the interactive flow
 * (B-1..B-5, driven against the b-spawner pi session) depends on.
 *
 * Run inside a REAL tmux pane of session e2e-b (B-7 spawns an agent via
 * agent-lifecycle's executeAgentSpawn, which requires TMUX_PANE):
 *
 *   tmux send-keys -t e2e-b 'cd <root> && bun run tests/e2e/dim-b.ts --subnet test-b > /tmp/e2e-b.log 2>&1' Enter
 *
 * The harness stays alive (heartbeating b-harness + b-noreply every 10s) until
 * a stop flag file appears: .pi/e2e-reports/dim-b-stop.flag
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { executeAgentSpawn } from "../../extensions/agent-lifecycle/index.ts";
import { createRegistry, type RegistryInstance } from "../../extensions/lib/comms/registry.ts";
import { createMessaging, type ActiveReminder, type MessagingInstance } from "../../extensions/lib/comms/messaging.ts";
import { createHistory } from "../../extensions/lib/comms/history.ts";

// Module-level factory instances, assigned in main() after the NATS connect
// (the e2e flow needs the tuned registry + the harness-identity messaging
// instance; all run* helpers read these bindings).
let registry: RegistryInstance;
let messaging: MessagingInstance;
import {
  statusFromLastSeen,
  nowIso,
  DEFAULT_NATS_URL,
  profileKey,
} from "../../extensions/lib/comms/protocol.ts";
import {
  connectNats,
  ensureStream,
  getKvProfiles,
  getKvHistory,
} from "../../extensions/lib/comms/nats.ts";
import { resolveToken, waitFor, sleep, readJsonl, kvRead } from "./helpers.ts";

const ROOT = process.cwd();
const SUBNET = "test-b";
const FLAG = join(ROOT, ".pi", "e2e-reports", "dim-b-stop.flag");
const DUMP_FILE = join(ROOT, ".pi", "e2e-reports", "kv-dump-b.json");

const results: { id: string; pass: boolean; note: string }[] = [];

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function check(id: string, pass: boolean, note: string): void {
  results.push({ id, pass, note });
  console.log(`${pass ? "[PASS]" : "[FAIL]"} ${id} ${note}`);
}

function mkIdentity(name: string, subnet: string = SUBNET) {
  return {
    name,
    subnet,
    cwd: ROOT,
    model: "deepseek-v4-flash",
    started_at: nowIso(),
  };
}

async function dumpKv(): Promise<Record<string, unknown>> {
  const read = async (kv: any, prefix: string): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    try {
      for await (const e of await kv.history({ key: prefix })) {
        if (e.operation === "DEL") { out[e.key] = { op: "DEL" }; continue; }
        try { out[e.key] = e.json(); } catch { out[e.key] = "?"; }
      }
    } catch (err: any) {
      out._error = err?.message ?? String(err);
    }
    return out;
  };
  return {
    profiles: await read(getKvProfiles(), "a.test-b.>"),
    history: await read(getKvHistory(), "h.test-b.>"),
  };
}

// ━━ B-6: remind scheduler (consolidated injection, stop stops it) ━━━━━━━━━━
// The reminder injector is a createMessaging CONSTRUCTOR arg now (no
// setRemindInjector setter) — the capture array is wired at instance
// construction in main(), and B-6 asserts on it.
const b6Captured: { t: number; pending: ActiveReminder[] }[] = [];

async function runB6(harnessId: any): Promise<void> {
  const captured = b6Captured;

  const t0 = Date.now();
  const r1 = await messaging.send("b-noreply", "hi", { remindS: 1 });
  check("B-6a", typeof r1.msg_id === "string" && r1.msg_id.length > 0, `send#1 ok msg_id=${r1.msg_id}`);

  // ≤40s: first consolidated injection containing msg_id
  const first = await waitFor(
    () => captured.find((c) => c.pending.some((p) => p.msg_id === r1.msg_id)) ?? null,
    { timeoutMs: 40_000, stepMs: 500, label: "B-6 first remind injection" },
  ).catch((e) => { check("B-6b", false, `no injection within 40s: ${String(e)}`); return null; });
  if (first) {
    check("B-6b", true, `first injection at +${Date.now() - t0}ms, pending count ${first.pending.length}`);
  }

  // second active send → next tick must still be exactly ONE injection, merged
  const before = captured.length;
  const lastT = before > 0 ? captured[before - 1].t : 0; // strictly AFTER the first injection
  const r2 = await messaging.send("b-noreply", "hi again", { remindS: 1 });
  await waitFor(
    () => (captured.length > before ? captured[captured.length - 1] : null),
    { timeoutMs: 40_000, stepMs: 500, label: "B-6 second injection" },
  ).catch((e) => { check("B-6c", false, `no second injection: ${String(e)}`); });
  const winCount = captured.filter((c) => c.t > lastT).length;
  check("B-6c", winCount === 1, `one tick → exactly 1 injection (got ${winCount})`);
  const last = captured[captured.length - 1];
  check(
    "B-6d",
    !!last && last.pending.some((p) => p.msg_id === r1.msg_id) && last.pending.some((p) => p.msg_id === r2.msg_id),
    `injection covers BOTH active sends (merged; got ${last ? last.pending.length : 0} entries)`,
  );

  // stop both → no further injections within one full tick (~35s)
  const d1 = await messaging.remind(r1.msg_id, 0);
  const d2 = await messaging.remind(r2.msg_id, 0);
  check("B-6e", d1.outcome === "stopped" && d1.wasArmed, `stop r1 → ${d1.outcome}`);
  check("B-6f", d2.outcome === "stopped" && d2.wasArmed, `stop r2 → ${d2.outcome}`);
  const base = captured.length;
  await sleep(35_000);
  const extra = captured.slice(base);
  check("B-6g", extra.length === 0, `no injections in 35s after stop (got ${extra.length})`);
}

// ━━ B-9: subnet isolation negative test ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function runB9(harnessId: any): Promise<void> {
  const dummy = mkIdentity("b-xdummy", "test-a");
  await registry.register(dummy, {
    context_used_pct: 0,
    model: "deepseek-v4-flash",
  });
  log(`B-9 dummy registered in test-a as ${dummy.name}`);

  let threw = false;
  let errMsg = "";
  try {
    await messaging.send("b-xdummy", "hi from test-b");
  } catch (err: any) {
    threw = true;
    errMsg = err?.message ?? String(err);
  }
  check("B-9a", threw, `send from test-b to test-a-only name threw (threw=${threw})`);
  check("B-9b", threw && /target not found/.test(errMsg), `error mentions "target not found" — got: ${errMsg}`);

  await registry.clearOwn(dummy);
  // clearOwn writes a TERMINAL tombstone (lifecycle gracefully_exited) instead
  // of deleting — the entry remains, but the name claim is dead and stealable.
  const tomb = (await kvRead(getKvProfiles(), profileKey("test-a", "b-xdummy"))) as any;
  check("B-9c", !!tomb && tomb.lifecycle === "gracefully_exited", `test-a dummy profile tombstoned (read=${JSON.stringify(tomb)})`);
}

// ━━ B-7 + B-8: spawn b-leaser, crash it (kill-window), lease expiry + profile ━━━━
async function runB7B8(): Promise<void> {
  const fakeCtx = { model: { provider: "deepseek", id: "deepseek-v4-flash" }, thinkingLevel: "off" } as any;
  const spawnRes = await executeAgentSpawn(
    { name: "b-leaser", llmContext: { systemPrompt: "You are a test agent. Do nothing and wait." } },
    ROOT,
    fakeCtx,
  );
  const sessionFile = (spawnRes.details.sessionFile as string) ?? "";
  const windowId = (spawnRes.details.windowId as string) ?? "";
  check("B-7-spawn", !!windowId && !!sessionFile, `spawned b-leaser window=${windowId} session=${sessionFile}`);

  const reg = await waitFor(
    () =>
      readJsonl(sessionFile).find(
        (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
      ) ?? null,
    { timeoutMs: 90_000, stepMs: 1_000, label: "B-7 b-leaser register" },
  );
  check("B-7-reg", !!reg, `b-leaser registered (${reg ? `${reg.data.name}@${reg.data.subnet}` : "no register event"})`);

  const profile = await waitFor(
    async () => (await kvRead(getKvProfiles(), profileKey("test-b", "b-leaser"))) ?? null,
    { timeoutMs: 30_000, stepMs: 1_000, label: "B-7 b-leaser profile" },
  ).catch(() => null);
  check("B-7-profile", !!profile, `KV profile a.test-b.b-leaser present at register time`);
  if (profile) {
    const st = statusFromLastSeen((profile as any).last_seen_at, 60_000);
    check("B-7-profile-online", st === "online", `profile status derived online before crash (got ${st})`);
  }

  // Crash semantics: tmux kill-window = SIGHUP
  try {
    execFileSync("tmux", ["kill-window", "-t", windowId]);
    log("B-7 killed b-leaser window (kill-window = SIGHUP = crash)");
  } catch (err: any) {
    check("B-7-kill", false, `kill-window failed: ${err?.message ?? err}`);
    return;
  }
  const t0 = Date.now();

  // B-7a: +5s — profile still resolves (holder presumed alive)
  await sleep(5_000);
  const sid5 = await registry.resolveName("test-b", "b-leaser");
  check("B-7a", sid5 !== null, `t+5s profile still resolves (got ${JSON.stringify(sid5)})`);

  // B-7b: +35s — the crashed holder's entry persists (living-labeled, stale
  // last_seen_at); the name is stealable (reclaim threshold 30s in this
  // harness) but addressability never lapses.
  await sleep(30_000);
  const sid35 = await registry.resolveName("test-b", "b-leaser");
  check(
    "B-7b",
    sid35 !== null && sid35.lifecycle === "living",
    `t+35s crashed holder's entry remains, lifecycle=living (got ${JSON.stringify(sid35)})`,
  );

  // B-8: +70s — profile permanent + stale derived (same crash timeline)
  await sleep(35_000);
  const profile70 = (await kvRead(getKvProfiles(), profileKey("test-b", "b-leaser"))) as any;
  const st70 = profile70 ? statusFromLastSeen(profile70.last_seen_at, 60_000) : null;
  check("B-8a", !!profile70, `t+70s profile a.test-b.b-leaser still present (profile=null? ${profile70 === null})`);
  check("B-8b", st70 === "stale", `t+70s profile statusFromLastSeen → stale (got ${st70})`);

  // Evidence snapshot BEFORE the re-register overwrites the profile
  writeFileSync(
    join(ROOT, ".pi", "e2e-reports", "kv-dump-b-crash.json"),
    JSON.stringify(await dumpKv(), null, 2),
  );

  // B-7c: same-name re-register succeeds by STEALING the dead claim
  // (living + last_seen_at older than reclaimAfterMs=30s in this harness)
  let reregOk = false;
  let reregErr = "";
  for (let i = 0; i < 6 && !reregOk; i++) {
    try {
      await registry.register(mkIdentity("b-leaser"), { context_used_pct: 0, model: "deepseek-v4-flash" });
      reregOk = true;
    } catch (err: any) {
      reregErr = err?.message ?? String(err);
      await sleep(2_000);
    }
  }
  check("B-7c", reregOk, `same-name re-register succeeded after lease expiry${reregOk ? "" : ` — ${reregErr}`}`);
}

// ━━ B-10: pure statusFromLastSeen (single 60s threshold — no stale band) ━━━━
function runB10(): void {
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  check("B-10a", statusFromLastSeen(iso(10_000), 60_000) === "online", "last_seen 10s ago → online");
  check("B-10b", statusFromLastSeen(iso(40_000), 60_000) === "online", "last_seen 40s ago → online (below 60s threshold)");
  check("B-10c", statusFromLastSeen(iso(70_000), 60_000) === "stale", "last_seen 70s ago → stale");
}

// ━━ main ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main(): Promise<void> {
  log(`dim-b harness start — root=${ROOT} tmux_pane=${process.env.TMUX_PANE ?? "(none!)"} pid=${process.pid}`);
  if (!process.env.TMUX_PANE) log("WARNING: TMUX_PANE not set — B-7 executeAgentSpawn will fail");

  const cfg = {
    natsUrl: process.env.PI_COMMS_NATS_URL || DEFAULT_NATS_URL,
    authToken: resolveToken(),
    subnet: SUBNET,
    heartbeatMs: 10_000,
    messageTtlMs: 1_800_000,
    staleAfterMs: 60_000,
    reclaimAfterMs: 30_000,
    historyTtlMs: 24 * 60 * 60 * 1000,
  };
  await connectNats(cfg);
  await ensureStream(cfg.messageTtlMs, SUBNET);
  registry = createRegistry({
    staleAfterMs: 60_000,
    reclaimAfterMs: 30_000,
    kvProfiles: () => getKvProfiles(),
  });
  log(`connected to ${cfg.natsUrl}, stream COMMS_${SUBNET} ensured`);

  // Long-lived identities: b-harness + b-noreply, 10s heartbeats
  const harnessId = mkIdentity("b-harness");
  const noReplyId = mkIdentity("b-noreply");
  await registry.register(harnessId, { context_used_pct: 0, model: "deepseek-v4-flash" });
  await registry.register(noReplyId, { context_used_pct: 0, model: "deepseek-v4-flash" });
  log(`registered b-harness=${harnessId.name} b-noreply=${noReplyId.name}`);

  // Messaging instance closes over the harness identity BY REFERENCE (the
  // factory contract); the B-6 reminder injector is a constructor arg.
  const messagingInst = createMessaging({
    identity: harnessId,
    subnet: SUBNET,
    messageTtlMs: 1_800_000,
    js: () => { throw new Error("e2e harness does not consume prompts"); },
    jsm: () => { throw new Error("e2e harness does not manage consumers"); },
    registry,
    history: createHistory({
      messageTtlMs: 1_800_000,
      kvHistory: () => getKvHistory(),
    }),
    remindInjector: (pending) => {
      b6Captured.push({ t: Date.now(), pending });
      log(`B-6 injector fired: ${pending.length} active — ${pending.map((p) => p.msg_id).join(",")}`);
    },
  });
  messaging = messagingInst;
  log(`registered b-harness=${harnessId.name} b-noreply=${noReplyId.name}`);

  setInterval(() => {
    void registry.heartbeat(harnessId, { context_used_pct: 0, model: "deepseek-v4-flash" }).catch(() => {});
  }, 10_000);
  setInterval(() => {
    void registry.heartbeat(noReplyId, { context_used_pct: 0, model: "deepseek-v4-flash" }).catch(() => {});
  }, 10_000);
  log("heartbeat loops started (b-harness + b-noreply, 10s)");

  // Wait for the name leases to be visible before B-6 send (first heartbeat put)
  await sleep(2_000);

  runB10();

  await Promise.all([
    runB6(harnessId),
    runB9(harnessId),
    runB7B8(),
  ]);

  writeFileSync(DUMP_FILE, JSON.stringify(await dumpKv(), null, 2));
  log(`KV dump → ${DUMP_FILE}`);

  log("=== B-6..B-10 summary ===");
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.note}`);
  log(`B-6..B-10: ${passed}/${results.length} passed`);

  console.log("HARNESS_READY");
  log("harness now heartbeating b-harness/b-noreply; interactive flow (B-1..B-5) can start. Waiting for stop flag...");

  // Keep-alive: heartbeats continue until the stop flag appears (max 40 min)
  const waitStart = Date.now();
  while (!existsSync(FLAG) && Date.now() - waitStart < 40 * 60_000) {
    await sleep(2_000);
  }
  if (existsSync(FLAG)) {
    writeFileSync(DUMP_FILE, JSON.stringify(await dumpKv(), null, 2));
    log(`final KV dump → ${DUMP_FILE}`);
    log("HARNESS_DONE — stop flag seen");
    const passed2 = results.filter((r) => r.pass).length;
    log(`final tally: ${passed2}/${results.length} passed`);
    for (const r of results) log(`${r.pass ? "PASS" : "FAIL"} ${r.id}`);
  } else {
    log("HARNESS_TIMEOUT — 40min elapsed, exiting");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[HARNESS_CRASH]", err);
  process.exit(1);
});
