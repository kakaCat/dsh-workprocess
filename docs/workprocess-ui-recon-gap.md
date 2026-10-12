# 差距与候选方案：workprocess 要显示 UI 还差什么（wt:recon:2 结论）

宿主仓库：`/Users/mac/Documents/ai/dsh/deepseek-harness`；插件仓库：本仓库。
**关键先例：`/Users/mac/Documents/ai/dsh/dsh-pmboard`（同作者的仓外插件，已有可用 UI）** —— 下面每条的对照都指向它。

## 1. workprocess 现状读数（差什么）

| # | 现状 | 证据 |
| --- | --- | --- |
| 1 | `workprocess/src/client.ts` 只有 7 行类型再导出，**没有浏览器半** | 本仓库 `workprocess/src/client.ts`（注释自称"对齐宿主 dsh-goal/src/client.ts"，但 goal 那边另有 `client/` 目录） |
| 2 | `workprocess/package.json` 的 `exports` 只有 `.` 与 `./invariant`，**没有 `./client`**；`dsh` 字段只有 `bundle.patch`，**没有 `dsh.client`** | 本仓库 `workprocess/package.json`（对照 pmboard：`exports["./client"] = ./lib/client.js` + `dsh.client{platform,inject}`） |
| 3 | 没有面向浏览器的**只读数据面**：状态落在宿主 storage domain（`workprocess` 域 / `processes` 表），没有 HTTP/SSE 端口 | 本仓库 `workprocess/src/storage.ts`；`~/.dsh/storages/workprocess.json` |
| 4 | **不能走 goal 那条 session projection 路**（本仓作者已在代码里写明） | `workprocess/src/storage.ts` 抬头：对仓外插件 `session.append` 没有地方设 `ignorable:true`，持久化读路径对"不认识的类型 + 无 ignorable"会拒绝解释整条会话日志；且投影的 `apply(state, event)` 只吃**会话事件**（`docs/subsystems/session-projection.md`），转发事件白名单是宿主自有的 `packages/api/remotes/src/remote-events.ts` |
| 5 | 装载行已就位，**不必改 profile** | `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 已列 `workprocess` 等四行，且 `node_modules/workprocess` 是 `link:` 到本仓 `workprocess/` |

## 2. 要改的清单（最小集）

1. **宿主半加一条只读数据面**：把阶段表/当前阶段/每阶段任务数折成一份小 JSON，经 `ctx.webServer.register({kind:'exact', path, handler})` 暴露（**惰性注入 `webServer`**，缺省零行为）。先例：pmboard `pm/src/index.ts:1168-1173` 注册 REST/SSE；客户端 `pm-client/src/api.ts:86,659`（`fetch` + `EventSource`，带超时与重连）。
2. **新增浏览器半产物**（照 `templates/decoration/client.js` 或 pmboard 的 `wrap-client.mjs` 形态）：`window.__ModuleLoader__.load({ id, factory(require){…} })`，React 从模块表 `require('react')` 取；**任何裸 npm 包必须打进产物**（pmboard 踩过 `require("marked")` 落空的坑，见其 `tsdown.client.config.mjs` 注释）。
3. **注册码头条**：`ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name:'conversation.input.dock', id:'workprocess', order:20, locale:NS }, StageDock))`。该槽 `kind=list / scope=session`、**`replaceRisk: 'none'`（可叠加）**，现有 occupant：queue、`todo`(order 0)、`goal`(order 10)。
4. **装载声明**：`package.json` 补 `exports["./client"]` + `dsh.client = { platform:'web', inject:[...] }`；`cordis.patch.yml` **不用动**（它只插宿主行）。
5. **样式**：产物自带 CSS 注入（模板用 React 元素内联 style + 宿主主题变量 `var(--dsw-alias-*)`；pmboard 另有 `tests/client-styles-ownership.test.ts` 约束归属），不许读别的插件 DOM/样式来定位。

## 3. 候选方案对比

| 方案 | 数据通道 | 结论 |
| --- | --- | --- |
| **A（推荐）** 宿主 `webServer` REST + SSE，客户端 `fetch`/`EventSource` | 自选端口 | 与 pmboard 同构、已被验证可行；仓外插件不碰会话日志；改动集中在两个包内 |
| B 宿主注册 session projection + 客户端 `useProjection('workprocess')` | 宿主投影系统 | **当前 build 对仓外插件不通**：需要把状态写进会话事件（见 §1.4），且转发事件白名单是宿主文件；除非宿主侧放宽，否则不选 |
| C 客户端走 Remote RPC（`ctx.remote.*`） | typert 生成的 Remote API | 需要宿主代码生成链（`packages/api/remotes` 是仓内 typert 产物），仓外插件没有这条生成通路；不选 |

## 4. 未决问题（留给 design 阶段裁决，不在 recon 拍板）

- 形态：composer 上方的**条**（同 todo）还是右栏/主区**面板**；是否需要点开看每阶段任务。
- 载荷：只回阶段名 + 态 + 当前标记 + 任务计数，还是连任务列表（决定 SSE 尺寸与隐私面）。
- 刷新：SSE 推送 vs 轮询；气泡边界（宿主换会话/多窗口）时怎么对齐归属域键。
- 降级：无流程、未绑定、取数失败三态各显示什么（不得报错糊屏）。
- 归属域键 ≠ 当前会话 id 的情形（`scope` 显式传过）在 UI 上如何表达。
