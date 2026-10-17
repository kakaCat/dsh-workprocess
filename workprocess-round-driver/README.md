# workprocess-round-driver

> 本包自带装载行（`dsh.bundle.patch: ./cordis.patch.yml`，只插自己那一行）：profile 的
> `dsh.profile.bundles` 里列上本包即生效。

**回合驱动器插件**（对齐宿主 `@deepseek-ai/dsh-goal-round-driver`）：`name` / `inject` / `apply(ctx, config)`，
**独立装载行**（`cordis.patch.yml` 的第二条，紧跟领域插件）。职责：agent 空闲时把流程往前推——
落"不需要人"的副作用（开工 / auto 收口 / 落盘 block / 流程收口），并投递下一轮（任务轮 / 阶段规划轮 / 收口确认轮）。

## 模块与设计（与宿主逐条对应）

| 模块 | 内容 |
|---|---|
| `src/index.ts` | 插件壳 + 运行时（事实投影 · 一拍 · 投递）+ 消息来源声明（`kind: 'work'`） |
| `src/decide.ts` | 契约类型 + 决策树（**纯层**：零 I/O、零宿主依赖，可穷举单测） |
| `src/prompt.ts` | 五种轮次的提示词渲染（纯字符串函数）：任务轮 / 规划轮 / 收口确认轮 / **终局收束轮** / **停手通告轮** |
| `src/invariant.ts` | **不变量伴生件**（独立入口 `workprocess-round-driver/invariant`，对齐宿主 `goal-round-driver/invariant`）：每条自称 `kind:'work'` 的会话消息必须与驱动器给定持久状态会渲染的载荷**逐字节一致**——没有它，`kind:'work'` 就是"自动回合冒充人话"的口子 |

宿主那个包源码也是三个模块（`index` / `prompt` / `invariant`）——粒度一致；我们的第二模块是**决策树**
（goal 的规则简单到能内联进 `drive()`，我们的域有阶段 × 任务相位 × 收口策略 × 回合预算 × 规划/确认轮）。

| 宿主 goal driver | 本插件 |
| --- | --- |
| `inject = ['agents','goals','sessions']` | `inject = ['agents','sessions','workprocess']` |
| 每 agent 一张 state（`attempt`/`competingQueued`/`needsCheckpoint`/`requested`/`run`/`stopping`） | 同 |
| `readyToDrive`：fiber 活跃 + agent 仍活着 + `idle` + 无竞争排队 | 同 |
| `requestDrive`：触发合并成**一条** agent 局部串行 run（`withoutInitiator` + while + retire） | 同 |
| `drive`：耐久检查点（`ctx.sessions.flush`）→ 收尾上一轮预约 → 决策 → 落副作用/投下一轮 | 同 |
| `agent.followup(createUserMessage(...))` + `attempt` 预约（消息身份精确比对） | 同（来源自署 `work`，绝不冒充人） |
| `turn/end` 停止信号：`aborted` ⇒ 被取消的回合把任务落盘暂停（空闲边界），不是我们那一轮 ⇒ 收回续跑许可；`max-tokens` ⇒ 收回许可 | 同（goal 的 pause ⇔ 任务 pause；disarm ⇔ `rounds.activation`） |
| `goal.activation !== 'armed'` ⇒ 一拍不推进（会话 resume 自动 disarm） | 同（读归属记录的 `rounds.activation`；`agent/created` 的 `source === 'resume'` 时落 `disarmed`） |
| `goal/changed` 触发驱动（人的 `resume` 也在这一步生效） | 同形但**多一格**：`session/event` 的 `goal/change` 且 `operation === 'resume'`（= 人说"继续"）⇒ 把流程许可一起放回（`disarmed` → `armed`）并立刻推一拍。**两个许可位各管各的，而恢复口令只有一个**——只放回 goal 那一半，流程仍冻着，且 disarmed 时连副作用都不落（auto 收口 / 开工 / 规划轮全停），会话里看不出异常（真机：盯盘流程 5/5 任务全达成、auto 收口永远不落）。反向**不联动**：goal 被 block / complete 时流程许可不动 |
| `agent/inbox/inserted｜claimed｜discarded` 竞态围栏（`sameQueued`：内容 + 来源逐字节深比对，不只看消息 id） | 同 |
| `agent/pre-step` waterfall 三段式：进步骤前验预约、拿到 enter 后再验一次，不过 ⇒ 置 stale + 撤预约 + 放回同批其它消息 + 重拍 + `reject` | 同（七核判据映射见下节） |
| `agent/error` / `drive()` 失败 ⇒ 收回续跑许可（不许静默重试）；投递失败 ⇒ 落 block（`queue-failed`）；下游 reject ⇒ 落 block（`prompt-rejected`） | 同（goal 的 `ctx.goals.block` ⇔ 域服务 `blockTask` 直调——不走工具面"撑满 N 轮"门槛，那是管 agent 的纪律） |
| 装载时对在场 agent 全部 disarm；卸载 ⇒ 收许可 + 预约置 stale + cancel 在跑回合 + 等 idle/run 收尾 | 同 |
| `wrapup` 模块：终局（complete / blocked）投一轮让模型给用户写结束语 | 同（`wrapupDeliveryOf` → `<workprocess_done>` / `<workprocess_blocked>`；收口是静默写，没有这一轮人分不清"跑完"与"卡死"） |
| （无） | **多一格：停手通告轮**——许可被驱动器自己收回（耐久记号 `activationBy = 'driver'`：`disarmOnResume` 等）且**有该推进的事**时投一轮（`notice: 'disarmed'` → `<workprocess_disarmed>`），把"驱动器停手了、怎么放回"说出口。不消耗回合预算；围栏**反核**：它进步骤时许可须仍是 `disarmed`（被放回后拒收，不许谎报停手）；每实例每条流程只喊一次；`activationBy = 'human'`（人亲手按的）不喊 |
| `ctx.effect(function* () { ... })` 挂监听 + `ctx.logger.warn` | 同 |

## pre-step 围栏（进步骤前的预约校验，fail closed）

宿主 `validReservation` 七核在本域的映射（每一条不过关 ⇒ 拒收，整个提议步骤丢弃）：

| 宿主核 | 本域映射 |
|---|---|
| fiber active + !stopping | 同 |
| 预约存在且 `phase === 'claimed'` + !stale | 同（stale 由 `inbox/inserted` 竞争插队落笔——写了不读的死代码已根治） |
| sameQueued：content + source 逐字节深比对 | 同；来源比对覆盖**全部**自署字段（processId/stageKey/taskId/revision/round/maxRounds/blockedAfterRounds） |
| goal 仍是那个 id/revision 且 active+armed | 流程仍是那个 id 且许可 `armed`；任务轮另要求任务仍 active 且 revision 相符 |
| `source.round === roundsStarted + 1`（恰好下一回合） | **预算按任务计，闸也按任务判**：`round === 该任务 rounds.tasks[taskId].rounds + 1` |

**规划 / 确认 / 收束轮**（无 round）过**轻闸**：锚流程 revision + 形状与当前流程状态相符——
直接复用不变量伴生件的重建判据（`invariant.ts` 的 `reconstructDelivery`），两处共一个实现，不漂移。

三段式时序：进步骤前验一次（不过 ⇒ 拒）；`await next()` 抛错且非 abort ⇒ 撤预约 + 重拍 + 重抛；
拿到 enter 决策后**再验一次**（等下游的期间状态可能已变）；全过 ⇒ `{ ...decision, startsRequestSeries: true }`。
**`restoreOtherClaimed` 是正确性的一部分**：reject 丢弃整个提议步骤，同批其它消息（人的话）必须放回 `next-step`。
拒收 = 这一轮没送到：投递期的去重记号（任务轮的回合键 / 规划·确认轮的内存记号）一并作废，重拍才投得出新的一份——
边界如实承认：规划 / 确认轮的**耐久**"已问过"记号同修订仍挡着重问，要等下一次域变更（修订前进）才自动重投。

数据**只经 `ctx.workprocess`**（存储域由领域插件独占打开：`storageDomain.open` 对同名域是响亮拒绝）。

## 投递与策略段的分工（优化过的口径）

**原则**：策略段 = 跨轮不变的**行为约束**；投递 = 这一轮的**客观数据 + 唯一动作 + 本轮特有停手条件**。
投递里**不复述策略**（复述的代价是每轮都进上下文）。

| 段 | 内容 | 体量（字符） |
|---|---|---|
| 策略段 `tool:workprocess`（常驻一次） | 阶段串行 / 谁能落 done / 预算与 block 门槛 / 标签语义 / 终局收束 / 续跑许可 | 935 |
| 任务轮（**每轮**） | 目标回响 · 阶段与判据 · **本轮任务号** · 轮号与上限 · **本阶段收口策略**（逐阶段数据） · 停手条件 | 315（原 424，-26%） |
| 规划轮（每阶段） | 目标 · 阶段与判据 · **只建任务不动手** · 一行理由 · 空转就停手 | 408（原 619，-34%） |
| 确认轮 / 收束轮 | 人机确认路径与三种结局 / 终局结束语合同 | 253–665（基本未动：那几条不直观，必须完整） |

**顺带修掉一个坑**：任务轮原来写「推不动就 block」却**没提门槛** ⇒ 模型照做会被 `WORK_TOOL_BLOCK_THRESHOLD` 拒、白跑一轮。
现在停手条件里明写「**先撑满 N 轮**（不足就落 block 会被拒）」，并有断言锁住。

**N 从哪来（两处必须同值）**：真正拒 `block` 的是**工具面**（`tool-workprocess` 的 `blockedAfterRounds`，
抛 `WORK_TOOL_BLOCK_THRESHOLD`），驱动器只决定"投给模型的提示词里写几轮"。两个包各自独立装载（一包一 patch），
驱动器读不到工具面的 `config` ⇒ 只能靠两处装载行写同一个数（都写 3），并由全栈门禁钉住"两边的缺省一致"
（`workprocess/tests/plugin.spec.ts` 的「门槛数字两处必须同值」）。**写死的代价**（本条修的就是它）：
提示词说 3、工具面按 5 拒 —— 模型白跑一轮。

数字随来源自署（与 `maxRounds` 同款）：`blockedAfterRounds` 是装载配置、不在持久状态里，
不变量伴生件要靠它才能逐字节重建这一轮的载荷（老日志没有这个字段 ⇒ 回落缺省 3）。

## 停止语义（宿主 stop 按钮为什么现在真的停得住）

真机 bug：人点宿主 stop 按钮，agent 停了一下立刻又跑——因为驱动器只在"agent 空闲"时撤预约、
接着拍下一回合，`turn/end` 的**中止原因**根本没看。对齐宿主 goal driver 的同款纪律：

| 信号（`session/event`） | 驱动器的动作 |
|---|---|
| `user/message` 命中预约消息身份 | 预约记 `admitted`：这一轮**跑成过**的记号 |
| `turn/end` = `aborted`，中止的是我们那一轮 | 预约记 `cancelled`；随后的空闲边界把该任务**落盘暂停**（`paused`：停得看得见、`/work resume` 放行），**不再投下一轮** |
| `turn/end` = `aborted`，不是我们那一轮 | 收回续跑许可（`disarmed`）：自动推进就此停住，任务相位原样保留 |
| `turn/end` = `max-tokens` | 收回续跑许可：模型在给定预算内说不完 = 配置不适配，不许无限自动续跑 |
| `goal/change` = `resume`（人说"继续"） | **放回**续跑许可（`disarmed` → `armed`，幂等零写入；已经是 `armed` 就不写）：goal 的 `resume` 本身是真人专属动作，跟着放行不构成自己给自己发通行证。**但只放回 `activationBy = 'driver'` 的那一格**：人亲手按的停手（`'human'`，粘性记号）机器口令不许放回 |
| 空闲边界，许可 `disarmed` 且耐久记号是 `activationBy = 'driver'`（**驱动器自己落的停手**） | 投一条**停手通告轮**（若只读判定说"有该推进的事"）：每实例每条流程一次，不刷屏；人亲手按的（`'human'`，粘性记号）不喊——重启后驱动器的同值重写也覆盖不了它 |
| 空闲边界，上一轮没跑成（`queued`/`claimed` 或被丢弃） | 同上：**先落盘暂停，再考虑下一拍**——"停了又跑"的根治点 |
| 空闲边界，上一轮 `admitted` | 正常完成的回合：不暂停，接着投下一轮（否则每个回合都要人 resume） |

两条栏杆防误伤：① 暂停前校验**任务仍是 active 且修订相符**——人若在空闲转换前已 resume 落定
（修订前进），不会把新起的回合重暂停；② 许可已 `disarmed` 时驱动器不替人落暂停（停手就够了）。

## 配置（装载层 `config` 段）

| 键 | 缺省 | 作用 |
|---|---|---|
| `tick` | `true` | 关掉 = 一条监听都不挂（等于没装驱动器，状态迁移全靠人/模型显式调） |
| `drive` | `false` | 是否自动**投递续跑回合**（本仓装载层打开）；关掉仍会落开工/收口/block |
| `defaultMaxRounds` | `20` | 任务没写 `max_rounds` 时的生效上限（自动续跑必须有刹车） |
| `blockedAfterRounds` | `3` | 投递里写几轮门槛；**必须与 `tool-workprocess` 的同名配置取同一个数**（拒 block 的是那边） |
| `close` | `'auto'` | 流程收口：`auto` = 最后一段 done 即落 close；`human` = 投「请判」轮（判了不落定） |
| `disarmOnResume` | `true` | 会话 `resume`（宿主重启后加载）⇒ 自动收回续跑许可（`disarmed`，一拍不推进），要人 `arm` 才继续；设 `false` = 跨重启接着自动跑 |
| （无开关） | — | 同会话 goal 被 `resume` ⇒ 流程许可跟着放回（`goal/change` 的 `resume`）。这是**纪律**不是配置：没有它，"继续"这一个口令只管半个系统 |

## "已经问过"的记号（耐久：跨重启不重复打扰）

规划轮与收口确认轮各有一次"同一件事只问一次"的去重，记号**落在归属记录里**（`asked`：

`{ plan: { key, revision }, ask: { key, revision } }`），规则是**修订一变即作废**：

| 情形 | 行为 |
|---|---|
| 进程内重复空闲 | 不重复问（内存快挡 + 耐久记号） |
| 宿主重启、状态**没变** | 不重复问（耐久记号仍与当前修订相符） |
| 状态变过（建了任务 / 进下一阶段 / 换了阶段表） | 记号作废，该问就问 |
| 流程被丢弃后重建 | 记号在丢弃时一并清（否则新流程可能撞上旧记号：同阶段键 + 同 revision） |

比对用的**当前修订**（`askedRevision`）长在**每 agent 的驱动状态**上、每拍 `drive()` 开头重读——
它曾经是 apply 级共享变量：两个会话的驱动拍在 `await` 点交错时互相覆盖，A 会话的修订会被拿去判
B 会话的"已问过"（重复打扰，或记号修订恰好撞上对方的当前修订时误判已问、流程静默停死）。
多会话并行场景下各读各的，互不串扰（有双 agent 交错用例钉住两个方向）。

## 它回答四件事

| 问题 | 落在哪 |
|---|---|
| 该会话归属吗 | `work.sessionKey` vs `scope.ownerSessionId`（两侧都缺 = 放行，只有明确不等才拦） |
| 现在该不该跑 | 闸只有三道，都是"这件事问过没有"：阶段规划轮已问过 / 收口确认已问过 / 流程自动收口（`autoClose`） |
| **层1**：阶段开工了吗 / 该收口了吗 | 阶段 `pending` 且串行门放行 → `start-stage`；全阶段 `done` → `ask-close`；任务全 `complete` → 策略 `auto` 则 `close-stage`（自动收口），策略 `human`（缺省）则 `ask-stage-done`（请人确认）。两种 ask 都是**请人拍板**：组合根各投一轮让 agent 开口（闸 `humanAskBlocked` 保证同一件事只问一次） |
| **层2**：这一轮跑哪个任务 | `active` 任务 → `drive`；**回合作顶**（任务自己的 `rounds` ≥ 它的生效上限 `maxRounds`）→ `block-task`（落盘）；`paused/blocked` → `wait-human`；**本阶段一个任务都没有 → `plan-stage`**（投一轮让 agent 建任务） |

**回合预算按任务计**：`TaskFacts.rounds` = **这个任务**已准入的回合数（归属记录 `rounds.tasks[<id>].rounds`），
闸比的是它而不是全流程累计数——早先拿累计数当每任务上限，第二个任务会继承前一个的消耗、一开拍就判到顶。
`TaskFacts.maxRounds` 是**生效上限** = 任务基础上限 × (1 + `grants`)（`grants` = 人 `resume` 追加的预算份数，
`effectiveCapOf` 一处换算）。全流程累计数（`rounds.started`）现在只有一个读者：`/work` 的"全程累计"读数
（落 block 的轮数门槛也改成读**该任务的账**——同一类错误的第二处：全局计数替按任务问的问题答话）。

**决策层不臆造任务，但会把"这个阶段是空的"交给 agent**：阶段串行 ⇒ 任务只属于当前阶段 ⇒
**每过一个阶段边界，新阶段必然没有任务**；此时若只是 `hold`，自动推进会在每个阶段边界上停死。
故落 `plan-stage`（投一轮"用 `create_worktask` 给本阶段建任务"——建几个由 agent 定）；
同一阶段**只问一次**（闸 `stagePlanBlocked`，组合根按阶段键记），问过就转 `wait-human`——不空转。

## 导出

| 导出 | 作用 |
|---|---|
| `decideWorkRound(input)` | 纯决策树（零 I/O，可穷举单测）；结论穷尽十态 |
| `renderWorkRoundPrompt(input)` | 纯提示词渲染：流程目标 / 当前阶段与判据 / 本轮任务 / 边界（含"不越阶段开工"与**收口策略**写的"请人确认 / 自动收口"）/ 停手条件 |
| `renderWorkPlanPrompt(input)` | **阶段规划轮**提示词：本阶段开工了却没任务 ⇒ 请 agent 用 `create_worktask` 给本阶段建任务（**只建、不动手**：动手会绕过任务轮的回合预算与 block 门槛） |
| `renderWorkNoticePrompt(input)` | **停手通告轮**提示词（`<workprocess_disarmed>`）：说清停在哪一段、驱动器为什么不动、怎么放回（`/work arm` / 说一句"继续"），并明确**本轮不能自己 arm**（真人专属，自治回合里调会被拒） |
| `renderWorkAskPrompt(input)` | **收口确认轮**提示词（三种投递都包在 `<workprocess_round>` / `<workprocess_plan>` / `<workprocess_ask>` 标签里，与宿主 `<goal_round>` 同款：便于模型分清「自动回合」与「人说的话」）：任务全达成（策略 `human`）或全阶段 done ⇒ 请 agent 向人拍板（`ask_user_question`），并给回落定路径 |
| 契约类型 | `RoundScopeFacts` / `GateFacts` / `WorkFacts` / `StageFacts` / `TaskFacts` / `DecideInput` / `RoundDecision` |

## 决策顺序（顺序即纪律）

```
归属 → 可驱动（意图 + 健康 + 无暂停告警）
     → 闸（规划轮已问过 / 确认轮已问过 / 流程自动收口）
     → 层1（串行门 / 收口：按阶段收口策略分流） → 层2（相位机 / 回合上限）
```

**收口分流的判据只有一条**：任务非空且全 `complete` 之后，看当前阶段的 `closePolicy`——
`auto` 落 `close-stage`（驱动器自己写 done），`human`（缺省）落 `ask-stage-done`（请人确认）。
两种策略都**不会**放过"没全完成就收口"：策略只管"谁落 done"，不管"够不够格落"。

**流程级收口仍是人的判断**：全阶段 `done` → `ask-close`（流程没有"完成"态，"成没成"是判据）。

**副作用由组合根落**（驱动器是纯函数，不下笔）：`start-stage` ⇒ `startWorkStage`、
`close-stage` ⇒ `completeWorkStage`、`block-task` ⇒ `blockWorkTask`。
本仓的组合根就是 `workprocess`（本包只**注入**它提供的 `ctx.workprocess`：一拍读现状、
副作用经它下笔；`drive` 的投递在本包装配的**回合边界触发器**里
（`agent.followup` + 自署 `work` 来源；`drive` 与 `plan-stage` 两种投递都在那里）。

## 测试

```bash
cd workprocess-round-driver && pnpm test   # 107 条：闸顺序 / 串行门 / 收口策略 / 相位机 / 回合上限（**按任务计**）/ 规划轮 / 提示词（含门槛随配置）/ 不变量伴生件（含门槛自署）/ 停止语义（turn/end aborted ⇒ 落盘暂停或收回许可；`interrupted` 是崩溃孤儿补记、**故意不处理**）/ **goal resume ⇒ 流程许可跟着放回**（human 记号不放回）/ **停手通告轮（说出口 + 只喊一次 + 只读判定 + 围栏反核）** / pre-step 围栏（拒过期 · 拒 stale · 放回同批消息 · 下游 reject 落 block · 校验异常收许可）/ 装载卸载纪律
```
