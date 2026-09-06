/**
 * comms 冒烟测试 — 真实 NATS + 真实 smoke-b 会话(手动驱动)。
 *
 * 前置:tmux 会话中 smoke-b pi 已启动(--cname smoke-b --subnet smoketest):
 *   pi -e <repo>/extensions/comms.ts --cname smoke-b --subnet smoketest
 *
 * 运行:bun run tests/e2e/comms-smoke.ts
 *
 * 验证:
 *   1. smoke-b 名字租约存在(在线)
 *   2. steer / followUp 两条消息发布,smoke-b 的 durable consumer 完成 ack
 *      (注入即 ack); pane 上可见 [comms-inbound] 注入与回答
 *   3. 第三条消息要求 comms_send 回复:模拟 sim-a(名字租约 + sub)收到
 *      smoke-b 的回信,reply_to_msg_id 与消息 ID 一致
 */
import { connectE2e, waitFor, BUCKETS, sleep } from "./helpers.ts";
import {
  streamName,
  msgSubject,
  msgSubjectPrefix,
  promptDurable,
  ulid,
  profileKey,
  DEFAULT_NATS_URL,
} from "../../extensions/lib/comms/protocol.ts";

const SUBNET = "smoketest";
const TARGET = "smoke-b";
const SENDER = "sim-a";

async function main(): Promise<void> {
  const nc = await connectE2e();
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  console.log(`[1] connected ${DEFAULT_NATS_URL}`);

  // ── 1. 等待 smoke-b 注册(living profile)──
  const profiles = await js.views.kv(BUCKETS.profiles);
  await waitFor(async () => Boolean(await profiles.get(profileKey(SUBNET, TARGET)).catch(() => null)), {
    label: "smoke-b profile", timeoutMs: 60_000,
  });
  console.log(`[2] smoke-b registered on ${SUBNET}`);

  // ── 1.5 consumer ack 基线 ──
  const baseCi: any = await jsm.consumers.info(streamName(SUBNET), promptDurable(TARGET));
  const baseAck = baseCi.ack_floor?.consumer_seq ?? 0;
  console.log(`[baseline] consumer p_${TARGET} ack_floor_seq=${baseAck} delivered_seq=${baseCi.delivered?.consumer_seq}`);

  // ── 2. sim-a 心跳(living profile,15s 续期 —— smoke-b 的 comms_send 才能 resolve)──
  const simProfile = {
    name: SENDER, model: "sim", cwd: "/tmp", subnet: SUBNET,
    started_at: new Date().toISOString(), context_used_pct: 0,
    lifecycle: "living", last_seen_at: new Date().toISOString(),
  };
  const lease = setInterval(() => {
    profiles.put(profileKey(SUBNET, SENDER), JSON.stringify({ ...simProfile, last_seen_at: new Date().toISOString() })).catch(() => {});
  }, 15_000);
  await profiles.put(profileKey(SUBNET, SENDER), JSON.stringify(simProfile));

  // ── 3. 订阅 sim-a 的收件,截获 smoke-b 的回复 ──
  const replies: any[] = [];
  const sub = nc.subscribe(msgSubjectPrefix(SUBNET, SENDER), {
    callback: (err, msg) => {
      if (err) return;
      try { replies.push(JSON.parse(msg.string())); } catch { /* ignore */ }
    },
  });

  // ── 4. 发布两条消息(steer + followUp)──
  const msgs: Array<{ deliver_as?: "steer" | "followUp"; text: string }> = [
    { deliver_as: "steer", text: "本地 comms 冒烟测试(steer)。这是 sim-a 发给 smoke-b 的测试消息,告知收到即可。" },
    { deliver_as: "followUp", text: "本地 comms 冒烟测试(followUp)。同上,告知收到即可。" },
  ];
  let i = 0;
  for (const m of msgs) {
    const msgId = ulid();
    await js.publish(msgSubject(SUBNET, TARGET, msgId), JSON.stringify({
      msg_id: msgId, subnet: SUBNET, sender: { name: SENDER, cwd: "/tmp" },
      message: m.text, deliver_as: m.deliver_as,
    }), { msgID: msgId });
    console.log(`[3] published #${++i} deliver_as=${m.deliver_as ?? "steer"} msg_id=${msgId}`);
  }

  // ── 5. 第三条消息:要求 smoke-b 用 comms_send 回复(验证 reply 链路)──
  const replyMsgId = ulid();
  await js.publish(msgSubject(SUBNET, TARGET, replyMsgId), JSON.stringify({
    msg_id: replyMsgId, subnet: SUBNET, sender: { name: SENDER, cwd: "/tmp" },
    message: "这是 sim-a 的第三条消息(要求回复)。请调用 comms_send(target=sim-a, reply_to_msg_id=" +
      `${replyMsgId}, message="replying to you") 回复我。`,
    deliver_as: "steer",
  }), { msgID: replyMsgId });
  console.log(`[4] published #3 (reply-request) msg_id=${replyMsgId}`);

  // ── 6. 等待 smoke-b 的回复 ──
  const got = await waitFor(async () => {
    const r = replies.find((x) => x.reply_to_msg_id === replyMsgId);
    return r || null;
  }, { label: "smoke-b reply publish", timeoutMs: 90_000 });
  console.log(`[5] REPLY received: sender=${got.sender?.name} message=${JSON.stringify(got.message)} reply_to_msg_id=${got.reply_to_msg_id}`);

  // ── 7. consumer ack 统计(注入即 ack 的硬证据):本次 3 条必须已 ack ──
  await waitFor(async () => {
    const x: any = await jsm.consumers.info(streamName(SUBNET), promptDurable(TARGET));
    return (x.ack_floor?.consumer_seq ?? 0) >= baseAck + 3;
  }, { label: "consumer ack_floor advanced +3", timeoutMs: 60_000 });
  const ci: any = await jsm.consumers.info(streamName(SUBNET), promptDurable(TARGET));
  console.log(`[6] consumer p_${TARGET}: ack_floor_seq=${ci.ack_floor?.consumer_seq} (+${ci.ack_floor.consumer_seq - baseAck}) delivered_seq=${ci.delivered?.consumer_seq} ack_pending=${ci.num_ack_pending} redelivered=${ci.num_redelivered} pending=${ci.num_pending}`);
  console.log(`[7] ack_pending=${ci.num_ack_pending} redelivered=${ci.num_redelivered} — 注入即 ack,无滞留、无重投`);
  if ((ci.num_ack_pending ?? 0) > 0 || (ci.num_redelivered ?? 0) > 0) {
    throw new Error(`unexpected ack_pending=${ci.num_ack_pending} / redelivered=${ci.num_redelivered}`);
  }

  console.log("SMOKE PASS");
  clearInterval(lease);
  sub.unsubscribe();
  await sleep(200);
  await nc.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err?.message ?? err);
  process.exit(1);
});
