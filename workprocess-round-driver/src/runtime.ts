/**
 * **驱动器的运行时接线**：把纯决策树 `decideWorkRound` 接到真流程与会话上。
 *
 * 【职责边界】决策树是纯函数（`decide.ts`，零 I/O）；本模块负责三件事：
 *   · 把流程快照投影成窄事实（`factsOf`）；
 *   · 落**不需要人**的副作用（开工 / auto 收口 / 落盘 block / 流程收口）——经 `ctx.workprocess` 域服务；
 *   · `drive` / `plan-stage` / `ask-*` 的**投递**（`agent.followup`，来源自署 `work`）。
 *
 * 【数据从哪来】只经 **`ctx.workprocess`**：存储域由领域插件独占打开（同名域重复 `open` 是响亮拒绝），
 * 驱动器不碰 store、不绕内核。
 *
 * 【为什么可以反复 tick】每拍都从盘上重读现状：迁移成立才写，不成立就零写入（幂等），
 * 所以"每个空闲边界都 tick 一次"不会滚雪球。
 *
 * @module workprocess-round-driver/runtime
 */
// type-only import：官方包的 `declare module` 增强（ctx.agents / agent/status / agent 族事件）随包入程序。
import type {} from '@deepseek-ai/dsh-agent'
import type { WorkProcess, WorkprocessService, WorkTask } from 'workprocess'
import { currentStageOf, stageAllowsStart } from 'workprocess'
import { decideWorkRound } from './decide.js'
import { renderWorkAskPrompt, renderWorkPlanPrompt, renderWorkRoundPrompt } from './prompt.js'
import type { DecideInput, GateFacts, RoundDecision, StageFacts, WorkFacts } from './types.js'

/** 任务没写 `max_rounds` 时的**生效上限**（缺省 20）：自动续跑必须有刹车，不许默认无限。 */
export const DEFAULT_MAX_ROUNDS = 20

/** 一个任务的生效回合上限（任务自己写的优先，否则兜底）。 */
export function effectiveMaxRoundsOf(task: WorkTask, fallback = DEFAULT_MAX_ROUNDS): number {
  return task.maxRounds ?? fallback
}

/** 把流程快照投影成驱动拍要读的**窄事实**。 */
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
  /** 域服务（`ctx.workprocess`）：读现状 + 落副作用都经它。 */
  readonly domain: WorkprocessService
  /** 一拍的时间源（缺省系统时钟；测试可注入）。 */
  readonly now?: () => number
  /** 任务没写 `max_rounds` 时的生效上限（缺省 {@link DEFAULT_MAX_ROUNDS}）。 */
  readonly defaultMaxRounds?: number
  /**
   * 本阶段的**规划轮是否已经问过**（内存态）：问过就不再问（否则每个空闲边界都投 = 空转），
   * 决策树改为停手等人（`wait-human`）——把"阶段空着"这件事露出来。
   */
  readonly stagePlanAsked?: (stageKey: string) => boolean
  /**
   * **收口确认是否已经问过人**（同一件事只问一次）：问过就不再投，避免每个空闲边界都刷一轮。
   * 键：`stage-done:<阶段键>` / `close`。
   */
  readonly humanAskAsked?: (askKey: string) => boolean
  /** **流程自动收口**（`close: 'auto'`）：最后一段 done 后驱动器直接落 close，不问人。 */
  readonly autoClose?: boolean
}

/**
 * 一拍：读现状 → 决策 → 只落"不需要人"的副作用。
 * @returns 本拍的结论（`drive` / `plan-stage` / `ask-*` 的投递由调用方做）；该归属域没有流程 ⇒ `undefined`。
 */
export async function tickWorkprocess(
  deps: TickDeps, scope: string, sessionKey?: string,
): Promise<RoundDecision | undefined> {
  const process = await deps.domain.process(scope)
  if (process === undefined) return undefined
  const roundsStarted = await deps.domain.roundsStarted(scope)
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
    now: (deps.now ?? Date.now)(),
    scope: { id: scope, drivable: true },
    work,
    ...(Object.keys(gates).length === 0 ? {} : { gates }),
    ...(roundsStarted === undefined ? {} : { roundsStarted }),
  }
  const decision = decideWorkRound(input)
  switch (decision.kind) {
    case 'start-stage':
      await deps.domain.startStage(scope, decision.stageKey)
      break
    case 'close-stage':
      await deps.domain.closeStage(scope, decision.stageKey)
      break
    case 'block-task':
      await deps.domain.blockTask(scope, decision.taskId, decision.reason)
      break
    case 'close-process':
      await deps.domain.closeProcess(scope)
      break
    default:
      // drive / plan-stage：只**返回**结论（投递由本模块的 deliver* 做，需要会话）；
      // ask-* / wait-human / hold：没有对应能力就不假装有。
      break
  }
  return decision
}

/** 一轮续跑的**载荷**（提示词 + 授权来源）。 */
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
 * 驱动器按阶段键记一次（`stagePlanAsked`），问过之后决策树改成停手等人。
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
 * 造**收口确认轮**的载荷：到这一步机器能做的都做完了，剩下的是人的判断。
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
