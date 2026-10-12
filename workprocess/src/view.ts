/**
 * workprocess 的**只读线投影**（浏览器数据面 `GET /workprocess/api/stages` 与 SSE 帧吃的全量快照）。
 *
 * 【为什么单独一层】工具面（`get_workstage` / `get_worktask`）与 HTTP 数据面要的是**同一份字段**——
 * 字段名以工具面回执为准（`tool-workprocess/src/tools.ts` 的 `getWorkstage` / `taskView`），
 * 本模块把它抽成纯函数，两处共用，避免各写一套后漂移。
 *
 * 【纯函数纪律】零 I/O、不读时钟、不抛异常：入参是 `WorkProcess` 快照（+ 可选续跑许可读数），
 * 出参是可 `JSON.stringify` 的完整线值。`scope` 不属于流程本身，由调用方（HTTP 处理器）包一层。
 *
 * @module workprocess/view
 */
import { currentStageOf, stageClosePolicyOf } from './stages.js'
import { allTasksOf, processAllowsClose, stageAllowsStart } from './fold.js'
import type { WorkActivation, WorkProcess, WorkStage, WorkStageState, WorkTask, WorkTaskPhase } from './types.js'

/** 一段的线值（字段名与 `get_workstage` 回执的 `stages[]` 逐字相同）。 */
export interface WorkStageWire {
  readonly key: string
  readonly statement: string
  readonly state: WorkStageState
  /** 达成判据（未登记时为空数组——缺失 ≠ 空表，空数组只是"没有登记"的显式形状）。 */
  readonly done_criteria: readonly string[]
  readonly close_policy: 'human' | 'auto'
  /** 本阶段任务总数。 */
  readonly tasks: number
  /** `phase === 'complete'` 的任务数。 */
  readonly tasks_done: number
}

/** 一个任务的线值（字段名与 `get_worktask` 回执的 `tasks[]` 逐字相同）。 */
export interface WorkTaskWire {
  readonly id: string
  readonly stage_key: string
  readonly objective: string
  readonly phase: WorkTaskPhase
  readonly revision: number
  readonly blocked_reason?: string
  readonly blocked_message?: string
  readonly max_rounds?: number
}

/** 全量线值：`GET /workprocess/api/stages` 的响应体（`scope` 由调用方补）。 */
export interface WorkWire {
  readonly process_id: string
  readonly objective: string
  readonly revision: number
  readonly stages: readonly WorkStageWire[]
  /** 当前阶段键（全收口 ⇒ `null`）。 */
  readonly current_stage: string | null
  readonly allows_start: boolean
  readonly allows_close: boolean
  /** 流程收口时间戳（缺省 = 未收口）。 */
  readonly closed_at?: number
  /** 续跑许可读数（归属记录里没有时缺省）。 */
  readonly activation?: WorkActivation
  readonly tasks: readonly WorkTaskWire[]
}

/** 一段 → 线值（与 `getWorkstage` 的 `stages.map` 同一口径）。 */
function stageWire(stage: WorkStage): WorkStageWire {
  return {
    key: stage.key,
    statement: stage.statement,
    state: stage.state,
    done_criteria: stage.doneCriteria,
    close_policy: stageClosePolicyOf(stage),
    tasks: stage.tasks.length,
    tasks_done: stage.tasks.filter((t) => t.phase === 'complete').length,
  }
}

/** 一个任务 → 线值（与 `taskView` 同一口径，含条件字段的缺省省略）。 */
function taskWire(task: WorkTask): WorkTaskWire {
  return {
    id: task.id,
    stage_key: task.stageKey,
    objective: task.objective,
    phase: task.phase,
    revision: task.revision,
    ...(task.blockedReason === undefined
      ? {}
      : { blocked_reason: task.blockedReason.code, blocked_message: task.blockedReason.message }),
    ...(task.maxRounds === undefined ? {} : { max_rounds: task.maxRounds }),
  }
}

/**
 * 流程快照 → 全量线值。
 * @param process - 当前流程快照（调用方保证非空；没有流程时不调本函数）。
 * @param activation - 续跑许可读数（缺省 = 省略该键）。
 */
export function workWireOf(process: WorkProcess, activation?: WorkActivation): WorkWire {
  const current = currentStageOf(process)
  return {
    process_id: process.id,
    objective: process.objective,
    revision: process.revision,
    stages: process.stages.map(stageWire),
    current_stage: current?.key ?? null,
    allows_start: current !== undefined && stageAllowsStart(process, current.key),
    allows_close: processAllowsClose(process),
    ...(process.closedAt === undefined ? {} : { closed_at: process.closedAt }),
    ...(activation === undefined ? {} : { activation }),
    tasks: allTasksOf(process).map(taskWire),
  }
}
