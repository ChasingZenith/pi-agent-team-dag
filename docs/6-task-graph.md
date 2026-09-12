# Task Graph — 任务图数据系统

---

## 1. 概述

**任务图（task graph）** 把计划编码为图：目标被分解成**任务（task）**，即图中的节点；任务之间的**依赖（deps）**是图中的边——`B.deps = [A]` 表示 B 依赖 A 的完成；另有**子图门（subgraph_deps）**作为第二种关系——模块的整个子图额外等待某节点完成（见 §2.7）。所有任务组成一个**有向无环图（DAG）**。

持久化在共享文件系统上，**内容即文件**：每个任务 = metadata toml + description.md + report.md 三个真本文件 + 每 agent 的草稿文件。没有 `task_create` / `task_update` 之类的函数参数修改——计划用 `write` / `edit` 直接改**草稿文件**，`task_commit` 是唯一的内容写入/版本形成函数（见 §3、§5）。

图的推进方式是状态迁移：每次标记 done / cancelled，系统解锁新就绪的后继（见 §2.6）。状态迁移是**生命周期事件**，不形成新版本。

本组件只负责图数据本身：机器可读格式与审计事件流为后续网站实时可视化预留（见 §6）。管理角色（Coordinator）如何基于这张图组织分工，见 docs/5。


## 2. 核心模型

### 2.1 task

图上节点为 task ——任何粒度（从「实现整个认证系统」到「改一个 typo」）、任何角色视角下都是同一个实体，不规定基础单位。节点通过 `kind` 字段声明类型（见 §3.2）：`unit`（可直接执行——可有顺序依赖 deps、无聚合子图）、`module`（聚合——可能有子图、可能需要下放），或 `info`（共享信息节点——见 §2.1.1）。

#### 2.1.1 共享信息节点（kind = info）

多个 task 常需要**同一份信息**（例如「对 100 个网站做相同的审计」——共同要求写一遍，各站点只写差异）。`info` 节点就是为此存在：它**不是 task**，而是纯内容源，用于消除重复要求。

- **不参与任何图语义**：`info` 节点没有 deps、没有子图门、不进就绪集、不派发、不做状态迁移（pending/active/done…完全无关），也不被编辑/完成记录。它对图的推进零影响——纯内容，随时可取用。
- **内容注入**：普通 task 通过 `info_refs = [<info id>]`（本章元数据字段，见 §3.2）引用一个或多个 `info` 节点；**读取该 task 的 description 时，被引用 `info` 节点的正文会自动注入**（`── shared information: "<id>" (<title>) ──` 段在 task 自己的正文之前）。因此共享要求**写一遍、更新一遍**，所有引用它的 task 自动带上最新内容——只在各自正文里写差异。
- **`info_refs` 是内容引用，不是图边**：它不影响就绪集/依赖/完成状态——引用 `info` 的 task 仍是就绪即派发（共享信息不 block、不排先后）。
- **checkout 编辑分离**：`task_checkout` 拷的是 task **自己的正文**（不注入共享内容），所以编辑不会把共享内容重复进 task——共享内容始终保持引用、不复制；`task_read(fields="description")` 返回的才是注入后的有效描述。
- **校验**（提交时）：`info_refs` 必须指向已存在的 `kind="info"` 节点；`info` 节点本身不能声明 deps / subgraph_deps / info_refs（它是源头）；`info` 节点无状态迁移，标 done/cancelled/report 都被拒。

### 2.2 DAG (task graph)

- **有向边表示依赖**：` A in B.deps` 表示 A 完成后 B 才能开始/完成——先后顺序、并行与否、分解归属，全部由这一种边表达。

### 2.3 任务的完成

- **任务的完成由管理节点手动标记**——系统不自动判定；状态迁移在 deps 未满足时硬拒绝并列出缺失（见 §2.4）。目标任务同样如此：其全部 deps 完成后才能标 done。
- **分解 = 目标任务 + 分解产物作 deps**：`auth-system`（deps: [login-module, register-module]）即表示「认证系统 = 登录模块 + 注册模块」——依赖方向是从目标任务指向其分解产物。
- **完成记录（completion report）由被派发的 agent 写入 report.md**——执行完成后，worker 用 `task_checkout(id, scope="report")` 生成空草稿、`write/edit` 写正文、`task_submit_report` 提交（见 §5、docs/5），工具自动回复委托消息（msg_id 记录在任务上；一行完成通知，停掉该委托的 reminder）；manager 在 `task_complete` 前从节点读取该记录。完成记录与 `change_summary` 分离：前者是执行者的事实记录，后者是管理层的单行摘要。

### 2.4 状态机

每个 task 的状态：`pending / dispatched / active / done / blocked / cancelled / worker_offline`。合法迁移由 `task_set_status` 校验：

| 当前状态 | 合法迁移 |
|------|------|
| `pending` | `dispatched`（派发）、`active`（开始执行）、`blocked`（现实受阻）、`done`（deps 满足时）、`cancelled`（放弃） |
| `dispatched` | `active`（worker 用 `task_start` 声明开工）、`pending`（收回重新派发）、`blocked`、`done`（deps 满足时）、`cancelled`、`worker_offline`（执行者离线） |
| `active` | `pending`（收回）、`blocked`、`done`（deps 满足时）、`cancelled`、`worker_offline`（执行者离线） |
| `blocked` | `pending`（解除阻塞）、`dispatched`（重新派发）、`active`、`done`（deps 满足时）、`cancelled` |
| `worker_offline` | `dispatched`（重启后重新派发）、`pending`（收回重新安排）、`blocked`、`done`（deps 满足时）、`cancelled` |
| `done` | `active`（reopen：验证未过 / 需返工） |
| `cancelled` | `pending`（undo：取消后重新规划） |

- **`dispatched` = 已派发、尚未开工**：`task_dispatch` 发送委托后置为 dispatched 并记录 `dispatched_to`（见 §3.2）；负责的 worker 真正开始时调用 `task_start` 转 active，并把**自己的执行会话**写入节点（见 §3.2 的 `execution_session`——worker 对图的写权限只有两个：`task_start` 声明开工并记录执行会话、`task_submit_report` 提交自己的完成记录——两者都在 task-comms-ops 扩展，见 docs/5 §3）。worker 未调 task_start 时，manager 仍可直接 complete / block / cancel。
- `done` / `cancelled` 是终态（除 reopen / undo 外）。
- **标 done 必须 deps 全部满足**——否则报错并**列出缺失 deps**（标 done、取消或调整 deps）。
- **`cancelled` 对依赖方视为满足**（解锁计算与之一致）；**`blocked` 不算满足**——被阻塞的节点保持锁定。
- **`worker_offline` = 执行任务的人在途离线/死亡**（可恢复失败，区别于 `blocked`）：coordinator 从 comms reminder 发现派发消息的接收方 offline 后，把任务置为 `worker_offline`——既不是现实阻碍计划（`blocked`），也不是执行完成（`done`）。对依赖方它**不算满足**（保持锁定）；但它是**可恢复**的：TP 用节点上记录的 `execution_session`（JSONL）重启同名 agent 后，coordinator 重新 `task_dispatch`（`worker_offline → dispatched` 合法）把任务交给重启的 agent。
- **`blocked` / `worker_offline` 只能手动标记**——系统不会自动判断阻塞或离线。

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
- **校验**（提交时，与 deps 同级）：门必须已存在；门**不能在本模块子图内**（自环）；**展开后的图保持 DAG**——互门/自环均被环检测拒绝并报环路径（见 §4）；`unit` 不能声明门（无子图可门）。
- **done 门控一致**：标记子图内任何节点 done 时，门未满足（非 done/cancelled）即拒绝并列出缺失门。


## 3. 存储

### 3.1 目录与文件布局

**每个任务 3 个真本文件 + 每 agent 草稿 + 每版本快照（历史），全部 3 文件一组：**

```
.pi/tasks/
├── <id>.toml                  # ① metadata 真本（不含正文；带两个正文的 sha256）
├── <id>.description.md        # ② description 真本 —— frontmatter: version —— 仅 commit 改写
├── <id>.report.md             # ③ report 真本 —— frontmatter: for_version —— 仅报告提交/void 改写
├── draft/
│   └── <cname>/               # 每 agent 的草稿（write/edit 自由修改；commit 后消费删除）
│       ├── <id>.toml              # metadata 草稿（patch 语义）
│       ├── <id>.description.md    # description 草稿
│       └── <id>.report.md         # report 草稿
└── history/
    └── <id>.v<N>/             # 版本 N 的快照 —— 也是 3 个文件，提交时冻结
        ├── metadata.toml
        ├── description.md
        └── report.md
```

- **真本 = 已提交内容**：只被 `task_commit` / `task_submit_report` / 生命周期工具改写，任何时刻对应一个已确定版本，永远干净；正文文件被外部改动会触发 **sha256 校验警告**（见 §3.5）。
- **草稿 = 编辑区**：agent 用 `write`/`edit` 直接编辑自己的草稿（`draft/<cname>/`，cname = `--cname` 身份，**按 agent 隔离**——多人同时改同一任务互不覆盖草稿文件）；`task_commit` 校验后把草稿落成新版本并**删除已消费的草稿**。
- **快照只在版本 bump 时写**：`history/<id>.v<N>/`（N = 被替换的版本号），先归档旧版本（3 文件）、后写新真本——旧版本持久化后新版本才可见。任意历史版本可经 `task_read(id, version=<n>)` 读回（§5）。
- **目录**：默认 `<cwd>/.pi/tasks/`（spawn 的 agent 与 spawner 同 cwd → 共享同一张图）；`PI_TASKS_DIR` env 可整体覆盖（测试与重定向）。图重建只扫描顶层 `*.toml` 真本；`draft/`、`history/` 子目录不参与。
- **版本语义**：`version` = 内容修订号——只有**内容**变化（`title / description / kind / info_refs`，每次成功的 `task_commit`）才 +1；**`deps` / `subgraph_deps` 变化不 bump `version`**，而是 bump `struct_version`（结构修订号，含 `into_*` 接线重提交父节点时）——结构变化绝不打扰持有内容版本的 consumer；**生命周期事件（状态迁移/派发/开工）与完成报告不 bump**，只追加 history 摘要并更新 `updated_at/by`。快照只对内容版本写（结构-only 变化不写快照，因为 description 契约与报告锚点未动）。

### 3.2 文件格式

**metadata toml（真本与快照同构，无正文）：**

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | string | kebab-case slug；由草稿 toml 的 `id` + `task_commit(id=...)` 指定 |
| `title` | string | 一句话标题 |
| `deps` | string[] | 依赖边：前置依赖 id 列表——任何粒度皆可声明；unit 的 deps 是纯顺序依赖（等待前置完成，仍直接执行） |
| `subgraph_deps` | string[] | 子图门（仅 module）（语义见 §2.7，校验见 §4） |
| `info_refs` | string[] | 共享信息引用（内容引用，**不是图边**）：所引用 `info` 节点（kind=`"info"`）的正文在此 task 读 description 时自动注入（见 §2.1.1）；unit / module 皆可声明，`info` 节点自身不可声明 |
| `status` | string | `pending` / `dispatched` / `active` / `done` / `blocked` / `cancelled` / `worker_offline`（见 §2.4）；`info` 节点无状态语义，状态迁移被拒 |
| `kind` | string | `unit`（默认）/ `module` / `info`（共享信息节点）；unit 不能声明 `subgraph_deps`；info 不能声明 deps / subgraph_deps / info_refs |
| `version` | number | 内容修订号（§3.1，内容变化 +1）；`task_read` 返回，`task_commit` / `task_submit_report` 携带 `expected_version` 做乐观并发校验（必填，见 §3.4） |
| `struct_version` | number | 结构修订号：`deps` / `subgraph_deps` 每变化一次 +1（含 `into_*` 接线重提交父节点），独立于 `version`——接线/改边从不 bump `version` |
| `struct_changed_at` | string | 最近一次结构（deps/subgraph_deps）变化的 ISO 时间戳——`task_read` 以此给出软信号（`subgraph changed (struct vN) @ ...`），通知持有旧内容版本的 consumer 图已增长，但不强制重读（内容 `version` 未变） |
| `description_sha256` / `report_sha256` | string | 真本 description.md / report.md 的 sha256（含 frontmatter 全文），提交时写入，读取时校验（见 §3.5） |
| `history` | array | 变更追踪，**只存摘要**（每条：`changed_items`（本次改了什么）+ 关联的 `version` + `event`（lifecycle 动作）+ `updated_by` + `updated_at` + `change_summary`），cap 10，最新在前——防上下文膨胀；被替换版本的完整内容见 `history/<id>.v<N>/` 快照 |
| `created_at` / `updated_at` | string | ISO 8601 时间戳 |
| `updated_by` | string | 更新者（agent 身份名，身份不可得时为 `unknown`） |
| `dispatched_to` | object \| null | 当前负责人 `{name, dispatched_by, dispatch_msg_id}`——在设置 `dispatched`（派发）时由 `task_dispatch` / `task_set_status` 写入，`active` 时保留，done/cancelled 自动清除；`name` 为负责 agent 的 comms 名字（即 comms 投递地址，跨重启稳定）；`dispatched_by` 为派发者、`dispatch_msg_id` 为委托消息 msg_id |
| `execution_session` | object \| null | **执行 agent 的 pi 会话** `{session_id, session_file}`——worker 在 `task_start` 写入；done/cancelled 时保留（回溯时机）；reopen/undo 保留、由下一次 start 覆盖 |
| `planned_by` | object \| null | **规划者身份 + 其 pi 会话** `{name, session_id, session_file}`——每次 `task_commit` 由提交者写入（与 `dispatched_to` 对称）：记录产出当前内容版本的 planner 是谁、其会话 JSONL 在哪，供重规划时接回同一 planner 上下文；`into_*` 接线重提交父节点时一并写入，因此模块节点记录的是分解它的 planner |

**正文文件（description.md / report.md）带 YAML 风格 frontmatter，直接打开文件即可看出版本信息：**

```markdown
# description.md                        # report.md
---                                     ---
version: 3                              for_version: 3
---                                     ---

<正文：目标/接口契约/验收标准>            <正文：完成记录>
```

- frontmatter 由机器在提交时生成/重建；`task_checkout` 给出的草稿**只含正文、不带 frontmatter**（description 拷自真本但剥离 frontmatter；report 是空白脚手架），提交时统一剥离并重写。
- **`for_version` 锚定报告针对的 description 版本**：description 变更后旧报告保留、`for_version` 不变——与新版本对照即可看出它针对旧契约（陈旧可见）。reopen/undo 时报告被清空（工作重启）。
- **草稿 metadata toml 是 PATCH**：只写要改的字段（`title / deps / subgraph_deps / kind / info_refs`），缺席字段保持现值（已有任务）/ 默认值（新建）；`status / version / history / 时间戳 / hash` 在草稿中一律被忽略（机器管理——状态走生命周期工具）。

### 3.3 示例

`auth-system`（目标任务，分解为两个模块）的 metadata 真本：

```toml
id = 'auth-system'
title = '实现认证系统'
deps = [ 'login-module', 'register-module' ]
subgraph_deps = []
status = 'pending'
kind = 'module'
version = 3
description_sha256 = '9f2c…'
report_sha256 = 'e3b0…'
created_at = '2026-08-10T03:00:00.000Z'
updated_at = '2026-08-10T04:15:00.000Z'
updated_by = 'planner-1'

[planned_by]
name = 'planner-1'
session_id = '01J0…'
session_file = '.pi/agent-sessions/planner-1.json'

[[history]]
changed_items = [ 'deps' ]
version = 3
event = ''
updated_at = '2026-08-10T04:15:00.000Z'
updated_by = 'planner-1'
change_summary = '注册模块拆分为 register-form / register-api'

[[history]]
changed_items = [ 'description' ]
version = 2
event = ''
updated_at = '2026-08-10T03:30:00.000Z'
updated_by = 'planner-1'
change_summary = '重写接口契约'
```

对应文件：`auth-system.description.md`（`---\nversion: 3\n---` + 正文）、`auth-system.report.md`（无报告时 `---\nfor_version: 3\n---\n\n` 空壳）、`history/auth-system.v1/`、`history/auth-system.v2/`（各 3 文件）。

### 3.4 写入语义

- **草稿 + 提交**：所有内容修改 = `write`/`edit` 草稿文件 → `task_commit`（或 worker 的 `task_submit_report`）→ 校验 → 归档旧版本（3 文件快照）→ 写新真本 → version+1 → history 摘要 → 审计 → **删除已消费草稿**。草稿在两次提交之间是唯一被编辑的东西——真本永远干净。
- **原子写**：每个文件写独占命名的 `.tmp`（含 pid + 进程内序号）再 `rename`——读方永远看不到半截文件；并行写者也不会共用同一个临时文件。
- **写锁（跨进程互斥）**：`task_commit` / `task_set_status` / `task_submit_report` 在整段「读—改—写」期间持有 `<tasks>/.lock/`（`mkdir` 原子创建即获取，EEXIST 即被占）。`expected_version` 只是**逻辑**守卫；check 与 `rename` 是两个系统调用，仅靠它无法阻止两个进程（每个 agent 一个 pi 进程、共享同一个 cwd 的 `.pi/tasks`）先后通过校验后各自写入、静默丢一次更新——写锁才是**物理**守卫，让同一时刻只有一个写者。同进程内并行的工具调用不会交错（整段写路径是同步 JS），所以写锁是针对跨进程拓扑而设。持锁超时（默认 15s，`PI_TASKS_LOCK_TIMEOUT_MS` 可调）→ 报错提示重试；持有者进程已死（同主机 pid 不存在）或加锁超过 60s 视为陈旧，自动打破。
- **乐观并发（expected_version，必填）**：`task_commit` 更新已有任务、`task_submit_report` 都必须携带调用方读到的版本（`task_read` 返回；派发头部也携带）。写入时若版本已越过 → **在任何写入之前**拒绝并报冲突错误（含期望/实际版本，提示重读合并草稿后重试）。它是**逻辑**守卫——拒绝调用方的陈旧意图，而不是自动合并；配合上面的写锁（物理守卫：写者不交错）才构成完整保证。**草稿按 agent 隔离** + 强制 expected_version = 同一版本只允许一次提交成功，冲突方重读、把自己的修改合并到新草稿、重新提交——不会有提交静默覆盖别人的已提交内容。创建新任务时 `expected_version` **必须**为 1（新任务总是建在 v1）。
- **失败语义**：`task_read` 遇到损坏文件（TOML 非法 / 缺字段）**严格报错**并列出可用 id；`task_list` **跳过**损坏文件；`task_commit` 无变化（草稿与真本一致）拒绝——防空版本。
- **旧格式不兼容**：单文件 TOML 旧格式不支持、无迁移；旧文件即使存在也被视为空描述——正规路径只有草稿 + 提交。

### 3.5 完整性校验（sha256）

- **写入**：每次提交把真本正文文件的全文（含 frontmatter）sha256 写入 metadata（`description_sha256` / `report_sha256`）；每个历史快照的 metadata 也带**它自己**的两个 hash——每版本独立可校验。
- **读取**：`task_read` / 写路径读真本文件、重算 sha256 与存储值比对——不一致或文件缺失 → **完整性警告**（`⚠ integrity: <id>.description.md hash mismatch …`，记录仍可读、问题被点名）：真本被提交之外的修改（篡改/误编辑）无处遁形。图计算只用 metadata，不受正文校验影响。


## 4. 写入校验与图算法

- **校验时机在 `task_commit`（提交）**——编辑草稿时不做任何校验；提交时对草稿内容校验：环检测、悬空依赖、门约束、kind 合法性，错误信息教 model 怎么修（列出可用 id / 环路径）。
- **环检测**：提交时强校验，拒绝成环——错误信息**含环路径**（如 `auth-system → login-module → auth-system`）。环检查在**展开后的图**上运行（subgraph_deps 已展开），互门/自环同样被拒。
- **悬空依赖**：deps 引用不存在的 id → 拒绝——错误信息**含可用 id 列表**。
- **游离任务（orphan）**：`task_list` 额外报告游离节点——非终态（非 done/cancelled）、无人依赖（不出现在任何节点的 `deps` 或 `subgraph_deps` 中）、且不在任何 module 的子图内。只在计划含 module 时才有意义；游离任务的重新挂接用 metadata 草稿改 `deps` + `task_commit`，或用生命周期工具取消。`module` 不豁免——一个 module 无人依赖且自身无内容（deps 与 subgraph_deps 均空）即为空壳游离节点；只有**非空** module（自身有 deps / 门）才是自己子图的根，不游离。
- **门校验**：deps 更新把门移入子图时同样在提交时被拒；其余规则见 §2.7。
- **done 门控用有效 deps**：标记 done 时检查的是 deps ∪ 门（读时展开）。


## 5. 工具

| 工具 | 参数 | 作用 |
|------|------|------|
| `task_commit` | `id`, `expected_version`(必填), `scope?`(`metadata`\|`description`\|`all`，默认 `all`), `change_summary?` | **唯一的内容写入/版本函数**：读调用者草稿（`draft/<cname>/`）→ 校验（deps 存在/无环/门约束/kind/info_refs）→ 归档被替换版本（`history/<id>.v<N>/` 3 文件）→ 写新真本（metadata + description.md；report.md 不动）→ version+1 → history 摘要 + 审计 + broadcast → **删除已消费草稿**，并在返回文本的 `pending drafts` 里报告本 agent 草稿目录中**剩余未消费的草稿**（按 id + 类型列出；类型决定谁来提交：`metadata`/`description` → `task_commit`，`report` → `task_submit_report`）——草稿不参与图扫描，只有这一行能提醒尚未提交的草稿。创建：草稿 toml 含 id/title（必填）+ 可选 deps/subgraph_deps/kind/info_refs → v1（`expected_version` 必须为 1）。`kind="info"` 建共享信息节点（纯内容、裸 description）；`info_refs` 引用 `info` 节点注入共享要求（见 §2.1.1）。更新：metadata 草稿是 patch（只写要改的字段）；`expected_version` **必填**（= `task_read` 返回的版本），版本已越过 → 冲突拒绝（重读、合并草稿、重试）。无变化拒绝。`version` 只在 title/description/kind/info_refs（内容）变化时 +1；`deps`/`subgraph_deps`（结构）变化 bump `struct_version`，不 bump `version`——`into_deps`/`into_subgraph_deps` 是 metadata 草稿字段（非调用参数），把本节点接入父节点并结构-only 重提交父节点（其内容 version 不受扰动）。每次提交把提交者身份 + 其 pi 会话写入节点 `planned_by`（见 §3.2 字段表） |
| `task_checkout` | `id`, `scope?`(`description`\|`report`，默认 `description`), `version?` | 初始化自己的草稿（改内容的 Step 1，只给正文、不带 frontmatter）。**创建新任务**：`version=0`（id 尚不存在）→ 脚手架化 metadata 草稿（含 `id`）+ 空 description 草稿，填好后 `task_commit(id, expected_version=1)` 建 v1。**已存在任务**：省略 version = 当前版本，把真本 `description.md` 的**正文**（剥离 frontmatter）复制到 `draft/<cname>/<id>.description.md`；`version=<n>`（n<当前）→ 把 `history/<id>.v<n>/` 该历史快照的正文复制进草稿（`scope="description"` 时）。`scope="report"`：在 `draft/<cname>/<id>.report.md` 创建**空白草稿**（不带 frontmatter，不复制旧报告），之后 `write/edit` 正文 → `task_submit_report`（提交时补上 `for_version` = 当前 description 版本，见 docs/5 §3）。已有草稿时拒绝覆盖（需手动清除后重建） |
| `task_set_status` | `id`, `status`, `dispatched_to?`, `change_summary?` | 状态迁移（见 §2.4）；返回 `unlocked`（见 §2.6）；`dispatched_to` 记录负责人——仅设置 `dispatched` 时有效，done/cancelled 自动清除。**生命周期事件：不 bump 版本**，只追加 history 摘要（`changed_items=["status"]` + `event`） |
| `task_read` | `id`, `version?`, `fields?` | 一律返回元数据 + 图上下文（身份行、title/kind、deps、`subgraph_deps`、`info_refs`、dispatched_to 及其派发者 `dispatched_by`、execution_session、planned_by、依赖方、缺失 deps（含门）、就绪性、变更历史）+ 正文字数（`description (vN): N chars` / `completion report (for description vN): N chars`）+ 你自己的未提交草稿数 + **完整性警告**（存储细节不外泄，读与编辑分离：编辑走 `task_checkout` + write/edit + `task_commit`/`task_submit_report`）；长正文按需加载——`fields="description"` / `fields="report"` / `fields="full"`；省略的正文报告字数；`version=<n>` 读历史快照（同样受 `fields` 约束）。description 返回的是**有效描述**：被引用 `info` 节点正文注入 + task 自身正文（见 §2.1.1）；`kind="info"` 节点显示 `ready: none — shared information`，无生命周期 |
| `task_list` | 无参 | 整图渲染为缩进树（roots = 交付物，children = 其 deps；glyph 反映节点状态、`[module]` 标记 module）；树后依次为状态计数行、`Ready: <ids>` 行、`── Shared information (N) ──` 段（`info` 节点不进 DAG 树，每行带 `referenced by N` 引用计数），最后在图有结构问题时附图告警（环 / 悬空依赖 / 游离任务 / 断图）；普通节点行尾带 `subgraph_deps: <ids>` / `info_refs: <ids>` |
| `task_ready_set` | `for?` | 查询就绪集（见 §2.5，**按 kind 分桶**：unit 执行 / module 待驱动）+ 每个未就绪 pending 项及其缺失 deps + 进度计数；`for=<id>` 缩到该节点及其依赖闭包 |

worker 的报告工具——`task_checkout(id, scope="report")`（生成空白报告草稿）与 `task_submit_report`（提交报告：读草稿 → 校验 `dispatched_to` 身份 + `expected_version`（description 契约未漂移）→ 以 `for_version` 锚定当前版本提交 → 自动回复委托消息）——见 docs/5 §3，不属于本扩展。

工具由 `session_start` 自动激活；所有 spawn 的 agent 通过 launch script 加载本扩展（见 §6）。


## 6. 组件定位与审计

- **独立组件**：图存储 + `task_*` 工具自成一体，不依赖任何其他组件即可读写（`task_commit` / `task_checkout` / `task_read` 等）。
- **加载**：spawn 的 agent 由 launch script 自动加载；手工启动的顶层 agent 通过 `pi.extensions`（package.json）获得图工具。`updated_by` 取当前 agent 身份名（`--cname`），身份不可得时回退 `unknown`；草稿目录 `draft/<cname>/` 同样取自 `--cname`。
- **依赖**：`lib/tasks/store.ts`（纯文件系统存储，无 pi 依赖，可单测）；`lib/tasks/graph.ts`（业务推导：子图门展开 / 就绪集 / 解锁）；图算法委托 `dependency-graph` 库（环检测 / 拓扑 / 反查依赖）。
- **审计**：每次 `task_commit` / `task_set_status` 写入 `tasks-log` 审计通道（事件 + changed_items + unlocked）；`task_start` / `task_submit_report` 的审计在 task-comms-ops 的 `task-comms-ops-log` 通道。该事件流也是网站实时可视化的订阅源。


## 7. 文件清单

```
extensions/task-graph.ts       ← 扩展入口：task_commit / task_checkout / task_set_status / task_read / task_list / task_ready_set + session_start 激活 + 审计（worker 写工具在 task-comms-ops，见 §5）
extensions/lib/tasks/
├── store.ts                      ← 存储层（3 文件布局 / 草稿 / frontmatter + sha256 / 快照 / 提交校验；纯文件系统，原子写）
└── graph.ts                      ← 图业务推导（子图门展开 / 就绪集 / 解锁）
tests/tasks-shell.test.ts         ← 扩展壳单测
tests/tasks-store.test.ts         ← 存储层单测
tests/tasks-graph.test.ts         ← 图语义单测
```
