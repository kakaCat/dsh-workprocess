# workprocess-round-driver

**以两层工作模型为基础的回合驱动器**：本包是**库而非插件**——没有独立挂载项、没有配置项，
由调用方的组合根接成驱动器后生效（形状对齐宿主 `packages/goal/goal-round-driver`）。

## 它回答四件事

| 问题 | 落在哪 |
|---|---|
| 该会话归属吗 | `work.sessionKey` vs `scope.ownerSessionId`（两侧都缺 = 放行，只有明确不等才拦） |
| 现在该不该跑 | 六道闸：内存闭锁 → 退避 → 进程级上游 → 人工确认/弹框（wait-human）→ 起链预算 |
| **层1**：阶段开工了吗 / 该收口了吗 | 阶段 `pending` 且串行门放行 → `start-stage`；全阶段 `done` → `ask-close`；任务全 `complete` → 策略 `auto` 则 `close-stage`（自动收口），策略 `human`（缺省）则 `ask-stage-done`（请人确认） |
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
本仓的组合根就是 `dsh-workprocess`（回合边界驱动 `src/driver.ts`）；`drive` 的投递也在那里
（`agent.followup` + 自署 `work` 来源；`drive` 与 `plan-stage` 两种投递都在那里）。

## 测试

```bash
cd workprocess/workprocess-round-driver && pnpm test   # 25 条：闸顺序 / 串行门 / 收口策略 / 相位机 / 回合上限 / 规划轮 / 提示词
```
