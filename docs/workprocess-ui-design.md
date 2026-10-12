# 设计说明：workprocess 的阶段清单 UI（像 todo）

状态：**待人工点头**（design 阶段收口是 human 门）。
范围：只定展示契约（形态 / 映射 / 进度 / 刷新 / 降级）；接口与装载声明的字段细则见 `docs/workprocess-ui-contract.md`。

## ① 槽位与条目形态

**决策 D-1：做成 composer 上方 dock 槽里的一条（strip），与 todo、goal 并列。**

- 槽位：`conversation.input.dock`（`kind=list` / `scope=session` / owner `InputZone`；契约 `packages/client/ui-conversation/src/client/contract/slots.ts:195`）。
- 现有 occupant 与顺序：`queue`、`todo`(order 0)、`goal`(order 10) → 本条目取 **id `workprocess`，order 20**（排在 todo 与 goal 之后）。
- 该槽 `replaceRisk: 'none'`（`slot-catalog.ts` `conversation.input.dock` 条目）= **纯叠加**，不改也不遮任何既有 UI。
- 为什么不用面板/右栏：目标是"一眼看到有哪些阶段"，条与 todo 同构，用户已有阅读习惯（D-1 的可替代项：右栏面板，代价是多一次点击且与 todo 不同构）。

**条内布局（折叠态，1 行 + 可选 1 行明细）**

```
◐ 阶段 2/4 · recon ✓␣design ◐␣implement ○␣verify ○     ← 主行
  ● wt:design:1 写展示契约   ○ wt:design:2 写接口契约    ← 展开行（仅当前阶段的未完成任务）
```
- 主行左：`StateDot`（当前阶段态）+ 文案「阶段 N/M」+ 当前阶段键；右：阶段链上的逐段小标记（done/ongoing/pending）。
- 展开行：当前阶段的在办任务（`id` 尾号 + objective 截断）；无在办任务时整行不渲染（不留空行）。
- 点击主行 = 展开/收起（本地 UI 态，不写任何流程状态）；**本条目只读**，不提供推进/收口按钮（那些是工具面与人工门的事）。

## ② 状态映射表（穷举，无"其他"兜底）

阶段态取值来自 `workprocess/src/types.ts:40`（`WorkStageState`），任务相位来自 `workprocess/src/types.ts:32`（`WorkTaskPhase`）。
视觉三态取自 `StateDot` 的取值域（`packages/client/ui-primitives/src/StateDot.tsx:9`：`done | warning | ongoing | error | idle`）。

**阶段（3 个取值，全覆盖）**

| 阶段态 `state` | 点 | 文案 | 备注 |
| --- | --- | --- | --- |
| `pending` | `idle` | 待开工 | 前序阶段未全 done |
| `active` | `ongoing` | 进行中 | 当前阶段（`current_stage` 同值） |
| `done` | `done` | 已收口 | 计数进「N/M」 |

**任务（4 个取值，全覆盖）**

| 任务相位 `phase` | 点 | 文案 | 备注 |
| --- | --- | --- | --- |
| `active` | `ongoing` | 进行中 | 进展开行 |
| `paused` | `idle` | 已暂停 | 与 `pending` 靠**文案**区分，不靠点 |
| `blocked` | `warning` | 被挡住 | 有 `blocked_message` 时挂在 tooltip |
| `complete` | `done` | 已完成 | 计数进「任务 x/y」 |

- 被 `clear` 的任务在内核里已是墓碑（`WorkTaskTombstone`）且不再出现在 `stage.tasks` 里 → **UI 侧无对应分支**，读到的永远只有上面 4 个相位。
- 映射表是闭集：实现里若出现 `default`/兜底分支，视为映射表不全（设计约束，不是建议）。

## ③ 进度口径与读数对应

口径**不新发明**，逐项照抄 `get_workstage` 回执（`tool-workprocess/src/tools.ts:274-303`）：

| UI 元素 | 读数来源 | 口径 |
| --- | --- | --- |
| 「阶段 N/M」的 N | `stages[].state === 'done'` 的条数 | 与工具面摘要同源（`tool-workprocess/src/tools.ts:684-690` 的 `renderReply`：`N/M 阶段已收口（当前 X）`） |
| 「阶段 N/M」的 M | `stages.length` | 阶段表长度 |
| 当前阶段键 | `current_stage` | 内核 `currentStageOf`（串行顺序里第一个非 done），UI 不自己找 |
| 当前阶段点 | `stages[current_stage].state` | 一般 `active`（`pending` 且前序全 done 时 `allows_start=true`） |
| 每段小标记 | `stages[].state` | 同阶段表顺序 = 串行顺序 |
| 展开行任务 | `get_worktask(stage_key=current_stage)` 的 `tasks[]` | 只显示 `phase !== 'complete'` 的 |
| 「任务 x/y」 | `stages[].tasks`（y）与 `stages[].tasks_done`（x） | 内核现成字段，不在客户端重算 |
| 用户可见的"门"提示 | `allows_start` / `allows_close` | 只在 tooltip 里说"可开工/可收口"，不做成按钮 |

## ④ 刷新时机

**决策 D-2：宿主端 SSE 推送为主，进入会话/重连时拉一次全量；不做定时轮询。**

| 触发 | 动作 |
| --- | --- |
| 宿主端流程写入后（create/update/submit/工具面任何写） | 服务端推一帧全量快照（`scope` 维度） |
| 切到某个会话（dock 条目按 session 作用域挂载） | 拉一次该 `scope` 的全量 |
| SSE 断线（`EventSource` 自带重连） | 重连后第一帧即全量；重连期间 UI 保持上一帧并标灰 |
| 同一 `scope` 多窗口 | 以服务端广播为准（客户端不做跨窗口同步） |

- 快照是**整份替换**（whole-value，与 todo 的 `todo/write` 同款语义）：不做增量 diff，避免"漏一帧就永久错"。
- 推送频率天然低（流程写入是人工/回合级，不是 token 级），无需节流。

## ⑤ 降级三态

| 情形 | 判据（读到什么） | 显示 | 不做什么 |
| --- | --- | --- | --- |
| **无流程** | 回执 `success:false` + `该归属域还没有流程`（缺失 ≠ 空表） | 整条不渲染（与 goal 的"无 goal 不渲染"同款）；**不显示"0/0 阶段"** | 不自动建流程、不弹提示 |
| **判据缺失** | `stages[].done_criteria` 为 undefined（真机已见：`（本阶段未登记达成判据——按阶段陈述推进）`） | 该段照常显示名称与态，tooltip 写"未登记达成判据" | 不隐藏该段、不报错 |
| **取数失败** | HTTP 非 2xx / 解析失败 / SSE 未建立 | 主行灰化 + 「阶段读数不可用」；保留上一帧（若有） | 不显示 0/0、不显示上一次的旧数字冒充当前 |

补充：`closed_at` 存在（流程已收口）时，主行尾部加「流程已收口」，阶段链按最后态只读展示。

## ⑥ 视觉外壳（探针实测后新增 D-5）

**决策 D-5：真条目必须照抄 `TodoPanel` 的 section 卡片外壳，不能像探针那样扔一个裸 `div`。**

探针实测（人已确认）：条目**确实出现在输入框上方那条带里**（槽位选对了），但"不像 todo"——因为探针只渲染了 `div{padding:4px 8px}` 一行字。真实现逐项对齐（`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx:65-99` 与 `TodoPanel.module.css:1-40,35-40`）：

| 元素 | todo 的做法 | 本条目照做 |
| --- | --- | --- |
| 外层 | `<section class=root>`：`margin: 0 auto` + `width/max-width` 用 `--dsh-composer-dock-inset` 与 `--dsh-composer-card-max-width` 算出的居中卡片 | 同 |
| 卡片皮 | `border-radius: var(--dsw-radius-lg)`、`background: var(--dsw-specific-menu)`、`box-shadow: var(--dsw-elevation-panel)`、`--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)`、`backdrop-filter: var(--dsw-menu-backdrop-filter)` | 同 |
| 内衬 | `.body`：`display:flex; flex-direction:column; gap:8px; padding:6px 12px` | 同 |
| 头行 | `<button class=header aria-expanded>`：图标 + 标题 + 进度摘要 + chevron，**缺省折叠**（`useState(true)`） | 同（图标用 `IconChecklistOutlineRegular` 同类） |
| 列表 | 展开时 `<ul>`，每项 `StateDot` + 文本 | 同（阶段行 + 任务行） |
| 空态 | `todos.length === 0 → return null`（整条不渲染） | 同（见 ⑤ 无流程/空表） |

由此**新增裁决项 D-5**：真条目是否也默认折叠（推荐：是，与 todo 一致），以及标题文案（推荐「阶段」）。

## 待人工裁决（点头时请一并看）

- **D-1** 条目形态：条（推荐）vs 右栏面板。
- **D-2** 刷新：SSE 推送（推荐）vs 轮询。
- **D-3** 展开行是否显示任务 objective 原文（涉及把任务描述带到浏览器）。
- **D-4** 被挡住的阶段/任务是否在折叠态就露出警示（推荐：露，靠 `StateDot warning`）。
- **D-5** 真条目是否默认折叠（推荐：是，与 todo 一致）；标题文案（推荐「阶段」）。

## 引用

- 现状与差距：`docs/workprocess-ui-recon.md`、`docs/workprocess-ui-recon-gap.md`
- 槽位契约：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（`conversation.input.dock`）
- 先例：`packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx`（todo）、`packages/client/ui-goal/src/client/GoalBar.tsx`（goal）
