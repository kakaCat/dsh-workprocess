/**
 * 阶段表（层1）的**结构投影**：当前阶段是谁、串行顺序怎么走、串行门怎么读。
 *
 * 【为什么单独立一个模块】同一件事有三处要问——驱动（`StageFacts` 的当前阶段）、
 * 工具面（`get_workstage` 的 `current_stage` / `allows_start`）、折叠（`stage-start` 的串行门）。
 * 各写一份 `findIndex(s => s.state !== 'done')` 或 `slice(0, i).every(...)` 必然漂移，
 * 于是会出现"驱动认为该开工、工具面说没到时候"这类无法判定的分歧。
 *
 * 【边界】这里只做**读投影**（纯函数、零 I/O）；阶段的**状态规则**（事件表、确认判据）仍在
 * `fold.js`——`stageAllowsStart` 在本文件之上只加"本阶段是 pending"这一条。
 *
 * 本包**不预置任何阶段键**：阶段表由调用方定义（大数据 / 训练 / 发布各不同），
 * 这里只给投影——模板属于调用方的领域。
 *
 * @module workprocess/stages
 */
import type { WorkProcess, WorkStage } from './types.js'

/** 阶段在串行顺序里的下标（不存在 ⇒ -1）。 */
export function stageIndexOf(process: WorkProcess, key: string): number {
  return process.stages.findIndex((s) => s.key === key)
}

/**
 * **当前阶段** = 串行顺序里第一个非 `done` 的阶段（全阶段 done ⇒ undefined）。
 * 这是"我们现在走到哪一段"的唯一口径（收口判断见 `processAllowsClose`）。
 */
export function currentStageOf(process: WorkProcess): WorkStage | undefined {
  const index = process.stages.findIndex((s) => s.state !== 'done')
  return index < 0 ? undefined : process.stages[index]
}

/** 串行顺序里紧跟某阶段的下一个阶段（不存在 ⇒ undefined）。 */
export function nextStageOf(process: WorkProcess, key: string): WorkStage | undefined {
  const index = stageIndexOf(process, key)
  return index < 0 ? undefined : process.stages[index + 1]
}

/**
 * **串行门的前半**：该阶段的**前序阶段是否全部 `done`**（阶段不存在 ⇒ false）。
 * `stageAllowsStart`（fold）在本判据之上只加一条"本阶段是 `pending`"。
 */
export function previousStagesDone(process: WorkProcess, key: string): boolean {
  const index = stageIndexOf(process, key)
  if (index < 0) return false
  return process.stages.slice(0, index).every((s) => s.state === 'done')
}
