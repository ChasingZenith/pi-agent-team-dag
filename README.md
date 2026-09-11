# Pi Agent Team DAG

> **把目标分解成任务依赖图，以图驱动弹性伸缩的 agent 团队去完成它。**

一个建立在 [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) 之上的多 agent 协作系统。

- **任务依赖图**：复杂任务沿逻辑关系逐层分解，再按时间先后连成一张有向无环图（DAG）。以图的结构表示目前的任务计划和任务状态。
- **以图驱动任务调度**：任务的执行和agent调度由任务依赖图的就绪集推导得出。
- **人力弹性伸缩**：agent 的数量与角色按就绪任务多少灵活找人或造人。
- **agent 组成团队**：agent 互相发现，检测在线，点对点，群发消息。完成信息交换、汇报、催办。
- **渐进式规划**：在图上逐渐扩展子节点，细化任务，是理想的预测，
- **反馈调节**：执行是现实检验；实践得到新的信息。理想与现实冲突时，沿依赖边表示的逻辑关系逐步修正任务依赖图。

> 架构总述与文档索引见 [docs/0-overview.md](docs/0-overview.md)。

## 一、Context 需要划分

复杂任务天然存在逻辑上与时间上的分层，这些分层应当成为 context 的分割边界：让每个 agent 只面对一个抽象层级、一个阶段的工作。

如果让一个 agent 一口气做完所有事，抽象的决策与具体的执行就会混在同一段上下文里——主次不分，不同阶段互不相关的内容挤在一起，既浪费 token 和算力，也稀释了注意力。因此先按层次把任务切开，再用图把这些层次重新组织起来。这正是 multi-agent 编排的必要性所在。

## 二、图上的边表达逻辑关系与时间关系

构造一张有向图：节点是任务，边是依赖关系。

边 `A → B` 表示 **B 依赖 A**——A 完成后 B 才能开始。同一条边在不同视角下表达两种关系：

- **逻辑关系（分解）**：A 是 B 的子任务 / 子依赖。
- **时间关系（先后）**：B 必须等 A 完成，两者不能并行。

这张图在实践中必须是**有向无环图（DAG）**：无环才能定义清晰的先后。

- **逻辑上**：图给出工作如何逐层展开，以及新信息沿依赖边如何流动。
- **时间上**：有了确定的先后，才能用就绪集把工作流铺开，按需弹性安排 agent 团队。

### 2.1 渐进式规划

复杂任务沿着逻辑关系逐层展开：分层调度、分层分解，从抽象逐步走向具体。计划不必把每一步都抠到极致——既要有大局，也要有颗粒度。

### 2.2 状态机弹性调度 agent

调度由节点的状态迁移驱动：

- **就绪集（ready set）**＝所有 `deps` 已满足的待办节点。就绪集内两两无依赖，因此**天然可并行**——就绪集有多大，就能同时开几路。
- **状态迁移推进图**。标记一个节点 `done`，系统立刻算出被它解锁的后继节点，就绪集随之扩大。依赖、进度、待办全部以图数据为准，随时可重建，无需维护副本。

### 2.3 实践检验计划，动态调整

图是先验的预测，执行是后验的检验；预测不可能全对，实践中得到的新信息要反过来修正计划。整个系统是一个「前馈 → 实践 → 反馈」的闭环：

- **前馈（规划）**：从目标出发，按逻辑分层渐进地规划——agent 用**已有信息**对世界做出预测，并把预测落到图的节点上。此时每个节点都还只是一个假设。
- **实践（获取信息）**：agent 按节点与现实交互——细化任务、执行任务，从而获得规划时不可能有的**新信息**。
- **反馈（调整）**：新信息一旦突破原有认知，就打破原有规划。图的结构表征了逻辑关系，使得可以沿边追溯，局部地、有重点地修改上游与下游——记录偏差、更新节点、重新调度。

## 三、快速开始

### 前置

| 工具 | 用途 |
| --- | --- |
| **Bun** ≥ 1.3.2 | 运行时与包管理  |
| **just** | 任务运行器  |
| **tmux** | 承载 agent 进程（完整团队需要） |
| **pi** | [Pi Coding Agent CLI](https://github.com/mariozechner/pi-coding-agent) |

```bash
bun install
```

### 两个 agent，先感受一下通信

```bash
# 终端 1 — 本地 NATS 服务器（JetStream，未安装会自动下载）
just comms-server

# 终端 2、3 — 两个客户端（默认连 nats://127.0.0.1:4222）
pi -e extensions/comms.ts    # 终端 2
pi -e extensions/comms.ts    # 终端 3
```

任一侧用 `comms_send(target="agent-xxxx", message="...")` 发送；对方用 `comms_send(target="agent-yyyy", message="...", reply_to_msg_id=<msg_id>)` 回复。

### 一支完整的 agent 团队

```bash
# 终端 1 — NATS hub
just comms-server

# 终端 2 — 网络注册中心（需在 tmux 中运行；
pi -e extensions/teammate-provider --cname teammate-provider
```

然后：

- 向 teammate-provider 要一个 **requirements-clarifier**——TP 会在 tmux 里替你把它造出来。
- 把需求讲给 requirements-clarifier，它会帮你把任务澄清并派发出去。
- agent 团队随即开始工作。

任务图落在 `.pi/tasks/`，可直接打开文件查看，也可通过前端查看图结构：

```bash
# 只读 API（默认 8787）——参数是 agent 团队的工作目录，缺省为本仓库
just work-items-server /path/to/workspace
just work-items-web             # 前端（默认 5173）
```

## 四、文档

| 文档 | 内容 |
| --- | --- |
| [docs/0-overview.md](docs/0-overview.md) | 架构总述与文档索引 |
| [docs/1-comms.md](docs/1-comms.md) | 通信层：NATS 拓扑、注册、消息、回复、提醒 |
| [docs/2-role-context.md](docs/2-role-context.md) | 角色模板、外部角色目录、能力声明、上下文与 fork |
| [docs/3-create-and-kill-agent-on-net.md](docs/3-create-and-kill-agent-on-net.md) | spawn / kill、launch script 装配、auto-exit |
| [docs/4-teammate-provider.md](docs/4-teammate-provider.md) | 注册中心：复用 vs 新建、重启恢复 |
| [docs/5-coordinator.md](docs/5-coordinator.md) | 管理角色：图驱动闭环、递归、接口仲裁、遇阻上报 |
| [docs/6-task-graph.md](docs/6-task-graph.md) | 任务图：模型、存储、工具、推进语义 |
| [docs/web-frontend.md](docs/web-frontend.md) | 任务图可视化前后端 |

## 五、模块

### comms — 通信网络层

每个 agent 一个 NATS 连接、一个以**名字**命名的 durable consumer。提供 `comms_send`（发送/回复，返回 `msg_id`）、`comms_list_peer`（在线名单与状态）、`comms_outbox`/`comms_inbox`（持久消息历史，压缩或重启后仍可重读）、`comms_remind`（设置/调整/取消提醒）、`comms_update_profile`（声明当前任务）。

可靠性是内建的：JetStream 持久化 + 未确认重投（崩溃不丢消息）、`comms_history` KV 保留 24h、心跳让 peer 能识别离线。**默认异步、不自动回复**（避免 ping-pong 循环）；需要等回复时挂 `remind_s`，收到回复自动停提醒。→ [docs/1-comms.md](docs/1-comms.md)

### role-context — 角色与上下文

`--role` 参数选择角色模板，注入 agent 的 system prompt。内置角色：`coordinator`（驱动图）、`planner`（分解）、`scout`（代码库调查）、`web-searcher`（网络调查）、`worker`（执行）、`experts-reviewer`（专家评审）、`consultor`（建议）、`requirements-clarifier`（需求澄清）、`teammate-provider`（注册中心）。

模板可用外部目录替换或扩展（`--role-dir` / `.pi/roles/` / `~/.pi/agent/roles/`），角色还能声明所需的外部能力（`skills:` / `extensions:`），spawn 时自动带上。同时提供 LLMContext 构建与 SessionManager 会话创建/fork。→ [docs/2-role-context.md](docs/2-role-context.md)

### task-graph — 任务图数据系统

图存储 + `task_commit` / `task_checkout` / `task_set_status` / `task_read` / `task_list` / `task_ready_set`。存储是「内容即文件」：真本、按 agent 隔离的草稿、按版本归档的快照，配合乐观并发（`expected_version`）、跨进程写锁（同一时刻单写者）与 sha256 完整性校验。

它是**独立的**——不依赖任何其他组件就能读写一张图，也是整个系统里进度与依赖的权威来源。→ [docs/6-task-graph.md](docs/6-task-graph.md)

### agent-lifecycle — Agent 生命周期

`agent_spawn` / `agent_kill`，在 tmux 窗口里以给定角色、模型、名字启动 agent；并提供 `executeAgentSpawnByRole()` 这类**模块级函数**供 TP 直接调用（不走工具层）。spawn 出的 agent 由统一的 launch script 装配：comms + task-graph + task-comms-ops + role-context + auto-exit，因此一上线就能通信、就能读写任务图。→ [docs/3-create-and-kill-agent-on-net.md](docs/3-create-and-kill-agent-on-net.md)

### task-comms-ops — 高级协调动作

把多步协调动作封装成**一个工具 = 一个动作**：`task_dispatch`（发委托 + 记负责人）、`task_complete` / `task_block` / `task_cancel`（改状态 + 通知受影响方），以及 worker 侧的 `task_start`（开工声明）与 `task_submit_report`（提交完成记录并自动回复委托消息）。

分工原则：**LLM 产出内容**（委托措辞、判断、仲裁），**代码产出动作**（找人、写图、通知）。→ [docs/5-coordinator.md](docs/5-coordinator.md)
