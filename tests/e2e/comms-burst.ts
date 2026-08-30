/**
 * comms 并发/突发消息试验 — 长 turn(工具 sleep)期间连发 steer + followUp。
 *
 * 前置:tmux 中 smoke-b 在线(--cname smoke-b --subnet smoketest)
 * 运行:bun run tests/e2e/comms-burst.ts
 *
 * 观测:发布顺序与注入顺序(见 smoke-b pane);steer 组在 turn 内、followUp 组
 * 在 turn 结束后,各自保序。
 */
import { connectE2e, waitFor, BUCKETS } from "./helpers.ts";
import { msgSubject, ulid, nameKey } from "../../extensions/lib/comms/protocol.ts";

const SUBNET = "smoketest";
const TARGET = "smoke-b";
const SENDER = "sim-a";
const log = (tag: string, ...rest: any[]) => console.log(new Date().toISOString().slice(11, 23), tag, ...rest);

async function main(): Promise<void> {
  const nc = await connectE2e();
  const js = nc.jetstream();
  const names = await js.views.kv(BUCKETS.names);
  await waitFor(async () => Boolean(await names.get(nameKey(SUBNET, TARGET)).catch(() => null)), {
    label: "smoke-b name lease", timeoutMs: 60_000,
  });
  log("[1] smoke-b online");

  const pub = async (m: { deliver_as?: "steer" | "followUp"; text: string }): Promise<string> => {
    const msgId = ulid();
    await js.publish(msgSubject(SUBNET, TARGET, msgId), JSON.stringify({
      msg_id: msgId, subnet: SUBNET, sender: { name: SENDER, cwd: "/tmp" },
      message: m.text, deliver_as: m.deliver_as,
    }), { msgID: msgId });
    return msgId;
  };

  // ── 0. 长 turn 指令 ──
  await pub({ text: "请现在调用 bash 工具执行:sleep 30(这是为了制造一个长时间的工具执行)。完成后只总结一句你执行了什么,不要做其它事。" });
  log("[2] sleep-30 指令已发布,等待工具开始执行 …");
  await new Promise((r) => setTimeout(r, 12_000));

  // ── 1. 突发 4 条:steer / followUp 交错,间隔 2s ──
  const burst = [
    { deliver_as: "steer" as const, text: "突发消息 A(steer)。请只用一句话确认收到,不要调用工具。" },
    { deliver_as: "followUp" as const, text: "突发消息 B(followUp)。请只用一句话确认收到,不要调用工具。" },
    { deliver_as: "steer" as const, text: "突发消息 C(steer)。请只用一句话确认收到,不要调用工具。" },
    { deliver_as: "followUp" as const, text: "突发消息 D(followUp)。请只用一句话确认收到,不要调用工具。" },
  ];
  for (const [i, m] of burst.entries()) {
    const id = await pub(m);
    log(`[3] published burst#${i + 1} ${m.deliver_as} msg_id=${id.slice(-6)}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  log("[4] burst 全部发布 — 等待 smoke-b 处理完 turn + 后续 …");

  // ── 2. 等待足够时间让 turn 结束 + followUp 处理 ──
  await new Promise((r) => setTimeout(r, 75_000));
  log("[5] 观察窗口结束,请查看 smoke-b pane 的注入顺序");
  process.exit(0);
}

main().catch((e) => { console.error("BURST FAIL:", e?.message ?? e); process.exit(1); });
