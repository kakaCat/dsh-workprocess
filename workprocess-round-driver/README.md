# workprocess-round-driver

**回合驱动器插件**（对齐宿主 `@deepseek-ai/dsh-goal-round-driver`）：`name` / `inject` / `apply(ctx, config)`，
**独立装载行**（`cordis.patch.yml` 的第二条，紧跟领域插件）。职责：agent 空闲时把流程往前推——
落"不需要人"的副作用（开工 / auto 收口 / 落盘 block / 流程收口），并投递下一轮（任务轮 / 阶段规划轮 / 收口确认轮）。

## 模块与设计（与宿主逐条对应）

| 模块 | 内容 |
|---|---|
| `src/index.ts` | 插件壳 + 运行时（事实投影 · 一拍 · 投递）+ 消息来源声明（`kind: 'work'`） |
| `src/decide.ts` | 契约类型 + 决策树（**纯层**：零 I/O、零宿主依赖，可穷举单测） |
| `src/prompt.ts` | 三种轮次的提示词渲染（纯字符串函数） |

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
| `goal.activation !== 'armed'` ⇒ 一拍不推进（会话 resume 自动 disarm） | 同（读归属记录的 `rounds.activation`；`agent/created` 的 `source === 'resume'` 时落 `disarmed`） |
| `agent/inbox/inserted｜claimed｜discarded` 竞态围栏 | 同 |
| `ctx.effect(function* () { ... })` 挂监听 + `ctx.logger.warn` | 同 |

数据**只经 `ctx.workprocess`**（存储域由领域插件独占打开：`storageDomain.open` 对同名域是响亮拒绝）。

## 配置（装载层 `config` 段）

| 键 | 缺省 | 作用 |
|---|---|---|
| `tick` | `true` | 关掉 = 一条监听都不挂（等于没装驱动器，状态迁移全靠人/模型显式调） |
| `drive` | `false` | 是否自动**投递续跑回合**（本仓装载层打开）；关掉仍会落开工/收口/block |
| `defaultMaxRounds` | `20` | 任务没写 `max_rounds` 时的生效上限（自动续跑必须有刹车） |
| `close` | `'auto'` | 流程收口：`auto` = 最后一段 done 即落 close；`human` = 投「请判」轮（判了不落章） |
| `disarmOnResume` | `true` | 会话 `resume`（宿主重启后加载）⇒ 自动收回续跑许可（`disarmed`，一拍不推进），要人 `arm` 才继续；设 `false` = 跨重启接着自动跑 |

## 它回答四件事

| 问题 | 落在哪 |
|---|---|
| 该会话归属吗 | `work.sessionKey` vs `scope.ownerSessionId`（两侧都缺 = 放行，只有明确不等才拦） |
| 现在该不该跑 | 六道闸：内存闭锁 → 退避 → 进程级上游 → 人工确认/弹框（wait-human）→ 起链预算 |
| **层1**：阶段开工了吗 / 该收口了吗 | 阶段 `pending` 且串行门放行 → `start-stage`；全阶段 `done` → `ask-close`；任务全 `complete` → 策略 `auto` 则 `close-stage`（自动收口），策略 `human`（缺省）则 `ask-stage-done`（请人确认）。两种 ask 都是**请人拍板**：组合根各投一轮让 agent 开口（闸 `humanAskBlocked` 保证同一件事只问一次） |
| **层2**：这一轮跑哪个任务 | `active` 任务 → `drive`；回合作顶 → `block-task`（落盘）；`paused/blocked` → `wait-human`；**本阶段一个任务都没有 → `plan-stage`**（投一轮让 agent 建任务） |

**决策层不臆造任务，但会把"这个阶段是空的"交给 agent**：阶段串行 ⇒ 任务只属于当前阶段 ⇒
**每过一个阶段边界，新阶段必然没有任务**；此时若只是 `hold`，自动推进会在每个阶段边界上停死。
故落 `plan-stage`（投一轮"用 `create_worktask` 给本阶段建 1–3 个任务"）；
同一阶段**只问一次**（闸 `stagePlanBlocked`，组合根按阶段键记），问过就转 `wait-human`——不空转。

## 导出

| 导出 | 作用 |
|---|---|
| `decideWorkRound(input)` | 纯决策树（零 I/O，可穷举单测）；结论穷尽十态 |
| `renderWorkRoundPrompt(input)` | 纯提示词渲染：流程目标 / 当前阶段与判据 / 本轮任务 / 边界（含"不越阶段开工"与**收口策略**写的"请人确认 / 自动收口"）/ 停手条件 |
| `renderWorkPlanPrompt(input)` | **阶段规划轮**提示词：本阶段开工了却没任务 ⇒ 请 agent 用 `create_worktask` 给本阶段建任务并直接动手 |
| `renderWorkAskPrompt(input)` | **收口确认轮**提示词（三种投递都包在 `<workprocess_round>` / `<workprocess_plan>` / `<workprocess_ask>` 标签里，与宿主 `<goal_round>` 同款：便于模型分清「自动回合」与「人说的话」）：任务全达成（策略 `human`）或全阶段 done ⇒ 请 agent 向人拍板（`ask_user_question`），并给回落章路径 |
| 契约类型 | `RoundScopeFacts` / `GateFacts` / `WorkFacts` / `StageFacts` / `TaskFacts` / `DecideInput` / `RoundDecision` |

## 决策顺序（顺序即纪律）

```
归属 → 可驱动（意图 + 健康 + 无暂停告警） → 闭锁 → 退避 → 上游闸
     → 人工确认 / 弹框在途（wait-human，等人不是故障）
     → 起链预算 → 层1（串行门 / 收口：按阶段收口策略分流） → 层2（相位机 / 回合上限）
```

**收口分流的判据只有一条**：任务非空且全 `complete` 之后，看当前阶段的 `closePolicy`——
`auto` 落 `close-stage`（驱动器自己写 done），`human`（缺省）落 `ask-stage-done`（请人确认）。
两种策略都**不会**放过"没全完成就收口"：策略只管"谁落 done"，不管"够不够格落"。

**流程级收口仍是人的判断**：全阶段 `done` → `ask-close`（流程没有"完成"态，"成没成"是判据）。

**副作用由组合根落**（驱动器是纯函数，不下笔）：`start-stage` ⇒ `startWorkStage`、
`close-stage` ⇒ `completeWorkStage`、`block-task` ⇒ `blockWorkTask`。
本仓的组合根就是 `workprocess`（回合边界驱动 `src/driver.ts`；`drive` 的投递也在那里
（`agent.followup` + 自署 `work` 来源；`drive` 与 `plan-stage` 两种投递都在那里）。

## 测试

```bash
cd workprocess/workprocess-round-driver && pnpm test   # 26 条：闸顺序 / 串行门 / 收口策略 / 相位机 / 回合上限 / 规划轮 / 提示词
```
