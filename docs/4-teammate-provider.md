# Teammate Provider — 网络 Agent 注册中心

---

## 1. 概述

**Teammate Provider (TP)** 是 comms 上的**唯一单例 agent**，负责在网络中查找或创建 agent。所有 agent（Coordinator、Worker、Scout 等）都通过同一个 TP 获取 teammate。

**核心特性：**

- TP 自身是 comms 上的独立 agent，有自己的 LLM
- 收到找人请求后，TP 的 LLM 读取描述、扫描可用 agent、自主判断：匹配已有还是 spawn 新的
- 调用者无法分辨 agent 是找到的还是创建的
- 基于角色模板系统 spawn（role-context 的 `<role>.md` 模板，见 §6）
- **建立在 agent-lifecycle 之上**——经模块导入 `executeAgentSpawnByRole` 等（见 docs/3 §8.2）

---

## 2. 架构

```
┌──────────────────────────────────────────────────────┐
│ comms Hub                                         │
│                                                      │
│  ┌─────────────────────┐                             │
│  │ Teammate Provider   │  ← "teammate-provider"      │
│  │ (独立 agent + LLM)  │    唯一的网络注册中心        │
│  │                     │                             │
│  │ comms_list_peer       │  扫描在线 agent              │
│  │ tp_spawn_agent      │  导入 executeAgentSpawnByRole│
│  └────────┬────────────┘                             │
│           │ comms                                 │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Coordinator    │  │ Scout    │  │ Worker   │     │
│  │ (delegate)     │  │ (explore)│  │ (execute)│     │
│  └────────────────┘  └──────────┘  └──────────┘     │
└──────────────────────────────────────────────────────┘
```

---

## 3. 工作流

```
Agent A                          Teammate Provider
  │                                    │
  │ comms_send(                     │
  │   target="teammate-provider",      │
  │   message="I need someone to       │
  │     review SQL injection in        │
  │     src/db/"                       │
  │ )                                  │
  │ ─────────────────────────────────► │
  │                                    │ 1. LLM 读到请求
  │                                    │ 2. 调用 comms_list_peer()
  │                                    │ 3. LLM 判断：没有合适的
  │                                    │ 4. 调用 tp_spawn_agent(
  │                                    │      role="experts-reviewer")
  │                                    │    → executeAgentSpawnByRole()
  │                                    │ 5. comms_send(
  │                                    │      target="<Agent A>",
  │                                    │      message="experts-reviewer",
  │                                    │      reply_to_msg_id="<A 的消息 id>")
  │  ◄───────────────────────────────── │
  │  收到: "experts-reviewer"          │
```

**关键设计**：调用者只描述工作（`Find a teammate/planner/coordinator to work on a task: <id>`），**不指定角色**；TP 从角色目录（§7）自己决定角色、直接回复 agent 名字——目录只注入 TP 的 prompt，调用方看不到。调用者拿到名字后自行交付任务（`task_dispatch`，见 docs/5 §3）。

**上下文隔离**：TP spawn 的 agent 获得干净的模板驱动上下文（通过 `llmContextFromRole()`），不继承 TP 的对话历史——spawned agent 与 TP 的身份完全独立。`agent_spawn` 的 `context: "fork"`（继承 spawner 会话）是显式 opt-in——TP 不启用，仅由主动声明"子 agent 应继承本会话工作上下文"的调用方使用。

---

## 4. 工具

TP 提供 **2 个工具**供自身的 LLM 使用。查看在线 agent 直接调 `comms_list_peer`。

### 4.1 `tp_spawn_agent`

- **用途**：从角色模板创建并 spawn 新 agent。
- **参数**：
  - `role`（string）：角色名（coordinator / scout / web-searcher / planner / experts-reviewer / consultor / worker / requirements-clarifier）
  - `name`（可选）：自定义名称，默认从 role 去重生成
  - `add_tools`（可选，string[]）：在角色模板 `defaultTools` **之外追加**的工具名（模板里没有的工具）；最终白名单 =（`defaultTools` ∪ `add_tools`）− `exclude_tools`
  - `exclude_tools`（可选，string[]）：从角色模板 `defaultTools` **移除**的工具名（如去掉 worker 的 `bash` 使其只读）
  - `add_skills`（可选，string[]）：**额外加载**的 skill（裸名或路径，裸名按标准 skill 位置查找，见 docs/2 §2.2）——模板已声明的 skills 仍默认加载
  - `exclude_skills`（可选，boolean）：**跳过**角色模板声明的 `skills:`（默认加载）
  - `add_extensions`（可选，string[]）：**额外加载**的 extension 路径（相对路径以项目根为基准）
  - `exclude_extensions`（可选，boolean）：**跳过**角色模板声明的 `extensions:`（默认加载）
- **实现**：**单步调用** `executeAgentSpawnByRole({ role, name, addTools, excludeTools, addSkills, excludeSkills, addExtensions, excludeExtensions }, cwd, ctx)`（docs/3 §8.2——模块函数导入，非工具调用）；工具白名单的计算（`defaultTools − exclude ∪ add`）在 agent-lifecycle 侧完成一次，经 `--role-tools` 传给 spawned agent（docs/3 §7.1）
- **上下文**：spawn 出的 agent 获得干净的模板上下文，不继承 TP 的对话历史（见 §3 上下文隔离）。
- **返回值**：agent 名称、role、**有效工具白名单**、skills、window ID 等（`tools` 为计算后的白名单，而非模板原始 `defaultTools`）。任务不在 spawn 时传入——由调用方在收到 TP 回复后自行交付（`task_dispatch`）。

### 4.2 `tp_restart_agent`

- **用途**：重启一个死掉/离线的 agent，**恢复其执行上下文**（worker-offline 恢复链路）。调用方传出 agent 名 + 它正在跑的任务 id。
- **参数**：
  - `agent`（string）：要重启的 agent 名——**同名**（comms 身份跨重启稳定，复用同一 durable consumer）。
  - `task_id`（string）：该 agent 正在跑的任务——用于读取任务节点上记录的 `execution_session`（dead agent 正在执行的 JSONL 转录）。
- **实现**：读 `task.execution_session.session_file` → **单步调用** `executeAgentRestart({ name: agent, resumeFrom: sessionFile }, cwd, ctx)`（docs/3 §8.2——模块函数导入）；重启从 spawn manifest（role/tools/skills/extensions/model）重建同名 agent，用 `resumeFrom` 指向该 JSONL，pi reopen 续传（保留上次执行上下文）。无 `execution_session`（worker 从未 task_start）+ 即报错。
- **上下文**：重启后的 agent 复用原会话转录，**保留上次执行的对话上下文**（这正是恢复的意义）。
- **返回值**：agent 名（同名）、role、工具白名单、session 路径、`restarted: true`——调用方据此重新 `task_dispatch` 给该名。

---

## 5. 文件清单与依赖

```
extensions/
└── teammate-provider/
    ├── package.json       ← pi.extensions 清单(依赖 comms、agent-lifecycle)
    └── index.ts           ← TP agent 主逻辑
```

> 其余文件（`agent-lifecycle/index.ts`、`lib/launch-script.ts`、`lib/tmux.ts`、`lib/role-context/` 等）均属于 agent-lifecycle / role-context，见 docs/2 §1；角色模板目录 `lib/role-context/roles/`（manager/：coordinator、teammate-provider；specialist/：scout / web-searcher / planner / experts-reviewer / consultor / worker / requirements-clarifier）同样归属 role-context。

**加载入口扩展即可**——comms、agent-lifecycle 由 `extensions/teammate-provider/package.json` 的 `pi.extensions` 清单声明，按依赖顺序自动加载：

```bash
pi -e extensions/teammate-provider \
   --cname teammate-provider
```

> **为何需要 agent-lifecycle**：role-aware spawn（`executeAgentSpawnByRole`：角色验证 → 去重命名 → 上下文构建 → tmux spawn）与角色查询（`listRoleNames`/`buildRoleCatalog`）都由它提供（docs/3 §8.2）；其 `session_shutdown` 处理器负责在 TP 关闭时清理所有 spawned agent 的 tmux window。
>
> TP 自身**不加载** role-context.ts（TP 的 prompt 是角色模板 `roles/manager/teammate-provider.md`，由自身的 `before_agent_start` 经 agent-lifecycle 转发 `getRoleTemplate` 读取并插值，与 spawn 路径同一套 role-context 机制）；spawn 出的 agent 由 launch script 自动加载 role-context.ts 以注册 `--role`。

---

## 6. 角色模板

TP spawn 使用 role-context 的角色模板——`lib/role-context/roles/` 下按语义分类（`manager/` 管理节点、`specialist/` 领域专家）存放的 `<role>.md`（YAML frontmatter + Markdown，含 `{{cname}}` 占位符与 `{{include:...}}` 内联协议）。格式与加载细节见 docs/2 §2。

---

## 7. System Prompt

TP 的 system prompt 是角色模板 `lib/role-context/roles/manager/teammate-provider.md`（frontmatter `defaultTools` 即其工具白名单：`tp_spawn_agent` + `tp_restart_agent` + `comms_*`，不含 `task_*`），使用 `{{role_catalog}}` 占位符在加载时注入角色目录。**角色目录逐项列出每个角色的 `Default tools`，以及模板声明的 `Declared skills:` / `Declared extensions:`**（`buildRoleCatalog` 经 `skillRefs`/`extensionRefs` 输出原始声明，docs/2 §3）——TP 据此知道每个角色默认有哪些工具/能力，从而在 spawn 时决定 `exclude_*`（去掉默认的）或 `add_*`（补模板没有的）。主要内容：

- 你是唯一的 TP，所有人来找你
- 收到请求 → 调 `comms_list_peer` 扫描在线 agent → 你（LLM）自己判断
- 复用判据是**任务相关性**：agent 正在做的任务对本请求任务有益（同一 task 的继续、同一工作线的后继）才复用；**角色名不是判据**——同角色可以有多个实例（`web-searcher-2`…），busy 的 agent 无论名字还是角色都不复用
- 无人合适 → 从角色目录（功能 + 适用场景）选最匹配请求 Task 的角色 → `tp_spawn_agent` → 回复新名字（spawner 自动分配唯一名）
- 一个请求 = 一个任务 = 一个 agent（调用方可能并行发多个请求，期望一任务一 agent）
- 回复要短：agent 名 + 一行理由
- 不让调用者看出是找到的还是创建的

### 匹配逻辑

资料**没有 role 标签**（comms 纯通信，不记录角色），角色字段只决定 spawn 用哪个模板。匹配依据：

- **`current_task`** — 实时状态：由任务生命周期自动跟踪（`task_start` 设标题、`task_submit_report` 清空，见 docs/1 §6.6；可手动覆盖），可能滞后，只能作为提示而非事实；busy（在做其他任务）的 agent 一律不复用

TP 的 LLM 按以下优先级决策：

1. **任务相关性** — 现有 agent 的 `current_task` 与本请求的 task **同一或直接延续**（经验可直接迁移）→ 复用
2. **否则一律 spawn** — 调 `tp_spawn_agent`（角色模板）创建新实例；无法确认相关性或空闲时也默认 spawn（新专家好过错误的复用）

请求携带的 **task id** 用于复用判断（见上「匹配逻辑」）；task 内容由 agent 用 `task_read(id=...)` 自行读取（task-graph 扩展提供，spawn 的 agent 自动加载）——默认返回元数据与图上下文（不含 description / 完成报告的长正文），正文按需用 `fields="description"` / `"report"` / `"full"` 加载（见 docs/6 §5）；委托消息只带补充信息（见 docs/5 §2.1）。TP 不转达内容。

---

## 8. 与其他组件的关系

TP 只从 `./agent-lifecycle` 导入：`executeAgentSpawnByRole()` 与转发的角色查询函数（见 docs/3 §8.2），所有 spawn 操作不经过 pi 的工具调用层。

---

## 9. 已验证的测试

| # | 测试项 | 结果 |
|---|--------|------|
| 1 | TP 注册到 comms | ✅ |
| 2 | NATS durable consumer prompt 事件接收 → LLM turn | ✅ |
| 3 | `comms_list_peer` 扫描 online agent | ✅ |
| 4 | 按 current_task 任务相关性判断复用（资料无 role 标签） | ✅ |
| 5 | `tp_spawn_agent` → `executeAgentSpawnByRole` 成功 | ✅ |
| 6 | LLM 自主判断：任务不相关/无法确认 → spawn → 同一任务延续 → 复用 | ✅ |
| 7 | 显式回复(comms_send + reply_to_msg_id) | ✅ |
| 8 | session_shutdown 清理 spawned agents | ✅ |
