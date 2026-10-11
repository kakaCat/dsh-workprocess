# tool-workprocess

workprocess 的**工具面**：两层各三工具（登记表 `src/registry.ts` 是唯一手写清单）。

**命名与形状对齐宿主 dsh**：`get_* / create_* / update_*`（动词在前），状态变更**收进 `update` 的 `action`**
（对齐 `get_goal / create_goal / update_goal`）——不是为每个动词各开一个工具。

| 工具 | 层 | 作用 |
|---|---|---|
| `get_workstage` | 层1 | 读阶段表（顺序即串行顺序）+ 当前阶段 + 串行门 + 收口条件 + 每阶段的收口策略（`close_policy`） |
| `create_workstage` | 层1 | 建流程（带阶段表：`key / statement / done_criteria? / close_policy?`）或整体替换阶段表；会丢掉**非空**阶段的一律被内核拒 |
| `update_workstage` | 层1 | `action=done`：阶段收口落定——按**本阶段收口策略**判谁来落（`human` = **真人专属**；`auto` = 驱动器/自治回合可落）；任务须非空且全部 complete。`action=edit`：**改流程目标**（要 `objective`；阶段与任务原样保留；**真人专属**）。`action=discard`：**丢弃整条流程**（不需要 `stage_key`，不可逆，**真人专属**） |
| `get_worktask` | 层2 | 读任务（给 `task_id` 读一条 / 给 `stage_key` 读一阶段 / 都不给读全部） |
| `create_worktask` | 层2 | 在某阶段建任务；身份由内核分配 `wt:<阶段键>:<序号>`，回执直接给 `task_id` |
| `update_worktask` | 层2 | `action` 六动词：`edit / pause / resume / block / complete / clear`（`edit`、`resume` = **真人专属**，`block` 必须给原因） |

**阶段开工没有动词**（有意）：`update_workstage` 只认 `done` / `edit` / `discard`——开工是**驱动器的动作**
（`workprocess-round-driver` 的 `start-stage` 决策，串行门放行才开工），避免两条开工入口。

### 与宿主 dsh 的两处必然差异

1. **六个而不是三个**：workprocess **分两层**（宿主只有单层 goal），故两层各一套 get/create/update。
2. **动词集不同**：`clear` 是本包加项（撤掉误建的任务，编号不复用）；宿主"一会话一 goal"没有这个动作。
   其余口径一致：`edit` / `resume` 需人直接发起，`pause` / `block` / `complete` 可由 agent 发起；
   阶段收口 `stage_done` 多一条**按阶段策略分流**（`human` 人工确认 / `auto` 自动收口）。

## 授权口径（对齐宿主 dsh 的 update 政策）

- **真人专属**：`task_edit`（改目标——对齐宿主 dsh「edit, pause, and resume require a direct top-level human request」）、
  `process_edit`（改**整条流程**的目标——agent 自行改会让流程悄悄跑偏到另一件事上）、
  `task_resume`（改人的意图——agent 自行 continue 会推翻人的暂停）、
  `process_discard`（丢整条流程——agent 自撤会抹掉"这里曾经有一条流程"这段历史；误建流程的补救口只给人）。
- **按阶段的收口策略判**：`stage_done` 的目标阶段 `close_policy=human`（缺省）时是**人工确认**（真人专属）；
  `close_policy=auto` 时**放行自治回合**——阶段自己声明了"任务全完成即自动收口"，此时再按人工确认拦
  等于把声明作废。策略从流程里读（`stageClosePolicyOf`），**授权面不自己猜**；拿不到上下文就按保守的
  `human` 判。两条路都要过内核的收口判据（任务非空且全 complete）。
- **agent 可发起**：`task_pause` / `task_block` / `task_complete` / `task_clear`。
- `authorityFromEvents(...)`：从开放回合的事件切面判定"本轮是人打的字"还是"**精确命中**的续跑回合"
  （`taskId + revision + round` 三项全对；旧回合、改过的目标一律不授自治权）。
- 越权抛 `WorkError('WORK_NO_PERMISSION')`，回执里给出路（由人在宿主界面确认 / 由人直接调 /
  `human` 策略下落不了的阶段，由人把 `close_policy` 改成 `auto`）。

## 结构

| 文件 | 职责 |
|---|---|
| `src/registry.ts` | 六个工具的登记表（`handler` 名与 `handlers.ts` 逐字对应，用例逐条核） |
| `src/authority.ts` | 授权判据（真人专属集合 + **按阶段收口策略的 `stage_done` 判据** + 精确授权三元组 + `requireActionAuthority`） |
| `src/handlers.ts` | 处理器：协议无关（deps + 参数对象 → 回执对象），**不需要宿主即可单测** |
| `src/tools.ts` | `defineTool` 工具壳（名字与自述**逐字取自登记表**）+ `WORK_TOOL_FACTORIES` |
| `src/plugin.ts` | 独立插件入口 `applyWorkToolSurface(ctx, deps)`（装不上只降级，不带崩插件其余面） |
| `src/index.ts` | 再导出（插件入口在 `tool-workprocess/plugin.js`） |

组合根把 `WorkToolDeps`（`store` + `now` + 可选 `resolveAuthority` / `verifyCaller`）注入后即可挂载。

## 测试

```bash
cd workprocess/tool-workprocess && pnpm test   # 25 条：登记表自洽 / 授权口径（含收口策略与 process_edit）/ 六工具行为
```
