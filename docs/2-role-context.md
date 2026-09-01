# Role Context — 角色模板与上下文

---

## 1. 概述

**role-context** 是 Pi Coding Agent 的独立扩展，提供角色模板与上下文构建能力：`--role` flag、角色模板注入、LLMContext 构建、session 创建/fork。它是 agent 身份与上下文的基础——**不通信、不 spawn、不编排**。

**核心特性：**

- `--role` flag + `before_agent_start` 角色模板注入（交互式启动路径；spawn 路径由 launch script 传 `--system-prompt` 承担）
- 声明式角色模板：YAML frontmatter + Markdown，`{{}}` 插值与 `{{include:...}}` 内联协议
- **外部角色目录**：模板不限于插件内置 `roles/`，可按优先级从 `--role-dir`、`.pi/roles/`、`~/.pi/agent/roles/` 加载（§2.1）
- **能力声明**：角色 frontmatter 声明 `skills:` / `extensions:`，spawn 时经 launch script 自动传出（§2.2）
- `llmContextFromRole()` 从角色模板构建 LLMContext——agent-lifecycle 的 role-aware spawn 使用
- session 创建/fork 全部委托 pi 官方 `SessionManager`（fork.ts），不手写 JSONL
- **零依赖**：不依赖 comms / tasks，可被任何扩展独立导入

**文件清单：**

```
extensions/
├── role-context.ts                # 扩展入口：--role flag + before_agent_start 角色注入
└── lib/role-context/
    ├── template.ts                # 声明式模板：LLMContext、插值、llmContextFromRole
    ├── fork.ts                    # SessionManager 驱动的 session 创建/fork
    └── roles/                     # 角色模板目录
        ├── manager/
        │   ├── coordinator.md
        │   └── teammate-provider.md
        └── specialist/
            ├── requirements-clarifier.md
            ├── planner.md
            ├── worker.md
            ├── scout.md
            ├── web-searcher.md
            ├── experts-reviewer.md
            └── consultor.md
```

---

## 2. 角色模板格式

每个 `<role>.md` 是 YAML frontmatter + Markdown，按语义分类存放于 `roles/manager/`（管理节点：coordinator、teammate-provider）与 `roles/specialist/`（领域专家）；`{{include:...}}` 用于内联共享协议片段：

```markdown
---
role: scout
label: Scout
description: Fast, read-only local codebase exploration...
defaultTools: read,grep,find,ls
---
You are {{cname}}...
```

占位符在 spawn 时替换：`{{cname}}`（agent 的 comms 名，即 `--cname`）。工具白名单由 `defaultTools` 经 role-context 的 `setActiveTools` 强制执行，工具描述由 pi 自身的工具注入机制提供——模板不再重复罗列工具清单。

### 2.1 模板加载优先级

内置 `roles/` 是默认 catalog；外部目录中的同名 role 完全替换内置版本（首个命中者胜，不做字段级合并），新增角色并入 catalog（`listRoleNames` / `buildRoleCatalog`，供 Teammate Provider 选择 spawn）：

```
--role-dir <path>（可重复，按出现顺序，最高）
<cwd>/.pi/roles              项目级（可 git 提交、团队共享）
~/.pi/agent/roles           用户级（跨项目共用）
内置 extensions/lib/role-context/roles/   （fallback，恒在最后）
```

- 相对 `--role-dir` 以进程 cwd 为基准；spawn 的 agent 经 launch script 继承绝对化的 `--role-dir`，与 spawner 解析同一 catalog（工具白名单一致）
- 不存在的 `--role-dir` 目录会被跳过并警告（防拼写错误静默回落到内置）；项目/用户级目录缺失是常态，不警告
- 模板加载为进程级缓存：会话中途新增角色文件不会热更新（重启/重载生效）
- `{{include:...}}` 片段只从引用文件所在目录解析——外部角色若需片段，请把片段放在同一目录

### 2.2 能力声明（skills / extensions）

角色 frontmatter 可声明 spawn 时自动传递的外部能力：

```markdown
---
role: web-searcher
defaultTools: read,web_search,web_fetch,comms_send,bash
skills: playwright-cli,bx,/abs/path-to-skill,~/mine
extensions: /abs/path/to/ext.ts,./rel-to-cwd/ext.ts
---
```

- **`skills:`** 裸名按 pi 的 skill 位置顺序查找并绝对化（`<cwd>/.pi/skills/<name>`、
  `<cwd>/.agents/skills/<name>`、`~/.pi/agent/skills/<name>`、`~/.agents/skills/<name>`；同名位置
  优先 `<name>/SKILL.md` 目录、其次 `<name>.md`）；`/`、`~` 开头的字面量路径原样使用
- **`extensions:`** 相对路径以 spawner cwd 为基准，`~` 前缀展开为 home；缺失的文件/目录被跳过
- **解析不到的引用警告并跳过**（spawn 继续）：警告进入角色模板的 `capabilityWarnings`（spawn 结果
  details 可见）并写 `role-context` 审计条目（`capability_skip`），提醒角色作者修正
- 声明 `extensions:` 时，该扩展注册的工具名**必须出现在同一角色的 `defaultTools` 中**——否则
  role-context 的工具白名单（替换语义）会将其移除，扩展能力不可用
- 简化 frontmatter 解析器的限制：`skills:`/`extensions:` 必须是单行逗号分隔列表（无引号包裹、
  无换行续行、值内不得含逗号）

---

## 3. 能力函数（lib/role-context/template.ts）

**声明式 agent 上下文模板**——不使用命令式逻辑。

**导出：**

| 函数 | 说明 |
|------|------|
| `interpolate(template, vars)` | 通用 `{{}}` 插值——替换模板中的占位符 |
| `SESSION_PATH` | 模板常量：`"{{sessionDir}}/{{agentName}}.json"` |
| `parseAgentFile(path)` | 解析单个 agent .md 文件 |
| `scanAgentDirs(cwd)` | 扫描 `.pi/agents/`、`agents/`、`.claude/agents/` |
| `roleDirsFromArgv(argv)` | 收集 argv 中全部 `--role-dir`（可重复，两种写法均可） |
| `resolveRoleDirs(opts?)` | 按优先级合并角色目录（`--role-dir` → `.pi/roles` → `~/.pi/agent/roles` → 内置），绝对化、去重、剔除缺失目录 |
| `loadRoleTemplates(opts?)` | 递归加载全部角色目录中的模板（内置 + 外部，同名首胜），展开 `{{include:...}}` 共享协议片段并按 frontmatter 解析能力声明 |
| `resolveSkillPath(ref, opts)` | skill 名/字面量 → 绝对路径（§2.2 查找顺序），无命中返回 null |
| `resolveExtensionPath(ref, cwd)` | 扩展引用 → 绝对路径（相对路径以 cwd 为基准），不存在返回 null |
| `setRoleWarn(fn)` / `roleWarn(msg)` | 能力/目录解析警告 writer（默认 console.warn；扩展入口安装为审计条目 `capability_skip`） |
| `getRoleTemplate(role)` | 按名查找角色模板 |
| `listRoleNames()` | 返回有序的角色名列表 |
| `buildRoleCatalog()` | 生成可嵌入 system prompt 的角色目录 |
| `buildAgentPrompt(role, name)` | 从角色模板构建完整的 agent system prompt |
| `llmContextFromRole(role, name)` | 从角色模板构建 LLMContext（含 skills/extensions 能力字段） |

**类型：**

```typescript
interface AgentDef { name, description, tools, systemPrompt, role?, file }
interface RoleTemplate {
  role, label, description, defaultTools, buildSystemPrompt(),
  skillPaths: string[],          // skills: 声明解析出的绝对路径
  extensionPaths: string[],      // extensions: 声明解析出的绝对路径
  capabilityWarnings: string[],  // 解析失败的能力引用（跳过并警告）
}
interface LLMContext {
  systemPrompt?, messages?({ role, content }[]), role?,
  context?: "fresh" | "fork",    // 默认 "fresh"；"fork" 继承 spawner 会话并裁剪委派尾巴
  skills?: string[],             // 绝对路径，spawn 时作为 --skill（可重复）
  extensions?: string[],         // 绝对路径，spawn 时作为 -e（可重复）
  tools?: string[],              // 完整工具白名单（可选）；覆盖角色 defaultTools，spawn 时作为 --role-tools
}
```

**LLMContext 生成**：上下文来源（`context` 字段）由调用方显式设置，默认 fresh。`llmContextFromRole()` 生成干净的模板 system prompt，不预载任务——任务在 spawn 后由 comms_send 发送。

---

## 4. Session 创建/fork（lib/role-context/fork.ts）

**Session 创建/fork 模块（零 pi 依赖）**。格式工作（header、id/parentId 链、model/thinking 条目）全部委托 pi 官方 `SessionManager`（运行时解析实例构造器，测试注入 fake engine）。本模块只做 pi 不做的部分：裁剪定位、fallback 落盘、Anthropic thinking 清洗。

**导出：**

| 函数/类型 | 说明 |
|----------|------|
| `forkSession(parent, sessionDir, opts?)` | 分支 spawner 自己的会话：`SessionManager.open(父文件)` → `createBranchedSession(裁剪目标)` → `--session` 传给子进程。返回 `{ sessionFile, trimmed, fullInherit, materializedByFallback }`，或 `null`（整个活跃路径都是委派流量，无可继承） |
| `findForkTargetId(entries, leafId)` | 纯函数：从 leaf 沿 parentId 回溯，找最后一个 `comms-inbound` 的前驱（连续 inbound 一并跳过）；无 inbound → leafId（完整继承）；无 message 历史 → null |
| `writePreloadedSessionFile(filePath, input, engine)` | fresh 预载：`SessionManager.open(路径)`（不存在路径 → newSession 固定到该路径）→ `appendModelChange` → `appendThinkingLevelChange` → 逐条 `appendMessage`；无 assistant 消息不落盘时用 `getHeader()+getEntries()` 序列化 + tmp/rename 原子替换 |
| `sanitizeUnsafeThinkingBlocks(entries)` | Anthropic 专属（redacted/signed thinking 块）清洗——deepseek `reasoning_content` 会被 pi 原生 round-trip，不处理 |
| `DELEGATION_CUSTOM_TYPE` | `"comms-inbound"`——委派对话标记（comms.ts 的 injector customType） |

**fork 语义**：子 agent 继承**委派对话之前**的任务背景（继承的 `comms-log` 审计条目对 LLM 上下文无贡献——pi 对 `type:"custom"` 返回空上下文）。fork 文件由库生成，落在 `sessionDir`（与父文件同目录）。

---

## 5. `--role` 注入入口（role-context.ts）

扩展入口：注册 `--role` 与 `--role-dir` flag，`before_agent_start` 时把角色模板**链式追加**到现有 system prompt（交互式启动路径；spawn 路径由 launch script 传 `--system-prompt` 承担）。规则：

- 显式 `--system-prompt`（含 spawn 路径传入的插值模板）优先，不会被模板覆盖
- 未知名 role 不注入 prompt（boot 不报错）；注入/跳过均有 `role-context` 审计条目可查
- `--role` 不写入注册资料——comms 纯通信，peer 列表不显示角色标签
- `--role-dir` 为外部角色目录（§2.1），从 argv 直接读取（与 `--subnet` 同模式，不依赖 `pi.getFlag`）
- `--role-tools`（csv）为**完整工具白名单**：存在时**完全覆盖**角色的 `defaultTools`（否则用 `defaultTools` 经 `setActiveTools` 强制）。该标志由 agent-lifecycle 在 spawn 时计算一次（`defaultTools − exclude ∪ add`，来自 teammate-provider 的 `add_tools`/`exclude_tools`，docs/4 §4.1），spawned pi 只负责照单执行——白名单计算不落在 role-context 侧

---

## 6. 使用与关联

- **agent-lifecycle**（docs/3）：`executeAgentSpawnByRole` 内部经 `llmContextFromRole()` 构建上下文（docs/3 §8.2）；`executeAgentSpawn` 的 session 三分支使用 `forkSession` / `writePreloadedSessionFile`（docs/3 §5.1）；并向 teammate-provider 转发 `listRoleNames` / `buildRoleCatalog` / `getRoleTemplate` / `interpolate`
- **spawn 路径**：launch script 传插值后的 `--system-prompt`，注入守卫跳过，不双注入（docs/3 §7.1）
- **Teammate Provider**（docs/4）：经 agent-lifecycle 获取角色能力，不直接触碰本组件
- 组件间装配与协作见 docs/0-overview §4
