# dsh-command-workprocess

`/work` 命令行（**独立包、独立装载行**，与宿主 `@deepseek-ai/dsh-command-goal` 同形）。

## 语法（与 `/goal [<目标>|edit <目标>|pause|resume|clear]` 逐字同形）

| 命令 | 谁来做 | 作用 |
|---|---|---|
| `/work` | 命令直读 | 看：目标 / 各阶段（key · 态 · 收口策略 · 任务 done/total）/ 当前阶段的任务 / 回合（**本任务**已准入/上限 + 全程累计）/ 谁该动 |
| `/work <目标>` | **agent** | 把目标投给 agent（`agent.followup`），由它用 `create_workstage` **自己拆阶段**建流程 |
| `/work edit <目标>` | **agent** | 让 agent 改流程目标（`update_workstage action=edit`，阶段与任务保留；要重排它再用 `create_workstage`） |
| `/work pause` | 命令直落 | 暂停**当前阶段**的活动任务（自动续跑随之停下） |
| `/work resume` | 命令直落 | 恢复当前阶段被暂停的任务（**不含**被 `round-limit` 挡下的任务——那种要 `update_worktask action=resume`，顺带追加一份回合预算，见根 README 的 block 语义） |
| `/work clear` | 命令直落 | 丢弃整条流程（不可逆；幂等）。`discard` 作老写法别名仍认 |

**只有自己的控制词被吃掉，其余一律当目标**（同 `/goal`）——所以 `/work 全部推倒重来` 是目标，不是命令。

## 为什么创建是"投话"而不是命令自己建

goal 的目标是一句话，命令自己就能落库；workprocess 的流程**必须带阶段表**，而"这条目标该拆成哪几段"
是判断，不是机械转换。所以命令只把目标转成一条投给会话的指令，由 agent 用工具面自己拆：
**命令绝不替它猜阶段表**（猜出来的结构会把模型绑在它没同意过的东西上）。

控制动作（`pause` / `resume` / `clear`）反过来——机械、可判定，命令**直接落领域**，模型不在也能用。

## 投给 agent 的指令怎么写（`createInstruction` / `editInstruction` 同一套纪律）

**范本是宿主 `dsh-goal-round-driver` 的 `renderGoalRoundPrompt`**：它通篇是
`<goal_round>` + 两行数据（Objective / Round）+ **一段连贯散文**——没有标题、没有列表、不点名任何参数，
重点是那一整句**工作方式纪律**：

> Treat the current workspace, tool results, and durable session state as **authoritative; inspect them
> instead of assuming earlier narration is still current**. Make concrete progress and **verify** the result…

指令是**人敲命令那一刻**投给会话的一条消息，一次进上下文。照范本立五条：

| 纪律 | 为什么 |
|---|---|
| **形状照范本**：一行数据（目标）+ 一段散文 | 上一版写成 `##` 标题 + 加粗 + 分条规格书，与范本不是一路 |
| **要教"怎么算好"** | 范本的精髓就是那句工作方式纪律。本面给三条：拆段前**先看工作区与会话里已确立的事实**（别按早先叙述假设）、每段要有**能收口的边界**、`done_criteria` 要写成**别人照着能跑**的判据 |
| **不替工具 schema 说话** | 字段名、`close_policy` 的缺省、替换阶段表的两条陷阱——都归 `create_workstage` 的**参数描述**（模型调工具时读到的唯一来源）。投递里抄一份 = 给 schema 建一个会过期的副本（上一版正是抄了四个字段 + `stage_key`）。但"这段的产出要不要人点头"这个**判断口径** schema 说不出来，必须留在投递里 |
| **必带停手条件**：这一轮**只建、不要动手做** | 与规划轮同源的真机坑：写成"建完直接动手"，两阶段流程跑完 `rounds.started` 还是 0——回合预算与 `block` 门槛都按任务轮计数，等于没启用；而且活已经干完，驱动器的任务轮还会照样投，白跑一轮 |
| **不交代"这是人敲的命令"** | 授权面读的是**消息来源**（`source: { kind: 'user' }`，见 `deliver`），不是正文；且这一轮的动作不需要真人授权 |

"不预设阶段表"这条铁律不变：指令给的是**口径**（几段、怎么算一段算好、收口怎么选、只建当前阶段），
从不说"该拆成哪几段"——那是模型该做的判断（命令猜出来的结构会把模型绑在它没同意过的东西上）。

## 投出去的消息来源自署 `user`

这一轮是**人敲了命令**才发生的（`/goal` 提交附件同款）。授权面据此判"本回合由人发起"，
于是 `update_workstage action=edit`、`human` 策略的阶段收口这类**真人专属**动作才落得下章；
`workprocess` 驱动的自动续跑回合则自署 `work`（判为自治）——两者绝不混淆。

## 其它纪律

- **只消费 `ctx.workprocess`**（由 `workprocess` 提供的领域服务）：不自己开存储域
  （同名域重复 `open` 会被响亮拒绝），也不绕内核改状态。
- 宿主 agent 不支持 `followup` 时**如实报错**（不假装建成，也不偷偷自己建）。
- 装载：`workprocess/cordis.patch.yml` 里插两行（`workprocess` + `dsh-command-workprocess`），
  与宿主 base bundle 里 `dsh-goal` / `dsh-command-goal` 的关系一致；profile 只需装好这两个包。

## 依赖与类型

- 直接对接官方包：`@deepseek-ai/cordis` 的 `Context`（peer，类型面）、`@deepseek-ai/dsh-commands`
  的 `CommandInvocation / CommandResult`（peer，类型面）——**两处都是 type-only**，运行时不留引用；
  运行时唯一的外部引用是 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（投话用）。
- `ctx.workprocess` 的类型来自 `declare module '@deepseek-ai/cordis'` 增强（由 `workprocess` 插件 provide）。

## 测试

```bash
pnpm test   # 18 条：语法（与 /goal 同形）/ 排版 / 分派（投话 vs 直落）/ 真服务接线 /
            #   指令措辞（教质量判据·不替 schema 说话·必带停手条件·不复述策略段·形状照范本·长度上限）
```
