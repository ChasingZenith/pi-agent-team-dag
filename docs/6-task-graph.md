# Task Graph — 任务图数据系统

---

## 1. 概述

**任务图（task graph）** 把计划编码为图：目标被分解成**任务（task）**，即图中的节点；任务之间的**依赖（deps）**是图中的边——`B.deps = [A]` 表示 B 依赖 A 的完成；另有**子图门（subgraph_deps）**作为第二种关系——模块的整个子图额外等待某节点完成（见 §2.7）。所有任务组成一个**有向无环图（DAG）**。

持久化在共享文件系统上。

图的推进方式是状态迁移：每次标记 done / cancelled，系统解锁新就绪的后继（见 §2.6）。

本组件只负责图数据本身：机器可读格式与审计事件流为后续网站实时可视化预留（见 §6）。管理角色（Coordinator）如何基于这张图组织分工，见 docs/5。


## 2. 核心模型

### 2.1 task

图上节点为 task ——任何粒度（从「实现整个认证系统」到「改一个 typo」）、任何角色视角下都是同一个实体，不规定基础单位。节点通过 `kind` 字段声明粒度（见 §3.2）：`unit`（可直接执行——可有顺序依赖 deps、无聚合子图）或 `module`（聚合——可能有子图、可能需要下放）。字段定义见 §3.2。

### 2.2 DAG (task graph)

- **有向边表示依赖**：` A in B.deps` 表示 A 完成后 B 才能开始/完成——先后顺序、并行与否、分解归属，全部由这一种边表达。

### 2.3 任务的完成

- **任务的完成由管理节点手动标记**——系统不自动判定；`task_set_status` 在 deps 未满足时硬拒绝并列出缺失（见 §2.4）。目标任务同样如此：其全部 deps 完成后才能标 done。
- **分解 = 目标任务 + 分解产物作 deps**：`auth-system`（deps: [login-module, register-module]）即表示「认证系统 = 登录模块 + 注册模块」——依赖方向是从目标任务指向其分解产物。
- **完成记录（completion report）由被派发的 agent 直接写入节点**——执行完成后，worker 用 `task_submit_report` 把自己的完成情况写入 `completion_report` 字段（与计划一致 → 简洁；有任何偏差 → 详细记录），工具自动回复委托消息（msg_id 记录在任务上；一行完成通知，停掉该委托的 reminder）；manager 在 `task_complete` 前从节点读取该记录。完成记录与 `change_summary` 分离：前者是执行者的事实记录，后者是管理层的单行摘要。

### 2.4 状态机

每个 task 的状态：`pending / dispatched / active / done / blocked / cancelled`。合法迁移由 `task_set_status` 校验：

| 当前状态 | 合法迁移 |
|------|------|
| `pending` | `dispatched`（派发）、`active`（开始执行）、`blocked`（现实受阻）、`done`（deps 满足时）、`cancelled`（放弃） |
| `dispatched` | `active`（worker 用 `task_start` 声明开工）、`pending`（收回重新派发）、`blocked`、`done`（deps 满足时）、`cancelled` |
| `active` | `pending`（收回）、`blocked`、`done`（deps 满足时）、`cancelled` |
| `blocked` | `pending`（解除阻塞）、`dispatched`（重新派发）、`active`、`done`（deps 满足时）、`cancelled` |
| `done` | `active`（reopen：验证未过 / 需返工） |
| `cancelled` | `pending`（undo：取消后重新规划） |

- **`dispatched` = 已派发、尚未开工**：`task_dispatch` 发送委托后置为 dispatched 并记录 `dispatched_to`（见 §3.2）；负责的 worker 真正开始时调用 `task_start` 转 active，并把**自己的执行会话**写入节点（见 §3.2 的 `execution_session`——worker 对图的写权限只有两个：`task_start` 声明开工并记录执行会话、`task_submit_report` 写自己的完成记录——两者都在 task-comms-ops 扩展，见 docs/5 §3）。worker 未调 task_start 时，manager 仍可直接 complete / block / cancel。
- `done` / `cancelled` 是终态（除 reopen / undo 外）。
- **标 done 必须 deps 全部满足**——否则报错并**列出缺失 deps**（标 done、取消或调整 deps）。
- **`cancelled` 对依赖方视为满足**（解锁计算与之一致）；**`blocked` 不算满足**——被阻塞的节点保持锁定。
- **`blocked` 只能手动标记**——系统不会自动判断阻塞。

### 2.5 就绪集（ready set）

- **就绪**：状态为 pending 且所有 deps 已满足（每个 dep 为 done 或 cancelled）→ 可执行。已派发（`dispatched`）的节点**不在**就绪集——它已有负责人，等 worker 开工。
- **就绪集**：全部就绪节点组成的集合；就绪集内两两无依赖（deps 全满足 ⇒ 不存在互相依赖）→ **可并行执行**。
- **按 kind 分桶**：`task_ready_set` 把就绪集按粒度分组——`unit`（可直接执行）与 `module`（可能需要下放）。分桶只是事实分组，不预设决策：module 的驱动者（自驱 / 下放子 coordinator）由管理角色决定（见 docs/5）。
- `task_ready_set` 直接查询就绪集——调用方无需自行遍历图；可选 `for=<id>` 把查询范围缩到该节点及其依赖闭包（节点自身 + 直接与间接依赖的全部项）——节点自身就绪时也会列出，用于查看推进某个子图需要派发哪些项。

### 2.6 数据系统推进

- 执行推进的每一步都是图上的状态迁移：标记 done / cancelled → 系统计算 newly unlocked 后继（之前因最后一个未满足 dep 而锁定的节点）→ 返回 unlocked 清单，就绪集随之更新。
- unlocked 只用于通知与展示，**不写回文件**（计算不持久化）。
- 进度、依赖、待办全部以 `.pi/tasks/` 的数据为准——agent 随时可重建图，无需维护副本。

### 2.7 子图门（subgraph_deps）

- **门是第二种关系**：`subgraph_deps`（仅 module）声明「本节点的整个子图额外等待某个完成」。`subgraph_deps = [X]` 表示该 module **自身及其全部传递 deps**（整个子图）都必须在 X 完成后才能开始——一条排序边，不是数据依赖。
- **动机**：测试模块下已有多个 deps，若全部测试工作都必须在 coding 模块之后，逐个把 coding 写进每个子图节点的 deps 是机械劳动且易漏。声明一次门，整个子图生效（门由本层 planner 声明在等待方模块上——用法见角色模板 planner.md）。
- **读时展开**：门不写入子图节点的 deps——每次读图（就绪集 / done 门控 / 环检查）按**当前**子图闭包展开为有效 deps（deps ∪ 门）。因此**之后加入子图的节点自动带门**（模块新增 deps 无需任何额外操作）。
- **渲染**：门只渲染在模块行尾（`subgraph_deps: <ids>`），子图节点不逐个标记，流程图保持简单。
- **校验**（写入时，与 deps 同级）：门必须已存在；门**不能在本模块子图内**（自环）；**展开后的图保持 DAG**——互门/自环均被环检测拒绝并报环路径（见 §4）；`unit` 不能声明门（无子图可门）。
- **done 门控一致**：标记子图内任何节点 done 时，门未满足（非 done/cancelled）即拒绝并列出缺失门。

示例——测试模块的整个子图等待 coding：

```json
{
  "id": "test-module",
  "title": "测试模块",
  "deps": ["test-case-1", "test-case-2"],
  "subgraph_deps": ["coding-module"],
  "status": "pending",
  "kind": "module"
}
```

等价于把 `coding-module` 写进三个节点的 deps——但只存一处。

## 3. 存储

### 3.1 目录与图重建

- **目录**：默认 `<cwd>/.pi/tasks/`（spawn 的 agent 与 spawner 同 cwd → 共享同一张图）；`PI_TASKS_DIR` env 可整体覆盖（测试与重定向，仿既有 `PI_*_DIR` 覆盖惯例）。
- **图重建**：每次操作从目录扫描全部 `<id>.toml` 重建图（无内存态）——任何 agent 的写入立即对所有 agent 可见；删除文件即从图中移除该节点。
- **版本快照**：每次变更前，被替换版本的**完整内容**原子归档到 `.pi/tasks/history/<id>.v<N>.toml`（N = 被替换的版本号；无上限，全量保留）——任何历史版本随时可回溯（`task_read` 的 `version=<n>`，见 §5）。`history/` 子目录不参与图重建（`task_list` 只扫描顶层 `.toml` 文件）。

### 3.2 TOML 字段

每个 task 一个 `<id>.toml`：持久化用 TOML（而非 JSON），自由文本字段（`description`、`completion_report`）写成**字面量多行字符串**（`'''...'''`）——整段原文照抄，换行 / 双引号 / 反斜杠都无需转义，Agent 写入时无需处理 JSON 式 `\n` / `\"` / `\\` 转义序列。

| 字段 | 类型 | 语义 |

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | string | kebab-case slug；create 省略时自动生成 `task-<ulid8>` |
| `title` | string | 一句话标题 |
| `description` | string | 详细说明——模块目标 / 接口契约 / 验证标准（内容组织由角色 prompt 约定） |
| `deps` | string[] | 依赖边：前置依赖 id 列表——任何粒度皆可声明；unit 的 deps 是纯顺序依赖（等待前置完成，仍直接执行） |
| `subgraph_deps` | string[] | 子图门（仅 module）：本节点整个子图额外等待的 id 列表——存一处、读时展开，后加入子图的节点自动带门（语义见 §2.7，校验见 §4） |
| `status` | string | `pending` / `dispatched` / `active` / `done` / `blocked` / `cancelled`（见 §2.4） |
| `kind` | string | 粒度声明：`unit`（可直接执行——可带 deps 顺序依赖、无聚合子图——默认）/ `module`（聚合——可能有子图、可能需要下放；review 节点也是 module）。create 省略默认 `unit`；读取时 `kind` 缺失/非法按损坏文件处理（见 §3.4）；**unit 不能声明 `subgraph_deps`**（门绑定子图，unit 无子图可门） |
| `version` | number | 创建为 1；每次变更 +1；`task_read` 返回，写操作可携带 `expected_version` 做乐观并发校验（见 §3.4） |
| `history` | array | 版本追踪，**只存摘要**（每条：被本次写入替换的版本号 + updated_by + updated_at + change_summary），cap 10，最新在前——防上下文膨胀；被替换版本的**完整内容**见 `history/` 目录下的 `<id>.v<N>.toml` 快照（§3.1） |
| `created_at` / `updated_at` | string | ISO 8601 时间戳 |
| `updated_by` | string | 更新者（agent 身份名，身份不可得时为 `unknown`） |
| `dispatched_to` | object \| null | 当前负责人 `{name, dispatched_by, dispatch_msg_id}`——在设置 `dispatched`（派发）时由 `task_dispatch` / `task_set_status` 写入，`active` 时保留，done/cancelled 自动清除；`name` 为负责 agent 的 comms 名字（即 comms 投递地址，跨重启稳定，无需解析任何会话文件）；`dispatched_by` 为派发者 agent 名、`dispatch_msg_id` 为委托消息的 msg_id（均 `task_dispatch` 记录；裸 `task_set_status` 派发为 `""`） |
| `execution_session` | object \| null | **执行 agent 的 pi 会话** `{session_id, session_file}`——由 worker 在 `task_start`（开工）时写入自己的会话：`session_id` 为该 pi 会话的唯一 id（JSONL 转录文件 header 中的 id），`session_file` 为该会话 JSONL 转录文件的相对路径——打开即可回溯该任务实际是如何完成的。done/cancelled 时**保留**（正是回溯的时机）；reopen / undo 时保留、由下一次 start 覆盖；未开工时为 null |
| `completion_report` | string \| null | **被派发 agent 写入的完成记录**（markdown，可详细）——执行事实与计划偏差的记录（见 §2.3），由 `task_submit_report` 写入；reopen / undo 时自动清空；未写入时为 null |

### 3.3 示例

`auth-system`（目标任务，分解为两个模块）：

```toml
id = 'auth-system'
title = '实现认证系统'
description = '总体目标：登录 + 注册 + JWT 签发与校验。模块间契约写入各子项 description。'
deps = [ 'login-module', 'register-module' ]
subgraph_deps = []
status = 'pending'
kind = 'module'
version = 3
created_at = '2026-08-10T03:00:00.000Z'
updated_at = '2026-08-10T04:15:00.000Z'
updated_by = 'planner-1'

[[history]]
version = 2
updated_at = '2026-08-10T04:15:00.000Z'
updated_by = 'planner-1'
change_summary = '注册模块拆分为 register-form / register-api'

[[history]]
version = 1
updated_at = '2026-08-10T03:30:00.000Z'
updated_by = 'planner-1'
change_summary = '登录模块拆分为 login-form / login-api / jwt'
```

### 3.4 写入语义

- **原子写**：每次变更写 `.tmp` 再 `rename`——读方永远看不到半截文件。
- **先归档后改写**：每次变更先把被替换版本的完整内容写成快照（原子），再改写主文件——新版本可见前旧版本已持久化；快照写入失败则本次变更整体失败、主文件不变（写入成功后才产生快照，故快照只对应成功变更）。
- **乐观并发（optimistic concurrency）**：写操作携带调用方读到的版本——`task_update` / `task_set_status` 的可选参数 `expected_version`（`task_read` 返回当前 `version`）。写入时若节点已越过该版本，在**任何写入之前**拒绝并报冲突错误（错误信息含期望版本与实际版本，提示重读后重试）；主文件与快照均不变。省略 `expected_version` 时维持 last-writer-wins 语义。该机制补充而非替代角色分工——冲突保护的前提仍是写入方由角色分工约束、正常流程下互不冲突（见 docs/5）。
- **失败语义**：`task_read` 遇到损坏文件（TOML 非法 / 缺字段）**严格报错**并列出可用 id；`task_list` **跳过**损坏文件；`task_create` **覆盖修复**（last-writer-wins 即修复）；`task_read` 的 `version=<n>` 读历史快照——版本非法 / ≥ 当前版本 / 快照缺失时报错并列出已归档版本。


## 4. 写入校验与图算法

- **环检测**：create / update 写入时强校验，拒绝成环——错误信息**含环路径**（如 `auth-system → login-module → auth-system`）。环检查在**展开后的图**上运行（subgraph_deps 已展开），互门/自环同样被拒。
- **悬空依赖**：deps 引用不存在的 id → 拒绝——错误信息**含可用 id 列表**（提示可以链接哪些节点）。
- **游离任务（orphan）**：`task_list` 额外报告游离节点——非终态（非 done/cancelled）、无人依赖（不出现在任何节点的 `deps` 或 `subgraph_deps` 中）、且不在任何 module 的子图内（module 自身是子图根，永不报出）。只在计划含 module 时才有意义（无 module 时每个根都是顶层交付物，不报）；游离任务的重新挂接用 `task_update` 改 `deps`（unit / module 皆可，unit 加 deps 即顺序依赖），或用 `task_set_status` 取消。
- **门校验**：`deps` 更新把门移入子图时同样在写入时被拒；其余规则（门必须已存在、门在自身子图内拒绝、展开保持 DAG、`unit` 禁门）见 §2.7。
- **done 门控用有效 deps**：标记 done 时检查的是 deps ∪ 门（读时展开，见 §2.7）。


## 5. 工具

| 工具 | 参数 | 作用 |
|------|------|------|
| `task_create` | `id?`, `title`, `description?`, `deps?`, `subgraph_deps?`, `kind?`, `change_summary?` | 创建节点；省略 `id` 自动生成 `task-<ulid8>`；`kind` 声明粒度（`unit` / `module`，省略默认 `unit`）；写入时校验环（展开图）/ 悬空 / unit 带门 |
| `task_update` | `id`, `title?`, `description?`, `deps?`, `subgraph_deps?`, `kind?`, `change_summary?`, `expected_version?` | 更新节点（改依赖 / 门 / 契约 / 描述 / 粒度）；`subgraph_deps` 传 `[]` 清除门；`kind` 可翻转（unit → module，执行暴露需细化时）；写入时同样校验；`expected_version` 做乐观并发校验（见 §3.4） |
| `task_set_status` | `id`, `status`, `dispatched_to?`, `change_summary?`, `expected_version?` | 状态迁移（见 §2.4）；返回 `unlocked`（见 §2.6）；`dispatched_to` 记录负责人——**agent 名字**（comms 身份，即 comms 实际投递的地址，跨重启稳定）——仅设置 `dispatched`（派发）时有效，done/cancelled 自动清除；`expected_version` 做乐观并发校验（见 §3.4） |
| `task_read` | `id`, `version?`, `fields?` | 一律返回元数据 + 图上下文（身份行、title/kind、deps、`subgraph_deps`、dispatched_to、execution_session、依赖方、缺失 deps（含门）、就绪性、变更历史、归档提示）；长正文（description / 完成报告）按需加载——`fields="description"` 加载任务指令正文、`fields="report"` 加载完成报告正文（验证完成项时避免重复读 description）、`fields="full"` 加载两个正文；省略的正文会报告其**字数**（`omitted (N chars)`），便于判断是否值得补读；`version=<n>` 读取该历史版本的**归档快照**（不含图上下文行，同样受 `fields` 约束） |
| `task_list` | `status?` | 扁平表列出全部节点（可按状态过滤）：id、title、状态 + 图告警（环 / 悬空依赖 / 游离任务）+ 状态计数（含 dispatched）；module 节点行尾带 `[module]` 标记、带门节点行尾 `subgraph_deps: <ids>` |
| `task_ready_set` | `for?` | 查询就绪集（见 §2.5，**按 kind 分桶**：unit 执行 / module 待驱动）+ 每个未就绪 pending 项及其缺失 deps + 进度计数（含 dispatched 派发中）；`for=<id>` 缩到该节点及其依赖闭包（自身就绪也列出） |
| `task_render` | 无参 | 整图渲染为缩进树（glyph 反映节点状态） |

工具由 `session_start` 自动激活；所有 spawn 的 agent 通过 launch script 加载本扩展（见 §6）。

> worker 的两个图写工具——开工声明 `task_start` 与完成记录 `task_submit_report`——属 **task-comms-ops 扩展**（worker 侧工具，见 docs/5 §3），不属于本扩展：它们需要 comms 身份与消息发送（开工通知派发者、完成时回复委托消息）。

## 6. 组件定位与审计

- **独立组件**：图存储 + `task_*` 工具自成一体，不依赖任何其他组件即可读写。
- **加载**：spawn 的 agent 由 launch script 自动加载；手工启动的顶层 agent 通过 `pi.extensions`（package.json）获得图工具。`updated_by` 取当前 agent 身份名，身份不可得时回退 `unknown`。
- **依赖**：`lib/tasks/store.ts`（纯文件系统存储，无 pi 依赖，可单测）；`lib/tasks/graph.ts`（业务推导：子图门展开 / 就绪集 / 解锁）；图算法委托 `dependency-graph` 库（环检测 / 拓扑 / 反查依赖）。
- **审计**：每次 `task_create` / `task_update` / `task_set_status` 写入 `tasks-log` 审计通道（事件 + unlocked）；`task_start` / `task_submit_report` 的审计在 task-comms-ops 的 `task-comms-ops-log` 通道。该事件流也是网站实时可视化的订阅源。


## 7. 文件清单

```
extensions/task-graph.ts       ← 扩展入口：7 工具 + session_start 激活 + 审计（worker 写工具在 task-comms-ops，见 §5）
extensions/lib/tasks/
├── store.ts                      ← 存储层（纯文件系统，原子写，目录扫描重建图；subgraph_deps 写入校验）
└── graph.ts                      ← 图业务推导（子图门展开 / 就绪集 / 解锁）
tests/tasks-shell.test.ts         ← 扩展壳单测
tests/tasks-store.test.ts         ← 存储层单测
tests/tasks-graph.test.ts         ← 图语义单测
```
