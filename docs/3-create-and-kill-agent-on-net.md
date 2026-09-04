# Agent Lifecycle — Agent 生命周期管理

---

## 1. 概述

**agent-lifecycle** 是 Pi Coding Agent 的一个扩展，提供基于 **tmux** 的 agent 启动/停止管理能力。它是 comms 生态中的 **agent 生命周期管理层**——负责创建和销毁运行在独立 tmux 窗口（window）中的 agent 进程，而 agent 之间的通信则由 comms 负责。

**核心特性：**

- 在 tmux 窗口中启动独立的 Pi agent 进程
- 被 spawn 的 agent 自动连接 comms Hub
- 统一 `LLMContext` 上下文机制（role-context 组件提供，见 docs/2 §3）
- shutdown 时自动清理所有管理的 window
- 默认 `autoExit: false`——agent 持续存活，生命周期由 spawner 显式管理（`agent_kill` / `session_shutdown`）；`autoExit: true` 仅限非常简单的单轮任务（详见 §4）
- **模块级共享状态** + **导出核心函数**，供 teammate-provider 等扩展直接导入调用
- **session 创建/fork**：经 role-context 的 fork.ts 委托 pi 官方 `SessionManager`——`forkSession()` 分支 spawner 会话（裁剪到最后一个委派消息 `comms-inbound` 之前）、`writePreloadedSessionFile()` 预载初始消息（见 docs/2 §4）

**设计原则：** agent-lifecycle 只做 tmux window 管理，所有 comms 通信（注册、心跳、消息收发）完全通过 `comms.ts` 的工具完成，不重复实现任何 comms 客户端逻辑。

**文件清单：**

```
extensions/
├── lib/
│   ├── tmux.ts              # tmux window 操作原语
│   ├── launch-script.ts     # agent 启动脚本构建器（含 --role, --system-prompt 等）
│   └── role-context/        # role-context 组件（template / fork / roles/，见 docs/2 §1）
├── auto-exit.ts             # agent_settled 判定自动退出（含 pending send 防线）
└── agent-lifecycle/         # 目录入口
    ├── package.json         # pi.extensions 清单(依赖 comms,自动加载)
    └── index.ts             # agent_spawn/agent_kill 工具 + 导出 executeAgentSpawn/executeAgentSpawnByRole
```

> 启动脚本加载的 `role-context.ts` 及其 `lib/role-context/`（角色模板、LLMContext 构建、session fork）属于独立组件 role-context，见 docs/2。

**关键架构决策**：role-aware spawn 与角色查询由 agent-lifecycle 统一提供（§8.2 导出函数），teammate-provider 等扩展经模块导入直接调用，不重复实现（组件关联见 docs/0-overview §1）。

---

## 2. 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        tmux 会话                                   │
│                                                                  │
│  ┌──────────────────────────────┐                                │
│  │ 主 Pi 进程                    │                                │
│  │ agent-lifecycle/          │                                │
│  │ comms.ts                  │                                │
│  │                              │                                │
│  │ agent_spawn ──→ agent_kill   │                                │
│  └──────────┬───────────────────┘                                │
│             │                                                    │
│             │ tmux new-window / kill-window                      │
│             ▼                                                    │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐  │
│  │ tmux 窗口 @1                 │  │ tmux 窗口 @2             │  │
│  │ pi                           │  │ pi                       │  │
│  │ -e comms.ts               │  │ -e comms.ts           │  │
│  │ -e task-graph.ts            │  │ -e task-graph.ts       │  │
│  │ -e task-comms-ops.ts        │  │ -e task-comms-ops.ts   │  │
│  │ -e role-context.ts           │  │ -e role-context.ts       │  │
│  │ -e auto-exit.ts              │  │ -e auto-exit.ts          │  │
│  │ --cname scout                │  │ --cname builder          │  │
│  │ --role scout                  │  │ --role worker            │  │
│  │ --system-prompt ...           │  │ --system-prompt ...      │  │
│  │ --session ...                │  │ --session ...            │  │
│  │ autoExit: false              │  │ autoExit: false          │  │
│  └──────────────────────────────┘  └──────────────────────────┘  │
│             │                               │                    │
│             │ NATS                          │ NATS               │
│             ▼                               ▼                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                  comms Hub (NATS)                      │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

**组件说明：**

- **agent-lifecycle**（`extensions/agent-lifecycle/index.ts`）：主扩展，注册 `agent_spawn` 和 `agent_kill` 两个工具；导出核心函数与共享状态供其他扩展直接调用（见 §8）。
- **lib/launch-script.ts**：构建启动脚本，写入临时目录并发送到 tmux window 执行（见 §7.1）。
- **lib/tmux.ts**：tmux 底层操作封装——`checkTmux()`（校验环境）、`tmuxNewWindow()`（在 spawner 所在 session 中创建新窗口）、`tmuxSendScript()`（发送脚本到窗口）、`tmuxKillWindow()`（关闭窗口，见 §7.2）。
- **role-context**（`lib/role-context/` + `role-context.ts`）：独立组件——agent-lifecycle 只导入使用（模板、fork、`--role` 注入），见 docs/2。

---

## 3. 启动方式

```bash
# 入口扩展,comms 由其清单自动加载
pi -e extensions/agent-lifecycle
```

> **前置条件**：必须在 tmux 会话内运行（`TMUX_PANE` 环境变量存在）。

---

## 4. 完整 LLM 工作流

agent-lifecycle 本身不发送消息——spawn 后的通信由 LLM 调用 comms 工具完成。一个典型的使用流程：

```
LLM → agent_spawn(name="worker")           # lifecycle: 创建 tmux window
LLM → comms_list_peer                        # 确认 agent 已上线
LLM → comms_send(target="worker", ..., remind_s=300)  # 发送初始消息,每 300 秒开启周期提醒
LLM → comms_outbox(msg_id)              # 查询回复(worker 用 send+reply_to_msg_id 显式回复)
LLM → agent_kill(name="worker")            # lifecycle: 关闭 window
```

> **参数形态**：`agent_spawn` 接收 `llmContext` 自包含的上下文对象——TP 场景由 `executeAgentSpawnByRole` 内部经 `llmContextFromRole()`（docs/2 §3）生成；LLM 直调时直接构造 `{ systemPrompt }`（schema 见 §5.1）。spawn 后初始消息由 LLM 通过 comms 工具发送。`llmContext.context` 控制会话来源：默认 `"fresh"`（干净会话）；显式 `"fork"` 时继承 spawner 自己的会话（裁剪到最后一个委派消息之前），子 agent 只获得任务背景、看不到委派对话（细节见 §5.1 与 docs/2 §4）——**不要**用 fork 去 spawn 一个不同人格的 agent，继承的历史会与新 system prompt 矛盾。

> **autoExit 参数**（可选，默认 `false`）：仅对**非常简单的单轮任务**（单次问答、无需等待外部回复）显式传 `autoExit: true`，agent 完成后自动退出。多轮交互、需要等待回复的 agent 一律不传——即使开启，auto-exit.ts 的 pending 防线也会在 agent 仍有未决 send 时阻止退出。

---

## 5. 工具列表

agent-lifecycle 提供 **2 个工具**：

### 5.1 `agent_spawn` — 启动 agent

- **用途**：在 tmux 窗口中启动一个独立的 Pi agent 进程，自动连接 comms Hub。
- **参数**：
  - `name`（string，必填）：agent 名称，同时作为 `--cname` 传入。
  - `llmContext`（LLMContext，必填）：自包含的初始 LLM 上下文。
    - `systemPrompt`（可选）：agent 的 system prompt（`--system-prompt` 标志）。
    - `messages`（可选）：初始对话消息，经 pi `SessionManager`（`writePreloadedSessionFile`）写入 session JSONL。`context: "fork"` 时忽略。
    - `context`（可选，`"fresh" | "fork"`，默认 `"fresh"`）：会话来源——`"fresh"` 干净会话（空自举或预载 messages）；`"fork"` 分支 spawner 自己的会话（`SessionManager.createBranchedSession`），裁剪到最后一个 `comms-inbound` 委派消息之前，子 agent 继承任务背景、看不到委派对话（`messages` 忽略，任务经 comms_send 送达）。
    - `role`（可选）：角色模板名（`--role` 标志，如 scout, worker），由 `llmContextFromRole()` 内部设置。
    - `tools`（可选，string[]）：**完整工具白名单**，覆盖角色 `defaultTools`（`--role-tools` 标志）——设置后仅这些工具激活；省略时用角色模板的 `defaultTools`。
  - `model`（string，可选）：模型覆盖。默认使用调用者的 model，无则省略 `--model` 标志（不传空串），让 pi 自行选择默认模型。
- **LLM 直接调用时的 schema**：LLM 通过工具调用 `agent_spawn` 时，`llmContext` 暴露 `systemPrompt` / `messages` / `context` / `skills` / `extensions` / `tools` 字段；`role` 仅通过 `llmContextFromRole()` 在代码侧注入。
- **上下文生成**：LLM 直调 `agent_spawn` 时直接构造 `llmContext: { systemPrompt: "..." }`——agent 的第一轮由到达的首条 comms 消息触发（comms_send 送达即触发 turn），无需初始 user 消息，任务在 spawn 后经 comms_send 送达（代码侧角色模板上下文见 §4）。
- **行为**：
  1. 校验 tmux 环境（`checkTmux()`）
  2. 通过 `interpolate(SESSION_PATH, ...)` 构建 session 文件路径（fresh 保留稳定名 `<stem>-<hash>.json`）
  3. **Session 文件三分支**（fork / 预载细节见 docs/2 §4）：
     - `context: "fork"` → `forkSession()` 分支 spawner 会话（`<ts>_<uuid>.jsonl`，由库生成）；整个活跃路径都是委派流量（无历史可继承）时回退空文件自举
     - `messages` 非空 → `writePreloadedSessionFile()`（SessionManager 预载，保留稳定路径）
     - 否则写空文件让 pi 自行初始化
  4. **Dedupe 检查**——`moduleAgents` 中已有同名则报错（在任何文件创建之前；fork 也不触碰现有 session 文件）
  5. 创建 tmux 窗口（`tmuxNewWindow()`，先解析 spawner pane 所在 session，再在其中 `new-window`）
  6. 构建启动脚本（含 `--system-prompt`、`--role` 等）并发送
  7. **Auto-cleanup**：任何步骤失败 → 自动 kill window + 清除 Map 状态 + 重新抛异常
  8. **最终名确认**：spawned agent 注册到 comms 后，其**最终注册名**（名字冲突时可能被自动后缀，如 `scout` → `scout2`）以资料形式出现在注册表——spawner（如 Teammate Provider）通过 `comms_list_peer` 读资料确认最终名，后续寻址务必使用这个最终名，而不是 spawn 前请求的名字
- **返回值**：agent 名称、tmux window ID、session 文件路径、状态（fork 时附 `forked/trimmed/fullInherit` 标记）。

### 5.2 `agent_kill` — 停止 agent

- **用途**：关闭由 `agent_spawn` 启动的 agent 的 tmux 窗口。
- **参数**：
  - `name`（string，必填）：要停止的 agent 名称。
- **行为**：
  1. 在模块级 `moduleAgents` Map 中查找 agent
  2. 如果未找到，返回提示（可能已被 kill 或由其他 session 管理）
  3. 调用 `tmuxKillWindow()` 关闭窗口（window 已死则静默忽略）
  4. 从 `moduleAgents` 中移除状态记录
- **注意**：agent 从 comms 的注销由 comms 断线机制自动处理（心跳停止 → 名字租约释放、状态推导 offline，见 docs/1 §9），agent_kill 不需要手动注销。

---

## 6. 生命周期事件

### session_start

- 确保 `.pi/agent-sessions/` 目录存在。

### session_shutdown

- 遍历 `moduleAgents`，逐一 `tmuxKillWindow()` 关闭窗口
- 清空 `moduleAgents` Map
- 采用 best-effort 方式——单个 window kill 失败不影响其他 window 的清理

---

## 7. 支持库

### 7.1 lib/launch-script.ts

构建并发送 agent 启动脚本。

**`buildLaunchScript(params)`** 生成的脚本结构：

```bash
#!/bin/bash
set -e
cd <project_dir>
export PI_AGENT_AUTO_EXIT=1        # 仅在 autoExit: true 时（默认 false；仅非常简单的单轮任务开启）
export PI_AGENT_NAME="<name>"
exec pi \
  -e extensions/comms.ts \
  -e extensions/role-context.ts \
  -e extensions/auto-exit.ts \
  --skill <project>/.pi/skills \
  --cname '<name>' \
  --subnet '<subnet>' \                 # 通信域，继承 spawner 的 --subnet（未指定则省略）
  --system-prompt '<system_prompt>' \   # 角色的 system prompt 内容
  --role '<role>' \                     # 角色模板名（如 scout, worker）
  --model '<provider/model>' \
  --session '<session_file>'
```

角色声明的 `skills:`/`extensions:` 与 spawner 的 `--role-dir` 按需追加：`-e <role-extension>` 排在
插件链之后、`--skill <role-skill-path>` 追加在项目 `.pi/skills` 之后（均只出现在角色声明时），
`--role-dir <abs>` 随 subnet 一组（只在 spawner 带该 flag 时出现）。

**能力覆盖（add/exclude）**：`--role-tools <csv>`（完整工具白名单，覆盖角色 `defaultTools`）只在
`executeAgentSpawnByRole` 收到 `addTools`/`excludeTools`（teammate-provider 的 `add_tools`/`exclude_tools`）
或显式 `tools` 时出现；spawn 时的额外 skills/extensions（`addSkills`/`addExtensions`，除角色声明外追加）
与 `excludeSkills`/`excludeExtensions`（跳过角色声明 skills/extensions）也在 agent-lifecycle 侧解析合并后以
`--skill`/`-e` 发出——docs/4 §4.1、docs/2 §5。

关键设计：
- 使用 `exec pi` 替换 bash 进程，使 pi 退出时 tmux window 自动关闭
- `--role`、`--system-prompt` 标志使 spawned agent 自带身份和上下文（spawn 路径已带插值模板作为 `--system-prompt`，role-context 的注入守卫跳过，不会双注入——见 docs/2 §5）
- **subnet 继承**：spawner 通过 `--subnet` 加入的通信域会透传给 spawned agent（`subnetFromArgv` 扫描 spawner 进程 argv）——否则 spawn 的 agent 会落到默认 subnet，与 spawner 互不可见
- **能力透传**：角色 frontmatter 声明的 `skills:`/`extensions:`（docs/2 §2.2）经 LLMContext 追加为 `--skill`/`-e`——agent 自带角色所需的外部能力；解析不到的引用由 spawner 侧警告跳过（details 的 `capabilityWarnings` 可见）
- **role-dir 继承**：spawner 的 `--role-dir` 被绝对化后透传给 spawned agent（`roleDirsFromArgv`），其 role-context 工具白名单与 spawner 命中同一外部模板
- `--model` 仅在提供了 model 时才出现——未指定时启动脚本**省略该标志**（不传空串），让 pi 自行选择默认模型；有 model 时优先使用调用者的 model
- **不传 `--name`**：comms 拥有会话名——boot 认领基础名 `cname`，由 profile 的 `current_task` 驱动（`task_start` 设标题、`task_submit_report` 清空，见 docs/1 §6.6 与 docs/5 §3）；`dispatch` / `complete` / `block` / `cancel` 等管理动作不改变会话名；手动 `--name` / `/name` 永远优先，自动命名不再覆盖

**`writeAndSendScript(windowId, params)`**：
1. 将脚本写入 `$TMPDIR/pi-agent-lifecycle/launch-<name>.sh`（权限 0755）
2. 通过 `tmux send-keys` 发送 `exec bash <script_path>` 到目标 window

### 7.2 lib/tmux.ts

底层 tmux 操作封装。

| 函数 | 说明 |
|------|------|
| `checkTmux()` | 检查 `TMUX_PANE` 环境变量，不在 tmux 中则抛出错误；返回 parent pane ID（用于解析 session） |
| `tmuxNewWindow(cwd, parentPane)` | 先 `tmux display-message -p -F '#{session_id}'` 解析 parentPane 所在 session，再 `tmux new-window -d -t <session>` 创建新窗口，返回 window ID（如 `@42`） |
| `tmuxSendScript(windowId, scriptPath)` | 通过 `tmux send-keys` 向窗口发送命令 |
| `tmuxKillWindow(windowId)` | 调用 `tmux kill-window`，window 已死则静默忽略 |

> lib/role-context/（template.ts、fork.ts、roles/）与 role-context.ts 的详细设计见 docs/2——agent-lifecycle 只导入使用，不重复实现。

---

## 8. 模块级状态与导出函数

### 8.1 共享状态

```typescript
// agent-lifecycle/index.ts — 模块级 Map，在扩展实例和导出函数间共享
const moduleAgents = new Map<string, AgentState>();

interface AgentState {
  name: string;         // agent 名称
  windowId: string;      // tmux window ID
  sessionFile: string;   // session .json 文件路径
  status: "spawning" | "online" | "offline" | "error";
  startedAt: string;     // ISO 时间戳
}
```

- 状态存储在模块级 `Map<string, AgentState>`（key 为 agent 名称小写）
- 无论通过工具注册的 `agent_spawn` 还是模块函数 `executeAgentSpawn` spawn 的 agent，都写入同一个 `moduleAgents`
- `session_shutdown` 时遍历 `moduleAgents` kill 所有 window——无论谁 spawn 的（§6）
- 状态由 comms 推导（资料 `last_seen_at` → `online` / `offline`，见 docs/1 §2.3），agent-lifecycle 本身不轮询更新

**spawn manifest（持久化的 spawn 配方）**：`moduleAgents` 只记 name/windowId/sessionFile/status，**不记 role/tools/skills/extensions/model**——`executeAgentRestart` 恢复 agent 时需要重建这些（同名 agent 重启必须复现同样的工具白名单与能力）。因此每次成功 spawn 时把完整配方写入 `.pi/agent-sessions/<agentFileStem(name)>.manifest.json`（`{ name, role, model, tools, skills, extensions, sessionFile }`），重启时读取它重建。write 是 best-effort（失败只使恢复-by-配方不可用，不影响 spawn 本身）。

### 8.2 导出函数（供其他扩展直接调用）

`agent-lifecycle` 不仅注册工具，还**导出**核心函数供其他扩展直接导入：

| 函数 | 签名 | 用途 |
|------|------|------|
| `executeAgentSpawn(params, cwd, ctx)` | `→ Promise<SpawnResult>` | 核心 spawn 逻辑（接收 LLMContext；`params.resumeFrom` 为**恢复**现有 session 文件——reopen 某个已存在的 JSONL，不截断，pi 直接续传转录） |
| `executeAgentSpawnByRole(params, cwd, ctx)` | `→ Promise<SpawnResult>` | **role-aware spawn**：角色验证 → 去重命名 → `llmContextFromRole` → 应用能力覆盖（`addTools`/`excludeTools`/`addSkills`/`excludeSkills`/`addExtensions`/`excludeExtensions`）→ spawn——teammate-provider 的 `tp_spawn_agent` 只调用它（参数见 docs/4 §4.1） |
| `executeAgentRestart(params, cwd, ctx)` | `→ Promise<SpawnResult>` | **恢复死掉的 agent**：读 spawn manifest（role/tools/skills/extensions/model）→ kill 残留 window/状态 → 用 `resumeFrom` 指向已记录的 `execution_session` JSONL 重新 spawn 同名 agent（上下文保留）→ 重启后**不写 session 文件**、不改文件名（重命名字稳定，comms consumer 复用）——teammate-provider 的 `tp_restart_agent` 调用它 |
| `executeAgentKill(params)` | `→ SpawnResult` | 核心 kill 逻辑 |
| `listRoleNames` / `buildRoleCatalog` / `interpolate` | 转发自 lib/role-context | 角色查询——TP 构建自身 prompt 与工具描述时使用 |

角色/上下文底层函数（`llmContextFromRole`、`getRoleTemplate` 等）位于 role-context 组件（docs/2 §3），**仅**由 agent-lifecycle 直接导入；teammate-provider 通过 agent-lifecycle 的导出获取角色能力，不直接触碰 lib。

**为何导出而非通过工具调用**：Pi 没有 `pi.api.getTool()` API 用于跨扩展调用工具。teammate-provider 通过 `import { executeAgentSpawnByRole } from "./agent-lifecycle"` 直接导入并作为 TypeScript 函数调用。

---

## 9. 错误处理

- **不在 tmux 中**：`checkTmux()` 抛出明确错误，引导用户先启动 tmux 会话
- **同名 agent 已存在**：`executeAgentSpawn` 抛出错误，提示先 `agent_kill`（`executeAgentSpawnByRole` 的默认命名先去重，通常不触发）
- **未知角色**：`executeAgentSpawnByRole` 返回 error result（`details.error = "Unknown role"` + 可用角色列表），不抛错、不 spawn
- **能力解析失败**：角色的 `skills:`/`extensions:` 声明解析不到 → 警告并跳过（spawn 继续）；spawn 结果 `details` 携带 `skills`/`extensions`/`capabilityWarnings` 供调用方察觉（docs/2 §2.2）
- **Spawn 失败 auto-cleanup**：任何步骤失败 → 自动 kill window + 清除 Map 状态 + 重新抛异常（不残留僵尸 window；见 §5.1 行为 7）
- **kill 不存在的 agent**：返回提示信息，不抛错（幂等设计）
- **tmux 操作失败**：`tmuxKillWindow` 静默忽略 window 已死的情况；`tmuxNewWindow` 异常会向上传播
- **shutdown 清理**：best-effort，单个失败不影响其他
