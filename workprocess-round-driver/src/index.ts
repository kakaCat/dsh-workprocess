/**
 * workprocess-round-driver：**回合驱动器插件**（结构照宿主 `@deepseek-ai/dsh-goal-round-driver` 一比一）。
 *
 * 【一个模块一件事】宿主那个包源码是三个模块（`index` / `prompt` / `invariant`），
 * 我们同粒度：
 *   · 本模块 = 插件壳（`name` / `inject` / `apply`）+ 运行时（事实投影 · 一拍 · 投递）+ 消息来源声明；
 *   · `decide.ts` = 契约类型 + 决策树（纯层，可穷举单测）；
 *   · `prompt.ts` = 三种轮次的提示词渲染（纯字符串）。
 *
 * 【壳的设计（与宿主逐条对应）】
 * | 宿主 goal driver | 本插件 |
 * | --- | --- |
 * | `name` / `inject = ['agents','goals','sessions']` / `apply(ctx)` | `name` / `inject = ['agents','sessions','workprocess']` / `apply(ctx, config?)` |
 * | 每 agent 一张 state（`attempt` / `competingQueued` / `needsCheckpoint` / `requested` / `run` / `stopping`） | 同 |
 * | `readyToDrive`：fiber 活跃 + agent 仍活着 + `status === 'idle'` + 无竞争排队 | 同 |
 * | `requestDrive`：触发合并成**一条** agent 局部串行 run（`withoutInitiator` + while + retire） | 同 |
 * | `drive`：耐久检查点 → 收尾上一轮预约 → 读现状 → 落副作用 / 投下一轮 | 同（读现状经 `ctx.workprocess`） |
 * | `agent.followup(createUserMessage(...))` + `attempt` 预约（消息身份精确比对） | 同（来源自署 `kind:'work'`） |
 * | `agent/inbox/inserted｜claimed｜discarded` 竞态围栏 | 同 |
 * | `ctx.effect(function* () { ... })` 挂监听 + `ctx.logger.warn` | 同 |
 *
 * 【我们多出来的三件事（goal 没有阶段概念）】阶段规划轮（`plan-stage`）、收口确认轮（`ask-*`）、
 * 流程自动收口（`close-process`）——投递走同一套 `attempt` 预约与围栏，去重键在 state 里
 * （`planAsked` / `askAsked`，语义等价于宿主"同一 goal 只推进一轮"）。
 *
 * 【数据从哪来】只经 `ctx.workprocess`（存储域由领域插件独占打开）；回合计数也是域服务的一部分。
 *
 * @module workprocess-round-driver
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { currentStageOf, onWorkChanged, stageAllowsStart, workprocessOf } from 'workprocess'
import type { WorkProcess, WorkprocessService, WorkTask } from 'workprocess'
import { decideWorkRound } from './decide.js'
import type { DecideInput, GateFacts, RoundDecision, StageFacts, WorkFacts } from './decide.js'
import { renderWorkAskPrompt, renderWorkPlanPrompt, renderWorkRoundPrompt, renderWorkWrapupPrompt } from './prompt.js'

//#region 消息来源（仓外插件必须自己声明这一格）
/** 续跑回合的来源载荷（进程 / 阶段 / 任务 / 修订 / 回合号：授权面按它精确匹配）。 */
export interface WorkRoundMessageSource {
  readonly kind: 'work'
  readonly processId: string
  /** 本轮所在的阶段（任务轮与**阶段规划轮**都带）。 */
  readonly stageKey?: string
  /**
   * 这一轮跑的**任务**；**阶段规划轮没有任务**（它在请 agent 给本阶段建任务），
   * 也因此没有 `round`——规划轮不消耗任务的回合预算，不该推进 `rounds.started`。
   */
  readonly taskId?: string
  readonly revision: number
  readonly round?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** workprocess 的自动续跑回合（**不是人**）。 */
    work: WorkRoundMessageSource
  }
}
//#endregion

//#region 运行时：事实投影 · 一拍 · 投递载荷
// type-only import：官方包的 `declare module` 增强（ctx.agents / agent/status / agent 族事件）随包入程序。

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
 * 造**终局收束轮**的载荷：流程已收口（complete）或停住等人（blocked）⇒ 请 agent 写结束语。
 *
 * 【为什么静默不行】阶段/流程收口都是写库、不投轮 —— 对话里毫无痕迹，"跑完了"与"卡死了"在人看来
 * 一模一样（真机两次被误判）。宿主 goal 的 `wrapup` 模块就是为这件事存在的，本函数是它的同款。
 */
export function wrapupDeliveryOf(
  process: WorkProcess, kind: 'complete' | 'blocked', blockedReason?: string,
): RoundDelivery | undefined {
  const doneStages = process.stages
    .filter((stage) => stage.state === 'done')
    .map((stage) => ({ key: stage.key, statement: stage.statement }))
  if (kind === 'complete' && process.closedAt === undefined && process.stages.some((s) => s.state !== 'done')) {
    return undefined   // 还没全收口：不是"落幕"，别报喜
  }
  return {
    processId: process.id,
    stageKey: '',
    revision: process.revision,
    prompt: renderWorkWrapupPrompt({
      processObjective: process.objective,
      kind,
      ...(doneStages.length === 0 ? {} : { doneStages }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
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
//#endregion

//#region 驱动器插件
// 引入模块增强（MessageSourceMap 加 'work' 一格）：类型面的事，运行时不需要它。

/** 插件名（装载层条目 id 同源）。 */
export const name = 'workprocess-round-driver'

/** 装配依赖：agent 面（投递 / 空闲信号 / 竞态事件）、会话面（耐久检查点）、域服务（读写）。 */
export const inject = ['agents', 'sessions', 'workprocess']

/** 装载层配置（`cordis.patch.yml` 的 config 段）。 */
export interface WorkRoundDriverConfig {
  /** 回合边界是否自动驱动（缺省 true；关掉 = 只留领域服务与工具面，状态迁移全靠人/模型显式调）。 */
  readonly tick?: boolean
  /**
   * 空闲边界是否**自动投递续跑回合**（缺省 false；本仓的装载层把它打开）。
   * 打开它 = 任务会自己往下跑（受 `defaultMaxRounds` / 任务 `max_rounds` 硬刹车）。
   */
  readonly drive?: boolean
  /** 任务没写 `max_rounds` 时的生效上限（缺省 {@link DEFAULT_MAX_ROUNDS}）。 */
  readonly defaultMaxRounds?: number
  /**
   * **流程收口**（方案 B）：'auto'（缺省）= 最后一段 done 后驱动器直接落 close，记录终止；
   * 'human' = 全阶段 done 后投「请判」轮（方案 B 口径：判了不落章，与旧行为等价）。
   */
  readonly close?: 'human' | 'auto'
  /**
   * 会话 **`resume`**（宿主重启后从盘上加载）时是否**自动收回续跑许可**（缺省 true，对齐宿主 goal：
   * "After session resume or fork, an active goal is disarmed"）。
   *
   * 打开 = 重启后不被自动续跑（要人说一句"继续"才 rearm）——无人值守的流程不会在你不知情时继续动。
   * 关掉 = 重启后接着自动跑（适合长时间无人值守的流程）。
   */
  readonly disarmOnResume?: boolean
}

/** cordis `FiberState.ACTIVE` 的数值（const enum 在 isolatedModules 下不能当值用，宿主同款写法）。 */
const FIBER_ACTIVE = 2

/** 一次投递的**预约**：消息身份精确比对（竞态围栏靠它，绝不靠"内容差不多"）。 */
interface Attempt {
  readonly kind: 'drive' | 'plan' | 'ask' | 'wrap'
  readonly messageId: string
  readonly content: string
  readonly processId: string
  readonly revision: number
  readonly stageKey?: string
  readonly taskId?: string
  readonly round?: number
  phase: 'queued' | 'claimed'
  cancelled: boolean
  stale: boolean
}

/** 单个 agent 的驱动状态（对齐宿主 goal driver 的 state）。 */
interface State {
  readonly agent: Agent
  attempt?: Attempt
  /** 有**别的**消息排在了 next-turn（本驱动器让路，不与它抢）。 */
  competingQueued: boolean
  /** 需要做一次耐久检查点（`ctx.sessions.flush`）再继续驱动。 */
  needsCheckpoint: boolean
  /** 已请求再拍一拍（请求合并：多个触发只跑一条 run）。 */
  requested: boolean
  /** 当前那条 agent 局部串行 run（同一 agent 同时只有一条）。 */
  run?: Promise<void>
  stopping: boolean
  /** 已投递的**回合键**（`taskId:revision:round`）：域没变时同一轮绝不重复投。 */
  readonly queued: Set<string>
  /** 已经问过**阶段规划轮**的阶段键（同一阶段只问一次）。 */
  readonly planAsked: Set<string>
  /** 已经问过人的**收口确认**键（`stage-done:<阶段键>` / `close`）。 */
  readonly askAsked: Set<string>
}

/** 会话事件的**最小读取面**（只读得出"这一轮是不是我们自署的回合"）。 */
interface SessionEventLike {
  readonly type?: string
  readonly data?: {
    readonly source?: { readonly kind?: string; readonly round?: number }
  }
}

/** 安装同会话自动续跑：触发 → 合并 → 串行驱动 → 投递 → 围栏。 */
export function apply(ctx: Context, config?: WorkRoundDriverConfig): void {
  if (config?.tick === false) return
  const domain = workprocessOf(ctx)
  const driveEnabled = config?.drive === true
  const defaultMaxRounds = config?.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS
  const autoClose = config?.close !== 'human'
  /** 会话 resume ⇒ 自动收回续跑许可（缺省开；goal 同款纪律）。 */
  const disarmOnResume = config?.disarmOnResume !== false
  const states = new Map<Agent, State>()

  const warn = (message: string): void => {
    try {
      ctx.logger.warn('[workprocess-round-driver] ' + message)
    } catch {
      console.warn('[workprocess-round-driver] ' + message)
    }
  }
  const renderThrown = (value: unknown): string => (value instanceof Error ? value.message : String(value))

  /** 取（或建）某 agent 的状态。 */
  function stateFor(agent: Agent): State {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: State = {
      agent,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      stopping: false,
      queued: new Set<string>(),
      planAsked: new Set<string>(),
      askAsked: new Set<string>(),
    }
    states.set(agent, state)
    return state
  }

  /** 仅在**这个** agent 仍活着时认它（防 dispose 之后的僵尸引用）。 */
  function liveAgent(state: State): Agent | undefined {
    return ctx.agents.get(state.agent.session.id) === state.agent ? state.agent : undefined
  }

  /** 是否到了可以驱动的静止点（宿主 goal driver 同款判据）。 */
  function readyToDrive(state: State): boolean {
    return ctx.fiber.state === FIBER_ACTIVE
      && !state.stopping
      && liveAgent(state) !== undefined
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** 检查点等待期间可能变天：等完再核一遍每个条件。 */
  function readyAfterCheckpoint(state: State): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** 这条消息是不是我投的那一轮（消息身份精确比对）。 */
  function isOwnAttempt(message: { readonly id?: string }, attempt: Attempt | undefined): boolean {
    return attempt !== undefined && message.id === attempt.messageId
  }

  /**
   * 预留一轮并投递：**先记预约再投**（投失败就撤销）——投出去的消息身份就是预约身份，
   * 竞态围栏据此判"这条是不是我投的"。
   */
  function reserveAndQueue(state: State, kind: Attempt['kind'], delivery: RoundDelivery): boolean {
    const message = createUserMessage({
      content: [{ type: 'text', text: delivery.prompt }],
      // **自署来源**：这一轮不是人打的字（授权面据此判自治），也绝不许冒充人。
      source: {
        kind: 'work',
        processId: delivery.processId,
        ...(delivery.stageKey === '' ? {} : { stageKey: delivery.stageKey }),
        ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
        revision: delivery.revision,
        ...(delivery.round === undefined ? {} : { round: delivery.round }),
      },
    })
    state.attempt = {
      kind,
      messageId: message.id,
      content: delivery.prompt,
      processId: delivery.processId,
      revision: delivery.revision,
      ...(delivery.stageKey === '' ? {} : { stageKey: delivery.stageKey }),
      ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
      ...(delivery.round === undefined ? {} : { round: delivery.round }),
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    try {
      state.agent.followup(message)
      return true
    } catch (error) {
      state.attempt = undefined
      warn(`could not queue ${kind} round for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      return false
    }
  }

  /** 本拍读到的流程修订（耐久记号按它判定有效性）。 */
  let askedRevision: number | undefined

  /** 读现状 → 决策 → 落"不需要人"的副作用 / 投一轮；返回是否请求再拍一拍。 */
  async function driveOnce(state: State): Promise<boolean> {
    const scope = state.agent.session.id
    // **"已经问过"的耐久记号**：跨重启只在"没有任何状态变更"时继续算数（修订一变即作废）。
    // 内存集合保留作**进程内快挡**：耐久写可能还没落盘，先挡住重复投递。
    const asked = await domain.asked(scope)
    const askedAt = (kind: 'plan' | 'ask', key: string): boolean =>
      asked?.[kind] !== undefined && asked[kind]!.key === key && asked[kind]!.revision === askedRevision
    const decision = await tickWorkprocess({
      domain,
      defaultMaxRounds,
      stagePlanAsked: (stageKey) => state.planAsked.has(stageKey) || askedAt('plan', stageKey),
      humanAskAsked: (askKey) => state.askAsked.has(askKey) || askedAt('ask', askKey),
      autoClose,
    }, scope, scope)
    if (decision === undefined) return false
    switch (decision.kind) {
      case 'drive': {
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const roundsStarted = (await domain.roundsStarted(scope)) ?? 0
        const delivery = roundDeliveryOf(process, decision.taskId, roundsStarted, defaultMaxRounds)
        if (delivery === undefined) return false
        // 同一轮只投一次（`taskId:revision:round`）：宿主靠 goal 服务的耐久回合计数挡住重复，
        // 我们额外在进程内挡一道——域没变（没有 work/changed）时这一轮就是"已投出去的那一轮"。
        const key = delivery.taskId + ':' + String(delivery.revision) + ':' + String(delivery.round)
        if (state.queued.has(key)) return false
        if (reserveAndQueue(state, 'drive', delivery)) state.queued.add(key)
        return false
      }
      case 'plan-stage': {
        // **阶段规划轮**：本阶段开工了却没任务 ⇒ 投一轮让 agent 给本阶段建任务。
        // 记下"已经问过"（决策树下一拍会改成停手等人），不消耗任何任务的回合预算。
        state.planAsked.add(decision.stageKey)
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = planDeliveryOf(process, decision.stageKey, state.planAsked.size)
        if (delivery === undefined) return false
        if (reserveAndQueue(state, 'plan', delivery)) {
          void domain.markAsked(scope, 'plan', decision.stageKey, delivery.revision)
        }
        return false
      }
      case 'ask-stage-done':
      case 'ask-close': {
        // **收口确认轮**：机器能做的都做完了 ⇒ 请 agent 向人确认（不说出口 = 看起来卡死）。
        const askKey = decision.kind === 'ask-close' ? 'close' : 'stage-done:' + decision.stageKey
        state.askAsked.add(askKey)
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = askDeliveryOf(
          process, decision.kind === 'ask-close' ? 'close' : 'stage-done',
          decision.kind === 'ask-close' ? undefined : decision.stageKey,
        )
        if (delivery === undefined) return false
        if (reserveAndQueue(state, 'ask', delivery)) {
          void domain.markAsked(scope, 'ask', askKey, delivery.revision)
        }
        return false
      }
      case 'close-process': {
        // 推进态结论已落盘（流程收口）。**收口是静默写**——不投一轮话说清楚，
        // 人在对话里看到的"跑完了"与"卡死了"一模一样（真机两次误判）。投终局收束轮。
        state.needsCheckpoint = true
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = wrapupDeliveryOf(process, 'complete')
        if (delivery === undefined) return true
        reserveAndQueue(state, 'wrap', delivery)
        return false
      }
      case 'block-task': {
        // 回合作顶落盘 block ⇒ 机器停住等人：同样要说出口（goal 的 `<goal_blocked>` 同款）。
        state.needsCheckpoint = true
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = wrapupDeliveryOf(process, 'blocked', decision.reason?.code + ': ' + String(decision.reason?.message ?? ''))
        if (delivery === undefined) return true
        reserveAndQueue(state, 'wrap', delivery)
        return false
      }
      case 'start-stage':
      case 'close-stage':
        // 推进态结论（副作用已由 `tickWorkprocess` 经域服务落盘）⇒ 再拍一拍接着推进。
        state.needsCheckpoint = true
        return true
      default:
        // hold / wait-human：没有可做的了，停手等人。
        return false
    }
  }

  /** 一拍的完整语义（宿主 goal driver 的 `drive`：许可 → 检查点 → 收尾上一轮 → 决策）。 */
  async function drive(state: State): Promise<void> {
    if (!readyToDrive(state)) return
    // **续跑许可**（耐久）：recall 后是 disarmed ⇒ 一拍都不推进（goal：`activation !== 'armed'` 就返回）。
    // 与 goal 的差别只有一处：它读 goal 的相位，我们读归属记录里的 `rounds.activation`。
    const scope = state.agent.session.id
    const activation = await domain.activation(scope)
    if (activation === 'disarmed') return
    // 当前流程修订（耐久记号只在与之相符时算数）：这一读也顺手确认流程还在。
    askedRevision = (await domain.process(scope))?.revision
    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(state.agent.session)
      } catch (error) {
        warn(`durability checkpoint failed for agent "${state.agent.session.id}": ${renderThrown(error)}`)
        return
      }
      if (!readyAfterCheckpoint(state)) return
    }
    if (state.attempt !== undefined) {
      // 上一轮**还挂着**（投出去还没被接手 / 还没等到空闲转换）⇒ 一拍都不再投。
      //
      // 【为什么撤预约不在这里做】`drive()` 会被很多触发调到，包括**我们自己投递那条消息**
      // 产生的 `session/event`。那一刻 agent 往往还是 idle，若在这里判"agent 空闲 ⇒ 上一轮跑完了"，
      // 就会当场撤掉预约、立刻跑下一拍 —— 真机症状：任务轮与 blocked 收束轮**同时**到手，
      // 回合预算被"投递即消耗"烧光，agent 一次手都没动（第三种真机 bug）。
      // 宿主的做法是只在 `agent/status → idle`（真·空闲**转换**）里撤预约，本模块照办。
      return
    }
    if (await driveOnce(state)) state.requested = true
  }

  /** 触发合并：多个触发只跑**一条** agent 局部串行 run（宿主同款 `requestDrive`）。 */
  function requestDrive(state: State): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error) {
            warn(`driver failed for agent "${state.agent.session.id}": ${renderThrown(error)}`)
          }
        }
      })
    } catch (error) {
      warn(`could not start driver for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    run.then(retire, (error) => {
      warn(`driver task rejected for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      retire()
    })
  }

  /** 回合被**接手**了 ⇒ 计数前进（`rounds.started`，耐久）。只有我们自署来源的回合才算。 */
  async function observeRound(scope: string, event: unknown): Promise<void> {
    const ev = event as SessionEventLike | undefined
    const source = ev?.data?.source
    if (ev?.type !== 'user/message' || source?.kind !== 'work' || typeof source.round !== 'number') return
    await domain.observeRound(scope, source.round)
  }

  ctx.effect(function* () {
    ctx.on('agent/created', ({ agent, source }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
      // 会话 `resume`（宿主重启后从盘上加载）⇒ **收回续跑许可**：无人值守的流程不会在你
      // 不知情时接着动；人要继续说一句就 arm（对齐宿主 goal 的 disarm-on-resume 纪律）。
      if (disarmOnResume && source === 'resume') {
        return domain.setActivation(agent.session.id, 'disarmed')
          .then(() => undefined)
          .catch((error: unknown) => {
            warn(`could not disarm on resume for "${agent.session.id}": ${renderThrown(error)}`)
            return undefined
          })
      }
      return undefined   // 该事件的监听器签名要求 promise | undefined（宿主同款）
    })
    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent)
    })
    ctx.on('agent/error', ({ agent }) => {
      // 出错的那一轮没有可用的接续：撤预约，等下一次空闲重新决策（状态面照旧）。
      stateFor(agent).attempt = undefined
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const state = stateFor(agent)
      state.competingQueued = false
      // **真·空闲转换**（宿主同款）：上一轮（若还挂着）到此为止 —— 撤预约、要求一次耐久检查点，
      // 然后接着拍。只有这条路径撤预约：`session/event` 之类的触发不许代劳（那是"投递即消耗"的坑）。
      if (state.attempt !== undefined) {
        state.attempt = undefined
        state.needsCheckpoint = true
      }
      requestDrive(state)
    })
    // **空闲信号与域变更都触发驱动**（对齐宿主 `goal/changed → requestDrive`）：
    // 别的插件写了流程时未必有本会话的回合结束事件，变更本身就该叫醒驱动器。
    onWorkChanged(ctx, ({ scope }) => {
      const agent = ctx.agents.get(scope as never)
      if (agent === undefined) return
      const state = stateFor(agent)
      // 域变了 ⇒ 旧的"已投递轮次"作废（修订前进后，同一任务可以再投新的一轮）。
      state.queued.clear()
      state.needsCheckpoint = true
      requestDrive(state)
    })
    // 回合事实（耐久计数）：每条会话事件都看一眼——只有自署 `work` 的回合才算数。
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id as never)
      if (agent === undefined) return undefined
      const state = stateFor(agent)
      // 返回 promise 供宿主/测试等待（cordis 不看返回值，等不到也不影响宿主）。
      return observeRound(session.id, event)
        .then(() => { if (agent.status === 'idle') requestDrive(state) })
        .catch((error: unknown) => { warn(`round observation failed for "${session.id}": ${renderThrown(error)}`) })
    })
    // 竞态围栏：别的消息排进 next-turn ⇒ 让路；我们那条被认领 / 丢弃 ⇒ 如实记账。
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const state = stateFor(agent)
      if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return
      const attempt = state.attempt
      if (isOwnAttempt(message, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const attempt = stateFor(agent).attempt
      if (isOwnAttempt(message, attempt)) attempt!.phase = 'claimed'
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const attempt = stateFor(agent).attempt
      if (isOwnAttempt(message, attempt)) attempt!.cancelled = true
    })
    yield () => {
      // 卸载：立刻关门，别再起新的拍。
      for (const state of states.values()) state.stopping = true
      states.clear()
    }
  })
}

//#endregion

export * from './decide.js'
export * from './prompt.js'
