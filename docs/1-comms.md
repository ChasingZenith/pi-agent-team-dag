# Comms — Pi Agent 通信网络层(NATS + JetStream)

---

## 1. 概述

**comms** 是 Pi Coding Agent 的**消息通信总线扩展**,为同一台机器(或同一网络)上运行的多个 Pi agent 实例提供发现、路由、消息传递和响应应答能力,基于 **NATS + JetStream** 实现。

**核心特性:**

- NATS 服务器(JetStream 持久化)统一承载注册表、消息流与回复流
- agent 注册与自动发现(TTL 租约心跳)
- 实时推送:KV watch 驱动 peer 缓存(自愈见 §3);UI 另有 15s 周期刷新,派生状态(online→stale→offline)即使无任何事件也按时如实呈现(见 §7)
- 消息**持久化**:服务器重启不丢;agent 崩溃自动重投(max_deliver 3)
- **跨重启复用**:地址以名字锚定、不随进程变化——同名重启复用同一 durable consumer(干净关闭也不删除),未 ack 的 prompt 重投、已 ack 的不重放、离线期间积累的消息续投(stream TTL 内);outbox/inbox 历史同样跨重启可读(见 §2.1.1、§9)
- **显式回复**:回复 = `comms_send(target=<发送方>, reply_to_msg_id=<收到的 msg_id>)`,无自动应答;回复自动以入站 turn 到达,无需轮询(见 §2.4、§6.2)
- **合并定时提醒**:提醒按**消息**挂载→ `comms_send(remind_s=<seconds>)` 挂上,事后用 `comms_remind(msg_id, remind_s)` 设置/调整/取消;激活的提醒每过一个间隔注入**一条合并提醒**(覆盖所有激活提醒),到期停止提醒;完全不带提醒的发送(默认 `remind_s=0`)即单向纯通知(见 §2.4)
- **投递模式可选**:`comms_send(deliver_as=…)` 控制消息到达对端 agent 的投递方式 — `steer`(默认)/ `follow-up` / `next turn`(语义见 §6.2)
- Bearer token 认证(NATS 原生,默认自动生成,0600 持久化)
- 客户端原生自动重连(指数退避由 NATS 客户端处理)

---
## 2. 架构

### 2.1 拓扑结构

```
┌───────────────────────────────────────────────────────────────────────┐
│                    nats-server (JetStream)                            │
│                                                                       │
│  stream COMMS_<subnet>   <subnet>.msg.> (subnet 默认 "subnet0",--subnet 指定) │
│  bucket comms_profiles     a.<subnet>.<name> 资料(永久,离线保留可见)      │
│  bucket comms_names     n.<subnet>.<name> 名字租约(TTL 30s,存在=在线)  │
│  bucket comms_history   h.<subnet>.<name>.<out|in>.<msg_id> 消息内容历史(TTL 默认 24h) │
└──────┬────────────────────────────────────────────────────────────────┘
       │  NATS 协议(TLS/认证可选)
       ▼
  ┌─────────┐       ┌─────────┐        ┌─────────┐
  │ Agent A │       │ Agent B │        │ Agent C │
  │ (pi +   │       │ (pi +   │        │ (pi +   │
  │ comms.ts)│       │ comms.ts)│        │ comms.ts)│
  └─────────┘       └─────────┘        └─────────┘
```

每个 agent 一个 NATS 连接,持有一个 durable consumer:

- **`p_<name>`** — prompt consumer,过滤 `<subnet>.msg.<name>.>`(名字经 sanitize 后作段),显式 ack,ack_wait = 5 分钟重投窗口(远小于消息 TTL,max_deliver 重投才有机会发生),max_deliver 3。回复也走同一 subject,靠 payload 的 `reply_to_msg_id` 标记区分。consumer 以**名字**命名并**跨重启保留**(干净关闭不删除,见 §3):同名重启复用同一 consumer — 未 ack 的 prompt 重投,已 ack 的不重放,离线期间积累的消息在重启后续投。`deliver_policy: All` 只在 consumer **首次创建**时生效(拿回创建前就排队的消息),之后投递由游标 + ack 决定。

### 2.1.1 身份模型:名字即身份

agent 的 **name** 就是它的 comms 身份,也是所有持久构件的地址:

| 构件 | 锚定 |
|---|---|
| 消息 subject | `<subnet>.msg.<name>.<msg_id>` |
| prompt consumer | `p_<name>` |
| 消息历史 key | `h.<subnet>.<name>.<out\|in>.<msg_id>` |
| 资料 / 名字租约 | `a.<subnet>.<name>` / `n.<subnet>.<name>` |

不存在每进程的随机 id:名字跨重启稳定,所以同名的重启 agent 复用同一 consumer 队列(未 ack 重投、已 ack 不重放、离线消息续投)、同一历史记录(outbox/inbox 重读跨重启成立)、同一任务派发归属(任务图 `dispatched_to` 记的就是名字)。一次运行(incarnation)的区分由资料的 `started_at` / `last_seen_at` 承担。pi session id 属于 pi 会话层(会话文件、上下文压缩),comms 不消费。名字在 subnet 内唯一:租约独占 + 冲突自动后缀(`scout` → `scout2`)。

### 2.2 消息流

```
Agent A (发送方)              NATS                    Agent B (接收方)
     │                         │                          │
     │  comms_send          │                          │
     │  js.publish             │                          │
     │  default.msg.<B>.<msgid> │                    │
     │ ───────────────────────►│ (JetStream 持久化)        │
     │  (合并 remind 调度)      │  B 的 p_<B> consumer      │
     │                         │ ───────────────────────► │
     │                         │        (B 处理任务…)       │
     │                         │                          │
     │                         │  B 回复 = comms_send  │
     │                         │  js.publish              │
     │                         │  default.msg.<A>.<id2> │
     │                         │   payload.reply_to_msg_id   │
     │                         │    = <msgid>             │
     │                         │ ───────────────────────► │
     │  A 的 p_<A> consumer   │                          │
     │ ◄────────────────────── │  命中 pending:记录结果    │
     │   + 停止该 msgid 的提醒  │  + 停止提醒循环           │
```

**关键设计:消息都通过 JetStream 持久化**(不是 core NATS 的 at-most-once)。接收方崩溃后未 ack 的 prompt 自动重投,客户端按 msg_id 去重,不会重复触发对话。回复与普通消息同一条通道,`reply_to_msg_id` 命中发送方本地 pending 时自动记录结果并停止提醒循环。

### 2.3 注册表 = 资料永久 + 名字租约

三个 KV bucket,**生命周期刻意不同**(NATS KV 的 TTL 是 bucket 级,不能按 key 混配):

- **`comms_profiles`(无 TTL,永久)** — `a.<subnet>.<name>` 完整资料。key 用**名字**:一个名字一份资料,名字被新运行抢占时自动覆盖旧资料(不产生重启后的重复资料);agent 离线后资料**保留可见**,状态由 `last_seen_at` 推导,不会从注册表消失。正常退出(`clearOwn`)显式删除自己的资料;崩溃则留下供 peers 查看。
- **`comms_names`(bucket 级 TTL 30s,租约)** — `n.<subnet>.<name>` 名字租约,值是名字本身(名字即地址,无需映射)。心跳 = 每 10s 重新 put(滑动过期)。停止心跳 → 30s 后名字自动释放,可被新 agent 抢占。**没有 stale/offline 扫描循环**——存在性(名字)靠 TTL,活跃度(状态)靠推导。
- **`comms_history`(bucket 级 TTL 默认 24h)** — `h.<subnet>.<name>.<out|in>.<msg_id>` 双向**消息内容历史**:发出与收到的每条消息全文,compact(上下文压缩)或 agent 重启后由 `comms_outbox` / `comms_inbox` 重读。key 锚定名字,跨重启可读,outbox/inbox 的列表模式覆盖 agent 的**全部**历史而非仅当前进程。发送状态由历史记录推导(`replied` / `expired` / `waiting`);提醒本身是进程内存,不落历史。写入是 best-effort(不阻塞发送与消息注入),TTL 首次创建生效。

状态推导(只对资料):`status: online` — last_seen_at 距今 < 30s;`stale` — 30s ~ 60s;`offline` — 超过 60s。离线资料**保留**在缓存里显示 ✗(这是"永久资料"的语义)。

注意:nats.js 的 `kv.get()` 对已删除的 key 返回 DEL tombstone 条目(非 null)——所有存在性判断必须检查 `entry.operation !== "DEL"`。

### 2.4 显式回复 + 定时提醒

回复是**显式的**:调用 `comms_send(target=<发送方名字>, message="<回复内容>", reply_to_msg_id=<入站消息的 msg_id>)`——系统不自动应答,回复必须由接收方显式发起。发送方收到 `reply_to_msg_id` 命中自己**激活提醒条目**的消息时,自动把回复内容写入该发送的历史记录(`comms_outbox` 可查)并**停止该消息的提醒**;回复本身以普通入站 turn 自动到达——**接收方无需轮询**(工具语义见 §6.2)。

**合并定时提醒**:提醒是**按消息**挂载的:每条提醒绑定一条消息的 `msg_id`,方向覆盖两个方向——自己**发出的**(等待回复)与**收到的**(收到后要跟进)。`comms_send(..., remind_s=<seconds>)` 挂上;之后用 `comms_remind(msg_id, remind_s)` 设置/调整/取消(语义见 §6.5)。激活的提醒每过一个间隔向 context 注入**一条合并提醒**,列出**所有**激活提醒(方向、对方、内容摘要、提醒间隔、已等时长、TTL 倒计时),而不是每条消息一条提醒。提醒在以下情况结束:

- 收到命中该 msg_id 的回复(带 `reply_to_msg_id`)
- `comms_remind(msg_id, 0)` 取消(提醒被移除,消息本身不变)
- 提醒条目被 FIFO 驱逐(超过 256 条)或进程关闭(提醒不持久化,重启即失)

消息超过 stream TTL(仅发出方向)时提醒**不受影响**——照常注入,只是注入文本里标注 `expired`(消息状态查 `comms_outbox`,由你决定取消或重发)。

提醒只属于**本会话进程**——回复与否完全由接收方 LLM 决定;对方不带 `reply_to_msg_id` 回复时,提醒不会自动停止,由你看到内容后自行 `comms_remind(msg_id, 0)` 取消。

**无提醒(`remind_s=0`,默认)**:`comms_send(...)` 不设 `remind_s`(默认 0)即发送**单向纯通知**——发布与 comms_history 落库照常,但**不挂提醒**:不注册提醒、不出现在合并提醒里、**不阻塞 auto-exit**(守卫是"有激活提醒不退出")。注意"无提醒"不等于"无痕":消息全文在 comms_history(`comms_outbox` 可重读),之后想跟进了还能用 `comms_remind(msg_id, N)` 事后挂上。仅当需要等待回复时才显式设置 `remind_s>0`(如 300 = 每 5 分钟)。用于无需回复的单向通知(如 task 变更公告,见 docs/5)——收方按需用其他工具取详情,无人回复。

### 2.5 名称与消息寻址

- 注册时 `kv.create("n.<subnet>.<name>", name)` 原子占名(comms_names,TTL 租约);资料 key 为 `a.<subnet>.<name>`(comms_profiles,永久,抢名即覆盖)——名字冲突自动后缀见 §2.1.1
- 发送时按名字索引确认目标**在线**(租约存在=心跳中);subject 直接以名字寻址;租约不存在(未注册/租约已过期) → `target not found`
- msg_id 为 ULID,同时作为 JetStream 发布的 **msgID 去重键**(重复发布被 duplicate window 拒绝)

---
## 3. 客户端生命周期

```
session_start
    │
    ├── 1. 解析配置:--nats-url > PI_COMMS_NATS_URL > nats://127.0.0.1:4222
    │      token:PI_COMMS_AUTH_TOKEN > server.secret.json(0600)
    │
    ├── 2. 解析身份:CLI flags > frontmatter > 自动生成
    │      (name / subnet="subnet0" — 名字即身份,无每进程 id)
    │
    ├── 3. connect(NATS 原生自动重连)
    │
    ├── 4. ensureStream(幂等创建 COMMS_<subnet>)
    │
    ├── 5. 注册:kv.create 占名 + put 资料
    │
    ├── 6. 起 durable prompt consumer(回复同通道,reply_to_msg_id 标记)
    │
    ├── 7. 起 KV watch(填充 pool 缓存;自愈循环 — 迭代器意外终止或
    │       建立失败时 1s 后重建,重建时清空缓存并以全量快照重填)
    │
    ├── 8. 安装 Status(📡 name@subnet)+ belowEditor peers widget(初始渲染)
    │
    ├── 9. 心跳定时器(默认 10s,unref)
    │        put 完整资料刷新 TTL
    │
    └── 10. UI 刷新定时器(15s,unref):周期重渲染派生状态
             (online→stale→offline,即使无任何 watch 事件)
             ─────────────────────────────────────────────────
session_running
    │
    │  consumer 循环 + KV watch 自愈循环 + 心跳 + UI 周期刷新
    │
    │  断线 → NATS 客户端自动重连(指数退避)
    │         重连后 durable consumer 从 ack 位置继续;KV watch
    │         迭代器若已终止,1s 后重建并以全量快照重填缓存
    │
    ▼
session_shutdown / SIGINT / SIGTERM
    │
    └── cleanShutdown()
          ├── 停心跳、停 consumer、停 watch
          ├── 清空提醒定时器
          ├── 删除自己的资料 + 名字索引(key)
          ├── 保留 prompt durable consumer(跨重启复用:
          │       未 ack 重投、已 ack 不重放、离线消息续投)
          ├── 移除 status
          └── 审计 shutdown
```

---
## 4. 身份与命名

### 4.1 身份解析优先级

| 属性 | 优先级 1 (CLI) | 优先级 2 (frontmatter) | 优先级 3 (自动) |
|------|---------------|----------------------|----------------|
| `name` | `--cname <name>` | `.md` 的 `name` 字段 | `agent-<ulid末6位>` |

> agent 名会被消毒为 `[A-Za-z0-9_-]`(NATS subject/KV key 字符集限制)。subnet(通信域)默认 `"subnet0"`,用 `--subnet <name>` 加入特定子网(隔离语义见 §5)。

---
## 5. 配置

### CLI 标志

| 标志 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--cname` | string | 自动生成 | Agent 网络名称 |
| `--subnet` | string | `subnet0` | 通信域(子网):不同 subnet 的 agent 互相隔离,各自独立的 stream/subjects/KV 键 |
| `--nats-url` | string | `nats://127.0.0.1:4222` | NATS 服务器 URL |

> `--role`(角色模板名)由独立扩展 role-context 注册并注入角色模板,见 [2-role-context.md](2-role-context.md)。comms 只做通信。

### 环境变量

| 变量 | 说明 |
|------|------|
| `PI_COMMS_DIR` | comms 状态目录根(默认 `~/.pi/comms`;up.sh 与 protocol.ts 同时生效,`just check-paths` 校验一致) |
| `PI_COMMS_NATS_URL` | NATS 服务器 URL(默认 nats://127.0.0.1:4222) |
| `PI_COMMS_AUTH_TOKEN` | NATS 认证 token |
| `PI_COMMS_PORT` | up.sh 的服务器端口(默认 4222) |
| `PI_COMMS_HOST` | up.sh 绑定地址(默认 127.0.0.1) |
| `PI_COMMS_HEARTBEAT_MS` | 心跳间隔(默认 10000) |
| `PI_COMMS_MESSAGE_TTL_MS` | 消息 TTL / stream max_age(默认 1800000 = 30 分钟;consumer 重投窗口 ack_wait 固定 5 分钟) |
| `PI_COMMS_REGISTRY_TTL_MS` | 注册表租约 TTL(默认 30000) |
| `PI_COMMS_STALE_AFTER_MS` | 心跳超过多久标记 stale(默认 30000) |
| `PI_COMMS_OFFLINE_AFTER_MS` | 心跳超过多久标记 offline(默认 60000;离线资料仍保留,不会从注册表删除) |
| `PI_COMMS_HISTORY_TTL_MS` | 消息内容历史(comms_history)保留时长(默认 86400000 = 24h)。**bucket 级 TTL 首次创建时生效**,改动需删除 bucket |
| `PI_COMMS_NATS_VERSION` | up.sh 下载 nats-server 的版本(默认 2.14.4) |
| `NATS_SERVER_BIN` | 显式指定 nats-server 二进制路径 |

---
## 6. 工具列表

### 6.1 `comms_list_peer` — 列出在线 peer
- 返回:名称、模型、在线状态(● / ~ / ✗,纯文本)、上下文使用率、current_task
- 数据源:本地 KV watch 缓存(不含自己)

### 6.2 `comms_send` — 发起消息 / 回复 / 群发
- `target`(peer 名称,**大小写敏感**)或 `targets`(数组,群发,每个收件人一个 `msg_id`)、`message`
- **回复自动到达**:回复以入站 turn 注入,**无需轮询**
- `remind_s`(可选,秒,默认 0):挂起提醒 — 未收到回复时每过 `remind_s` 秒向 context 注入**一条合并提醒**(覆盖所有激活提醒);收到回复或消息过期后自动停止,`comms_remind(msg_id, 0)` 取消。**`remind_s=0`(默认) = 纯通知**(不挂提醒、不阻塞 auto-exit;事后可用 `comms_remind(msg_id, N)` 挂上;见 §2.4)
- `reply_to_msg_id`(可选):**回复模式** — 填你要回复的入站消息的 msg_id;发送方收到后自动记录回复并停止该 msg_id 的提醒循环。回复 = 显式 `comms_send(target=<发送方>, reply_to_msg_id=<msg_id>)`,**没有自动应答**
- `deliver_as`(可选):**投递模式** — 控制消息到达目标 agent 的投递方式,三个取值与 pi.sendMessage 的 deliverAs **一一对应**:`steer`(默认,目标忙碌时在其下一次 LLM 调用边界注入 — 当前 turn 的 tool call 结束后、下一条响应前,**不**打断进行中的流式响应;空闲时立即触发 turn)/ `follow-up`(目标当前 turn 完全结束后处理,空闲时立即触发)/ `next turn`(进入目标的 next-turn 队列,在目标**下一次 turn 开始时**注入 — 目标忙碌时等其当前 turn 结束再注入;**空闲时不主动触发**,等下一次 turn(用户输入或其他注入)到来时随其注入)。三种模式的区分只对**非 comms 批处理轮次**(用户输入轮次 / 其他扩展注入)成立:忙碌时分别为下一 LLM 调用边界 / 当前 turn 结束后 / 下一个 turn 开始时;目标正在回答 **comms 批处理轮次**时,批处理轮次不可被打断,`steer` / `follow-up` 一致等到该轮结束、在下一轮开始时投递。空闲时 `steer` / `follow-up` 立即触发,`next turn` 不触发
- 入站批处理:收到的消息先入队,agent 轮次空闲时按到达顺序一次性取出全部,合并注入;批内按 `deliver_as` **分组注入**(steer 组一次、follow-up 组一次,steer 组先行 — 与 pi 的队列消费顺序一致),**不做模式提升** — 每条消息保持自己的投递模式,与 pi.sendMessage 逐条行为一致。`next turn` 消息不参与批处理 — 到达即直送目标 pi 的 next-turn 队列并在注入时确认(pi 进程崩溃时随进程丢失,与 pi 原生 nextTurn 消息一致);其余消息 gate 到 agent_settled 再 ack,崩溃恢复一致
- 无跃点限制:转发链不设防循环上限,由使用方自行约束
- 返回(每个收件人):`msg_id`、`target_status`(目标的注册状态:`online` / `stale` / `offline`)
- 注意:发送的前提是目标**正在心跳**(名字租约存在);一旦发送成功,消息就留在 stream(TTL 内)——目标随后崩溃/重启,同名重启后由复用同一 consumer 收到(崩溃重投);目标已停机超过租约期(心跳停止 30s 后名字被回收)再发送则报 `target not found`

### 6.3 `comms_outbox` — 重读自己发送的消息(含状态与回复)
- 数据源:**持久化消息历史(comms_history,bucket TTL 默认 24h)** — compact 或重启后仍可重读;状态由历史记录推导:`replied` / `expired` / `waiting`
- `msg_id`(可选):单条详情 — 发送全文、状态(`waiting` / `ended` + `reason`)、收到的回复全文;如果该消息的提醒激活中,额外标注 `· remind N`(会话内存,重启后消失)。省略时列出最近发送(新→旧,状态 + 内容摘要,`limit` 默认 10,最大 100)
- `reason`(仅 `ended`):`replied`(收到回复,内容在返回里)/ `expired`(超过消息 TTL 仍未收到回复,目标很可能从未收到)

### 6.4 `comms_inbox` — 重读收到的消息
- 数据源:同一持久化消息历史 — compact 或重启后重读收到的内容、找回丢失的 msg_id
- `msg_id`(可选):单条详情 — 发送方、时间戳、reply 关联、全文;省略时列出最近收到的消息(新→旧,发送方 + 内容摘要,`limit` 默认 10,最大 100)
- 回复也会落在这里(标注 `reply to <msg_id>`);已回复的发送在 `comms_outbox` 侧同样可查

### 6.5 `comms_remind` — 设置 / 调整 / 取消提醒
- `msg_id`:**任意消息**的 msg_id — 自己发出的(`comms_send` 返回)或收到的(`comms_inbox` 返回)
- `remind_s`(秒):`1–3600` 设置或调整提醒间隔(`300` = 每 5 分钟);`0` 取消该提醒
- 取消只是**移除提醒条目**:消息本身不变(不写任何终态、不落历史);晚到内容按普通消息/回复照常收到
- 一条消息一条提醒,重复调用即调间隔(时钟重置);回复命中该 msg_id 时自动停止
- 提醒的取消只发生在**回复到达时**(自动);对已回复、甚至已过 TTL 的发送挂/停提醒都合法(提醒是"记得这事",不是"等回复");消息死活(replied / expired)查 `comms_outbox` 获悉
- 取消是幂等的:对没有挂提醒的消息 `remind_s=0` 同样返回 `stopped`(说明"未挂提醒"而非报错);`unknown` 只表示 comms_history 里查无此消息
- 提醒是本会话进程内的调度状态,**不持久化**——重启后丢失,但消息内容仍在 comms_history

### 6.6 `comms_update_profile` — 更新自身资料
- `current_task`
- 立即 put 资料(不等下一个心跳 tick),peer 通过 KV watch 实时看到
- 返回值只回显本次更新的字段
- 更新**同时驱动 session 名**——comms 拥有会话名(纯逻辑见 `lib/comms/session-name`):boot 认领基础名 `cname`,profile 更新时设为 `cname [当前任务]` / 清空时回退纯 `cname`;手动 `--name` / `/name` 永远优先
- `current_task` 由任务生命周期自动跟踪(见 docs/5):`task_start` 设为任务标题、`task_submit_report` 清空——与 `comms_update_profile` 走同一实现;手动调用用于覆盖自动值或空闲时声明

---
## 7. 状态行

status key `comms`,显示 `name @subnet`(有 peer 时追加紧凑的 `· N peers` 计数)。完整 peer 列表放在 belowEditor widget(`comms-peers`)中,单行文本按终端宽度自动换行 — 窄窗口/多 peer 时也不会截断,所有 peer 都能看到。格式紧凑:`Peers: ● alice, ~ bob, ✗ carol, …`(● 在线 / ~ stale / ✗ 离线,符号与 `comms_list_peer` 一致;不含自己)。无 peer 时 widget 隐藏,状态只显示 `📡 name@subnet`。状态由 `last_seen_at` 派生,除 watch 事件外每 15s 定时重渲染 — peer 崩溃(无任何事件)或 NATS 断线时,离线状态也会在 ~75s 内如实呈现,恢复后自动回到在线。详细 peer 信息统一走 `comms_list_peer`。

---
## 8. 审计日志

写入 `comms-log` 通道,关键事件(逐消息/逐 tick 的噪音事件已裁剪):

| 事件 | 说明 |
|------|------|
| `boot` / `boot_failed` | 启动成功/失败(含原因) |
| `register` / `name_collision` | 注册成功/名称冲突后缀 |
| `ensure_stream` / `ensure_stream_config_drift` | stream 创建(幂等)/ 配置漂移检测 |
| `nats_disconnect` / `nats_reconnect` | 连接生命周期 |
| `pending_evicted` | pending 超 256 条 FIFO 驱逐 |
| `heartbeat_failed` | 心跳失败 |
| `shutdown` | 正常关闭 |

---
## 9. 可靠性模型

| 场景 | 行为 |
|------|------|
| 网络抖动 / 服务器短暂不可达 | NATS 客户端自动重连;durable consumer 从 ack 位置继续;未 ack 的 prompt 重投(去重后不重复触发,见 §2.2) |
| agent 崩溃(SIGKILL) | **名字索引(comms_names)TTL 30s 后过期释放**;资料(comms_profiles)**永久保留**,状态由 last_seen_at 推导为 offline;已投递未 ack 的 prompt 重投见下行;发起方的合并提醒继续(见 §2.4) |
| nats-server 重启 | stream/KV 落盘恢复,消息不丢;客户端自动重连 |
| 目标离线 | 消息在 stream 中排队(30min TTL);目标重连后由复用同一 consumer 送达(游标续投);TTL 过期未投的消息由 stream 清理;提醒与 expired 语义见 §2.4 |
| 并发入站 | 队列批处理:按到达顺序合并为一轮注入,agent_settled 统一 ack;turn 中途到达的消息等待下一轮 |
| 回复忘记 reply_to_msg_id | 对方回复走普通消息注入,发起方提醒不会自动停止 — 发起方看到内容后自行 `comms_remind(msg_id, 0)` 取消 |
| 接收方崩溃(未 ack 的消息) | 未 ack 的消息在 5 分钟(ack_wait)后重投,重投后重新注入;已 ack 的消息不重投 |
| 转发链 | 无跃点限制,转发不受限(由使用方自行约束转发范围) |

### Token 安全

- token 存 `~/.pi/comms/server.secret.json`(单文件),必须 0600 否则客户端忽略
- `PI_COMMS_AUTH_TOKEN` 设置时优先,up.sh 不写文件
- 非 loopback 绑定(LAN)要求显式设置 token
- 所有错误消息不泄露 token

---
## 10. 启动方式

### 10.1 启动 NATS 服务器

```bash
bash scripts/comms-nats/up.sh
# 或
just comms-server
```

up.sh 自动:
1. 在 PATH 找 `nats-server`;找不到则从 GitHub releases 下载固定版本到 `~/.pi/comms/bin/`(SHA256 校验)
2. 生成配置 `~/.pi/comms/nats-server.conf`(port/host/token/jetstream store_dir)
3. 无 token 时生成随机 token 写入 `~/.pi/comms/server.secret.json`(0600)
4. spawn `nats-server -js -c <conf>`,等到可达后打印 banner
5. Ctrl-C 停止并清理(仅清理自己生成的文件)

### 10.2 启动 Agent(客户端)

```bash
# 基础用法 — 自动连接本机 NATS
pi -e extensions/comms.ts

# 带身份
pi -e extensions/comms.ts --cname scout

# 远程 NATS(token 走环境变量或 server.secret.json,不经过 argv)
PI_COMMS_AUTH_TOKEN=<tok> pi -e extensions/comms.ts --nats-url nats://192.168.1.100:4222

# 与其他扩展组合 — 组合扩展入口自声明依赖,comms 由其清单自动加载
pi -e extensions/agent-lifecycle
```

---
## 11. 模块结构

```
extensions/comms.ts                — 薄入口:flags、5 工具、生命周期接线(纯通信,不含角色逻辑)
extensions/lib/comms/
  protocol.ts                         — 共享契约:类型 + subject/stream/bucket 模板 + 常量
  config.ts                           — flag/env → RuntimeConfig + secret 文件(0600)
  nats.ts                             — 连接单例 + 幂等 ensure(stream + KV bucket)
  registry.ts                         — 注册/心跳/update_profile/watch 缓存
  messaging.ts                        — prompt consumer + send/reply_to_msg_id/合并提醒/过期/去重
  reminder.ts                         — 合并提醒调度器(单 interval,onTick 全量列表)
  batch.ts                            — 入站队列 + 批次注入/ack(入站 framing,标注身份和 msg_id)
  audit.ts                            — comms-log 审计辅助
  ui/display.ts                      — 共享显示 helper(model 缩写/状态点,纯文本 + theme 着色版;工具渲染内联在 comms.ts)
scripts/comms-nats/
  up.sh                               — NATS 服务器启动器(下载/配置/token/spawn)
```
