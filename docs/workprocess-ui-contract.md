# 接口与装载契约（实施阶段照抄用）

配套：形态与映射见 `docs/workprocess-ui-design.md`；现状与差距见 `docs/workprocess-ui-recon.md` / `docs/workprocess-ui-recon-gap.md`。
宿主仓库：`/Users/mac/Documents/ai/dsh/deepseek-harness`。**本文件里的片段可直接粘进实施，无需改名。**

## ① 宿主只读数据面

### 挂钩方式（惰性注入 `webServer`，缺省零行为）

```ts
// 宿主半（本仓某包 src/index.ts 的 apply 内）
;(ctx as unknown as { inject?: (s: string[], cb: (c: any) => void) => void }).inject?.(
  ['webServer'],
  (webCtx: { effect?: (fn: () => void, label?: string) => void; webServer?: any }) => {
    webCtx.effect?.(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix', path: '/workprocess/api', handler: createWorkprocessApi(ports),
      })
      return () => dispose()          // effect 的清理 = 撤销注册
    })
  },
)
```
先例：`dsh-pmboard/pm/src/index.ts:1168-1173`（prefix + effect）；`dsh-pmboard/pm/src/http/legacy-board-route.ts:90-110`（`register({kind:'exact', path, handler})` 形状 + 半注册回滚）。

### 路由表

| 方法 | 路径 | 用途 | 成功体 |
| --- | --- | --- | --- |
| GET | `/workprocess/api/stages?scope=<归属域键>` | 全量快照（拉一次 + 重连后兜底） | `200 application/json`，见下 |
| GET | `/workprocess/api/events?scope=<归属域键>` | SSE：连上先补一帧全量，之后每次流程写入推一帧全量（帧名 `stages`），25s 心跳 | `text/event-stream` |

- **`scope` 由客户端显式传**（HTTP 侧没有会话上下文）：取 dock 条目标准 prop `sessionId`（见 §2），值 = 归属域键。
- 失败一律 `4xx/5xx` + `{ "error": "<人话>" }`；**无流程不是错误**，见下。
- SSE 头与帧先例：`dsh-pmboard/pm/src/http/routers/stages.ts:241-290`（`text/event-stream; charset=utf-8` + `Cache-Control: no-store` + `: connected\n\n` 首帧 + `event: <kind>\ndata: <json>\n\n` + `req.on('close')` 清理）。

### 响应字段（**逐字照抄工具面读数的字段名**，前端可直接吃）

来源：`tool-workprocess/src/tools.ts:274-303`（`getWorkstage`）+ `tool-workprocess/src/tools.ts:252-262`（`taskView`）。内核侧类型：`workprocess/src/types.ts`（`WorkStageState` / `WorkTaskPhase`）。

```jsonc
{
  "scope": "session-…",            // = 归属域键
  "process_id": "…",
  "objective": "…",
  "revision": 12,                   // CAS 用；UI 只展示/比对，不写
  "stages": [{
    "key": "design",
    "statement": "…",
    "state": "active",              // pending | active | done
    "done_criteria": ["…", "…"],    // 字符串数组；未登记时该键缺省（见降级态②）
    "close_policy": "human",        // human | auto（缺省 human）
    "tasks": 3,                     // 本阶段任务总数
    "tasks_done": 1                 // phase === 'complete' 的条数
  }],
  "current_stage": "design",        // 内核 currentStageOf；全收口时为 null
  "allows_start": false,            // 串行门：当前阶段 pending 且前序全 done
  "allows_close": false,            // 是否具备收口条件
  "closed_at": 0,                   // 仅已收口时出现
  "activation": "armed",            // 仅归属记录里有时出现
  "tasks": [{                       // 全量任务（展开行只需 current_stage 的子集）
    "id": "wt:design:2",
    "stage_key": "design",
    "objective": "…",
    "phase": "active",              // active | paused | blocked | complete
    "revision": 1,
    "blocked_reason": "…",          // 仅 blocked 时出现（lower-kebab-case）
    "blocked_message": "…",         // 仅 blocked 时出现
    "max_rounds": 20                // 仅在显式设过时出现
  }]
}
```

### 真实响应样例（本机实测，2026-10-12）

取自 `~/.dsh/storages/workprocess.json` 中 scope `session-e301aa22-d34d-45d6-8612-36c1361b0672`（本流程，`revision: 12`，`rounds.started: 4`）：

```json
{
  "scope": "session-e301aa22-d34d-45d6-8612-36c1361b0672",
  "objective": "dsh 的 goal 有 UI 展示，workprocess 也需要一个 UI 展示有哪些阶段，类似 todo 的样子",
  "revision": 12,
  "stages": [
    { "key": "recon", "state": "done", "close_policy": "auto", "tasks": 2, "tasks_done": 2 },
    { "key": "design", "state": "active", "close_policy": "human", "tasks": 3, "tasks_done": 1 },
    { "key": "implement", "state": "pending", "close_policy": "auto", "tasks": 0, "tasks_done": 0 },
    { "key": "verify", "state": "pending", "close_policy": "human", "tasks": 0, "tasks_done": 0 }
  ],
  "current_stage": "design",
  "allows_start": false,
  "allows_close": false,
  "tasks": [
    { "id": "wt:design:1", "stage_key": "design", "phase": "complete", "revision": 2 },
    { "id": "wt:design:2", "stage_key": "design", "phase": "active", "revision": 1 },
    { "id": "wt:design:3", "stage_key": "design", "phase": "active", "revision": 1 }
  ]
}
```

> 注意 `done_criteria` 在本样例里**缺省**：建流程时该字段传的是字符串，工具只认**字符串数组**（`tool-workprocess/src/tools.ts:244`），类型不符被静默忽略 → 正好是设计里"判据缺失"降级态的真实来源。正常形态应为 `"done_criteria": ["跑 pnpm -r build 通过", "…"]`。

## ② 浏览器半注册声明（可直接粘）

```ts
// 浏览器半：模块形态
export const name = 'workprocess/client'
export const inject = ['slots', 'sessions']        // cordis 服务名（先例 pmboard pm-client/src/index.ts:29）

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'workprocess', order: 20 },
    StageDock,
  ))
}
```

- slot key：`conversation.input.dock`（`kind=list` / `scope=session` / `replaceRisk: 'none'`，纯叠加）。
- `register` 选项（该槽全表）：`id`（**必填** string）、`order`（可选 number，缺省 0）、`label`（可选 `string | (() => string)`）。现有 occupant 顺序：`todo` 0、`goal` 10 → 本条取 **20**。
- 组件拿到的标准 prop（该槽声明）：含 **`sessionId: SessionId`**（→ 数据面的 `scope`）、`useSession`、`useConversation`、`useChat`、`useInput`、`useProjection`、`useTrajectory` 等。
- 契约与示例出处：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 的 `conversation.input.dock` 条目。

### `package.json` 片段（宿主扫描的就是这两处）

```jsonc
{
  "exports": {
    ".": { "types": "./dist/types/index.d.ts", "default": "./dist/index.js" },
    "./invariant": { "types": "./dist/types/invariant.d.ts", "default": "./dist/invariant.js" },
    "./client": "./lib/client.js",              // ← 新增：浏览器半产物（由 client/*.tsx 构建）
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {                                  // ← 新增：browser 声明
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

> 实施注（implement 落地时定稿）：inject 只列了 ui-conversation 一项——真产物 `lib/client.js`
> 是**零依赖**实现（状态点 / 图标全内联，不 `require('@deepseek-ai/dsh-client-ui-primitives')`），
> 用不上第二项；多余的 inject 只是加载排序提示，不留。

- `dsh.client` 合法字段：`platform`（必填 string）、`inject?`、`external?`（string[]）、`immediately?`（boolean）——校验器 `packages/client/modules/src/client/manifest.ts:161-180`。
- 声明了 `dsh.client` 却**没有** `exports["./client"]` → 宿主启动期直接抛：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（`packages/client/modules/src/index.ts:845-848`）。
- **两个 inject 别混**：`package.json` 里的 `dsh.client.inject` 是**装载图**（包说明符，先例 ui-goal 列 `@deepseek-ai/dsh-client-*`）；模块里 `export const inject` 是 **cordis 服务名**（先例 pmboard 列 `slots/sessions/...`）。graph 对认不出的名字按"静态表名、不加边"处理（`packages/client/modules/src/index.ts:491-495`），所以 pmboard 那种写法也能启动，但按 ui-goal 的包说明符写更准确。
- `cordis.patch.yml` **不用改**：profile 的 `dsh.profile.bundles` 已列本包，patch 只插宿主行（`~/.dsh/profiles/desktop/package.json`）。

## ③ 产物形态

```js
// lib/client.js —— 唯一约定：把工厂注册到 id === 包名
window.__ModuleLoader__.load({
  id: 'workprocess',
  factory(require) {
    const React = require('react')          // React 从模块表取
    return { name: 'workprocess/client', inject: ['slots', 'sessions'], apply(ctx) { /* … */ } }
  },
})
```

- **`id` 必须等于包名**，否则宿主报 `loaded without registering "<id>" via __ModuleLoader__.load` 并置该 entry 失败（`packages/client/modules/src/client/system.ts:203-217`）。
- 模块表只预置 `react` / `react-dom` / `@deepseek-ai/*`；**任何裸 npm 包必须打进产物**（先例与事故记录：`dsh-pmboard/pm/tsdown.client.config.mjs` 抬头注释，`marked` 留 external 导致整个浏览器半加载失败）。
- 构建路径（**已落地**）：源码 `workprocess/client/*.tsx` → tsdown 出 CJS → 用 `outputOptions.banner/intro/footer` 包一层 loader 调用 → 产物 `lib/client.js`（与宿主 `packages/client/tsdown.client.ts` 同一份产物契约）。`react` / `react/jsx-runtime` 保持 `require` 外置（模块表提供），其余全部内联。
- 样式：CSS Modules（`*.module.css`）由构建期的 lightningcss 编译成 `[hash]_[local]` 类名 + 文本，在**模块执行时**注入一条带 `data-plugin-css` 的 `<style>`（与宿主客户端包同一套做法）；不得读别的插件 DOM/样式定位。

## ④ 先例索引

| 契约点 | 先例 |
| --- | --- |
| 槽位与选项 | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（`conversation.input.dock`） |
| 同槽 occupant 写法 | `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:103-118`；`packages/client/ui-goal/src/client/index.ts`（`ctx.slots.inject` + `register`） |
| 标准 prop `sessionId` | slot-catalog `conversation.input.dock` 的 `standardProps` |
| webServer 惰性注入 / 路由注册 | `dsh-pmboard/pm/src/index.ts:1168-1173`；`dsh-pmboard/pm/src/http/legacy-board-route.ts:90-110` |
| SSE 头 + 帧 + 心跳 + 清理 | `dsh-pmboard/pm/src/http/routers/stages.ts:241-290` |
| 客户端取数（fetch + EventSource 重连） | `dsh-pmboard/pm-client/src/api.ts:86,648-660` |
| `dsh.client` 声明与校验 | `packages/client/modules/src/client/manifest.ts:157-180` |
| 缺 `./client` 的报错 | `packages/client/modules/src/index.ts:845-848` |
| loader id 校验 | `packages/client/modules/src/client/system.ts:203-217` |
| 打产物 | `dsh-pmboard/scripts/wrap-client.mjs`；`dsh-pmboard/pm/tsdown.client.config.mjs` |
| 最小可跑模板 | `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/`（package.json + client.js + index.js + patch 四件套） |
