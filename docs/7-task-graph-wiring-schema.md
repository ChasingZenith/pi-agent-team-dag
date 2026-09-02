# 任务图接线(结构版本拆分 + into_* 原子接线)

> 本文描述该特性的**目标形态**(已随之落地于 `lib/tasks/store.ts` 与 `task-graph.ts`),不描述改动过程。
> 目的:消除「先存在后引用」带来的接线锁;让「子节点声明挂到哪个父、父 re-commit 接线」成为一次原子提交;并让**接线只作用于图结构、不干扰正在负责该节点的契约消费方**。

---

## 1. 问题与目标

- **现状锁**:`deps`/`subgraph_deps` 引用一个不存在的目标时,`task_commit` 直接拒绝 → 被迫「先建叶子(孤儿)、再反向接线」,产生一段混乱的中间状态;`info_refs` 同理要求源先存在。
- **核心矛盾**:当前 `version` 一肩挑两件事 —— ① 内容契约锚点(worker 用 `expected_version` 检测「干活期间契约漂移」);② 图结构版本(「有人动了 deps」)。接线是**纯结构变化**(子图里多一个节点,父的 description 契约未动),却因为「deps 变化 bump version」而**推高内容契约版本**,导致手上握着 `expected_version=V` 的 coordinator 被迫重读、report 被拒。
- **目标**:① 用「子声明+父 re-commit」反转写入方向,消掉 forward-ref 锁(容器先建,良序);② 把**图结构**从**内容契约版本**里剥出来,接线不干扰契约消费方;③ 保持父的 `deps`/`subgraph_deps` 为**唯一真边**(子节点不存归属),graph 语义与孤儿判定零改动。

---

## 2. 核心概念

### 2.1 两种变化的严格区分

| 变化 | 是否影响 worker 契约 | 归属哪个版本 |
|---|---|---|
| `title` / `description` / `kind` / `info_refs` | 是(worker 按其实现/交付) | **内容版本** |
| `deps` / `subgraph_deps`(含 `into_*` 接线) | 否(描述未动,只多/少一个子图节点) | **结构版本** |

一切图结构推导(父是否 done、子是否 ready、gate 是否作用、孤儿判定)本就是**读时基于 live 状态重算**(`effectiveDeps` / `readySet` / `unlockedBy` / `orphanItems`),**不依赖任何版本号**——所以接线无需靠版本才能生效,只需靠版本做**写入并发控制**。

### 2.2 两个版本字段(并存)

| 字段 | 类型 | 何时 +1 | 用来做 |
|---|---|---|---|
| `version`(**内容版本**,沿用现有字段,语义收窄) | number | `title` / `description` / `kind` / `info_refs` 变化(每次内容 `task_commit`) | `task_commit` / `task_submit_report` 的 `expected_version` 乐观并发锚点;确定快照 `history/<id>.v<N>/`;`for_version` 报告锚定 |
| `struct_version`(**结构版本**,新增) | number | `deps` / `subgraph_deps` 变化(**含 `into_*` 接线导致的父 re-commit**) | 对**结构边数组**的写入并发控制(compare-and-swap);图完整性审计 |

- **接线只 bump `struct_version`,绝不 bump `version`**——这是本草案的核心。
- `version` 不再因 deps/subgraph_deps 变化而 +1;`expected_version`(commit/report/for_version)只锚内容契约 → **正在负责某父的 coordinator 不会因为「多挂了个子」而被迫重读**。
- 新增 `struct_version` 时,历史任务默认从 1 起(见 §7 迁移)。

---

## 3. 新提交指令:`into_deps` / `into_subgraph_deps`

### 3.1 位置与生命周期

这两个字段**只出现在 `task_commit` 的 metadata 草稿里**,作为本次提交的指令;**提交后即被消费,绝不写入子节点的 metadata**。它们声明的是「把本节点(id)追加进目标父的哪个数组」。

| 字段(仅 draft payload) | 类型 | 声明语义 | 物化到 |
|---|---|---|---|
| `into_deps` | string[] | 本节点**成为这些父的 deps 成员**(父等待本节点完成) | 各父的 `deps += <本节点 id>` |
| `into_subgraph_deps` | string[] | 本节点**成为这些模块子图的 gate**(模块及其子图等待本节点) | 各父的 `subgraph_deps += <本节点 id>` |

- 二者**正交且相互独立**;`into_deps` 把本节点作为**成员**,`into_subgraph_deps` 把本节点作为**外部 gate**——角色不同,故用两个词,不合并为模糊的 `attach_to`。
- 两者既可在**创建**新节点时声明,也可在**更新**已有节点时声明(例如把已有任务移挂到新父)。对已有成员/门重复声明是**幂等**(目标已有该 id 则不再追加,也**不视为变化**)。
- 子节点**自身**的 `deps` / `subgraph_deps`(它的前置依赖 / 它的门)与 `into_*` 完全独立、互不干扰。

### 3.2 校验(在子节点 commit 时,对「扩大后的父状态」做)

`into_*` 是真正改变图结构的时机,因此所有图校验必须**前移到子节点 commit 时**对着「父现有数组 + 新追加的本节点」这一**扩大后状态**进行:

1. **目标存在**:每个 `into_*` 目标父必须已存在(要 re-commit 它)。这是**良序**约束:先建容器(父),再让子声明加入 —— 顶层规划天然如此,无需 forward-ref 宽容。
2. **kind 合法性**:
   - `into_deps` 目标:不能是 `info`(info 无 deps);本节点自身不能是 `info`(info 是纯内容,不能作为依赖边)。
   - `into_subgraph_deps` 目标:必须是 `module`(只有 module 有子图可 gate);本节点自身不能是 `info`。
3. **环检测**:对「父(扩大后的 deps/subgraph_deps)+ 整张图」跑展开后的 DAG 检查。`into_subgraph_deps` 把本节点塞进父的子图门,若本节点已在父的子图内 ⇒ 自环,拒绝;互门/交叉环同样拒绝(同现有 `assertNoCycle`)。
4. **gate 约束**:`into_subgraph_deps` 的目标模块,其 `subgraph_deps` 门不得位于自身子图内(将其把本节点当门时检查);`into_deps` 追加成员不触发此约束,但要确保 expand 后无环。
5. **父终态拒绝**:接线目标父若处于 `done` / `cancelled`(终态)则拒绝(需先 reopen/undo)。**父处于 `pending` / `dispatched` / `active` / `blocked` 均可接线**——因为只 bump `struct_version`,不打扰内容契约消费方;且 `active` 允许接线是明确期望(靠结构版本解耦,不打断负责中的 coordinator)。

### 3.3 原子提交(子 + 接线父,一个逻辑提交)

子节点 commit 现在是「一个子 + 一个或多个父」的**多目标原子提交**:

1. **校验先行**:先完成 §3.2 全部校验(子自身内容校验 + 每个父扩大后的图校验),任何一项失败则**整个提交失败,不改任何文件**。
2. **无变化短路**:若 `into_*` 目标都已存在(幂等)且子自身也无内容变化 → 拒绝(防空版本)。
3. **归档再写**:先为被替换版本写快照(`history/<id>.v<N>/`,3 文件),再写新真本——保证旧版本先持久化、新版本后可见。
4. **写子**:子自己的 metadata + description.md(若内容变,`version` +1;若仅 `into_*` 无内容变化,`version` 不变)。
5. **写每个父**:父的 metadata 重写,`deps` / `subgraph_deps` 追加本节点 id,`struct_version` +1,置 `struct_changed_at`(见 §5);父的 `version` / description.md / report.md **不动**。
6. **删除已消费草稿**(子自身的草稿)。

**失败回滚语义**:单文件写入仍是 `tmp + rename`(原子);多文件之间的「部分写坏」由 §4 的写入互斥尽量规避,且图结构永远读 live 状态导致最坏情形是「接了一半的父」,仍可读、可重试(wiring 幂等),通过下一轮接线或显式 `task_wire` 收敛。

---

## 4. 写入并发(接线到同一父)

两个子并发往同一父接线,各自 `read-modify-write` 父的 toml → 后写覆盖先写,丢一个子。本草案采用**不引入图级写锁**的乐观并发模型,与现有纯乐观并发风格保持一致。

### per-父 乐观并发(`struct_version` compare-and-swap)
- **不加全局锁**;每个父的 re-commit 用 `struct_version` 做 compare-and-swap:
  1. 写前**重读**父当前数组与 `struct_version`(不用提交开始时读到的快照);
  2. 计算新数组 = 父当前数组 ∪ {本节点 id};
  3. 若重读到的 `struct_version` 与「本次提交开始读取父时」记录的 `struct_version` 不同 → 说明已有他人接线,则**重试**(重读、重新计算追加、再写);
  4. 否则写回,`struct_version` +1。
- 因每次 re-commit 都基于**写时重读**而非旧快照,且追加是**幂等并集**(`∪ {id}`),两个子并发时会有一个重试并通过,不会静默丢子。
- **与内容 commit 的竞态**:内容提交(改 `version`)与接线(改 `struct_version`)若在同一父上几乎同时发生,两者都是整文件 toml 的 last-writer-wins→ 后写覆盖先前改变量的可能性低但存在。接受该额度(内容变与结构变同时作用于同一父、且几乎同时发生,概率极低);此竞态会通过 `task_read` 的完整性/hash 告警暴露,且接线幂等可重试,不会造成不可修复的丢边。

---

## 5. 软信号:父的结构已变(不强制重读)

拆版本后,握有旧 `content_version` 的 coordinator**不会**因为「多了一个兄弟子」被强制重审。为使结构变化**可感知但不打断**:

- 父 metadata 新增 `struct_changed_at: string`(ISO)——每次 `struct_version` +1 时更新。
- 父的 `history` 追加一条摘要:`changed_items=["subgraph"]`、`event="wiring"`、`version` = 当前内容版本(不变)、`change_summary` 说明接线了哪个子。
- `task_read` 把 `struct_changed_at` 作为**软提示**展示(如 `subgraph changed (struct v2) @ <time>)`);coordinator 何时重读由它自己决定。**因为父 done 判定是 live 的(会自动等新接线进来的子),coordinator 只是「晚知道」,不会「做错」**。

> 明确**不**选「deps 变化就冲突内容版本」的硬信号——那正是要解决的问题。

---

## 6. 对现有字段与语义的影响

| 现有字段/语义 | 改动 |
|---|---|
| `version` | 语义收窄为**内容版本**;不再因 deps/subgraph_deps 变化 +1 |
| `expected_version` | 只锚**内容版本**;`into_*` 接线不触发它 |
| `for_version`(report) | 只锚内容版本;接线后旧报告锚仍有效(契约未漂移) |
| `deps` / `subgraph_deps` | **仍是唯一真边**,仅存在父上;接线由 `into_*` 在父上原子追加 |
| `orphanItems` / `validateGraph` | **零改动**——仍基于父的真边(接线后父的数组已含本节点,自然不再孤儿/不悬空) |
| `effectiveDeps` / `readySet` / `unlockedBy` | **零改动**——读 live 状态,接线自动生效 |
| `resolveKind`(unit 不能带 subgraph_deps,info 各类约束) | 保持不变;`into_*` 补一条:目标/本节点要满足 §3.2 的 kind 约束 |
| 草稿 metadata PATCH | 新增可写字段 `into_deps` / `into_subgraph_deps`(**只用于本次提交后即丢弃,不入库**) |

---

## 7. 数据演进

- 新增 `struct_version` / `struct_changed_at`:存量任务缺省 `struct_version = 1`、`struct_changed_at = created_at`(或空);不做数据迁移、不强制回填,缺失时按 1 处理。
- `history` 条目若含有 `struct_version` 相关的写入,保持 `version` 字段只存内容版本。
- 现有 `expected_version` 校验逻辑不变,只是其参照的字段不再被接线推高。

---

## 8. 工具接口变化(草案)

| 工具 | 变化 |
|---|---|
| `task_commit` | metadata 草稿新增可写 `into_deps` / `into_subgraph_deps`;执行「子 + 接线父」原子提交(§3.3);`expected_version` 只针对子自身内容版本;父 re-commit 走 `struct_version` CAS(§4)。不入 `task_wire` |
| `task_read` | 展示 `struct_changed_at`(软提示,自动伴随提示);`version` 字段沿用内容版本 |
| `task_render` / `task_list` | 不变(父的数组即真边);`struct_changed_at` 可选择性标注 |

---

## 9. 评审要点(已确认)

1. **并发模型**:不引入图级写锁,采用 per-父 `struct_version` compare-and-swap(§4)。
2. **父 `active` 允许接线**:确认期望(结构版本解耦,不打断负责中的 coordinator)。
3. **`into_*` 允许在「更新已有节点」时用**:确认除创建外也支持(移挂已有任务)。
4. **`struct_changed_at` 配合 `task_read` 自动提示**:确认软信号做成自动伴随提示。
5. **不引入 `task_wire`**:确认;「父先存、子后到」的补接线依赖 `into_*` 在后续子 commit 里天然覆盖。
