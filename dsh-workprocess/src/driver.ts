/**
 * **回合边界的驱动器接线**（把纯决策树 `decideWorkRound` 接到真流程上）。
 *
 * 【两种副作用】
 *   · 不需要人的（本模块直接落）：开工（`start-stage`）、自动收口（`close-stage`）、
 *     回合作顶落盘 block（`block-task`）；
 *   · 需要**投递**的（`drive`）：本模块只产出"这一轮该跑什么"的**载荷**（`roundDeliveryOf`），
 *     投递由组合根做（它才知道会话/agent 的投递口）——决策层不碰会话。
 *
 * 【为什么可以反复 tick】每拍都从盘上重读现状：迁移成立才写，不成立就零写入（幂等），
 * 所以"每个会话事件都 tick 一次"不会滚雪球。
 *
 * `ask-*`（弹框请人确认）**不在**本模块内：要接宿主的人机确认通道。
 *
 * @module dsh-workprocess/driver
 */
import {
  blockWorkTask, completeWorkStage, currentStageOf, stageAllowsStart, startWorkStage, workProcessOf,
} from 'workprocess'
import type { WorkProcess, WorkStoreLike, WorkTask } from 'workprocess'
import { decideWorkRound, renderWorkRoundPrompt } from 'workprocess-round-driver'
import type { DecideInput, RoundDecision, StageFacts, WorkFacts } from 'workprocess-round-driver'

/** 任务没写 `max_rounds` 时的**生效上限**（缺省 20）：自动续跑必须有刹车，不许默认无限。 */
export const DEFAULT_MAX_ROUNDS = 20

/** 一个任务的生效回合上限（任务自己写的优先，否则组合根兜底）。 */
export function effectiveMaxRoundsOf(task: WorkTask, fallback = DEFAULT_MAX_ROUNDS): number {
  return task.maxRounds ?? fallback
}

/** 把流程快照投影成驱动拍要读的**窄事实**（组合根适配器的最小样本）。 */
export function factsOf(
  process: WorkProcess, sessionKey?: string, fallbackMaxRounds = DEFAULT_MAX_ROUNDS,
): WorkFacts {
  const current = currentStageOf(process)
  return {
    processId: process.id,
    processRevision: process.revision,
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(current === undefined ? {} : {
      currentStage: {
        key: current.key,
        statement: current.statement,
        doneCriteria: current.doneCriteria,
        state: current.state,
        allowsStart: stageAllowsStart(process, current.key),
        ...(current.closePolicy === undefined ? {} : { closePolicy: current.closePolicy }),
        tasks: current.tasks.map((t) => ({
          id: t.id, objective: t.objective, phase: t.phase, revision: t.revision,
          // 生效上限（缺省回落）：回合上限闸靠它——否则"没写 max_rounds"就成了无限续跑。
          maxRounds: effectiveMaxRoundsOf(t, fallbackMaxRounds),
        })),
      } satisfies StageFacts,
    }),
  }
}

export interface TickDeps {
  readonly store: WorkStoreLike
  readonly now: () => number
  /** 该归属域**已准入回合数**（缺省 0）：回合上限判据要它才生效。 */
  readonly roundsStartedOf?: (scope: string) => Promise<number | undefined>
  /** 任务没写 `max_rounds` 时的生效上限（缺省 {@link DEFAULT_MAX_ROUNDS}）。 */
  readonly defaultMaxRounds?: number
}

/**
 * 一拍：读现状 → 决策 → 只落"不需要人"的副作用。
 * @returns 本拍的结论（`drive` 的投递由调用方做）；该归属域没有流程 ⇒ `undefined`。
 */
export async function tickWorkprocess(
  deps: TickDeps, scope: string, sessionKey?: string,
): Promise<RoundDecision | undefined> {
  const process = await workProcessOf({ store: deps.store }, scope)
  if (process === undefined) return undefined
  const roundsStarted = await deps.roundsStartedOf?.(scope)
  const input: DecideInput = {
    now: deps.now(),
    scope: { id: scope, drivable: true },
    work: factsOf(process, sessionKey, deps.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS),
    ...(roundsStarted === undefined ? {} : { roundsStarted }),
  }
  const decision = decideWorkRound(input)
  switch (decision.kind) {
    case 'start-stage':
      await startWorkStage(deps, scope, decision.stageKey)
      break
    case 'close-stage':
      await completeWorkStage(deps, scope, decision.stageKey)
      break
    case 'block-task':
      await blockWorkTask(deps, scope, decision.taskId, decision.reason)
      break
    default:
      // drive：只**返回**结论（投递是组合根的事）；ask-* / wait-human / hold：没有对应能力就不假装有。
      break
  }
  return decision
}

/** 一轮续跑的**载荷**（提示词 + 授权来源；投递口由组合根接）。 */
export interface RoundDelivery {
  readonly processId: string
  readonly taskId: string
  readonly revision: number
  readonly round: number
  readonly prompt: string
}

/**
 * 造"下一轮"的载荷：`round` = 已准入回合数 + 1，提示词由 `renderWorkRoundPrompt` 渲染
 * （流程目标 / 当前阶段与判据 / 本轮任务 / 边界与停手条件）。
 * 任务不在当前阶段 / 阶段已收口 ⇒ `undefined`（没得投）。
 */
export function roundDeliveryOf(
  process: WorkProcess, taskId: string, roundsStarted: number, fallbackMaxRounds = DEFAULT_MAX_ROUNDS,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (stage === undefined) return undefined
  const task = stage.tasks.find((t) => t.id === taskId)
  if (task === undefined) return undefined
  const round = roundsStarted + 1
  const prompt = renderWorkRoundPrompt({
    processObjective: process.objective,
    stage: {
      key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria,
      ...(stage.closePolicy === undefined ? {} : { closePolicy: stage.closePolicy }),
    },
    task: { id: task.id, objective: task.objective },
    round,
    maxRounds: effectiveMaxRoundsOf(task, fallbackMaxRounds),
  })
  return { processId: process.id, taskId: task.id, revision: task.revision, round, prompt }
}
