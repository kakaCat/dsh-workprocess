/**
 * dsh-workprocess：workprocess 的**插件入口**（宿主装配面）。
 *
 * 【这一层就是"组合根"】内核 / 驱动两件是库，缺的是把三样东西接上：
 *   ① 归属记录的 `store`（`./domain`：宿主 storage domain——schema 校验 + 写即耐久 + `domain/changed`）；
 *   ② （工具面的授权判据 / 通告 / 人机确认已随工具面迁到 `tool-workprocess`——那是工具自己的关切）；
 *   ③ 回合边界驱动（`./driver`：开工 / auto 收口 / 落盘 block——只做不需要人的那三种）；
 *   ④ **续跑投递**（`drive`）：空闲边界上把"下一轮该跑什么"投给会话（`agent.followup`），
 *      让任务在没人催的情况下自己往前走；刹车 = 任务的 `max_rounds`（缺省 {@link DEFAULT_MAX_ROUNDS}）。
 *
 * 【与宿主 tool-goal 同形】`export const name` / `export const inject` / `export function apply(ctx, config)`。
 *
 * 【状态为什么不进会话日志】goal 能进是因为它**在仓内**（事件类型进了生成的 KNOWN 列表）；
 * 仓外插件 append 自定义事件没有 `ignorable` 标记，会被持久化读路径判为"未知且必需"而
 * **拒绝解释整条会话日志**。本插件改用宿主给仓外插件准备的持久化面（`ctx.storageDomain`）。
 *
 * 【还没接的部分】`ask-*`（人机弹框确认）——见 README。
 *
 * @module workprocess
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 引入模块增强（MessageSourceMap 加 'work' 一格）：类型面的事，运行时不需要它。
import type {} from './message.js'
import { workProcessOf } from './kernel.js'
import type { WorkStoreLike } from './kernel.js'
import type { Context } from '@deepseek-ai/cordis'
// type-only import：官方包的 `declare module` 增强（ctx.agents / agent/status 事件 /
// ctx.sessionProjections 等）随包入程序——单包编译时不会被别的包顺带拉进来。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { WorkChangedPayload } from './events.js'
import { storageDomainStoreOf } from './storage.js'
import { createWorkprocessService } from './service.js'
import {
  DEFAULT_MAX_ROUNDS, askDeliveryOf, planDeliveryOf, roundDeliveryOf, tickWorkprocess, type RoundDelivery,
} from './driver.js'

export * from './kernel.js'
import './events.js'
export type { WorkChangedPayload } from './events.js'
export { storageDomainStoreOf, workprocessDomain, WORKPROCESS_DOMAIN, WORKPROCESS_DOMAIN_VERSION } from './storage.js'
export { createWorkprocessService } from './service.js'
export type { WorkprocessService, WorkprocessStatus } from './service.js'
export { DEFAULT_MAX_ROUNDS, askDeliveryOf, effectiveMaxRoundsOf, factsOf, planDeliveryOf, roundDeliveryOf, tickWorkprocess } from './driver.js'
export type { StorageDomainCtx, DomainTableHandle } from './storage.js'
export type { RoundDelivery } from './driver.js'

/** 插件名（日志前缀与装载层条目 id 同源）。 */
export const name = 'workprocess'

/** 装配依赖：会话/agent 面（授权 + 投递）、工具注册面、会话投影（回合边界）、存储域（归属记录）。 */
export const inject = ['agents', 'sessionProjections', 'storageDomain']

/** 装载层配置（`cordis.patch.yml` 的 config 段）。 */
export interface WorkprocessConfig {
  /** 回合边界是否自动驱动（缺省 true；关掉 = 只留工具面，状态迁移全靠人/模型显式调）。 */
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

/** 会话的**窄引用**（投递/驱动只要 id；官方 Session 类型在边界处自然满足）。 */
type SessionRef = { readonly id: string }

/** 会话事件的**最小读取面**（与 authority.ts 的 AuthorityEventSlice 同源，这里只多要 taskId/revision）。 */
interface SessionEventLike {
  readonly type?: string
  readonly data?: {
    readonly source?: { readonly kind?: string; readonly round?: number; readonly taskId?: string; readonly revision?: number }
  }
}

interface DriveCtx {
  readonly drive: boolean
  readonly defaultMaxRounds: number
  /** **流程自动收口**（`close: 'auto'`）：最后一段 done 后驱动器直接落 close，不问人。 */
  readonly autoClose: boolean
  /** 已投递、尚未接手的回合（`taskId:revision:round`；内存态——跨重启不重复投同一轮）。 */
  readonly pending: Set<string>
  /** 已经问过**阶段规划轮**的阶段键（同一阶段只问一次：问过就停手等人，不空转）。 */
  readonly planAsked: Set<string>
  /** 已经问过人的**收口确认**键（`stage-done:<阶段键>` / `close`：同一件事只问一次，不刷屏）。 */
  readonly askAsked: Set<string>
}

/** 装配：打开归属记录域 + 注册六个工具 + 提供 ctx.workprocess 服务 + 发 work/changed + 挂回合边界驱动。 */
export function apply(ctx: Context, config?: WorkprocessConfig): void {
  const store = storageDomainStoreOf(ctx)
  /** 内核变更通知 → 宿主事件：写路径（工具 / 服务 / 驱动拍）统一在这里进事件总线。 */
  const emitChanged = (scope: string, change: WorkChangedPayload['change']): void => {
    try {
      ctx.emit('work/changed', { scope, change })
    } catch (err) {
      // 监听器故障由宿主兜底；这里再兜一层，绝不让通知中断写路径。
      console.warn('[workprocess] work/changed 投递失败：' + String((err as Error)?.message ?? err))
    }
  }
  // **服务面**：域 API（读 + 全部写动词）+ 人机干预。工具面 / 命令行都经它读写——
  // 存储域只能由本插件独占打开（同名域重复 open 是响亮拒绝），消费方不需要 store。
  ctx.provide('workprocess', createWorkprocessService(
    { store, now: () => Date.now(), onChanged: (n) => emitChanged(n.scope, n.change as WorkChangedPayload['change']) },
    (scope) => emitChanged(scope, undefined),
  ))
  if (config?.tick !== false) {
    const driveCtx: DriveCtx = {
      drive: config?.drive === true,
      defaultMaxRounds: config?.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS,
      // 方案 B 缺省 'auto'：最后一段 done 即收口（human 模式与旧行为等价——请判轮问了也不落章）。
      autoClose: config?.close !== 'human',
      pending: new Set<string>(),
      planAsked: new Set<string>(),
      askAsked: new Set<string>(),
    }
    // ① 回合事实：只有我们自署来源的回合才算数（人的消息不是回合）。
    ctx.on('session/event', (session: SessionRef, event: unknown) => {
      // 返回 promise 供宿主/测试等待（cordis 不看返回值，等不到也不影响宿主）。
      return onSessionEvent(ctx, store, session, event, driveCtx, emitChanged)
    })
    // ② **空闲边界驱动**（对齐宿主 `goal-round-driver` 的 `agent/status === 'idle'`）：
    //    "agent 空闲了"这件事的权威信号是 agent 状态事件，不是会话事件里读 turnBoundary——
    //    后者的时序靠不住（`turn/end` 那一拍投影可能还没翻成空闲，翻完之后又不再有事件，
    //    于是驱动器一枪不放；真机踩过）。返回 promise 供测试等待。
    // 官方载荷形状（dsh-agent 的 Events 增强）：{ agent, status }；session 取窄引用。
    ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return undefined
      const session = payload.agent?.session as SessionRef | undefined
      return session === undefined ? undefined : driveAtIdle(ctx, store, session, driveCtx, emitChanged)
    })
  }
}

/** 一个会话事件的处理：只记回合事实（驱动放在空闲边界上，见 `agent/status` 那条）。 */
async function onSessionEvent(
  ctx: Context, store: WorkStoreLike, session: SessionRef, event: unknown, drive: DriveCtx,
  emitChanged: (scope: string, change: WorkChangedPayload['change']) => void,
): Promise<void> {
  try {
    await observeWorkRound(store, session.id, event)
    // 兜底：万一 `agent/status` 的那一拍错过了（事件竞争），会话事件到达时若 agent 已空闲，补一拍。
    if ((ctx.agents.get(session.id as never) as { status?: string } | undefined)?.status !== 'idle') return
    await driveAtIdle(ctx, store, session, drive, emitChanged)
  } catch (err) {
    // 驱动失败不许冒泡进宿主的事件总线（那会带崩本轮会话）：如实记一行，下个边界再试。
    console.warn('[workprocess] 回合边界驱动失败（不影响本轮会话）：' + String((err as Error)?.message ?? err))
  }
}

/**
 * **空闲边界上把该做的做完**：一拍只推进一件事，但推进完**立刻再拍**——
 * 因为"阶段开工"与"投第一轮"是两拍（开工改状态，投递才让 agent 真的动起来），
 * 而空闲边界只会来一次：只拍一下的话，开工之后没人再拍，流程就停在那儿了（真机症状）。
 *
 * 终止条件：得出 `drive`（投递后 agent 会醒，由下一轮空闲边界接着驱动）、
 * 或得出任何**不推进状态**的结论（hold / wait-human / ask-* / 没流程）。
 */
async function driveAtIdle(
  ctx: Context, store: WorkStoreLike, session: SessionRef, drive: DriveCtx,
  emitChanged: (scope: string, change: WorkChangedPayload['change']) => void,
): Promise<void> {
  try {
    // 上界只是兜底（每拍推进都会 bump revision，正常两拍内就到 drive）：防规则改坏时打转。
    for (let tick = 0; tick < 4; tick += 1) {
      const decision = await tickWorkprocess({
        store,
        now: () => Date.now(),
        roundsStartedOf: async (scope) => (await store.get(scope))?.rounds?.started,
        defaultMaxRounds: drive.defaultMaxRounds,
        stagePlanAsked: (stageKey) => drive.planAsked.has(stageKey),
        humanAskAsked: (askKey) => drive.askAsked.has(askKey),
        autoClose: drive.autoClose,
        onChanged: (notification) => emitChanged(notification.scope, notification.change as WorkChangedPayload['change']),
      }, session.id, session.id)
      if (decision === undefined) return
      if (decision.kind === 'drive') {
        if (drive.drive) await deliverRound(ctx, store, session, decision.taskId, drive)
        return
      }
      // **阶段规划轮**：本阶段开工了却没任务 ⇒ 投一轮让 agent 给本阶段建任务。
      // 记下"已经问过"（决策树下一拍会改成停手等人），不消耗任何任务的回合预算。
      if (decision.kind === 'plan-stage') {
        if (!drive.drive) return
        drive.planAsked.add(decision.stageKey)
        await deliverPlanRound(ctx, store, session, decision.stageKey)
        return
      }
      // **收口确认轮**：任务全达成但策略是 human（或全阶段 done ⇒ 流程收口）⇒ 请人拍板。
      // 到这一步机器能做的都做完了；不把"该人拍板了"说出口，流程就会安静地停住（看起来就是卡死）。
      if (decision.kind === 'ask-stage-done' || decision.kind === 'ask-close') {
        if (!drive.drive) return
        const askKey = decision.kind === 'ask-close' ? 'close' : 'stage-done:' + decision.stageKey
        drive.askAsked.add(askKey)
        await deliverAskRound(ctx, store, session, decision.kind, decision.kind === 'ask-close' ? undefined : decision.stageKey)
        return
      }
      // **流程自动收口**：推进态结论，再拍一拍（下一拍会发现已收口 → hold('process-closed')，循环终止）。
      if (decision.kind === 'close-process') continue
      // 只有**确实改了状态**的三种结论才值得再拍一次；其余（hold / wait-human）停手。
      if (decision.kind !== 'start-stage' && decision.kind !== 'close-stage' && decision.kind !== 'block-task') return
    }
  } catch (err) {
    console.warn('[workprocess] 空闲边界驱动失败（不影响本轮会话）：' + String((err as Error)?.message ?? err))
  }
}

/**
 * 回合被**接手**了 ⇒ 计数前进（`rounds.started`，耐久）。上限判据靠它：重启后不丢、不重复。
 * 只有我们自署来源的回合（`source.kind === 'work'`）才算——人的消息不是回合。
 */
export async function observeWorkRound(
  store: WorkStoreLike, scope: string, event: unknown,
): Promise<number | undefined> {
  const ev = event as SessionEventLike | undefined
  const source = ev?.data?.source
  if (ev?.type !== 'user/message' || source?.kind !== 'work' || typeof source.round !== 'number') return undefined
  const round = source.round
  await store.mutate(scope, (r) => {
    const current = r.rounds?.started ?? 0
    if (round <= current) return undefined   // 旧回合 / 重复观察：零写入
    r.rounds = { ...r.rounds, started: round }
    r.updatedAt = Date.now()
    return { changed: true }
  })
  return round
}

/**
 * 回合边界上的**一拍驱动**（给"已知当前空闲"的调用方用：命令行、测试、一次性补拍）。
 *
 * 【为什么不再由插件内部的会话事件调它】空闲边界的权威信号是 `agent/status → idle`
 * （宿主 `goal-round-driver` 同款）。曾经在 `session/event` 里读 `turnBoundary` 判空闲：
 * `turn/end` 那一拍投影可能还没翻成空闲，翻完之后又不再有事件——驱动器一枪不放（真机踩过）。
 */
export async function tickAtBoundary(
  ctx: Context, store: WorkStoreLike, session: SessionRef, drive?: DriveCtx,
): Promise<Awaited<ReturnType<typeof tickWorkprocess>>> {
  const boundary = ctx.sessionProjections?.stateOf(session as never, 'turnBoundary')
  if (boundary?.openTurnStartSeq !== null) return undefined
  return tickWorkprocess({
    store,
    now: () => Date.now(),
    roundsStartedOf: async (scope) => (await store.get(scope))?.rounds?.started,
    ...(drive === undefined ? {} : { defaultMaxRounds: drive.defaultMaxRounds }),
  }, session.id, session.id)
}

/** 把下一轮投给会话（`agent.followup`）：同一轮只投一次（`taskId:revision:round` 去重）。 */
export async function deliverRound(
  ctx: Context, store: WorkStoreLike, session: SessionRef, taskId: string, drive: DriveCtx,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const roundsStarted = (await store.get(session.id))?.rounds?.started ?? 0
  const delivery = roundDeliveryOf(process, taskId, roundsStarted, drive.defaultMaxRounds)
  if (delivery === undefined) return undefined
  const key = delivery.taskId + ':' + String(delivery.revision) + ':' + String(delivery.round)
  if (drive.pending.has(key)) return undefined
  const agent = ctx.agents.get(session.id as never) as { followup?: (message: unknown) => void } | undefined
  if (typeof agent?.followup !== 'function') return undefined
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: delivery.prompt }],
    // **自署来源**：这一轮不是人打的字（授权面据此判自治），也绝不许冒充人。
    source: {
      kind: 'work', processId: delivery.processId, stageKey: delivery.stageKey, taskId: delivery.taskId,
      revision: delivery.revision, round: delivery.round,
    },
  }))
  drive.pending.add(key)
  return delivery
}

/**
 * 把**阶段规划轮**投给会话：本阶段开工了却没任务 ⇒ 请 agent 用 `create_worktask` 给本阶段建任务。
 *
 * 【为什么这是自动推进闭环缺的一环】阶段串行 ⇒ 任务只属于当前阶段 ⇒ **每过一个阶段边界，
 * 新阶段必然是空的**；没人叫 agent 拆任务，流程就在每个阶段边界上停死（真机踩过）。
 *
 * 来源同样自署 `work`（这是自动回合，不是人打的字），但**不带 `round`**：
 * 规划轮不消耗任务预算，也就不该把 `rounds.started` 往前推（那个计数是回合上限的判据）。
 */
export async function deliverPlanRound(
  ctx: Context, store: WorkStoreLike, session: SessionRef, stageKey: string,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const delivery = planDeliveryOf(process, stageKey)
  if (delivery === undefined) return undefined
  const agent = ctx.agents.get(session.id as never) as { followup?: (message: unknown) => void } | undefined
  if (typeof agent?.followup !== 'function') return undefined
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: delivery.prompt }],
    source: {
      kind: 'work', processId: delivery.processId, stageKey: delivery.stageKey, revision: delivery.revision,
    },
  }))
  return delivery
}

/**
 * 把**收口确认轮**投给会话：任务全达成但策略 `human`（或全阶段 done）⇒ 请 agent 向人确认。
 *
 * 【为什么这是必须的】`human` 策略下 done 由人落、agent 只提议——但"提议"得**说出口**。
 * 没有这一轮：流程安静地停在阶段边界上，人只看到"卡住了"（真机踩过）。
 * 来源同样自署 `work`（自动回合，不是人打的字），**不带 `round`**（不消耗任务预算）。
 */
export async function deliverAskRound(
  ctx: Context, store: WorkStoreLike, session: SessionRef,
  kind: 'ask-stage-done' | 'ask-close', stageKey?: string,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const delivery = askDeliveryOf(process, kind === 'ask-close' ? 'close' : 'stage-done', stageKey)
  if (delivery === undefined) return undefined
  const agent = ctx.agents.get(session.id as never) as { followup?: (message: unknown) => void } | undefined
  if (typeof agent?.followup !== 'function') return undefined
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: delivery.prompt }],
    source: {
      kind: 'work', processId: delivery.processId,
      ...(delivery.stageKey === '' ? {} : { stageKey: delivery.stageKey }),
      revision: delivery.revision,
    },
  }))
  return delivery
}
