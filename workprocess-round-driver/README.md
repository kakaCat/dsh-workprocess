# workprocess-round-driver

**以两层工作模型为基础的回合驱动器**：本包是**库而非插件**——没有独立挂载项、没有配置项，
由调用方的组合根接成驱动器后生效（形状对齐宿主 `packages/goal/goal-round-driver`）。

## 它回答四件事

| 问题 | 落在哪 |
|---|---|
| 该会话归属吗 | `work.sessionKey` vs `scope.ownerSessionId`（两侧都缺 = 放行，只有明确不等才拦） |
| 现在该不该跑 | 六道闸：内存闭锁 → 退避 → 进程级上游 → 人工确认/弹框（wait-human）→ 起链预算 |
| **层1**：阶段开工了吗 / 该收口了吗 | 阶段 `pending` 且串行门放行 → `start-stage`；全阶段 `done` → `ask-close`；任务全 `complete` → `ask-stage-done` |
| **层2**：这一轮跑哪个任务 | `active` 任务 → `drive`；回合作顶 → `block-task`（落盘）；`paused/blocked` → `wait-human` |

**决策层不臆造任务**：阶段已开工却没有任务时 `hold('stage-has-no-runnable-task')`——
任务从哪来是上游（拆分/骨架）的事。

## 导出

| 导出 | 作用 |
|---|---|
| `decideWorkRound(input)` | 纯决策树（零 I/O，可穷举单测）；结论穷尽八态 |
| `renderWorkRoundPrompt(input)` | 纯提示词渲染：流程目标 / 当前阶段与判据 / 本轮任务 / 边界（含"不越阶段开工"）/ 停手条件 |
| 契约类型 | `RoundScopeFacts` / `GateFacts` / `WorkFacts` / `StageFacts` / `TaskFacts` / `DecideInput` / `RoundDecision` |

## 决策顺序（顺序即纪律）

```
归属 → 可驱动（意图 + 健康 + 无暂停告警） → 闭锁 → 退避 → 上游闸
     → 人工确认 / 弹框在途（wait-human，等人不是故障）
     → 起链预算 → 层1（串行门 / 收口） → 层2（相位机 / 回合上限）
```

## 测试

```bash
cd workprocess/workprocess-round-driver && pnpm test   # 18 条：闸顺序 / 串行门 / 相位机 / 回合上限 / 提示词
```
