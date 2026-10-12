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
 * @module workprocess/driver
 */
import {
  blockWorkTask, closeWorkProcess, completeWorkStage, currentStageOf, stageAllowsStart, startWorkStage,
  workProcessOf,
} from './kernel.js'
import type { WorkProcess, WorkStoreLike, WorkTask } from './kernel.js'
import { decideWorkRound, renderWorkAskPrompt, renderWorkPlanPrompt, renderWorkRoundPrompt } from 'workprocess-round-driver'
import type { DecideInput, GateFacts, RoundDecision, StageFacts, WorkFacts } from 'workprocess-round-driver'

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
    ...(process.closedAt === undefined ? {} : { processClosed: true }),
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
  /**
   * 本阶段的**规划轮是否已经问过**（组合根的内存态）：问过就不再问（否则每个空闲边界都投 = 空转），
   * 决策树改为停手等人（`wait-human`）——把"阶段空着"这件事露出来。
   */
  readonly stagePlanAsked?: (stageKey: string) => boolean
  /** **流程自动收口**（`close: 'auto'`）：最后一段 done 后驱动器直接落 close，不问人。 */
  readonly autoClose?: boolean
  /**
   * **收口确认是否已经问过人**（同一件事只问一次）：问过就不再投，避免每个空闲边界都刷一轮。
   * 键由组合根定（如 `stage-done:<阶段键>` / `close`）。
   */
  readonly humanAskAsked?: (askKey: string) => boolean
}

/**
 * 一拍：读现状 → 决策 → 只落"不需要人"的副作用。
 * @returns 本拍的结论（`drive` / `plan-stage` 的投递由调用方做）；该归属域没有流程 ⇒ `undefined`。
 */
export async function tickWorkprocess(
  deps: TickDeps, scope: string, sessionKey?: string,
): Promise<RoundDecision | undefined> {
  const process = await workProcessOf({ store: deps.store }, scope)
  if (process === undefined) return undefined
  const roundsStarted = await deps.roundsStartedOf?.(scope)
  const work = factsOf(process, sessionKey, deps.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS)
  const planAsked = deps.stagePlanAsked
  const askAsked = deps.humanAskAsked
  const gates: GateFacts = {
    ...(deps.autoClose === true ? { autoClose: true } : {}),
    ...(planAsked === undefined || work.currentStage === undefined
      ? {}
      : { stagePlanBlocked: planAsked(work.currentStage.key) === true }),
    ...(askAsked === undefined
      ? {}
      : {
        humanAskBlocked: askAsked(
          work.currentStage === undefined ? 'close' : 'stage-done:' + work.currentStage.key,
        ) === true,
      }),
  }
  const input: DecideInput = {
    now: deps.now(),
    scope: { id: scope, drivable: true },
    work,
    ...(Object.keys(gates).length === 0 ? {} : { gates }),
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
    case 'close-process':
      await closeWorkProcess(deps, scope)
      break
    default:
      // drive / plan-stage：只**返回**结论（投递是组合根的事）；
      // close-process 已在上面落库；ask-* / wait-human / hold：没有对应能力就不假装有。
      break
  }
  return decision
}

/** 一轮续跑的**载荷**（提示词 + 授权来源；投递口由组合根接）。 */
export interface RoundDelivery {
  readonly processId: string
  /**
   * 这一轮跑的**任务**；**阶段规划轮没有任务**（`undefined` = 让 agent 先给本阶段建任务）。
   * 规划轮也不带 `round`：它不消耗任何任务的回合预算。
   */
  readonly taskId?: string
  /** 本轮的阶段（任务轮与规划轮都带：投递来源与日志同源）。 */
  readonly stageKey: string
  /** 授权判据的第三维：任务轮 = 任务 revision；规划轮 = 流程 revision。 */
  readonly revision: number
  readonly round?: number
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
  return { processId: process.id, taskId: task.id, stageKey: stage.key, revision: task.revision, round, prompt }
}

/**
 * 造**阶段规划轮**的载荷：当前阶段已开工但还没有任务 ⇒ 让 agent 给本阶段建任务。
 *
 * 刹车**不在回合数上**（规划轮不消耗任务的回合预算），而在"同一阶段只问一次"：
 * 组合根按阶段键记一次（`stagePlanAsked`），问过之后决策树改成停手等人。
 * 阶段已不在当前 / 已有任务 ⇒ `undefined`（没什么可规划的）。
 */
export function planDeliveryOf(
  process: WorkProcess, stageKey: string, askedRound = 1,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (stage === undefined || stage.key !== stageKey || stage.tasks.length > 0) return undefined
  return {
    processId: process.id,
    stageKey: stage.key,
    revision: process.revision,
    prompt: renderWorkPlanPrompt({
      processObjective: process.objective,
      stage: {
        key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria,
        ...(stage.closePolicy === undefined ? {} : { closePolicy: stage.closePolicy }),
      },
      round: askedRound,
    }),
  }
}

/**
 * 造**收口确认轮**的载荷：到这一步机器能做的都做完了，剩下的是人的判断——
 * 于是投一轮让 agent 把"该人拍板了"这件事**说出口**（没有这一轮，流程会安静地停住，看起来就是卡死）。
 *
 * 与规划轮同理：来源自署 `work`、**不带 `round`**（不消耗任务预算）。
 */
export function askDeliveryOf(
  process: WorkProcess, kind: 'stage-done' | 'close', stageKey?: string,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (kind === 'stage-done') {
    if (stage === undefined || stage.key !== stageKey) return undefined
    return {
      processId: process.id,
      stageKey: stage.key,
      revision: process.revision,
      prompt: renderWorkAskPrompt({
        processObjective: process.objective,
        kind: 'stage-done',
        stage: { key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria },
      }),
    }
  }
  if (stage !== undefined) return undefined   // 还有阶段没 done：不是流程级收口
  return {
    processId: process.id,
    stageKey: '',
    revision: process.revision,
    prompt: renderWorkAskPrompt({ processObjective: process.objective, kind: 'close' }),
  }
}
