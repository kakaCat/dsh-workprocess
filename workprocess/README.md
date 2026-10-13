# workprocess

workprocess 的**插件入口**（组合根）：把「内核 + 宿主存储域」接成宿主能装载的插件
（**驱动器与工具面不在这里**：分别在 `workprocess-round-driver` / `tool-workprocess`，本包都不 import）。

## 它补的正是那层接线

| 缺口 | 本包怎么补（**只补自己这一层**：其余缺口在兄弟包里，见右列） |
|---|---|
| 没有 `store` 实现 | `src/storage.ts` + `src/index.ts`：**用宿主的存储域**（`defineDomain` + `ctx.storageDomain.open`，域 `workprocess` v1、表 `processes`、键 = 归属）。schema 校验、耐久、`domain/changed` 事件都由宿主后端负责——**不自造文件库**。`workProcess` 的权威校验器仍是**内核**的 `decodeWorkProcess`（schema 的 `superRefine` 调它） |
| 真人判定 | **本包不判**（保持领域层"只管状态规则"）：判定在 `tool-workprocess/src/authority.ts`（从会话事件切面判本回合由谁发起 + 动作分级），合法性来源在 `command-workprocess`（命令由人敲、投话自署 `user`）。内核只**定义域词汇**（**域**错误码 `WORK_ERROR_CODES`，住在 `src/domain.ts`；阶段策略 `closePolicy: 'human' \| 'auto'`）——**授权是工具面的牙**，它的政策码是 `tool-workprocess/src/codes.ts` 里的 `WORK_TOOL_*`（`WORK_TOOL_AUTHORITY_REQUIRED`），不进域联合（对齐宿主：`GoalErrorCode` 在 domain.ts、`GOAL_TOOL_*` 在工具面） |
| `drive` 的结论没人执行 | 在 `workprocess-round-driver` 包：开工 / auto 收口 / 落盘 block 由 tick 直接落，续跑回合由 `agent.followup` 投递（本包只提供 `ctx.workprocess` 服务面） |
| 投递会冒充人话 | 在 `workprocess-round-driver/src/index.ts` + `tool-workprocess/src/authority.ts`：往 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 加 `work` 一格并**自署来源**——自动回合 = `autonomous`，`human` 策略的收口照样落不了章（省略 source 会被当成 user，那正是"自动回合替人收口"的口子） |
| 没有插件形状 | `src/index.ts`：`export const name / inject / apply(ctx, config)`（与宿主 `dsh-goal` 同形）；六个工具在 `tool-workprocess`，命令行在 `command-workprocess` |

## 装配

```
inject = ['agents', 'sessionProjections', 'storageDomain']
apply(ctx: Context, config) ⇒
  · 打开归属记录域（storage domain `workprocess`）——**域由本插件独占**（同名域重复 open 是响亮拒绝）
  · ctx.provide('workprocess', 域服务)   ← 官方 cordis provide，纯对象即可（无 instanceof Service 检查）
     域 API：process / createProcess / defineStages / editObjective / closeStage /
             createTask / editTask / pause·resume·block·complete·clearTask / discardProcess / closeProcess
     人机干预：view / discard / pauseActive / resumePaused（agent 键）
  · **发 `work/changed` typed 事件**（declare module '@deepseek-ai/cordis'；写路径统一进事件总线；
     payload = { scope, change }，丢弃为墓碑 change: undefined——外部插件可 ctx.on 订阅）
  · 回合边界驱动（agent/status = idle）+ 续跑投递（M4 迁往 round-driver 插件）

工具面 / 命令行都是**独立包、独立装载行**，只消费 `ctx.workprocess`（见 `cordis.patch.yml` 三行）。
apply(ctx, config) ⇒
  · 打开归属记录域（storage domain `workprocess`）
  · 六个工具进 ctx.tools.register（get_/create_/update_ × workstage/worktask）
  · 注册**常驻策略段**（`ctx.systemPrompt.section('tool:workprocess')`：阶段串行 / 谁能落 done / 回合预算）
  · 给工具面接上**通告口**（`deferNotice` ⇒ 宿主 `exec.deferContext`：把"下一步"说在决策点上）
  · 归属缺省 = **本会话**（不传 scope 时用 agent.session.id；多流程并存仍可显式给 scope）
  · ctx.on('session/event') ⇒ 空闲边界一拍：记回合 → 驱动 → （可选）投递下一轮
```

**前置（composition 必须挂的行）**：`@deepseek-ai/dsh-storage` + 一个后端（`dsh-storage-json` / `dsh-storage-sqlite`）
+ `@deepseek-ai/dsh-storage-domain`。一行都没挂 ⇒ 本插件不激活（cordis 等依赖）。

配置（`cordis.patch.yml` 的 config 段）：

```yaml
- insert:
    - id: workprocess
      name: "workprocess"
      config:
        tick: true            # 回合边界是否自动驱动（缺省 true）
        drive: true           # 空闲边界是否**自动投递续跑回合**（缺省 false；本仓装载层打开）
        defaultMaxRounds: 20  # 任务没写 max_rounds 时的硬上限（防跑飞）
        close: auto           # 流程收口：auto（缺省）= 最后一段 done 即收口；human = 全阶段 done 后投「请判」轮（判了不落定，方案 B 口径）
```

## 续跑是怎么跑的（刹车在哪）

1. **空闲边界**才动手：信号取自宿主的 **`agent/status === 'idle'`**（与宿主 `goal-round-driver` 同款）。
   活动轮次里改流程会与模型正在做的事打架。
   *为什么不用 `turnBoundary`*：那要等一条会话事件到达才能读，而 `turn/end` 那一拍投影可能还没翻成空闲、
   翻完之后又不再有事件——驱动器会**一枪不放**（真机踩过；会话事件到达时若 agent 已空闲，另有一拍兜底）。
2. **一次空闲边界要把该做的做完**：开工（`start-stage`）与投第一轮是两拍，而边界只来一次，
   故一拍推进完**立刻再拍**，直到得出 `drive`（投递）或非推进结论（`hold` / `wait-human` / `ask-*`）为止。
3. 该跑任务就**投一轮**（`agent.followup`，source 自署 `work`）；
   **本阶段一个任务都没有**（每过一个阶段边界都必然如此）⇒ 投**阶段规划轮**，请 agent 用
   `create_worktask` 给本阶段建任务。同一阶段只问一次，问过就停手等人（不空转、也不替它臆造任务）。
4. 任务全达成但策略 `human`（或全阶段 done ⇒ 流程级收口）⇒ 投**收口确认轮**，请 agent 用
   `ask_user_question`（或直接开口）把"该人拍板了"摆到人面前；人一确认就是人类回合，agent 落定
   时授权面自然放行。**同一件事只问一次**（不刷屏）。没有这一轮，流程会安静地停在阶段边界上——
   看起来就是卡死（真机踩过）。
4. 同一轮（`taskId:revision:round`）**只投一次**；回合被接手（会话里出现该 source 的 `user/message`）才把
   `rounds.started` **耐久**前进一格。
5. **刹车**：任务写了 `max_rounds` 用它，没写用 `defaultMaxRounds`；到顶 ⇒ 驱动器 `block-task` **落盘**
   （重启不失忆、人可见可裁），不再投——不会无限自动续跑。

## 状态放在哪（为什么不是会话日志）

goal 把状态放**会话日志**（`session.append('goal/change')` + 自己的 session 投影），因为它**在仓内**：
事件类型进了**脚本生成**的 `KNOWN_SESSION_EVENT_TYPES`，读路径才认它。

仓外插件走同一条路在本 build 里不成立：`Session.append(type, data, ...opts)` 只对 surface 事件开放第三参数，
**没有任何地方能设 `ignorable: true`**；而持久化读路径 `validateStoredEvents`
（`session-persistence/src/storage-contract.ts`）规定"遇到本 build 不认识的类型 + 无 `ignorable` ⇒
**拒绝解释整条会话日志**"。真去 append 自定义类型，下次会话加载直接失败。
宿主为仓外插件准备的持久化面就是 `ctx.storageDomain`。

## 装进 profile（宿主装配）

```bash
pnpm install && pnpm build          # ① 仓内构建（宿主加载的是 JS）
# ② profile 登记：依赖 "workprocess": "link:<repo>/workprocess"、bundles 追加 "workprocess"
ln -sfn <repo>/workprocess ~/.dsh/profiles/desktop/node_modules/workprocess
# ③ 重启 DSH
```

回滚：删掉 profile `package.json` 里的依赖与 bundles 条目 + `node_modules/workprocess` 链接
（改动前的备份是 `package.json.bak-workprocess`），重启即恢复原状。

## 命令行：`/work`（**独立包** `dsh-command-workprocess`）

与宿主的 `/goal` 同构：**命令行也是一个独立包、独立装载行**，不塞在领域插件里；
语法也逐字同形 —— `/work [<目标>|edit <目标>|pause|resume|clear]`。

- 装载：本包的 `cordis.patch.yml` 插两行——`workprocess`（本包）+ `dsh-command-workprocess`（命令行包），
  与宿主 base bundle 里 `dsh-goal` / `dsh-command-goal` 的关系一致。
- 数据来源：命令行只消费 **`ctx.workprocess`**（本包 `ctx.provide` 出去的领域服务：view / discard /
  pauseActive / resumePaused），不自己开存储域（同名域重复 `open` 会被响亮拒绝），也不绕内核改状态。
- **`/work <目标>` 不由命令建流程**：流程必须带阶段表，而"该拆成哪几段"是判断——命令只把目标转成一条
  指令投给会话（`agent.followup`，source 自署 `user`），由 agent 用 `create_workstage` 自己拆。
  `pause` / `resume` / `clear` 反过来是机械动作，命令直接落领域（模型不在也能用）。
- 命令天然的授权：由人敲出来（投出去的指令也自署 `user`），所以 `edit` / `resume` / `clear` 这类真人专属
  动作在那一层合法（与工具面同源，不是开后门）。
- 没装命令行包 = 只少一条命令行，六个工具照旧（两者是两条独立装载行）。


## 还没接的部分

- **`ask-*`（宿主弹框通道）已接**：`human` 策略的阶段收口由**工具自己问人**——
  `update_workstage action=done` 在缺授权时调 `ctx.get('userQuestions').ask(...)`（对齐宿主
  `plan-mode` 的 `exit_plan_mode`）。为什么必须这样：宿主把 `ask_user_question` 的答复**只记成
  工具结果**，不产生 `user/message` 事件 ⇒ 授权面看不见，"模型问完再自己落定"必然被拒（真机踩过）。
  没弹框通道（CLI / 无头 / 子 agent）时退回原来的"拒绝并指路"。

## 工具面上与流程相关的三个动词（在 `tool-workprocess`）

- `update_workstage { action: 'done' }` —— 阶段收口（策略 human 时真人专属）。
- `update_workstage { action: 'edit', objective }` —— **改流程目标**（阶段与任务原样保留；**真人专属**：
  改的是"这条流程要达成什么"）。幂等：同值 ⇒ `changed:false`；没有流程 ⇒ 内核拒
  （`objective-edit:no-process`）。
- `update_workstage { action: 'discard' }` —— **丢弃整条流程**（不需要 stage_key；不可逆：流程与任务墓碑
  一起消失、回合计数归零；**真人专属**——误建流程的补救口）。幂等：没有流程 ⇒ `changed:false`。

## 域**不**执行 agent 的纪律：提前给后续阶段建任务是**有意允许**的

工具面会拒"给非当前阶段建任务"（`WORK_TOOL_NOT_CURRENT_STAGE`），但**内核不拒**——这是刻意的分工，
别把它当成缺口"补"进 `fold`：

- **域是通用引擎**：`createWorkTask` 允许给任何未收口的阶段落任务（"计划先落任务、开工归驱动器"）。
  驱动器的环测与 `service.view` / `workWireOf` 的读投影都按这个状态写（`tests/service.spec.ts` 与
  `tests/view.spec.ts` 的夹具就是这么造的）；把它变成状态规则会让那批能力与夹具一起作废
  （试过：4 处夹具当场红）。**这个状态也不只由"提前建"造出来**：重排阶段表在前插一段，同样能把已有的
  任务留在非当前阶段上（单阶段流程建好任务 → 前面插一段）。两条路都合法，所以读路径必须继续吃得下它
  （`workprocess-kernel.spec.ts` 有一条用例把"域层允许 + 严格解码接受"钉住）。
- **牙长在纪律的作者那里**：那句"不要提前建"是**策略段**（`tool-workprocess`）写的，属 **agent 行为
  纪律**；与 `blockedAfterRounds` 完全同形——内核不知道的 agent 政策，由工具面自己写前拒。
- **域只管状态完整性**：已收口的阶段不许再塞任务（`task-create:stage-done`）、串行门（`stage-start` /
  `stage-define` 重排）、任务身份（`wt:<阶段键>:<序号>` 不复用）、聚合 CAS。

## 测试

```bash
pnpm test   # 全仓 282 条；本包 128 条：装配面 / 域声明与内核校验 / 归属缺省 / 真人判定 /
            #   空闲边界（开工·auto 收口·running 不动手）/ 续跑投递（自署来源·去重·上限刹车·门槛两处同值）/ **阶段规划轮** / **收口确认轮** /
            #   服务面 ctx.workprocess（view / pauseActive / resumePaused / discard 幂等 / **逐任务回合账 + resume 追加预算**）/ 内核（含"域有意允许提前建任务"）
```
