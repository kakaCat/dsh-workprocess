# tool-workprocess

> 本包自带装载行（`dsh.bundle.patch: ./cordis.patch.yml`，只插自己那一行）：profile 的
> `dsh.profile.bundles` 里列上本包即生效。

**插件形态**（对齐宿主 `dsh-tool-goal`）：`name` / `inject: ['tools','workprocess','agents','sessionProjections','systemPrompt']` / `apply(ctx, config)`。
**数据口只有 `ctx.workprocess`**——存储域由领域插件独占打开（同名域重复 `open` 是响亮拒绝），
本面不碰 store、不绕内核；授权判据 / 通告（`exec.deferContext`）/ 人机确认（`ctx.userQuestions`）
/ 常驻策略段都归本面，装配由 `apply` 一次接好。


workprocess 的**工具面**：两层各三工具（`src/tools.ts` 顶部的登记表是唯一手写清单）。

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

## 人机确认（工具自己问人）

`update_workstage { action: 'done' }` 在**缺授权**（策略 `human` 且本轮不是人发起的）时，
不再直接拒：经 `WorkToolDeps.askHuman` 端口调宿主的 `ctx.userQuestions.ask(...)` **自己弹框问人**
（与宿主 `plan-mode` 的 `exit_plan_mode` 同款）。四种裁决，**只有 `approved` 算同意**：

| 裁决 | 工具回什么 | 效果 |
|---|---|---|
| `approved` | 正常落章 | 阶段 done（与"人直接在会话里说一句"等价） |
| `declined`（选了别的 / 自定义输入） | `WORK_HUMAN_DECLINED` + 人的原话 | 不收口，模型按人说的补任务 |
| `cancelled`（打断去说话 / 中止） | `WORK_HUMAN_UNAVAILABLE` | 不收口，停手等人开口 |
| `no-channel`（没弹框通道 / 没人接这一问） | 退回 `WORK_NO_PERMISSION`（带指路） | CLI / 无头 / 子 agent 场景的原口径 |

**顺序纪律**：先判权、再判状态——越权者不会因为"阶段没做完"拿到另一个口径；而"确实做得成"
（active 且任务全达成）才会去打扰人。

## 模型面指令（对齐宿主 `dsh-tool-goal` 的另两种提示词）

宿主 goal 有三处模型面文本：**回合投递**（驱动包）、**常驻策略段**（工具包 `ctx.systemPrompt.section`）、
**工具回执之后的通告**（工具包 `exec.deferContext`，如 `<goal_complete>`）。本仓对齐后两处：

| 位置 | 给模型什么 |
|---|---|
| `create_workstage` / `create_worktask` 回执 | 下一步归谁：**开工是驱动器的动作**；任务建完直接做 |
| `update_worktask complete` ⇒ 通告 | `<workprocess_task_complete>`：本轮到此为止、不要顺手开新任务、不要替阶段收口 |
| `update_workstage done` ⇒ 通告 | `<workprocess_stage_done>`：下一阶段由驱动器开工与规划，不许越阶段 |
| `update_workstage discard` ⇒ 通告 | `<workprocess_discarded>`：不可逆，别再引用旧阶段键 / 任务 id |

通告经 `WorkToolDeps.deferNotice` 端口发出：本面**只产出「摘要 + 文本」**，消息形状与来源由组合根落成
（本面不 import 宿主 llm 包）。幂等重放（`changed:false`）**不发**通告——没发生的事不说成发生了。

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

## 结构（3 个模块，与宿主 `dsh-tool-goal` 同粒度）

宿主那个包源码也是三个模块（`authority` / `wrapup` / `index`），发布前打成一个 `lib/index.js`
（见其打包分区标记）；我们按同样的粒度切：

| 模块 | 职责 | 对应宿主 |
|---|---|---|
| `src/authority.ts` | 授权：**判据**（真人专属集合 + 按阶段收口策略的 `stage_done` 判据 + 精确授权三元组 + `requireActionAuthority`）＋ **宿主对话面**（授权判据读取 `authorityResolverOf`、通告 `exec.deferContext`、人机确认 `ctx.userQuestions`、`work-tool` 来源声明） | `authority.ts` + `wrapup.ts`（都是"工具与宿主/人的边界"） |
| `src/tools.ts` | 六个工具：登记表（唯一手写清单）+ `defineTool` 壳（协议面）+ 处理器（协议无关，**不需要宿主即可单测**） | 宿主 `index` 里的工具定义 + 处理器 |
| `src/index.ts` | 插件装配：`name` / `inject` / `apply(ctx, config)` + **常驻策略段**（模型面纪律） | 宿主 `index` 里的 `apply` + `ctx.systemPrompt.section` |

数据口只有 `ctx.workprocess`（`WorkToolDeps.domain`）；`apply` 从宿主 ctx 一次接好授权、通告、人机确认。

**配置**（装载层 `config` 段）：`policySection`（缺省 true，策略段是否注册）、
`blockedAfterRounds`（缺省 3，自治回合落 `block` 的前置轮数，对齐宿主 goal 的 `blockedAfterConsecutiveRounds`）。

## 测试

```bash
cd workprocess/tool-workprocess && pnpm test   # 34 条：登记表自洽 / 授权口径（含收口策略与 process_edit）/ 六工具行为 / 人机确认（userQuestions）/ 工具通告（deferContext 适配）
```
