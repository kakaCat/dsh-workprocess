/**
 * **驱动器插件**——结构照宿主 `@deepseek-ai/dsh-goal-round-driver` 一比一：
 *
 * | 宿主 goal driver | 本插件 |
 * | --- | --- |
 * | `name` / `inject = ['agents','goals','sessions']` / `apply(ctx)` | `name` / `inject = ['agents','sessions','workprocess']` / `apply(ctx, config?)` |
 * | 每 agent 一张 state（`attempt` / `competingQueued` / `needsCheckpoint` / `requested` / `run` / `stopping`） | 同 |
 * | `readyToDrive`：fiber 活跃 + agent 仍活着 + `status === 'idle'` + 无竞争排队 | 同 |
 * | `requestDrive`：请求合并成**一条** agent 局部串行 run（`withoutInitiator` + while + retire） | 同 |
 * | `drive`：耐久检查点 → 收尾上一轮预约 → 读现状 → 落副作用 / 投下一轮 | 同（读现状经 `ctx.workprocess`） |
 * | `agent.followup(createUserMessage(...))` 投递 + `attempt` 预约（消息身份精确比对） | 同（来源自署 `kind:'work'`） |
 * | `agent/inbox/inserted｜claimed｜discarded` 竞态围栏 | 同 |
 * | `ctx.effect(function* () { ... })` 挂监听 + `ctx.logger.warn` | 同 |
 *
 * 【我们多出来的三件事（goal 没有阶段概念）】阶段规划轮（`plan-stage`）、收口确认轮（`ask-*`）、
 * 流程自动收口（`close-process`）——投递走同一套 `attempt` 预约与围栏，去重键在 state 里
 * （`planAsked` / `askAsked`，语义等价于宿主"同一 goal 只推进一轮"）。
 *
 * 【数据从哪来】只经 `ctx.workprocess`（存储域由领域插件独占打开）；回合计数也是域服务的一部分。
 *
 * @module workprocess-round-driver/plugin
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { onWorkChanged, workprocessOf } from 'workprocess'
// 引入模块增强（MessageSourceMap 加 'work' 一格）：类型面的事，运行时不需要它。
import type {} from './message.js'
import { DEFAULT_MAX_ROUNDS, askDeliveryOf, planDeliveryOf, roundDeliveryOf, tickWorkprocess } from './runtime.js'
import type { RoundDelivery } from './runtime.js'

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
}

/** cordis `FiberState.ACTIVE` 的数值（const enum 在 isolatedModules 下不能当值用，宿主同款写法）。 */
const FIBER_ACTIVE = 2

/** 一次投递的**预约**：消息身份精确比对（竞态围栏靠它，绝不靠"内容差不多"）。 */
interface Attempt {
  readonly kind: 'drive' | 'plan' | 'ask'
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

  /** 读现状 → 决策 → 落"不需要人"的副作用 / 投一轮；返回是否请求再拍一拍。 */
  async function driveOnce(state: State): Promise<boolean> {
    const scope = state.agent.session.id
    const decision = await tickWorkprocess({
      domain,
      defaultMaxRounds,
      stagePlanAsked: (stageKey) => state.planAsked.has(stageKey),
      humanAskAsked: (askKey) => state.askAsked.has(askKey),
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
        reserveAndQueue(state, 'plan', delivery)
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
        reserveAndQueue(state, 'ask', delivery)
        return false
      }
      case 'start-stage':
      case 'close-stage':
      case 'block-task':
      case 'close-process':
        // 推进态结论（副作用已由 `tickWorkprocess` 经域服务落盘）⇒ 再拍一拍接着推进。
        state.needsCheckpoint = true
        return true
      default:
        // hold / wait-human：没有可做的了，停手等人。
        return false
    }
  }

  /** 一拍的完整语义（宿主 goal driver 的 `drive`：检查点 → 收尾上一轮 → 决策）。 */
  async function drive(state: State): Promise<void> {
    if (!readyToDrive(state)) return
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
      // 上一轮投出去、agent 又空闲了 ⇒ 这一轮已被接手跑完：撤预约，再拍一拍接着推进。
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
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
    ctx.on('agent/created', ({ agent }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
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

export type { RoundDelivery } from './runtime.js'
export { DEFAULT_MAX_ROUNDS } from './runtime.js'
