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

/** 流程（聚合根）与阶段（层1）的动词。 */
export type WorkProcessOperation = 'init' | 'objective-edit' | 'stage-define' | 'stage-start' | 'stage-done'

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
  /**
   * **改流程目标**（对齐宿主 `update_goal` 的 `edit`）：换掉整条流程要达成什么。
   *
   * 【为什么必须有它】目标变了而阶段表还是按旧目标拆的，流程就成了"名义上在跑、实际跑偏"——
   * 而在此之前 `objective` 只在 `init` 确立，改目标的唯一办法是丢弃重来（那会连着任务与墓碑一起没）。
   * 授权面把它判成**真人专属**（同宿主口径）：改人的意图只有人能发起。
   */
  | { readonly kind: 'objective-edit'; readonly objective: string }
  /**
   * **流程收口**（方案 B 的轻量落点）：全部阶段 done 后落一个终止水印。
   *
   * 【为什么需要它】"流程没有完成态"的原则不变（成没成是判据，不是第四个状态），但记录
   * 不能永远停在"具备收口条件"：不收口就没有终点的落点，开新流程只有抹掉（discard）一条路。
   * 收口后 fold 入口的总闸会拒掉一切后续写（`discard` 除外）——**记录终止，判据留在阶段表里**。
   * 没有 verdict 三档：轻量方案，判据本身就是全阶段 done。
   */
  | { readonly kind: 'process-close'; readonly closedAt: number }
  /** 整体替换阶段表（同名阶段保留其任务与态；会被丢掉的非空阶段一律拒，见 `WORK_STAGE_HAS_TASKS`）。 */
  | { readonly kind: 'stage-define'; readonly stages: readonly WorkStageDraft[] }
  /** 阶段开工（串行门：前序阶段必须全 `done`）。 */
  | { readonly kind: 'stage-start'; readonly stageKey: string }
  /** 阶段收口（本阶段任务须全 complete；**谁有权落**由阶段收口策略定：human = 人工确认，auto = 自动收口）。 */
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
  /** 归属键（`processId` 去掉 `wp:` 前缀）：事件载荷按它路由。 */
  readonly scope: string
  readonly change: WorkChange
}

/** 事件在当前状态下不成立时的原因（进日志/诊断，不进记录）。 */
export interface WorkRejection {
  readonly changed: false
  readonly reason: string
}

/**
 * **域错误码**（闭联合；随 {@link WorkError} 抛出）——域边界能给的**全部**机器可路由分类。
 *
 * 【为什么住在这里】对齐宿主 `@deepseek-ai/dsh-goal`：`GoalErrorCode` 就写在域词汇表
 * `goal/src/domain.ts` 里（与 `GoalOperation` 同一处），`runtime.ts` 只 `import type` 进来给
 * `GoalError` 用。**工具面的政策码不在这里**——宿主那边是 `GOAL_TOOL_*` 前缀、抛在判据旁边；
 * 本仓对应的那本表在 `tool-workprocess/src/codes.ts`（`WORK_TOOL_*` 闭联合）。
 * 两套词汇的判据：**域码 = 状态规则说"这样不成"；工具码 = 工具面自己加的牙**（授权、纪律、
 * 参数形状）。写在 const 数组里（而不是裸联合）是为了让守卫能机械检查两件事：
 * 每个码都带 `WORK_` 前缀、且没有一个 `WORK_` 码混进 `WORK_TOOL_` 那一本。
 */
export const WORK_ERROR_CODES = [
  /** 该归属没有流程（读/写的前提不成立）。 */
  'WORK_NO_PROCESS',
  /** 按 id 找不到任务 / 阶段。 */
  'WORK_NOT_FOUND',
  /** 建流程/建任务却没给陈述（空 objective 写进去就是自造坏记录）。 */
  'WORK_OBJECTIVE_REQUIRED',
  /** 同一个 id 想建成另一个东西（身份冲突）。 */
  'WORK_IDENTITY_CONFLICT',
  /** CAS 失败：调用方拿着旧 revision 在改（对齐宿主 `goalRef` 的乐观锁拒绝）。 */
  'WORK_CONFLICT',
  /** 阶段键不存在 / 重复 / 非法。 */
  'WORK_STAGE_NOT_FOUND',
  'WORK_STAGE_DUPLICATE',
  /** 串行门：前序阶段没全 done，本阶段不许开工。 */
  'WORK_STAGE_SERIAL_BLOCKED',
  /** 阶段收口条件不满足（本阶段还有没 complete 的任务）。 */
  'WORK_STAGE_NOT_READY',
  /** 整体替换阶段表会丢掉已有任务的阶段（静默丢任务是最坏的一类缺陷，故拒）。 */
  'WORK_STAGE_HAS_TASKS',
  /** 任务相位迁移不成立（终态不可逆 / 非 active 不许 pause 等）。 */
  'WORK_TASK_PHASE',
  /** block 没给结构化原因。 */
  'WORK_REASON_REQUIRED',
  /** 耐久快照/变更流解码失败：字段缺漏、类型不符或迁移链断裂（对齐宿主严格解码器）。 */
  'WORK_CORRUPT',
  /** 折叠结果违反域不变量（INV-1~6）——规则实现坏了，不是业务拒绝。 */
  'WORK_INVARIANT',
] as const

/** 域错误码（{@link WORK_ERROR_CODES} 的联合）。 */
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number]
