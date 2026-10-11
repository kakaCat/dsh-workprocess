/**
 * workprocess 驱动拍的**决策树**（纯函数）。
 *
 * 判定顺序（**顺序即纪律**，与宿主 `goal-round-driver` 逐条对齐）：
 *   ① 归属绑定？          未绑定 / 非本会话 → hold
 *   ② 可驱动？（人的意图 + 运行时健康 + 推进未告警）
 *   ③ 内存闭锁（当拍可信，先于一切记录判据）
 *   ④ 退避期内？          ⑤ 进程级上游闸？
 *   ⑥ 人工确认 / 弹框在途 → wait-human（等人不是故障：不写健康位、不改人的意图）
 *   ⑦ 起链预算闸
 *   ⑧ **层1**：全阶段 done → ask-close；当前阶段 pending → 串行门放行则 start-stage，否则 hold
 *   ⑨ **层2**：有 active 任务 → 回合作顶则 block-task，否则 drive；
 *              有 paused/blocked 任务 → wait-human；
 *              任务全 complete → 策略 `auto` 则 close-stage（自动收口），否则 ask-stage-done（请人确认）；
 *              **阶段已开工却没任务 → plan-stage**（投一轮让 agent 给本阶段建任务；问过一次就停手等人）。
 *              决策层仍**不臆造任务**：它只把"这个阶段是空的"这件事交给 agent。
 *
 * @module workprocess/round/decide
 */
import { stageClosePolicyOf } from 'workprocess-core'
import type { DecideInput, RoundDecision, StageFacts, TaskFacts } from './types.js'

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
  if (stage === undefined) return { kind: 'ask-close', processId }

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
    return stageClosePolicyOf(stage) === 'auto'
      ? { kind: 'close-stage', processId, stageKey: stage.key }
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
