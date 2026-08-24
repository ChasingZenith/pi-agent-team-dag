# Tasks 网页前端

task 图(DAG)的可视化网页:依赖图、状态着色、派生语义展示、实时刷新。前后端分离:独立的 API 服务(`server/`)与独立的 Svelte 前端(`web/`),浏览器只通过 `/api/*` 访问 API。

## 架构

```
web/  Svelte 5 + Vite + Svelte Flow (SPA, 纯前端)
  │  fetch / SSE (vite dev 时由 proxy 转发)
server/  Hono (Bun) — 只读 API
  │  直接复用 extensions/lib/tasks/{store,graph}.ts(纯模块,零 pi 依赖)
  ▼
<root>/.pi/tasks/<id>.json   ← agent 团队 (pi 会话) 在写同一份数据
```

- 派生语义(ready set、missing deps、dependents、环/悬空警告)全部在 server 端计算,前端只渲染,不重复实现图逻辑。
- `GET /api/events`(SSE)用 `fs.watch` 监听 tasks 目录 —— agent 侧任何写入(包括网页之外的 pi 工具操作)都会推送 `change` 事件,前端收到后重拉 `/api/graph` 整图刷新。第一版只读,UI 不做写操作。

## 启动

```sh
# 1. API 服务(默认端口 8787)
cd server && bun install && bun dev --root <agent工作目录>
# --root 指向 agent 团队运行 pi 的工作目录(缺省为启动目录);
# 也可以用环境变量 PI_TASKS_ROOT 或 PI_TASKS_DIR 覆盖。

# 2. 前端(默认端口 5173,proxy 转发 /api 到 8787)
cd web && bun install && bun dev
# 打开 http://127.0.0.1:5173/
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 健康检查(root、items 目录、item 数) |
| GET | `/api/graph` | 全量图:每个 item + ready / missing / dependents + 环/悬空警告 + 状态计数 |
| GET | `/api/events` | SSE:`init` 后每次写入推送 `change` |

`/api/graph` 响应:

```jsonc
{
  "items": [{ "item": {…Task}, "ready": false, "missing": ["task-ui"], "dependents": ["task-docs"] }],
  "warnings": { "cycles": [], "dangling": [] },
  "counts": { "pending": 0, "dispatched": 0, "active": 0, "done": 4, "blocked": 1, "cancelled": 0 }
}
```

## 前端说明

- 图视图:Svelte Flow 自定义节点(状态色边框 + 状态 glyph/chip + `ready` 徽章),dagre 自上而下分层布局(dep 在上、dependent 在下),环边红色虚线,ready 节点琥珀色描边。
- 点击节点打开右侧详情抽屉:状态、依赖、dependents、missing deps、description(markdown)、change history。
- 顶栏:状态计数、ready 数、环/悬空警告数、SSE 连接状态。
- 状态/类型定义在 `web/src/lib/types.ts`,与 server 响应一一对应;`api.ts` 是唯一接触网络的地方。
