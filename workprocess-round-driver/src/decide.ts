/**
 * **回合决策的纯层**：契约类型（事实 / 闸 / 结论）+ 决策树 `decideWorkRound`。
 *
 * 【为什么自成一个模块】这一层**零 I/O、零宿主依赖**：给定事实就出结论，可穷举单测
 * （见 `tests/workprocess-decide.spec.ts`）。宿主 `dsh-goal-round-driver` 没有对应的模块，
 * 是因为 goal 的规则简单到能内联进 `drive()`（一条激活相位 + 回合计数）；
 * 我们的域有阶段 × 任务相位 × 收口策略 × 回合预算 × 规划轮/确认轮，规则值得单独立住。
 *
 * @module workprocess-round-driver/decide
 */
import { stageClosePolicyOf } from 'workprocess'
import type { WorkStageClosePolicy, WorkStageState, WorkTaskPhase } from 'workprocess'

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
  /**
   * ⑥ **阶段规划轮已问过**（内存态：本阶段开工后没任务，已经投过一轮"给本阶段建任务"）。
   * 已问过就不再问（否则每个空闲边界都投一轮 = 空转）：停手等人，把"阶段空着"这件事露出来。
   */
  readonly stagePlanBlocked?: boolean
  /**
   * ⑦ **收口确认已经问过人**（内存态：同一件事只问一次）。
   * 问过就不再问——否则每个空闲边界都往会话里投一轮"请人确认"，人还没答就被刷屏。
   */
  readonly humanAskBlocked?: boolean
  /** ⑧ **流程自动收口**（配置态：`close: 'auto'`）：最后一段 done 后驱动器直接落 close，不问人。 */
  readonly autoClose?: boolean
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
  /** 收口策略（缺省 `human`；`auto` = 任务全 complete 后直接自动收口，不等人工确认）。 */
  readonly closePolicy?: WorkStageClosePolicy
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
  /** 流程已收口（`closedAt` 非空）：记录终止，一切推进结论都不再生效。 */
  readonly processClosed?: boolean
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

/** 驱动拍的结论（**穷尽十态**）。 */
export type RoundDecision =
  /** 起轮：把提示词投给会话（层2 的该任务已是 active）。 */
  | { readonly kind: 'drive'; readonly processId: string; readonly stageKey: string; readonly taskId: string }
  /**
   * **阶段规划轮**：当前阶段已开工但**还没有任务** ⇒ 投一轮让 agent 给本阶段建任务。
   *
   * 为什么必须有它：阶段是串行的、任务只属于当前阶段（建满后续阶段的任务等于把串行作废），
   * 于是**每过一个阶段边界，新阶段必然是空的**。此时若只是 `hold`，流程会在每个阶段边界上停死
   * （真机踩过：core 自动收口 → ui 开工 → 0 任务 → 永远无人叫 agent 拆任务）。
   */
  | { readonly kind: 'plan-stage'; readonly processId: string; readonly stageKey: string }
  /** **层1 开工**：当前阶段还是 pending 且串行门已放行 ⇒ 先开工（下一拍再起轮）。 */
  | { readonly kind: 'start-stage'; readonly processId: string; readonly stageKey: string }
  /** 阶段任务全 complete 且策略 `human` ⇒ 触发弹框请人确认（agent 不写）。 */
  | { readonly kind: 'ask-stage-done'; readonly processId: string; readonly stageKey: string }
  /** 阶段任务全 complete 且策略 `auto` ⇒ **自动收口**（驱动器直接落 done，不等人工确认）。 */
  | { readonly kind: 'close-stage'; readonly processId: string; readonly stageKey: string }
  /** 全部阶段 done ⇒ 触发收口弹框。 */
  | { readonly kind: 'ask-close'; readonly processId: string }
  /** **流程自动收口**（`close: 'auto'`）：最后一段 done 后由驱动器落 `process-close`（方案 B）。 */
  | { readonly kind: 'close-process'; readonly processId: string }
  /** 任务达回合上限 ⇒ **落盘 block**（重启不失忆、人可见可裁）。 */
  | {
    readonly kind: 'block-task'; readonly processId: string; readonly taskId: string
    readonly reason: { readonly code: string; readonly message: string }
  }
  /** 停手等人（人工确认 / 弹框在途 / 任务 paused-blocked）——不写健康位、不改人的意图。 */
  | { readonly kind: 'wait-human'; readonly processId: string; readonly reason: string }
  /** 停手（闸拦下 / 无立项 / 无可跑之事）——reason 必填，进诊断面。 */
  | { readonly kind: 'hold'; readonly reason: string; readonly processId?: string }

const hold = (reason: string, processId?: string): RoundDecision =>
  processId === undefined ? { kind: 'hold', reason } : { kind: 'hold', reason, processId }

/** 闸阶段：返回"停手结论"或 undefined（= 放行到两层判定）。 */
function gateStop(input: DecideInput): RoundDecision | undefined {
  const req = input.scope
  if (req === undefined) return hold('no-scope')
  const g = input.gates
  if (!req.drivable) return hold('not-drivable', req.id)
  if (req.pauseReason !== undefined) return hold('paused:' + req.pauseReason, req.id)
  if (g?.latchOpen === true) return hold('latch', req.id)
  if (g?.backoffUntil !== undefined && input.now < g.backoffUntil) return hold('backoff', req.id)
  if (g?.providerLatchOpen === true) return hold('provider-latch', req.id)
  if (g?.humanGateOpen === true) {
    return { kind: 'wait-human', processId: req.id, reason: g.humanGateReason ?? 'human-gate' }
  }
  if (g?.dialogInFlight === true) return { kind: 'wait-human', processId: req.id, reason: 'dialog-in-flight' }
  if (g?.chainBudgetAllowed === false) {
    return hold('chain-budget:' + (g.chainBudgetReason ?? 'unknown'), req.id)
  }
  return undefined
}

/** 层2：从本阶段的任务里挑一个"该跑的"（每类各取第一个，顺序稳定）。 */
function pick(tasks: readonly TaskFacts[]): { running?: TaskFacts; waiting?: TaskFacts } {
  return {
    running: tasks.find((t) => t.phase === 'active'),
    waiting: tasks.find((t) => t.phase === 'paused' || t.phase === 'blocked'),
  }
}

/** 层的分支：先层1（串行门 / 收口），再层2（相位机 / 回合上限）。 */
function layerBranch(input: DecideInput, processId: string, stage: StageFacts | undefined): RoundDecision {
  // 全阶段 done ⇒ 流程级收口。三条路（顺序即纪律）：
  //   · 已收口（closedAt 非空）⇒ 记录终止，一切推进结论都不再生效；
  //   · `close: 'auto'` ⇒ 驱动器直接落 close（最后一段 done 即完成——方案 B 的缺省）；
  //   · 否则请人判（ask-close，问过一次就停手等人）。
  if (stage === undefined) {
    if (input.work?.processClosed === true) return hold('process-closed', processId)
    if (input.gates?.autoClose === true) return { kind: 'close-process', processId }
    return input.gates?.humanAskBlocked === true
      ? { kind: 'wait-human', processId, reason: 'ask-close-asked' }
      : { kind: 'ask-close', processId }
  }

  // 层1 未开工：串行门放行才开工（开工是驱动的事，不是 agent 的自选动作）。
  if (stage.state === 'pending') {
    return stage.allowsStart === true
      ? { kind: 'start-stage', processId, stageKey: stage.key }
      : hold('stage-serial-blocked:' + stage.key, processId)
  }

  const tasks = stage.tasks ?? []
  const { running, waiting } = pick(tasks)

  if (running !== undefined) {
    // round-limit 闸（对齐宿主起轮前的 `roundsStarted >= maxGoalRounds → block`）：
    // 到顶**不是停手留内存**——落盘 block，重启不失忆、人可见可裁（resume 人专属）。
    const cap = running.maxRounds
    if (cap !== undefined && input.roundsStarted !== undefined && input.roundsStarted >= cap) {
      return {
        kind: 'block-task',
        processId,
        taskId: running.id,
        reason: {
          code: 'round-limit',
          message: '已准入回合数 ' + input.roundsStarted + ' 达到上限 ' + cap + '——该任务不再自动续跑，等人确认',
        },
      }
    }
    return { kind: 'drive', processId, stageKey: stage.key, taskId: running.id }
  }

  if (waiting !== undefined) {
    return { kind: 'wait-human', processId, reason: 'task-' + waiting.phase + ':' + waiting.id }
  }

  // 层2 全 complete ⇒ 层1 该收口了。**由谁落 done 由阶段收口策略定**：
  //   · `human`（缺省）——请人确认（agent 只提议，不写）；
  //   · `auto` ——驱动器直接落 done（"自动推进下一阶段"这条路的唯一入口；判据仍要求任务非空且全 complete）。
  if (tasks.length > 0 && tasks.every((t) => t.phase === 'complete')) {
    if (stageClosePolicyOf(stage) === 'auto') return { kind: 'close-stage', processId, stageKey: stage.key }
    // 策略 human：请人确认。**已经问过就停手等人**（不再重复投，避免刷屏）。
    return input.gates?.humanAskBlocked === true
      ? { kind: 'wait-human', processId, reason: 'ask-stage-done-asked:' + stage.key }
      : { kind: 'ask-stage-done', processId, stageKey: stage.key }
  }

  // 阶段已开工却**没有任务**：投一轮**阶段规划轮**，让 agent 给本阶段建任务。
  // 这里不能只是 hold——阶段是串行的、任务只属于当前阶段（建满后续阶段的任务等于把串行作废），
  // 于是**每过一个阶段边界，新阶段必然是空的**；hold 会让流程在每个阶段边界上停死（真机踩过）。
  // 问过一次（`stagePlanBlocked`）就停手等人：不空转，也不替 agent 臆造任务。
  if (tasks.length === 0) {
    return input.gates?.stagePlanBlocked === true
      ? { kind: 'wait-human', processId, reason: 'stage-plan-asked:' + stage.key }
      : { kind: 'plan-stage', processId, stageKey: stage.key }
  }
  return hold('stage-has-no-runnable-task:' + stage.key, processId)
}

/**
 * 一次驱动拍的唯一入口（纯函数：同输入必同输出，零 I/O）。
 *
 * `scope.ownerSessionId` 与 `work.sessionKey` 的归属比对放在这里（① 归属绑定）：
 * 两侧都缺身份时**放行**（老装配口径），只有明确不等才拦。
 */
export function decideWorkRound(input: DecideInput): RoundDecision {
  const req = input.scope
  if (req === undefined) return hold('no-scope')
  const work = input.work
  if (work === undefined || work.processId === undefined) return hold('no-process', req.id)
  if (work.sessionKey !== undefined && req.ownerSessionId !== undefined
    && work.sessionKey !== req.ownerSessionId) {
    return hold('not-owner-session', req.id)
  }
  const stopped = gateStop(input)
  if (stopped !== undefined) return stopped
  return layerBranch(input, work.processId, work.currentStage)
}
