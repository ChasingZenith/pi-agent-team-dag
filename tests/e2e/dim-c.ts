/**
 * dim-c — 维度 C E2E bun harness（subnet test-c / tmux e2e-c）
 *
 * 子命令：
 *   phase1          C-1/C-2/C-3：role spawn 语义 + JSONL v3 格式（必须在 tmux pane 内运行）
 *   sf <name>       打印 name 的 session 文件路径与 launch 脚本路径
 *   kvget <sub> <n> 打印 KV 卡/名条目
 *   kv-dump <sub>   dump 该 subnet 的 profiles+names 到 /tmp/e2e-c-kv-<sub>.json 并打印
 *   wake <n> <msg>  以 c-waker 身份向 <n> 发一条消息（test-c）
 *   noreply-harness 注册 c-noreply 并每 5s 心跳，直到进程被终止（C-7 长驻）
 *   fork-probe      F-1：fork spawn 集成 — 父 fixture → fork 文件 → 真实 pi 子进程加载
 */
import { executeAgentSpawn, executeAgentSpawnByRole, executeAgentKill, listRoleNames } from "../../extensions/agent-lifecycle.ts";
import * as registry from "../../extensions/lib/comms/registry.ts";
import * as messaging from "../../extensions/lib/comms/messaging.ts";
import * as nats from "../../extensions/lib/comms/nats.ts";
import { readSecretFile, type RuntimeConfig } from "../../extensions/lib/comms/config.ts";
import {
  DEFAULT_SUBNET, DEFAULT_NATS_URL, DEFAULT_REGISTRY_TTL_MS, DEFAULT_MESSAGE_TTL_MS,
  DEFAULT_HISTORY_TTL_MS, DEFAULT_HEARTBEAT_MS, DEFAULT_STALE_AFTER_MS, DEFAULT_OFFLINE_AFTER_MS,
} from "../../extensions/lib/comms/protocol.ts";
import type { Identity } from "../../extensions/lib/comms/protocol.ts";
import { agentFileStem, SCRIPT_DIR } from "../../extensions/lib/launch-script.ts";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { connectE2e, kvRead, waitFor, waitForJsonl, readJsonl, sessionHeader, tmuxWindows, tmuxWindowCount, sleep, BUCKETS } from "./helpers.ts";
import { forkSessionManager, freshSessionManager } from "../helpers/fake-session-manager.ts";

const ROOT = process.cwd();
const FAKE_CTX = {
  model: { provider: "deepseek", id: "deepseek-v4-flash" },
  thinkingLevel: "off",
  sessionManager: freshSessionManager(),
} as any;

// ━━ 断言辅助 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let passCount = 0;
let failCount = 0;
function check(id: string, ok: boolean, note: string): void {
  if (ok) {
    passCount++;
    console.log(`[PASS] ${id} ${note}`);
  } else {
    failCount++;
    console.log(`[FAIL] ${id} ${note}`);
  }
}
function deepEq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}



function sessionPath(name: string): string {
  return join(ROOT, ".pi", "agent-sessions", `${agentFileStem(name)}.json`);
}
function launchPath(name: string): string {
  return join(SCRIPT_DIR, `launch-${agentFileStem(name)}.sh`);
}
function launchScriptContent(name: string): string {
  const p = launchPath(name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function registerEntryIn(path: string) {
  return readJsonl(path).find((e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register");
}

function makeConfig(subnet: string): RuntimeConfig {
  return {
    natsUrl: DEFAULT_NATS_URL,
    authToken: readSecretFile(),
    subnet,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    messageTtlMs: DEFAULT_MESSAGE_TTL_MS,
    registryTtlMs: DEFAULT_REGISTRY_TTL_MS,
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    offlineAfterMs: DEFAULT_OFFLINE_AFTER_MS,
    historyTtlMs: DEFAULT_HISTORY_TTL_MS,
  };
}

// ━━ C-1 / C-2 / C-3 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function phase1(): Promise<void> {
  console.log(`[env] cwd=${ROOT} tmuxWindows=${JSON.stringify(tmuxWindows("e2e-c"))}`);
  const windowCountBefore = tmuxWindowCount("e2e-c");

  // ── C-1 ──
  const roles = listRoleNames();
  const EXPECTED_ROLES = ["coordinator", "requirements-clarifier", "scout", "worker", "planner", "experts-reviewer", "consultor", "web-searcher"];
  check("C-1", roles.length === 8 && EXPECTED_ROLES.every((r) => roles.includes(r)),
    `listRoleNames() 集合精确=8角色: [${roles.join(", ")}]`);
  // 顺序由 readdirSync 决定（文件系统序），代码无排序契约——只作为备注
  console.log(`[note] C-1 listRoleNames() 顺序=${JSON.stringify(roles)}（readdir 序，非契约）`);

  let unknownErr: unknown = null;
  let r1: any = null;
  try {
    r1 = await executeAgentSpawnByRole({ role: "nope" }, ROOT, FAKE_CTX);
  } catch (e) { unknownErr = e; }
  check("C-1", unknownErr === null, "未知角色不抛错");
  check("C-1", r1 !== null && r1.details?.error === "Unknown role",
    `details.error="Unknown role" (got ${JSON.stringify(r1?.details)})`);
  check("C-1", r1 !== null && r1.content?.[0]?.text?.includes("coordinator") && r1.content?.[0]?.text?.includes("web-searcher"),
    `content 列出角色: ${r1?.content?.[0]?.text}`);
  const windowCountAfterUnknown = tmuxWindowCount("e2e-c");
  check("C-1", windowCountAfterUnknown === windowCountBefore,
    `未知角色不 spawn（window 数 ${windowCountBefore} → ${windowCountAfterUnknown}）`);

  // ── C-2 ──
  let r2: any = null;
  let spawnErr: unknown = null;
  try {
    r2 = await executeAgentSpawnByRole({ role: "worker" }, ROOT, FAKE_CTX);
  } catch (e) { spawnErr = e; }
  check("C-2", spawnErr === null, "role=worker spawn 不抛错");
  check("C-2", r2?.details?.agentName === "worker", `details.agentName="worker" (got ${JSON.stringify(r2?.details)})`);
  const workerSession = sessionPath("worker");
  const workerLaunch = launchScriptContent("worker");
  check("C-2", workerLaunch.includes("--role 'worker'"), `launch 脚本含 --role worker: ${launchPath("worker")}`);
  check("C-2", workerLaunch.includes("--cname 'worker'"), `launch 脚本含 --cname worker`);
  check("C-2", workerLaunch.includes("--subnet 'test-c'"), `launch 脚本含 --subnet test-c (subnet 继承)`);

  // ── C-2 dedupe：同名角色二次 spawn → worker-2 ──
  let r2b: any = null;
  try {
    r2b = await executeAgentSpawnByRole({ role: "worker" }, ROOT, FAKE_CTX);
  } catch (e) { r2b = { details: { error: String(e) } }; }
  check("C-2", r2b?.details?.agentName === "worker-2",
    `重复 spawn 同名角色去重 → "worker-2" (got ${JSON.stringify(r2b?.details)})`);
  const worker2Session = sessionPath("worker-2");
  check("C-2", existsSync(worker2Session) && launchScriptContent("worker-2").includes("--cname 'worker-2'"),
    `worker-2 launch 脚本与 session 文件已生成`);

  // ── C-3a：pi 自举文件格式 ──
  const workerRegister = await waitForJsonl(workerSession,
    (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
    { timeoutMs: 90_000, label: "worker register" }).catch(() => null);
  check("C-2", workerRegister !== null, "≤90s worker agent session 出现 register 事件");
  check("C-3", workerRegister?.data?.subnet === "test-c", `worker register subnet="test-c"`);

  const wLines = readJsonl(workerSession);
  const w0 = wLines[0] ?? {};
  check("C-3", w0.type === "session" && w0.version === 3, `首行 session v3 (got ${JSON.stringify(w0).slice(0, 120)})`);
  const w1 = wLines[1] ?? {};
  check("C-3", w1.type === "model_change" && w1.provider === "deepseek" && w1.modelId === "deepseek-v4-flash",
    `model_change provider/id 与 spawner 一致 (got ${JSON.stringify({ type: w1.type, provider: w1.provider, modelId: w1.modelId })})`);
  const w2 = wLines[2] ?? {};
  check("C-3", w2.type === "thinking_level_change" && w2.parentId === w1.id,
    `thinking_level_change 紧随 model_change 且 parentId 链连续`);
  check("C-3", wLines.some((e) => e?.customType === "comms-log" && e?.data?.event === "ensure_stream"),
    `后续含 ensure_stream 条目`);
  check("C-3", wLines.some((e) => e?.customType === "comms-log" && e?.data?.event === "register"),
    `后续含 register 条目`);

  // worker-2 的 register（一并确认它在同一 subnet）
  const w2Reg = await waitForJsonl(worker2Session,
    (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
    { timeoutMs: 90_000, label: "worker-2 register" }).catch(() => null);
  check("C-2", w2Reg?.data?.subnet === "test-c", `worker-2 register subnet="test-c"`);

  // ── C-3b：writePreloadedSessionFile（带 messages，SessionManager 预载）文件格式 ──
  let r3: any = null;
  try {
    r3 = await executeAgentSpawn({
      name: "c-fmt",
      llmContext: { systemPrompt: "x", messages: [{ role: "user", content: "hi" }] },
    }, ROOT, FAKE_CTX);
  } catch (e) { r3 = { details: { error: String(e) } }; }
  check("C-3", r3?.details?.name === "c-fmt", `executeAgentSpawn c-fmt 成功 (got ${JSON.stringify(r3?.details)?.slice(0, 200)})`);
  const fmtSession = sessionPath("c-fmt");
  await sleep(300); // 给 pi 启动前留一个窗口，读预写文件头部
  const fLines = readJsonl(fmtSession);
  const f0 = fLines[0] ?? {};
  const f1 = fLines[1] ?? {};
  const f2 = fLines[2] ?? {};
  const f3 = fLines[3] ?? {};
  check("C-3", f0.type === "session" && f0.version === 3, `c-fmt 首行 session v3`);
  check("C-3", f1.type === "model_change" && f1.provider === "deepseek" && f1.modelId === "deepseek-v4-flash",
    `c-fmt model_change 与 fakeCtx 一致`);
  check("C-3", f2.type === "thinking_level_change" && f2.thinkingLevel === "off" && f2.parentId === f1.id,
    `c-fmt thinking_level_change(off) 紧随且 parentId 链连续`);
  check("C-3", f3?.type === "message" && f3?.message?.role === "user" && f3?.message?.content?.[0]?.text === "hi",
    `c-fmt 消息条目 user "hi"`);
  check("C-3", f3?.parentId === f2?.id, `c-fmt 消息 parentId 链连续 (${f3?.parentId} → ${f2?.id})`);

  // 之后 pi 追加 register（验证预写文件被 pi 接受、同一文件继续追加）
  const fmtReg = await waitForJsonl(fmtSession,
    (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
    { timeoutMs: 90_000, label: "c-fmt register" }).catch(() => null);
  check("C-3", fmtReg?.data?.subnet === "test-c" && fmtReg?.data?.name === "c-fmt",
    `c-fmt register 追加到同一文件 (subnet=${fmtReg?.data?.subnet})`);
  // 头部仍然是单一条 session 头（pi 不重写 header）
  const fmtLinesAfter = readJsonl(fmtSession);
  const sessionsAfter = fmtLinesAfter.filter((e) => e?.type === "session");
  check("C-3", sessionsAfter.length === 1, `pi 未重复写 session header（文件内仅 1 条）`);

  // ── 清理 ──
  executeAgentKill({ name: "worker" });
  executeAgentKill({ name: "worker-2" });
  executeAgentKill({ name: "c-fmt" });
  await sleep(1000);
  console.log(`[phase1 done] PASS=${passCount} FAIL=${failCount}`);
}

// ━━ KV 工具 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function kvDump(subnet: string): Promise<void> {
  const nc = await connectE2e();
  const kvC = await nc.jetstream().views.kv(BUCKETS.profiles, { history: 1 });
  const kvN = await nc.jetstream().views.kv(BUCKETS.names, { history: 1 });
  const out: Record<string, unknown> = { profiles: {}, names: {} };
  for (const [kv, target] of [
    [kvC, "profiles"],
    [kvN, "names"],
  ] as const) {
    const prefix = target === "profiles" ? `a.${subnet}.` : `n.${subnet}.`;
    const keys: string[] = [];
    try {
      const kiter = await kv.keys();
      for await (const k of kiter) {
        if (k.startsWith(prefix)) keys.push(k);
      }
      await kiter.stop().catch(() => {});
    } catch (e) {
      console.log(`[kv-dump] keys() failed for ${target}: ${String(e)}`);
    }
    const entries: Record<string, unknown> = {};
    for (const k of keys) {
      const v = await kvRead(kv, k);
      if (v !== null) entries[k] = v;
    }
    out[target] = entries;
  }
  const file = `/tmp/e2e-c-kv-${subnet}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`[kv-dump] ${subnet}: profiles=${Object.keys(out.profiles).length} names=${Object.keys(out.names).length} → ${file}`);
  console.log(JSON.stringify(out, null, 2));
  await nc.close();
}

async function kvGet(subnet: string, name: string): Promise<void> {
  const nc = await connectE2e();
  const kvC = await nc.jetstream().views.kv(BUCKETS.profiles, { history: 1 });
  const kvN = await nc.jetstream().views.kv(BUCKETS.names, { history: 1 });
  const profile = await kvRead(kvC, `a.${subnet}.${name}`);
  const nameEntry = await kvRead(kvN, `n.${subnet}.${name}`);
  console.log(`[kvget] a.${subnet}.${name} = ${JSON.stringify(profile)}`);
  console.log(`[kvget] n.${subnet}.${name} = ${JSON.stringify(nameEntry)}`);
  await nc.close();
}

// ━━ wake：给某 agent 发消息（C-5 唤醒验证） ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function wake(name: string, message: string): Promise<void> {
  const cfg = makeConfig("test-c");
  await nats.connectNats(cfg);
  const identity: Identity = {
    name: "c-waker",
    subnet: "test-c",
    cwd: ROOT,
    model: "deepseek/deepseek-v4-flash",
    started_at: new Date().toISOString(),
  };
  const r = await messaging.send(identity, name, message);
  console.log(`[wake] sent to ${name}: msg_id=${r.msg_id} target_status=${r.target_status}`);
  await sleep(500);
  await nats.closeNats();
}

// ━━ noreply-harness：C-7 长驻（c-noreply 身份 + 心跳） ━━━━━━━━━━━━━━━━━━━━

async function noreplyHarness(subnet: string): Promise<void> {
  const cfg = makeConfig(subnet);
  await nats.connectNats(cfg);
  const identity: Identity = {
    name: "c-noreply",
    subnet,
    cwd: ROOT,
    model: "deepseek/deepseek-v4-flash",
    started_at: new Date().toISOString(),
  };
  const reg = await registry.register(identity, { context_used_pct: 5, model: identity.model });
  console.log(`[noreply-harness] registered as ${reg.name}@${subnet}`);
  let beat = 0;
  const timer = setInterval(async () => {
    try {
      await registry.heartbeat(identity, { context_used_pct: 5, model: identity.model });
      beat++;
      if (beat % 6 === 0) console.log(`[noreply-harness] heartbeat #${beat}`);
    } catch (e) {
      console.log(`[noreply-harness] heartbeat failed: ${String(e)}`);
    }
  }, 5000);
  const shutdown = async () => {
    clearInterval(timer);
    try { await registry.clearOwn(identity); } catch { /* best effort */ }
    await nats.closeNats();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log("[noreply-harness] running (heartbeat every 5s). Ctrl-C or SIGTERM to stop.");
  // keep alive
  await new Promise<void>(() => {});
}

// ━━ main ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (!cmd) {
    console.log("usage: dim-c.ts <phase1|sf|kvget|kv-dump|wake|noreply-harness|fork-probe> [args]");
    process.exit(1);
  }
  switch (cmd) {
    case "phase1":
      await phase1();
      break;
    case "sf": {
      const p = sessionPath(a1);
      console.log(`session: ${p}`);
      console.log(`launch:  ${launchPath(a1)}`);
      console.log(`exists:  ${existsSync(p)}`);
      break;
    }
    case "kvget":
      await kvGet(a1, a2);
      break;
    case "kv-dump":
      await kvDump(a1);
      break;
    case "wake":
      await wake(a1, a2);
      break;
    case "noreply-harness":
      await noreplyHarness(a1 ?? "test-c");
      break;
    case "spawn-empty": {
      // 探测：spawn 空会话 agent，观察是否自 exit（复现 worker 现象）
      const name = a1 ?? "c-probe";
      const r = await executeAgentSpawn({ name, llmContext: {} }, ROOT, FAKE_CTX);
      console.log(`[spawn-empty] spawned ${name}: ${JSON.stringify(r.details)}`);
      const p = sessionPath(name);
      const reg = await waitForJsonl(p,
        (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
        { timeoutMs: 90_000, label: `${name} register` }).catch(() => null);
      console.log(`[spawn-empty] register: ${JSON.stringify(reg?.data)}`);
      const windowCount0 = tmuxWindowCount("e2e-c");
      let shutdownSeen = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const es = readJsonl(p);
        if (es.some((e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "shutdown")) {
          shutdownSeen = true;
          console.log(`[spawn-empty] SHUTDOWN EVENT at +${i + 1}s`);
          break;
        }
        const wc = tmuxWindowCount("e2e-c");
        if (wc < windowCount0) {
          console.log(`[spawn-empty] WINDOW GONE at +${i + 1}s (window count ${windowCount0} → ${wc})`);
          break;
        }
      }
      console.log(`[spawn-empty] shutdownSeen=${shutdownSeen} events=${JSON.stringify(readJsonl(p).map((e) => (e as any).data?.event ?? e?.type))}`);
      executeAgentKill({ name });
      break;
    }
    case "fork-probe": {
      // F-1：fork spawn 集成 — 父 fixture（含委派尾巴）→ fork 文件 → 真实 pi
      // 子进程用 --session 加载 fork 文件并追加 register；父文件字节不变。
      const name = a1 ?? "c-forkee";
      const sessionDir = join(ROOT, ".pi", "agent-sessions");
      const parentFile = join(sessionDir, "fork-parent-fixture.json");
      const forkFile = join(sessionDir, "fork-probe-out.jsonl");
      const ts = new Date().toISOString();
      // 父 fixture：背景对话 + 委派尾巴（comms-inbound）
      const parentLines = [
        JSON.stringify({ type: "session", version: 3, id: "fixture-parent", timestamp: ts, cwd: ROOT }),
        JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: ts, provider: "deepseek", modelId: "deepseek-v4-flash" }),
        JSON.stringify({ type: "thinking_level_change", id: "tl1", parentId: "mc1", timestamp: ts, thinkingLevel: "off" }),
        // usage is REQUIRED on assistant messages: pi's TUI renderer reads
        // usage.input/cost.total when rendering history (a fixture without it
        // crashes the child at startup — real forks inherit full usage from
        // the parent's messages, so this only affects hand-built fixtures).
        JSON.stringify({ type: "message", id: "bg1", parentId: "tl1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "background work from parent" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
        JSON.stringify({ type: "custom_message", id: "in1", parentId: "bg1", timestamp: ts, customType: "comms-inbound", content: "delegation tail", display: true }),
      ];
      writeFileSync(parentFile, parentLines.join("\n") + "\n");
      const parentBytes = readFileSync(parentFile);
      // 预构造 fork 文件 = 裁剪后的内容（不含 inbound 尾巴）
      const forkLines = parentLines.slice(0, 4);
      writeFileSync(forkFile, forkLines.join("\n") + "\n");

      // Feed the real fixture entries (with the inbound tail) so
      // findForkTargetId runs for real — trim targets bg1, trimmed=true.
      const ctx = {
        ...FAKE_CTX,
        sessionManager: forkSessionManager(
          parentFile,
          forkFile,
          parentLines.slice(1).map((l) => JSON.parse(l)),
          "in1",
        ),
      };
      let r: any = null;
      try {
        r = await executeAgentSpawn({ name, llmContext: { context: "fork", systemPrompt: "you are a forkee" } }, ROOT, ctx);
      } catch (e) { r = { details: { error: String(e) } }; }
      check("F-1", r?.details?.name === name && r?.details?.sessionFile === forkFile,
        `fork spawn 使用 fork 文件路径 (got ${JSON.stringify(r?.details)?.slice(0, 200)})`);
      check("F-1", r?.details?.forked === true && r?.details?.trimmed === true && r?.details?.context === "fork",
        `details.forked/trimmed/context 标记正确`);
      check("F-1", existsSync(forkFile) && !readFileSync(forkFile, "utf-8").includes("delegation tail"),
        `fork 文件存在且不含委派尾巴内容`);

      // 真实 pi 子进程加载 fork 文件并追加 register（验证文件被 pi 接受）
      const reg = await waitForJsonl(forkFile,
        (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
        { timeoutMs: 90_000, label: `${name} register in fork file` }).catch(() => null);
      check("F-1", reg?.data?.name === name, `register 追加进 fork 文件 (subnet=${reg?.data?.subnet})`);
      // 父文件未被修改（fork 是只读操作）
      check("F-1", Buffer.from(readFileSync(parentFile)).equals(Buffer.from(parentBytes)),
        `父 fixture 文件字节不变`);
      // fork 文件头部保持单一条 session header
      const fAfter = readJsonl(forkFile);
      check("F-1", fAfter.filter((e) => e?.type === "session").length === 1,
        `fork 文件内仅 1 条 session header`);
      executeAgentKill({ name });
      break;
    }
    case "spawn-role-probe": {
      // 探测：role=worker spawn（复现 C-2 条件），观察 20s 是否自 exit
      const name = a1 ?? "c-roleprobe";
      const r = await executeAgentSpawnByRole({ role: "worker", name }, ROOT, FAKE_CTX);
      console.log(`[spawn-role-probe] spawned: ${JSON.stringify(r.details)}`);
      const p = sessionPath(name);
      const reg = await waitForJsonl(p,
        (e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "register",
        { timeoutMs: 90_000, label: `${name} register` }).catch(() => null);
      console.log(`[spawn-role-probe] register: ${JSON.stringify(reg?.data)}`);
      const windowCount0 = tmuxWindowCount("e2e-c");
      let shutdownSeen = false;
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const es = readJsonl(p);
        if (es.some((e) => e?.type === "custom" && e?.customType === "comms-log" && e?.data?.event === "shutdown")) {
          shutdownSeen = true;
          console.log(`[spawn-role-probe] SHUTDOWN EVENT at +${i + 1}s`);
          break;
        }
        if (tmuxWindowCount("e2e-c") < windowCount0) {
          console.log(`[spawn-role-probe] WINDOW GONE at +${i + 1}s (window count ${windowCount0} → ${tmuxWindowCount("e2e-c")})`);
          break;
        }
      }
      console.log(`[spawn-role-probe] shutdownSeen=${shutdownSeen} events=${JSON.stringify(readJsonl(p).map((e) => (e as any).data?.event ?? e?.type))}`);
      executeAgentKill({ name });
      break;
    }
    default:
      console.log(`unknown command ${cmd}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.log(`[FATAL] ${e?.stack ?? String(e)}`);
  process.exit(1);
});
