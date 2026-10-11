/**
 * dsh-workprocess：workprocess 的**插件入口**（宿主装配面）。
 *
 * 【这一层就是"组合根"】内核 / 驱动 / 工具面三件都是库，缺的是把四样东西接上：
 *   ① 归属记录的 `store`（`./domain`：宿主 storage domain——schema 校验 + 写即耐久 + `domain/changed`）；
 *   ② 真人判定 `resolveAuthority`（`./authority`：宿主会话事件切面 → 授权，不接则 human 策略永远拒）；
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
 * @module dsh-workprocess
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 引入模块增强（MessageSourceMap 加 'work' 一格）：类型面的事，运行时不需要它。
import type {} from './message.js'
import { workProcessOf } from 'workprocess-core'
import { WORK_TOOL_FACTORIES, WORK_TOOL_REGISTRY, type WorkToolDeps } from 'tool-workprocess'
import { agentOf, authorityResolverOf, type AuthorityHostCtx, type HostAgent, type HostSession } from './authority.js'
import { storageDomainStoreOf, type StorageDomainCtx } from './domain.js'
import { createWorkprocessService } from './service.js'
import {
  DEFAULT_MAX_ROUNDS, roundDeliveryOf, tickWorkprocess, type RoundDelivery,
} from './driver.js'

export { storageDomainStoreOf, workprocessDomain, WORKPROCESS_DOMAIN, WORKPROCESS_DOMAIN_VERSION } from './domain.js'
export { createWorkprocessService } from './service.js'
export type { WorkprocessService, WorkprocessStatus } from './service.js'
export { agentOf, authorityResolverOf } from './authority.js'
export { DEFAULT_MAX_ROUNDS, effectiveMaxRoundsOf, factsOf, roundDeliveryOf, tickWorkprocess } from './driver.js'
export type { StorageDomainCtx, DomainTableHandle } from './domain.js'
export type { HostAgent, HostEvent, HostSession } from './authority.js'
export type { RoundDelivery } from './driver.js'

/** 插件名（日志前缀与装载层条目 id 同源）。 */
export const name = 'workprocess'

/** 装配依赖：会话/agent 面（授权 + 投递）、工具注册面、会话投影（回合边界）、存储域（归属记录）。 */
export const inject = ['agents', 'tools', 'sessionProjections', 'storageDomain']

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
}

/** 会话事件的**最小读取面**（与 `authority.ts` 的 HostEvent 同源，这里只多要 taskId/revision）。 */
interface SessionEventLike {
  readonly type?: string
  readonly data?: {
    readonly source?: { readonly kind?: string; readonly round?: number; readonly taskId?: string; readonly revision?: number }
  }
}

interface DriveCtx {
  readonly drive: boolean
  readonly defaultMaxRounds: number
  /** 已投递、尚未接手的回合（`taskId:revision:round`；内存态——跨重启不重复投同一轮）。 */
  readonly pending: Set<string>
}

interface PluginCtx extends AuthorityHostCtx, StorageDomainCtx {
  readonly agents: AuthorityHostCtx['agents'] & { get(id: string): unknown }
  readonly tools: { register(tool: unknown): () => void }
  on(event: 'session/event', cb: (session: HostSession, event: unknown) => void | Promise<void>): unknown
  /** agent 生命周期事件（宿主 `agent/status`：`{ agent, status }`）——空闲边界的权威信号。 */
  on(event: 'agent/status', cb: (payload: { agent?: HostAgent; status?: string }) => void | Promise<void>): unknown
  /** 提供服务面（宿主 cordis：`ctx.provide(name, value)`；消费方按名注入）。 */
  provide(name: string, value: unknown): unknown
}

/** 装配：打开归属记录域 + 注册六个工具 + 挂回合边界驱动（含续跑投递）。 */
export function apply(ctx: PluginCtx, config?: WorkprocessConfig): void {
  const store = storageDomainStoreOf(ctx)
  const deps: WorkToolDeps = {
    store,
    now: () => Date.now(),
    // 归属缺省 = **本会话**（一个会话一条流程；多流程并存时要显式给 scope）。
    defaultScope: (exec) => agentOf(exec)?.session?.id,
    resolveAuthority: authorityResolverOf(ctx),
  }
  for (const entry of WORK_TOOL_REGISTRY) {
    const build = WORK_TOOL_FACTORIES[entry.handler as keyof typeof WORK_TOOL_FACTORIES]
    ctx.tools.register(build(deps))
  }
  // 把"读 + 人可做的三种干预"提供成服务：命令行包（dsh-command-workprocess）只消费它，
  // 不自己再开一次存储域（同名域重复 open 是响亮拒绝），也不绕内核改状态。
  ctx.provide('workprocess', createWorkprocessService(store))
  if (config?.tick !== false) {
    const driveCtx: DriveCtx = {
      drive: config?.drive === true,
      defaultMaxRounds: config?.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS,
      pending: new Set<string>(),
    }
    // ① 回合事实：只有我们自署来源的回合才算数（人的消息不是回合）。
    ctx.on('session/event', (session: HostSession, event: unknown) => {
      // 返回 promise 供宿主/测试等待（cordis 不看返回值，等不到也不影响宿主）。
      return onSessionEvent(ctx, store, session, event, driveCtx)
    })
    // ② **空闲边界驱动**（对齐宿主 `goal-round-driver` 的 `agent/status === 'idle'`）：
    //    "agent 空闲了"这件事的权威信号是 agent 状态事件，不是会话事件里读 turnBoundary——
    //    后者的时序靠不住（`turn/end` 那一拍投影可能还没翻成空闲，翻完之后又不再有事件，
    //    于是驱动器一枪不放；真机踩过）。返回 promise 供测试等待。
    ctx.on('agent/status', (payload: { agent?: HostAgent; status?: string }) => {
      if (payload?.status !== 'idle') return undefined
      const session = payload.agent?.session
      return session === undefined ? undefined : driveAtIdle(ctx, store, session, driveCtx)
    })
  }
}

/** 一个会话事件的处理：只记回合事实（驱动放在空闲边界上，见 `agent/status` 那条）。 */
async function onSessionEvent(
  ctx: PluginCtx, store: WorkToolDeps['store'], session: HostSession, event: unknown, drive: DriveCtx,
): Promise<void> {
  try {
    await observeWorkRound(store, session.id, event)
    // 兜底：万一 `agent/status` 的那一拍错过了（事件竞争），会话事件到达时若 agent 已空闲，补一拍。
    if ((ctx.agents.get(session.id) as { status?: string } | undefined)?.status !== 'idle') return
    await driveAtIdle(ctx, store, session, drive)
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
  ctx: PluginCtx, store: WorkToolDeps['store'], session: HostSession, drive: DriveCtx,
): Promise<void> {
  try {
    // 上界只是兜底（每拍推进都会 bump revision，正常两拍内就到 drive）：防规则改坏时打转。
    for (let tick = 0; tick < 4; tick += 1) {
      const decision = await tickWorkprocess({
        store,
        now: () => Date.now(),
        roundsStartedOf: async (scope) => (await store.get(scope))?.rounds?.started,
        defaultMaxRounds: drive.defaultMaxRounds,
      }, session.id, session.id)
      if (decision === undefined) return
      if (decision.kind === 'drive') {
        if (drive.drive) await deliverRound(ctx, store, session, decision.taskId, drive)
        return
      }
      // 只有**确实改了状态**的三种结论才值得再拍一次；其余（hold / wait-human / ask-*）停手。
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
  store: WorkToolDeps['store'], scope: string, event: unknown,
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
  ctx: AuthorityHostCtx, store: WorkToolDeps['store'], session: HostSession, drive?: DriveCtx,
): Promise<Awaited<ReturnType<typeof tickWorkprocess>>> {
  const boundary = ctx.sessionProjections?.stateOf(session, 'turnBoundary')
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
  ctx: PluginCtx, store: WorkToolDeps['store'], session: HostSession, taskId: string, drive: DriveCtx,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const roundsStarted = (await store.get(session.id))?.rounds?.started ?? 0
  const delivery = roundDeliveryOf(process, taskId, roundsStarted, drive.defaultMaxRounds)
  if (delivery === undefined) return undefined
  const key = delivery.taskId + ':' + String(delivery.revision) + ':' + String(delivery.round)
  if (drive.pending.has(key)) return undefined
  const agent = ctx.agents.get(session.id) as { followup?: (message: unknown) => void } | undefined
  if (typeof agent?.followup !== 'function') return undefined
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: delivery.prompt }],
    // **自署来源**：这一轮不是人打的字（授权面据此判自治），也绝不许冒充人。
    source: {
      kind: 'work', processId: delivery.processId, taskId: delivery.taskId,
      revision: delivery.revision, round: delivery.round,
    },
  }))
  drive.pending.add(key)
  return delivery
}
