# 现状核查：goal / todo 的 UI 是怎么显示出来的（wt:recon:1 结论）

宿主仓库：`/Users/mac/Documents/ai/dsh/deepseek-harness`（包路径均相对该仓库）。

## 1. 界面承载：goal 的 UI 是一个「dock 条目」

| 事实 | 证据（文件:行） |
| --- | --- |
| goal 的条状 UI（GoalBar）是注册进 composer 上方 dock 槽的条目，id=`goal` | `packages/client/ui-goal/src/client/GoalBar.tsx`（`GoalDock` / `GoalBar`） |
| 同一槽位里已有 queue / **todo** / goal 三个 occupant——「像 todo 那样」= 做同槽的第三个表 | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:842`（`client-ui-conversation TodoDock id 'todo'`、`client-ui-goal GoalDock id 'goal'`） |
| 槽位契约：`conversation.input.dock`，kind=`list`，scope=`session`，owner=`InputZone` | `packages/client/ui-conversation/src/client/contract/slots.ts:195` |
| todo 的展示组件就是同槽的 `TodoDock`：`useProjection('todos')` + `ctx.slots.register({name:'conversation.input.dock', id:'todo', order:0, locale:NS}, TodoDock)` | `packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:103-118` |
| 注册方式：浏览器半声明 `inject:['slots']`，用 `ctx.slots.inject(key, () => ctx.slots.register(...))`；注册进未声明槽会抛 | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（`CLIENT_NOTES`） |

## 2. 数据通道：**session projection**（宿主端 reduce → 客户端 `useProjection(key)`）

| 事实 | 证据（文件:行） |
| --- | --- |
| goal 在宿主端定义一个投影：`key:'goal'` + `stateSchema/init/apply` + `wire:{viewSchema, view}` + `stateVersion` | `packages/goal/goal/src/index.ts:161-169`（`goalProjectionDefinition ... satisfies ProjectionDefinition<'goal', …>`） |
| 客户端读同一个 key：`GoalDock` 里 `useProjection('goal')`（undefined=加载中 / null=无 goal / 有值=快照） | `packages/client/ui-goal/src/client/GoalBar.tsx` 尾部 `GoalDock` |
| todo 同构：宿主投影 key=`todos`，客户端 `useProjection('todos')` | `packages/todo/tool-todo/src/index.ts:124`；`TodoPanel.tsx:106` |
| 变更（edit/pause/resume/clear）不走投影，走注入的动作面（RPC），结果由投影回流 | `packages/client/ui-goal/src/client/slots.ts`（`GoalBarActions`） |
| 子系统说明文档 | `docs/subsystems/session-projection.md`、`docs/subsystems/slots.md` |

结论：**展示所需的全部状态可以从宿主投影下来**；workprocess 的阶段表/当前阶段/任务态只要能折叠成一份可序列化的视图，就能沿用这条通道，不需要新造传输。

## 3. 装载方式：一个包同时出 node 半 + browser 半

| 事实 | 证据（文件:行） |
| --- | --- |
| node 半 `apply()` 可以为空——纯 UI 插件只是让插件出现在 cordis.yml / Loader 里 | `packages/client/ui-goal/src/index.ts` |
| browser 半通过 `exports["./client"]` 出，由 `package.json` 的 `dsh.client` 声明发现（含 `inject` 依赖与 `platform:"web"`） | `packages/client/ui-goal/package.json`（`exports["./client"]`、`"dsh":{"client":{…}}`） |
| 客户端产物由共享预设打出（closure-factory：`window.__ModuleLoader__.load`，CSS Modules 由 lightningcss 编译注入） | `packages/client/ui-goal/tsdown.config.ts`（`clientBundle(...)`）→ `packages/client/tsdown.client.ts` |

## 4. workprocess 侧现状（gap 清单的起点，细节留给 wt:recon:2）

- `workprocess/src/client.ts` 目前只有 7 行：纯类型再导出，**没有浏览器半**。
- 四个包（workprocess / workprocess-round-driver / tool-workprocess / command-workprocess）的 `package.json` 目前只有 `dsh.bundle.patch`，**没有 `dsh.client` / `exports["./client"]`**（对照 `packages/client/ui-goal/package.json`）。
- 阶段表已经是服务面可读的（`get_workstage` / `get_worktask`），但**尚未有宿主端投影定义**（对照 `goalProjectionDefinition`）。
- 候选槽位：`conversation.input.dock`（与 todo/goal 并列，最贴近「像 todo 的样子」）；备选 `rightbar` / `main`（见 slot-catalog 的 key 清单）。
