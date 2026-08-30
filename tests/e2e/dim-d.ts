/**
 * Dimension D E2E harness — comms no-reminder (remind_s=0) mechanism
 * layer: the capability task change notifications are built on.
 *
 * Verifies against a REAL NATS server (no LLM, no tmux spawn):
 *   D-1  no-reminder send (remind_s=0): message delivered (comms_history
 *        record) and NOT parked in the pending table — the semantics that
 *        keep auto-exit workers from hanging on notifications.
 *   D-2  control: a plain tracked send IS parked in the pending table
 *        (remind_ms omitted — behavior unchanged).
 *
 * Requires a running NATS server (just comms-server). Run from a tmux pane:
 *
 *   bun run tests/e2e/dim-d.ts
 *
 * Exits on its own when done (no stop flag, no long-lived identities).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as registry from "../../extensions/lib/comms/registry.ts";
import * as messaging from "../../extensions/lib/comms/messaging.ts";
import { nowIso, DEFAULT_NATS_URL, historyOutKey } from "../../extensions/lib/comms/protocol.ts";
import {
  connectNats,
  ensureStream,
  getKvHistory,
} from "../../extensions/lib/comms/nats.ts";
import { createTask, listTasks } from "../../extensions/lib/tasks/store.ts";
import { resolveToken, waitFor, sleep, kvRead } from "./helpers.ts";

const ROOT = process.cwd();
const SUBNET = "test-d";
/** Task files land in a scratch dir — never the project's real .pi/tasks. */
const TASKS_DIR = join(ROOT, ".pi", "e2e-reports", "tasks-d");
process.env.PI_TASKS_DIR = TASKS_DIR;

const results: { id: string; pass: boolean; note: string }[] = [];

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}
function check(id: string, pass: boolean, note: string): void {
  results.push({ id, pass, note });
  console.log(`${pass ? "[PASS]" : "[FAIL]"} ${id} ${note}`);
}

function mkIdentity(name: string) {
  return {
    name,
    subnet: SUBNET,
    cwd: ROOT,
    model: "deepseek-v4-flash",
    started_at: nowIso(),
  };
}

async function main(): Promise<void> {
  log(`dim-d start — root=${ROOT} pid=${process.pid}`);
  mkdirSync(TASKS_DIR, { recursive: true });
  rmSync(TASKS_DIR, { recursive: true, force: true });
  mkdirSync(TASKS_DIR, { recursive: true });

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
  messaging.setSubnet(SUBNET);
  messaging.setMessageTtlMs(1_800_000);
  log(`connected to ${cfg.natsUrl}, stream COMMS_${SUBNET} ensured`);

  const harnessId = await registry.register(mkIdentity("d-harness"), { context_used_pct: 0, model: "deepseek-v4-flash" });
  const recipientId = await registry.register(mkIdentity("d-recipient"), { context_used_pct: 0, model: "deepseek-v4-flash" });
  log(`registered d-harness=${harnessId.name} d-recipient=${recipientId.name}`);
  registry.startWatch(SUBNET);
  await sleep(2_000);

  // Seed a task into the scratch dir
  const seed = createTask(ROOT, {
    id: "item-d1",
    title: "goal",
    description: "assumptions: A1 …",
    change_summary: "created",
    updated_by: "d-harness",
  });
  check("D-0a", seed.version === 1 && listTasks(ROOT).length === 1, `task seeded v${seed.version} at ${TASKS_DIR}`);

  // ━━ D-1: no-reminder send (remind_s omitted, i.e. 0) — delivered, NOT reminded ━━
  // A task change notification is just a plain comms_send with no remind_s —
  // the sender composes the announcement body itself (no wrapper tool).
  const ff = await messaging.send(
    harnessId,
    "d-recipient",
    `[Task Update] item-d1 v1 (active) — updated by d-harness\nChange: created\nRead: task_read(id="item-d1")`,
    { remindS: 0 },
  );
  const syncedMsgId = ff.msg_id;
  check("D-1a", !!syncedMsgId, `no-reminder send delivered (msg=${syncedMsgId})`);
  check("D-1b", !messaging.listActiveReminders().some((p) => p.msg_id === syncedMsgId),
    "remind_s=0 → NOT in the active reminder list (auto-exit guard unaffected)");
  const historyRec = await waitFor(
    () => kvRead(getKvHistory(), historyOutKey(SUBNET, harnessId.name, syncedMsgId)),
    { timeoutMs: 10_000, stepMs: 300, label: "D-1 history record" },
  ).catch(() => null);
  check("D-1c", !!historyRec, `comms_history outbound record persisted (${!!historyRec})`);
  if (historyRec) {
    const msg = (historyRec as any).message ?? "";
    check("D-1d", String(msg).includes("item-d1") && String(msg).includes("task_read"),
      "notification body carries the task id + task_read pointer");
  }

  // ━━ D-2: control — remind_s-armed send IS registered ━━━━━━━━━━━━━━━━━━━━━━
  const tracked = await messaging.send(harnessId, "d-recipient", "normal tracked send", { remindS: 60 });
  check("D-2a", messaging.listActiveReminders().some((p) => p.msg_id === tracked.msg_id),
    "remind_s=x → in the active reminder list (tracked behavior)");
  const stopOutcome = await messaging.remind(harnessId, tracked.msg_id, 0);
  check("D-2b", stopOutcome.outcome === "stopped", `remind(…, 0) stops it (got ${stopOutcome.outcome})`);

  // ━━ summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  log("=== D-1..D-2 summary ===");
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.note}`);
  log(`dim-d: ${passed}/${results.length} passed`);

  await registry.clearOwn(harnessId).catch(() => {});
  await registry.clearOwn(recipientId).catch(() => {});
  if (existsSync(TASKS_DIR)) rmSync(TASKS_DIR, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("[HARNESS_CRASH]", err);
  process.exit(1);
});
