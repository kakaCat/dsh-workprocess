/**
 * workprocess 域的**事件与变更词汇**（对齐宿主 `@deepseek-ai/dsh-goal/src/domain.ts`：
 * 宿主把"操作动词 + 耐久变更载荷"放这里，把纯类型留在 types.ts）。
 *
 * 【两层为什么共用一条变更流】两层是同一个聚合（`WorkProcess`）的两个面：
 * 阶段能不能开工要看"前序阶段的任务全完成"，任务完成会改所属阶段的可收口性——
 * 拆成两条流会让两者的重放顺序无法判定（谁先谁后都能自圆其说）。
 * 故：**一条流、一个 revision、一个 fold**。
 *
 * 【变更为什么同时带 event 与 process】宿主 goal 的变更只带全量快照，事件由快照反推
 * （goal 的动词简单，反推无歧义）。两层模型里 `stage-start` / `task-pause` 这类动词
 * 反推要靠 diff 前后快照，脆弱且难测——故**显式带事件 + 结果快照**：
 * 解码时两样都严格校验，迁移时用事件重算再与快照逐字段比对（规则的唯一权威仍是 fold）。
 *
 * @module workprocess/domain
 */
import type {
  WorkBlockReason, WorkProcess, WorkProcessId, WorkStageDraft, WorkTaskDraft, WorkTaskId,
} from './types.js'

/** 层0（流程）与层1（阶段）的动词。 */
export type WorkProcessOperation = 'init' | 'stage-define' | 'stage-start' | 'stage-done'

/** 层2（任务）的动词（逐条对齐宿主 `GoalOperation`：create/edit/pause/resume/block/complete/clear）。 */
export type WorkTaskOperation =
  | 'task-create' | 'task-edit' | 'task-pause' | 'task-resume' | 'task-block' | 'task-complete' | 'task-clear'

/** 一条变更的动词（两层并集；`WorkChange.event` 的判别键）。 */
export type WorkOperation = WorkProcessOperation | WorkTaskOperation

/**
 * 状态机事件（纯函数 `applyWorkEvent` 的输入；**唯一一份**状态规则）。
 *
 * `init` 之外的事件都不携带"结果"——结果由 fold 从当前状态算出，
 * 这正是"事件表是唯一规则"的落点。
 */
export type WorkEvent =
  /** 建流程：把阶段表一起定下来（没有阶段的流程没有意义）。 */
  | { readonly kind: 'init'; readonly id: WorkProcessId; readonly objective: string; readonly stages: readonly WorkStageDraft[] }
  /** 整体替换阶段表（同名阶段保留其任务与态；会被丢掉的非空阶段一律拒，见 `WORK_STAGE_HAS_TASKS`）。 */
  | { readonly kind: 'stage-define'; readonly stages: readonly WorkStageDraft[] }
  /** 阶段开工（串行门：前序阶段必须全 `done`）。 */
  | { readonly kind: 'stage-start'; readonly stageKey: string }
  /** 阶段收口（**人工确认路径专属**：本阶段任务须全 complete）。 */
  | { readonly kind: 'stage-done'; readonly stageKey: string }
  /** 建任务（id 由调用方按 `WorkTaskId()` 分配；`done` 阶段不许再建）。 */
  | { readonly kind: 'task-create'; readonly task: WorkTaskDraft }
  /** 改任务（对齐宿主 `edit`）：换陈述 / 换回合上限，**至少要给一项**。 */
  | { readonly kind: 'task-edit'; readonly taskId: WorkTaskId; readonly objective?: string; readonly maxRounds?: number }
  /** 任务被中断/人工干预：active → paused。 */
  | { readonly kind: 'task-pause'; readonly taskId: WorkTaskId }
  /** 继续：paused / blocked → active。 */
  | { readonly kind: 'task-resume'; readonly taskId: WorkTaskId }
  /** 阻塞（等上游/等人裁）：**必须给原因**。 */
  | { readonly kind: 'task-block'; readonly taskId: WorkTaskId; readonly reason: WorkBlockReason }
  /** 达成：终态，不可逆（重开 = 新建任务）。 */
  | { readonly kind: 'task-complete'; readonly taskId: WorkTaskId }
  /** 清任务：摘掉但它占过的编号**不复用**（墓碑留在流程快照里，`clearedAt` 由调用方注入时钟）。 */
  | { readonly kind: 'task-clear'; readonly taskId: WorkTaskId; readonly clearedAt: number }

/** 事件的动词（`WorkOperation` 与 `WorkEvent['kind']` 同源，避免两处各写一份）。 */
export type WorkEventKind = WorkEvent['kind']

/**
 * 一条耐久变更：**事件 + 变更后的全量快照**（对齐宿主"每次非 clear 变更都写全量快照"）。
 *
 * 全量快照让重放可自校验（`applyWorkChange` 用事件重算，与记录逐字段比对），
 * 也让读面不必重放完整历史即可拿到当前值。
 */
export interface WorkChange {
  readonly kind: 'work/change'
  readonly version: 1
  readonly event: WorkEvent
  /** 变更后的全量快照（含 `revision`；`changed:false` 的幂等重放**不产出**变更）。 */
  readonly process: WorkProcess
}

/** 投给模型看的续跑消息源（对齐宿主 `GoalMessageSource`）。 */
export interface WorkMessageSource {
  readonly kind: 'work'
  readonly processId: string
  /** 这一回合跑的任务（回合的落点；两层模型里"跑的是层2"）。 */
  readonly taskId: string
  readonly revision: number
  /** 正整数的已准入回合号。 */
  readonly round: number
}

/**
 * `work/changed` 变更通知（对齐宿主 cordis 事件 `'goal/changed'`）：
 * 每次**有效写入**后发出，监听器（驱动/诊断面）据此感知两层迁移。
 *
 * 本包不依赖宿主的事件总线，故做成 `WorkDeps.onChanged` 注入端口：**写成功才发**，
 * 携带与耐久状态同源的全量变更（不是第二份状态）。
 */
export interface WorkChangedNotification {
  readonly processId: string
  readonly change: WorkChange
}

/** 事件在当前状态下不成立时的原因（进日志/诊断，不进记录）。 */
export interface WorkRejection {
  readonly changed: false
  readonly reason: string
}
