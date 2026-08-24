/**
 * 维度 A E2E — agent-lifecycle 核心机制（subnet test-a，tmux e2e-a）
 *
 * 运行（必须在真实 tmux pane 内，TMUX_PANE 必需）：
 *   bun run tests/e2e/dim-a.ts --subnet test-a        # A-1..A-5, A-7, A-8, A-12
 *   TMPDIR=/sys bun run tests/e2e/dim-a.ts --subnet test-a --only auto-cleanup  # A-6
 *
 * 关键语义（与源码对齐）：
 *   - agent_kill = tmux kill-window = SIGHUP = crash 语义：profile 永久保留、name 租约 TTL 过期
 *   - 只有 ctx.shutdown() 的干净退出才 clearOwn（profile+name 立即删除）
 *   - dedupe 检查在 session 文件写入之后（重复 spawn 先覆盖写文件再 throw）
 *   - SCRIPT_DIR 在模块加载时求值 → A-6 必须独立进程 + 启动前设 TMPDIR
 */
import {
  executeAgentSpawn,
  executeAgentSpawnByRole,
  executeAgentKill,
  isAgentNameTaken,
} from "../../extensions/agent-lifecycle.ts";
import lifecycle from "../../extensions/agent-lifecycle.ts";
import { Type } from "@sinclair/typebox";
import {
  connectE2e,
  kvRead,
  waitFor,
  waitForJsonl,
  readJsonl,
  sessionHeader,
  tmuxWindowCount,
  sleep,
  BUCKETS,
} from "./helpers.ts";
import { freshSessionManager } from "../helpers/fake-session-manager.ts";
import { existsSync, rmSync, statSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SUBNET = "test-a";
const SESSION = "e2e-a";
const FAKE_CTX = {
  model: { provider: "deepseek", id: "deepseek-v4-flash" },
  thinkingLevel: "off",
  sessionManager: freshSessionManager(),
} as any;
const EVIDENCE_DIR = join(ROOT, ".pi", "e2e-reports", "evidence");

let passCount = 0;
let failCount = 0;

function check(id: string, cond: boolean, msg: string) {
  if (cond) {
    passCount++;
    console.log(`[PASS] ${id} — ${msg}`);
  } else {
    failCount++;
    console.log(`[FAIL] ${id} — ${msg}`);
  }
}

function saveEvidence(name: string, data: string) {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, name), data);
    console.log(`  evidence → ${join(EVIDENCE_DIR, name)}`);
  } catch (err) {
    console.log(`  evidence write failed: ${String(err)}`);
  }
}

/** register 事件被 appendEntry 包装为 data.event（见 comms 的 audit） */
function registerPred(name: string) {
  return (e: any) => e?.data?.event === "register" && e?.data?.name === name && e?.data?.subnet === SUBNET;
}

/**
 * typebox shim（node_modules/@sinclair/typebox）只有空 Type{}——A-7 需要
 * lifecycle() 执行 registerTool 求值 Type.*，这里注入最小实现。
 */
function patchTypebox() {
  const t = Type as any;
  if (t.String) return;
  t.String = (o?: any) => ({ type: "string", ...o });
  t.Object = (o?: any) => ({ type: "object", properties: o });
  t.Optional = (s: any) => ({ ...s, optional: true });
  t.Enum = (o?: any) => ({ type: "enum", values: o });
  t.Boolean = (o?: any) => ({ type: "boolean", ...o });
  t.Array = (o?: any) => ({ type: "array", items: o });
}

/** 一次性包装：把错误转成 {threw, msg}，不中断流程。 */
async function spawnExpectThrow(params: any, cwd: string): Promise<{ threw: boolean; msg: string }> {
  try {
    await executeAgentSpawn(params, cwd, FAKE_CTX);
    return { threw: false, msg: "NO THROW" };
  } catch (e: any) {
    return { threw: true, msg: e?.code ? `${e.code}: ${e.message}` : (e?.message ?? String(e)) };
  }
}

// ━━━ A-1..A-5：spawn / dedupe / case-insensitive / kill / not_found ━━━

async function testSpawnBasics(): Promise<void> {
  const base = tmuxWindowCount(SESSION);

  // A-1
  const res = await executeAgentSpawn(
    {
      name: "a-worker",
      llmContext: {
        systemPrompt: "You are a test worker.",
        messages: [{ role: "user", content: "State your name and subnet." }],
      },
    },
    ROOT,
    FAKE_CTX,
  );
  const windowId = res.details.windowId as string;
  const sessionFile = res.details.sessionFile as string;
  check("A-1a", typeof windowId === "string" && windowId.startsWith("@"), `spawn returned windowId=${windowId}`);
  check("A-1b", tmuxWindowCount(SESSION) === base + 1, `window count ${base} → ${tmuxWindowCount(SESSION)}`);
  const hdr = sessionHeader(sessionFile);
  check("A-1c", hdr?.type === "session" && hdr?.version === 3, `session file header: ${JSON.stringify(hdr)}`);
  try {
    const reg = await waitForJsonl(
      sessionFile,
      registerPred("a-worker"),
      { timeoutMs: 90_000, label: "a-worker register" },
    );
    check(
      "A-1d",
      true,
      `register event: ${JSON.stringify({ name: reg?.data?.name, subnet: reg?.data?.subnet })}`,
    );
  } catch (err) {
    check("A-1d", false, `no register within 90s: ${String(err)}`);
    saveEvidence("A-1-a-worker-session.jsonl", readJsonl(sessionFile).map((l) => JSON.stringify(l)).join("\n"));
  }
  check("A-1e", isAgentNameTaken("a-worker") === true, "isAgentNameTaken(a-worker) === true");

  // A-2
  const dup = await spawnExpectThrow({ name: "a-worker", llmContext: {} }, ROOT);
  check("A-2a", dup.threw && dup.msg.includes("already running"), `duplicate spawn threw: ${dup.msg}`);
  check("A-2b", tmuxWindowCount(SESSION) === base + 1, `window count unchanged on duplicate spawn (${tmuxWindowCount(SESSION)})`);

  // A-3
  check("A-3a", isAgentNameTaken("A-WORKER") === true, "isAgentNameTaken(A-WORKER) === true");
  const up = await spawnExpectThrow({ name: "A-WORKER", llmContext: {} }, ROOT);
  check("A-3b", up.threw && up.msg.includes("already running"), `uppercase spawn threw: ${up.msg}`);
  check("A-3c", tmuxWindowCount(SESSION) === base + 1, `window count unchanged on uppercase spawn (${tmuxWindowCount(SESSION)})`);

  // A-4
  const killRes = executeAgentKill({ name: "a-worker" });
  check("A-4a", killRes.details.status === "killed", `kill status=${killRes.details.status}`);
  await waitFor(() => tmuxWindowCount(SESSION) === base, { timeoutMs: 15_000, label: "a-worker window gone after kill" }).catch(() => {});
  check("A-4b", tmuxWindowCount(SESSION) === base, `window count back to ${base} after kill (${tmuxWindowCount(SESSION)})`);
  check("A-4c", isAgentNameTaken("a-worker") === false, "isAgentNameTaken(a-worker) === false after kill");
  const killRes2 = executeAgentKill({ name: "a-worker" });
  check("A-4d", killRes2.details.status === "not_found", `re-kill → status=${killRes2.details.status}（不抛）`);

  // A-5
  const killRes3 = executeAgentKill({ name: "never-spawned" });
  check("A-5", killRes3.details.status === "not_found", `kill unknown name → status=${killRes3.details.status}（不抛）`);
}

// ━━━ A-7：fake pi — session_shutdown 全清 + session_start 重建目录 ━━━

async function testShutdownAndDirRebuild(): Promise<void> {
  const base = tmuxWindowCount(SESSION);
  patchTypebox();

  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const fakePi = {
    registerTool: () => {},
    registerFlag: () => {},
    on: (evt: string, cb: (event: any, ctx: any) => any) => { handlers[evt] = cb; },
  } as any;
  lifecycle(fakePi);

  const r1 = await executeAgentSpawn({ name: "a-7x", llmContext: {} }, ROOT, FAKE_CTX);
  const r2 = await executeAgentSpawn({ name: "a-7y", llmContext: {} }, ROOT, FAKE_CTX);
  check("A-7a", tmuxWindowCount(SESSION) === base + 2, `2 agents spawned → windows ${tmuxWindowCount(SESSION)}`);
  check("A-7b", isAgentNameTaken("a-7x") && isAgentNameTaken("a-7y"), "both names taken");

  await handlers["session_shutdown"]();
  await sleep(1000);
  check("A-7c", tmuxWindowCount(SESSION) === base, `session_shutdown killed both windows (${tmuxWindowCount(SESSION)})`);
  check("A-7d", isAgentNameTaken("a-7x") === false && isAgentNameTaken("a-7y") === false, "registry cleared ×2");

  const sessionsDir = join(ROOT, ".pi", "agent-sessions");
  const hadDir = existsSync(sessionsDir);
  try {
    cpSync(sessionsDir, join(EVIDENCE_DIR, "agent-sessions-before-delete"), { recursive: true });
  } catch { /* best effort */ }
  rmSync(sessionsDir, { recursive: true, force: true });
  check("A-7e", hadDir && !existsSync(sessionsDir), "removed .pi/agent-sessions (precondition)");
  await handlers["session_start"]({}, { cwd: ROOT });
  check("A-7f", existsSync(sessionsDir), ".pi/agent-sessions recreated by session_start");
}

// ━━━ A-8：角色式 spawn 的 uniqueName 去重 ━━━

async function testRoleSpawn(): Promise<void> {
  const r1 = await executeAgentSpawnByRole({ role: "worker" }, ROOT, FAKE_CTX);
  const n1 = r1.details.agentName as string;
  check("A-8a", n1 === "worker", `first role spawn name="${n1}"`);
  const r2 = await executeAgentSpawnByRole({ role: "worker" }, ROOT, FAKE_CTX);
  const n2 = r2.details.agentName as string;
  check("A-8b", n2 === "worker-2", `second role spawn name="${n2}"`);

  const k1 = executeAgentKill({ name: n1 });
  const k2 = executeAgentKill({ name: n2 });
  check("A-8c", k1.details.status === "killed" && k2.details.status === "killed", "both role agents killed");
}

// ━━━ A-12：空 llmContext — 0 字节 session 文件 + 观察 pi 自举 ━━━

async function testEmptyContextSpawn(): Promise<void> {
  const base = tmuxWindowCount(SESSION);
  const res = await executeAgentSpawn({ name: "a-empty", llmContext: {} }, ROOT, FAKE_CTX);
  const sessionFile = res.details.sessionFile as string;
  const st0 = statSync(sessionFile, { throwIfNoEntry: false });
  check("A-12a", st0 !== undefined && st0.size === 0, `initial session file 0 bytes (got ${st0?.size})`);
  check("A-12b", tmuxWindowCount(SESSION) === base + 1, `window spawned (${tmuxWindowCount(SESSION)})`);

  try {
    const reg = await waitForJsonl(
      sessionFile,
      registerPred("a-empty"),
      { timeoutMs: 90_000, label: "a-empty register" },
    );
    const hdr = sessionHeader(sessionFile);
    check(
      "A-12c",
      true,
      `agent booted: header ${hdr?.type} v${hdr?.version}, register name=${reg?.data?.name} subnet=${reg?.data?.subnet}`,
    );
  } catch (err) {
    const st = statSync(sessionFile, { throwIfNoEntry: false });
    const hdr = sessionHeader(sessionFile);
    const lines = readJsonl(sessionFile);
    check(
      "A-12c",
      false,
      `no register within 90s — file ${st?.size}B, header=${JSON.stringify(hdr)}, entries=${lines.length} (${String(err)})`,
    );
    saveEvidence("A-12-a-empty-session.jsonl", lines.map((l) => JSON.stringify(l)).join("\n"));
  }

  const killRes = executeAgentKill({ name: "a-empty" });
  check("A-12d", killRes.details.status === "killed", `a-empty killed (${killRes.details.status})`);
}

// ━━━ A-6：TMPDIR=/sys → EACCES → auto-cleanup ━━━

async function testAutoCleanup(): Promise<void> {
  const base = tmuxWindowCount(SESSION);
  const r = await spawnExpectThrow({ name: "a-cleanup", llmContext: {} }, ROOT);
  check("A-6a", r.threw && r.msg.includes("EACCES"), `spawn under TMPDIR=/sys threw EACCES: ${r.msg}`);
  await sleep(1500);
  check("A-6b", tmuxWindowCount(SESSION) === base, `window count unchanged after failed spawn (${base} → ${tmuxWindowCount(SESSION)})`);
  check("A-6c", isAgentNameTaken("a-cleanup") === false, "isAgentNameTaken(a-cleanup) === false after failed spawn");
}

// ━━━ main ━━━

async function main() {
  console.log(`dim-a: root=${ROOT} subnet=${SUBNET} session=${SESSION} tty=${process.env.TTY ?? "?"}`);
  const nc = await connectE2e();
  console.log(`dim-a: NATS connected`);
  await nc.close();

  const only = process.argv.findIndex((a) => a === "--only");
  const onlyCase = only >= 0 ? process.argv[only + 1] : undefined;

  if (onlyCase === "auto-cleanup") {
    console.log(`dim-a: running A-6 auto-cleanup (TMPDIR=${process.env.TMPDIR ?? "unset"})`);
    await testAutoCleanup();
  } else {
    console.log("dim-a: running main suite (A-1..A-5, A-7, A-8, A-12)");
    const base = tmuxWindowCount(SESSION);
    await testSpawnBasics();
    await testShutdownAndDirRebuild();
    await testRoleSpawn();
    await testEmptyContextSpawn();
    await sleep(2000);
    const finalWindows = tmuxWindowCount(SESSION);
    check("FINAL", finalWindows === base, `final window count ${finalWindows} == baseline ${base}`);
  }

  console.log(`\n==== DIM-A RESULT: ${passCount} PASS / ${failCount} FAIL ====`);
  console.log("DONE");
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("dim-a fatal:", err);
  console.log(`\n==== DIM-A RESULT: ${passCount} PASS / ${failCount} FAIL (fatal) ====`);
  process.exit(2);
});
