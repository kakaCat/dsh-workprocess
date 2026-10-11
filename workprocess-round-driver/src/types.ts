/**
 * workprocess 驱动回合的**契约**（对齐宿主 `packages/goal/goal-round-driver`：
 * 以"工作单元"为核心，闸与投递纪律照旧迁入、不重发明）。
 *
 * 【两层视图】驱动拍要回答四件事：
 *   ① 该会话归属吗（归位判定）
 *   ② 现在该不该跑（闸）
 *   ③ **层1**：当前阶段开工了吗（串行门）／该收口请人判了吗
 *   ④ **层2**：这一轮跑哪个任务（相位机 + 回合上限）
 *
 * 【为什么决策是纯函数】闸 + 两层分支必须能被穷举单测（与内核 `fold` 同款：
 * 纯函数、零 I/O）。I/O 全在端口后面。
 *
 * @module workprocess-round-driver/types
 */
import type { WorkStageState, WorkTaskPhase } from 'workprocess'

/** 归属侧窄投影（驱动拍要读的**有界**事实）。 */
export interface RoundScopeFacts {
  readonly id: string
  /** 归属绑定：本会话是不是这条流程的 owner 会话（undefined = 未绑定）。 */
  readonly ownerSessionId?: string
  /** 人的意图 + 运行时健康。 */
  readonly drivable: boolean
  /** 推进链的暂停告警（非空 ⇒ 不驱动；由归属记录注入）。 */
  readonly pauseReason?: string
}

/** 闸判据的当拍事实（全部由端口注入；缺失 = 该闸未启用）。 */
export interface GateFacts {
  /** ① 内存闭锁（当拍可信，先于一切记录判据）。 */
  readonly latchOpen?: boolean
  /** ② 退避期内（不早于该时刻才允许起轮）。 */
  readonly backoffUntil?: number
  /** ③ 进程级上游闸。 */
  readonly providerLatchOpen?: boolean
  /** ④ 人工确认（记录态：待确认 / 待批准）。 */
  readonly humanGateOpen?: boolean
  readonly humanGateReason?: string
  /** ④' 弹框在途（内存态：有人正站在框前）。 */
  readonly dialogInFlight?: boolean
  /** ⑤ 起链预算闸。 */
  readonly chainBudgetAllowed?: boolean
  readonly chainBudgetReason?: string
}

/** 层2：本阶段里的一个任务。 */
export interface TaskFacts {
  readonly id: string
  readonly objective: string
  readonly phase: WorkTaskPhase
  readonly revision: number
  /** 该任务生效的回合上限（缺省 = 由适配器按阶段回落）。 */
  readonly maxRounds?: number
}

/** 层1：当前阶段（第一个非 done 的阶段）。 */
export interface StageFacts {
  readonly key: string
  readonly statement: string
  readonly doneCriteria: readonly string[]
  readonly state: WorkStageState
  /** 串行门：前序阶段全 done 且本阶段 pending（`stageAllowsStart()` 的读数）。 */
  readonly allowsStart?: boolean
  /** 本阶段的任务（层2）；空数组 = 阶段已开工但还没有任务。 */
  readonly tasks?: readonly TaskFacts[]
}

/** 流程侧当拍事实。 */
export interface WorkFacts {
  readonly processId?: string
  /** 聚合 revision（授权三元组：processId + revision + round）。 */
  readonly processRevision?: number
  /** 当前阶段；**全阶段 done ⇒ undefined**（该请人收口了）。 */
  readonly currentStage?: StageFacts
  /** 归属会话键（ownership 判定用）。 */
  readonly sessionKey?: string
}

/** 一次驱动拍的全部输入（纯数据，便于穷举单测）。 */
export interface DecideInput {
  readonly now: number
  readonly scope?: RoundScopeFacts
  readonly gates?: GateFacts
  readonly work?: WorkFacts
  /** 已准入回合数（round-limit 闸的计数来源；由归属记录注入）。 */
  readonly roundsStarted?: number
}

/** 驱动拍的结论（**穷尽**七态）。 */
export type RoundDecision =
  /** 起轮：把提示词投给会话（层2 的该任务已是 active）。 */
  | { readonly kind: 'drive'; readonly processId: string; readonly stageKey: string; readonly taskId: string }
  /** **层1 开工**：当前阶段还是 pending 且串行门已放行 ⇒ 先开工（下一拍再起轮）。 */
  | { readonly kind: 'start-stage'; readonly processId: string; readonly stageKey: string }
  /** 阶段任务全 complete ⇒ 触发弹框请人确认（人工确认，agent 不写）。 */
  | { readonly kind: 'ask-stage-done'; readonly processId: string; readonly stageKey: string }
  /** 全部阶段 done ⇒ 触发收口弹框。 */
  | { readonly kind: 'ask-close'; readonly processId: string }
  /** 任务达回合上限 ⇒ **落盘 block**（重启不失忆、人可见可裁）。 */
  | {
    readonly kind: 'block-task'; readonly processId: string; readonly taskId: string
    readonly reason: { readonly code: string; readonly message: string }
  }
  /** 停手等人（人工确认 / 弹框在途 / 任务 paused-blocked）——不写健康位、不改人的意图。 */
  | { readonly kind: 'wait-human'; readonly processId: string; readonly reason: string }
  /** 停手（闸拦下 / 无立项 / 无可跑之事）——reason 必填，进诊断面。 */
  | { readonly kind: 'hold'; readonly reason: string; readonly processId?: string }
