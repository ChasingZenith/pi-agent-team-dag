# Coordinator — task 管理角色

---

## 1. 概述

**Coordinator** 是**管理角色**：拥有被交给它的 **task 节点及其子图**，对该子图的交付负责。它是**图的调度者**——不生成图、不执行、不亲自验证证据，只驱动：辨识就绪集、派发 agent、推进状态、仲裁接口契约。

**分工（围绕 task graph 各做一类动作）：**

| 动作域 | 角色 | 工具 |
|--------|------|------|
| 图作者：子图生成 / 嵌入 / 子图门 / 重构——每层 planner 只写本层骨架 | Planner | `task_create` + `task_update` |
| 执行：代码 / 命令 / 文件 | Worker | read/write/edit/bash |
| 审查：对照验收标准验证交付物 | **review 节点**，由 experts-reviewer 执行 | task_read + read/bash |
| 驱动：就绪集辨识 / 派发 / 状态推进 / 仲裁 | Coordinator | task-comms-ops 高级工具 |

**分层规划（layered planning）**：每层 Coordinator 委托的 planner 只编写该层节点的**直接子图**——子模块、子单元、审查节点、模块间门（subgraph_deps）。子模块的内部子图**不在上层预规划**：该模块启动时由它的 Coordinator 委托自己的 planner 编写，一层一次委托，深度不限。未展开的模块 = 正常待定（pending, not missing），不是规划缺失。

**审查是图上的一等公民**：Planner 分解时给每个可交付实现节点规划一个 `review` 节点（deps 指向实现节点），Coordinator 在就绪集中发现它后派 experts-reviewer 执行，基于 review 结论推进（`task_complete` 或返工）——审查不是 Coordinator 的隐式动作，而是图上一个显式的步骤。

**完整链路**：`用户需求 → Requirements Clarifier（需求明确）→ Coordinator（顶层，拥有目标节点）→ 递归子 Coordinator（拥有父级交给的节点）`——深度不限，各层协议一致。

**核心特性：**

- **高级接口驱动**：多步协调动作（找 agent → 派发；标 done → 通知等待方）封装为**单动作工具**（见 §3）——LLM 负责内容（委托消息、判断、仲裁决策），代码负责动作（找 agent、写图、通知）
- **全部委托**：不读文件、不写代码、不执行命令——一切通过 specialist 完成
- **图操作归 planner（小调整除外）**：coordinator 无 `task_create`/`task_set_status`，新增节点与状态推进经 task-comms-ops 工具，小调整直接用 `task_update`（改 title / description / deps，见 §3）
- **闭环工作流**：实际反馈 → 调整图 → 全局同步
- **递归**：复杂子目标可 spawn 子 Coordinator（父级把子图交给它）

**Coordinator 是一个纯角色模板**（`lib/role-context/roles/manager/coordinator.md`），无独立扩展文件。通过 `--role coordinator` 启动或由 TP 以 `tp_spawn_agent(role="coordinator")` spawn。图数据系统由 task-graph 扩展提供，协调动作由 task-comms-ops 扩展提供。

---

## 2. 工作流 — 图驱动闭环

```
用户需求 → Requirements Clarifier（需求明确：与用户确认 → task_create 建 module → 派发给 Coordinator）
    │
    ▼
Coordinator（顶层）拥有目标节点（经 TP spawn：role=coordinator，task_dispatch 派发后 task_start 接管）
    │
    │ ① 就绪集辨识（task_ready_set；可 for=<id> 限定某节点及其依赖闭包；就绪集按 kind 分桶）
    │    按 kind 路由每个就绪节点：
    │      · unit（可直接执行）→ comms_send 找 agent（TP 定角色）→ task_dispatch
    │      · module 且是 review 节点（验证实现子节点——按内容识别）→ comms_send 找 agent 做验证 → task_dispatch
    │      · module 且子图已完成（聚合父节点，deps 全满足）→ 不派发：task_complete 标 done
    │      · 其他 module（无子图，未细化）→ 决定驱动者：
    │          · 简单（单次派发可完成）→ 直接找 agent 执行
    │          · 否则 → 找 agent 接管节点并驱动其子图（TP 定角色；子图可为空——分层规划：
    │              该模块启动时由它委托的 planner 只写这一层骨架——子模块 / 子单元 / 审查节点 / 门）
    │    门（subgraph_deps，见 docs/6 §2.7）：未就绪项缺失清单含门 → 等门，不强推；
    │      门节点完成 → task_complete 返回新解锁清单，整个门控前沿一次就绪 → 照常派发
    │    就绪集 = 并行度：N 个就绪项 → N 个 agent（一任务一 agent）
    │
    │ ② 找 agent + 派发（两步，无轮询；一任务一 agent）
    │    comms_send(target="teammate-provider", message="Find a teammate/planner/coordinator to work on a task: <id>") → TP 从角色目录定角色 → 回复 agent 名（异步 inbound 消息自动进入上下文）
    │    → task_dispatch(task_id, agent, message)：发委托 + set_status(dispatched, dispatched_to) 一步完成；worker 开工时 task_start 转 active 并自动通知派发者
    │    就绪集 N 项 → 同一回合并行发 N 个请求（一请求一任务，绝不合并）→ 每个回复对应一个任务 → 一对一 dispatch
    │    一个 agent 同时只持有一个 dispatched/active 任务；其任务未 done/cancelled 前不再派第二个——需要更多并行度就向 TP 请求新 agent（同角色多实例 web-searcher-2…）
    │    委托消息 header 由工具保证，message 参数只带补充信息（§2.1）
    ▼
Worker / Reviewer 执行
    │
    ├─ 一切正常 → 完成情况写入节点（task_submit_report，带委托消息 msg_id）→ 自动回复委托消息（细节在节点上）
    │
    └─ 现实受阻 → 已完成部分写入节点 + 聚焦可控 + 立即上报（失效假设 / 阻塞环节 / 可控调整 / 待决策）
    ▼
    │ ③ Review（差距分类）——先分类再处理：worker 完成通知到达，先 task_read(id=..., fields="report") 读节点上的完成记录（completion report——comms 只是指针，无需重读 description）
    │    执行差距（worker 没做到）→ 重新派发（不改图）
    │    粒度错判（上报显示任务可拆、超出单次派发）→ task_update(kind="module") 翻转 → 按 module 路由（①）⬅️
    │    假设不成立（现实与图前提冲突）→ Adjust：task_update 小调整 / 大重构走 module 路径（下放子 coordinator，由其委托 planner）/ task_block ⬅️
    │    信息不足 → comms_send 找 agent 补充调查（TP 定角色——scout / consultor）
    │    交付验证 → review 节点（planner 规划、reviewer 执行）→ 通过则 task_complete，不过则返工
    ▼
    │ ④ Adjust（修正图）
    │    task_update（改 description / deps / title，change_summary 记录偏差）
    │    task_block（受阻项标记 blocked——不再进入就绪集，依赖方保持锁定）
    │    task_complete（标 done：store 校验 deps 满足，未满足报错列缺失；解锁方自动通知）
    │    task_cancel（取消：对依赖方视为满足——移除作用域 = 取消而非删除）
    │    （大重构如重新分解 → 委托 planner，不自己重建）
    ▼
    │ ⑤ Sync（同步）
    │    task_complete / task_block / task_cancel 自动通知等待方（unlocked 依赖项的已派发负责人）
    │    仲裁 / 小调整后 comms_send 定向通知受影响方（无提醒 [Task Update] 公告）
    │    comms_list_peer 拿名单 → 按需全网公告（新子图发布 / 全局同步 / 里程碑）
    │    + comms_update_profile(current_task=…) 同步自身状态
    ▼
    │ 循环 ③→④→⑤ 直至子图全部完成
    ▼
分解产物全部 done → task_complete 标记目标任务 done（store 校验 deps 满足）→ 上报父级（父 Coordinator 或用户，带验证证据）→ 最终汇总
```

**核心原则：图是框架而非枷锁。** 图给出方向与依赖顺序，不要求每步预言正确；执行是验证假设的过程；现实与图冲突时**绝不硬推**——记录偏差、更新节点、重新调度、同步全局。

### 2.1 委托消息格式

Coordinator 发给 worker / reviewer / planner 的委托消息（`task_dispatch` 的 `message` 参数）是**指针而非复述**：Objective / Output / Context / Assumptions 都写在任务的 description 里，对方 `task_read` 自行读取即可，不要重复 plan 内容。**dispatch header 由工具保证**：`task_dispatch` 始终在消息开头放置常量协议头——命令式 `Complete task <id>` + task_read 指引 + `task_start` 开工声明 + 完成规则（每条 dispatch 是一条任务，收到的都要完成）——并在**消息末尾**放置回复 guide（回应方式：`task_submit_report` 写节点、工具自动回复这条委托消息）——所以接收方永远知道做什么、读哪个任务、如何回应，且能同时持有多个委派。受阻上报（reality-beats-plan skill）写在各执行角色的角色模板里，消息中**无须复述**。**不要重申对方角色**——角色在 TP 选人时已定，名字即角色（如 `worker-3`），且 spawn 时角色模板已注入其身份。消息只放 plan 里没有的补充信息：

- **协作对象（可选）** — 遇到相关问题时可以找的 peer
- **其他补充（可选）** — coordinator 知道但 plan 没写的上下文、需要特别点名的假设编号

示例（`message` 只写补充信息，header 由工具恒定放在开头）：

```
Complete task login-api — read it with tool call task_read(id="login-api").
When you begin work, declare it: task_start(id="login-api") — it moves the item from dispatched to active.
Each dispatch is one task; complete every task you receive.

Collaborate: reach out via comms_send if you need input from another agent.
A2 的接口契约以 login-api 的 description 为准——实现前先 task_read 确认。

When you finish (or when reality stops part of the work), reply with task_submit_report(id="login-api", report=...) — it writes the completion record on the node and automatically replies to this dispatch message.
```

---

## 3. 工具

Coordinator 使用 task-comms-ops 高级工具 + tasks 工具 + comms 通信工具：

### task-comms-ops — 高级协调动作（一个工具 = 一个动作）

| 工具 | 参数 | 封装的动作 |
|------|------|-----------|
| `task_dispatch` | `task_id, agent, message` | 发送委托消息（带提醒，含常量开工指令）+ `set_status(dispatched, dispatched_to=<agent>)` 一步完成；`dispatched_to` 记 **agent 名字**（comms 身份，跨重启稳定），派发者与委托消息 msg_id 记入 `dispatched_to`（`dispatched_by` / `dispatch_msg_id`） |
| `task_start` | `id` | **worker 侧工具**：开工声明——把派发给自己的任务从 dispatched 转 active（校验 `dispatched_to.name` 为调用者）+ **把自己的 pi 执行会话写入节点**（`execution_session`：session id + JSONL 转录文件路径，后续据此回溯该任务实际如何完成）+ 自动通知派发者（无提醒，告知已开工）+ 自动把任务标题写入 comms profile 的 `current_task`（与 `comms_update_profile` 同一实现，peers 实时可见） |
| `task_submit_report` | `id, report` | **worker 侧工具**：把完成情况写入节点 `completion_report`（校验 `dispatched_to.name` 为调用者）+ 自动**回复**委托消息——回复目标与 msg_id 单一定义在节点记录（`dispatched_by` / `dispatch_msg_id`），工具自动发 `comms_send(target=派发者, reply_to_msg_id=委托消息 msg_id)`，**调用者无须传 target / reply_to_msg_id**，这就是 worker 回应 dispatch 消息的方式（一行完成通知，停掉派发者的 reminder）+ 清空 comms profile 的 `current_task`（汇报完即可复用） |
| `task_complete` | `id, change_summary?` | 标 done（store 校验 deps 满足，未满足报错列缺失）+ 自动通知解锁项的等待方（无提醒） |
| `task_block` | `id, change_summary?` | 标 blocked（现实受阻，受阻原因写入 change_summary）+ 自动通知依赖项的已派发负责人 |
| `task_cancel` | `id, change_summary?` | 标 cancelled（移除作用域；对依赖方视为满足，取消原因写入 change_summary）+ 自动通知解锁等待方 |

### tasks 工具

只读查询（参数与语义见 docs/6 §5）：`task_read`（读节点全文与就绪性）、`task_list`（按状态过滤列表）、`task_ready_set`（就绪集——派发前必查；**按 kind 分桶**：unit 执行 / module 待驱动；`for=<id>` 限定某节点及其依赖闭包，自身就绪也列出；就绪集内两两无依赖 → 可并行派发）、`task_render`（整图渲染，评审与汇报）。

图写：coordinator 的小调整与接口仲裁直接用 `task_update`（`id, title?/description?/deps?/kind?, change_summary?`，写时校验 deps 存在性与无环；`kind` 可翻转 unit → module——执行暴露需细化时）；子图生成（`task_create` + `task_update` 链接父节点 deps）归 planner（由下放的子 coordinator 委托）。

### comms 通信工具

通信工具来自 comms 扩展（参数与语义见 docs/1 §6）：`comms_send`（含 `remind_s=0` 纯通知公告）、`comms_inbox` / `comms_outbox`（重读消息）、`comms_remind`（设置/调整/停止消息提醒）、`comms_list_peer`（查看 agent）、`comms_update_profile`（维护 `current_task`，让 TP 能实时匹配）。

**找 agent = `comms_send(target="teammate-provider", message="Find a teammate/planner/coordinator to work on a task: <id>")`**——只描述工作、不指定角色，TP 从角色目录定角色（目录只注入 TP 的 prompt，见 docs/4 §7）；TP 回复的 agent 名自动作为 inbound 消息进入上下文，无需轮询；需要等待时可设 `remind_s`（如 300 = 每 5 分钟合并提醒一次）。

**等待纪律见 skill `waiting-protocol`**：发出请求后结束回合，任何回复（TP 分配、worker 的 task_start / task_submit_report 通知、planner 子图完成报告）都以 inbound 消息自动注入；等待期间不调用 `comms_outbox` / `comms_inbox` / `task_list` / `task_ready_set` 轮询，唯一计划的唤醒是 reminder 回合。

---

## 4. 任务图（示例）

```
auth-system                        ← 目标节点（顶层 Coordinator 拥有——用户交给它）
├── deps: [login-module, register-module]
│
├── login-module                   ← 子图（子 Coordinator 拥有——父 Coordinator 交给它）
│   ├── deps: [login-form, login-api, login-review]
│   ├── login-form                 ← 无依赖 → 就绪（可并行）
│   ├── login-api                  ← deps: [jwt] → 等 jwt 完成后才就绪（串行）
│   ├── jwt                        ← 无依赖 → 就绪（可并行）
│   └── login-review               ← deps: [login-form, login-api, jwt] → 三者完成后就绪，派 experts-reviewer
│
└── register-module                ← 子图（另一个子 Coordinator；与 login-module 无依赖 → 并行）
    ├── deps: [register-form, register-api, register-review]
    ├── register-form
    ├── register-api
    └── register-review
```

- **分工由 deps 推导**：`login-module` 与 `register-module` 之间无依赖边 → 并行调度；`login-form` 与 `jwt` 无依赖 → 并行；`login-api` 依赖 `jwt` → 串行在后。
- **审查是节点**：`login-review` 依赖全部实现子节点——全部完成后就绪，Coordinator 派 experts-reviewer 执行；审查通过（review 节点 done）后 `login-module` 的 deps 才全满足。
- **分解 = 目标任务 + 分解产物作 deps**：`auth-system` 的 done 由管理节点在 deps 全部完成后手动标记（`task_complete` 校验 deps 满足）。
- **递归**：子 Coordinator 拥有父级交给它的子图，可在其下继续分解（委托 planner）——深度不限，任意深度下同一套协议。
- **模块间排序用门**：若 `register-module` 需等 `login-module` 整体完成，在 `register-module` 声明 `subgraph_deps: [login-module]` 即可——整棵子树等待，不用逐叶写 deps（前端渲染为模块与门之间的紫色箭头）。门是排序边，不是数据依赖（语义见 docs/6 §2.7）。
- **待展开是正常状态**：分解产物不必一次建齐——先定骨架，细节随派发推进逐层下沉；未展开不是缺陷。

---

## 5. 嵌套递归（复杂子目标）

**适用判断**（任何一层都是同一条规则——即 §2 ① 中 module 节点的驱动决策）：

| 子目标的形态 | 驱动方式 |
|------|------|
| 需要独立的执行循环：自己的多阶段、长周期、独立验证 | 下放子 **Coordinator**（父级把节点交给它，由其委托 planner） |
| 单一子图拆成并行项、多 worker、接口仲裁 | 下放子 **Coordinator** |
| 一次派发就能完成（简单 module / unit） | **不建层**，直接派 worker |

- **子 Coordinator 拥有父级交给它的 task 节点及子图**，可在其下继续委托规划（planner）、继续 spawn 更深的子 Coordinator——深度不限
- 委托方式与 specialist 相同：`comms_send(target="teammate-provider", message="Find a teammate/planner/coordinator to work on a task: <id> — the node needs a sub-Coordinator to own it and drive its subgraph")` → TP 定角色（coordinator）→ `task_dispatch` 交付节点
- 约束：子 Coordinator 服从父 Coordinator 的图（尊重 deps 与契约）、重要变更上报父 Coordinator、局部改动不得静默改变全局依赖
- **协议各层一致**：遇阻上报（reality-beats-plan skill)、调整（task_update / task_block）、同步（comms 无提醒公告）在每一层是同一套
- **分层规划**：一层一次委托——每个 Coordinator 只委托一个 planner 编写本层骨架（子模块 / 子单元 / 审查节点 / 门）；子模块内部子图在其启动时由下一层规划，深度不限；未展开 = 正常待定，不是规划缺失
- 反模式：不要为一次派发就能完成的工作建层；**优先最浅结构**，只有子目标真正需要独立循环时才加深

---

## 6. Requirements Clarifier 工作流

入口角色（`roles/specialist/requirements-clarifier.md`），把用户三言两语的需求转成具体需求：

1. **提问澄清**：先钉 objective（用户真正要什么——destination 先定，范围随之），再宽度扇出：objective / acceptance criteria（成功如何验证）/ non-goals（明确不做）/ constraints（期限、技术、资源）/ risks（已知风险）
2. **落地到项目**：读当前项目现状（read/grep/find/ls），让需求反映现实而非想象
3. **确认**：把写好的需求交回用户确认，迭代直到一致
4. **交接并退出**：`task_create` 建 module（需求全文入 description）→ 经 TP spawn Coordinator（`role=coordinator`）→ `task_dispatch` 派发（Coordinator 以 `task_start` 接管节点）→ 派发确认后退出

目标可能是远期总体目标——分解与推进是 Coordinator 的事，需求明确者不规划、不分解、不执行。

---

## 7. 遇阻上报（统一协议）

所有层的遇阻上报统一走 **reality-beats-plan** skill（`.pi/skills/reality-beats-plan.md`）：

- worker → coordinator：task 无法按图执行
- coordinator → 父 Coordinator：子图内假设失效
- 顶层 coordinator → 用户：目标假设失效

协议与格式各层一致：停止受阻部分 → 完成不受影响的 → 前提安全的局部调整 → 立即按标准格式上报（failed assumptions / blocked links / adjustments / decisions needed）。

**新披露的边缘**（上报揭示的、图未覆盖的决策）也按这个闭环归类，判据：能否**精确陈述**问题（而非能否立即回答）——能精确陈述 → 建议建节点（即使受阻）；不能 → 记入模块 description 的 `## Not yet specified`（迷雾区，不预切片）；超出目的地 → 取消并记入 `## Out of scope`（出界永不毕业，仅当目的地重画时以新 effort 回归）。

**与图衔接**：Coordinator 收到上报后 `task_block(id, change_summary=...)` 标记受阻项（原因写入 change_summary）——blocked 项不再进入就绪集、依赖方保持锁定（见 docs/6 §2.4）；解除阻塞后按现实调整图（task_update 改 deps / description）并把节点恢复 pending（重新进入就绪集）/ dispatched（直接重新派发）/ active。

---

## 8. System Prompt

Coordinator 的 system prompt 来自 role template `lib/role-context/roles/manager/coordinator.md`，使用 `{{}}` 插值。模板只定义角色定位与驱动循环——**每个协调动作对应一次工具调用**，无长篇多步协议文本（写图、通知、派发等协调动作由 task-comms-ops 插件以代码形式封装进工具；找 agent 即 `comms_send` 给 teammate-provider）。

| 占位符 | 来源 | 说明 |
|--------|------|------|
| `{{displayName}}` | `buildSystemPrompt` | 格式化的 agent 名 |

---

## 9. 文件清单

```
extensions/task-comms-ops.ts                 ← 高级协调动作插件（task_dispatch / task_complete /
                                             task_block / task_cancel）
extensions/lib/role-context/roles/
├── manager/
│   └── coordinator.md                  ← Coordinator 角色模板（图调度者，无共享协议文件）
└── specialist/
    ├── requirements-clarifier.md       ← 入口角色（需求明确 → 建 module → 派发给 Coordinator）
    ├── planner.md                      ← 图的作者（task_create + task_update：子图生成 + 嵌入 + 子图门；一层一次委托）
    └── worker / scout / web-searcher / experts-reviewer / consultor

.pi/skills/reality-beats-plan.md        ← 遇阻上报统一协议（含新披露边缘三分类）
```

> 角色模板目录（`lib/role-context/roles/`）与 tasks / role-context 的完整文件清单见 docs/2 §1 与 docs/6 §7；task-comms-ops 的组件定位见 docs/0-overview §1。

---

## 10. 启动

```bash
# 用户入口：三言两语的需求（推荐从这开始）
pi -e extensions/comms.ts \
   -e extensions/task-graph.ts \
   -e extensions/task-comms-ops.ts \
   -e extensions/role-context.ts \
   --role requirements-clarifier \
   --cname clarify

# 或直接启动顶层 Coordinator（需求已在手，跳过需求明确环节）
pi -e extensions/comms.ts \
   -e extensions/task-graph.ts \
   -e extensions/task-comms-ops.ts \
   -e extensions/role-context.ts \
   --role coordinator \
   --cname coordinator-main

# 子 Coordinator 由父 Coordinator 经 TP spawn（tp_spawn_agent(role="coordinator")），无需手动启动
```

`--role coordinator` 由 role-context 扩展注入角色模板（链式追加到现有 system prompt；注入规则见 docs/2 §5）。任务不在启动时传入——由协调方/TP 在 agent 上线后通过 `comms_send` 发送。
