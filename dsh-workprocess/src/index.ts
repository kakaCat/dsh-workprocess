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
import {
  WORK_TOOL_FACTORIES, WORK_TOOL_REGISTRY,
  type WorkHumanAsk, type WorkHumanVerdict, type WorkToolDeps,
} from 'tool-workprocess'
import { agentOf, authorityResolverOf, type AuthorityHostCtx, type HostAgent, type HostSession } from './authority.js'
import { storageDomainStoreOf, type StorageDomainCtx } from './domain.js'
import { createWorkprocessService } from './service.js'
import {
  DEFAULT_MAX_ROUNDS, askDeliveryOf, planDeliveryOf, roundDeliveryOf, tickWorkprocess, type RoundDelivery,
} from './driver.js'

export { storageDomainStoreOf, workprocessDomain, WORKPROCESS_DOMAIN, WORKPROCESS_DOMAIN_VERSION } from './domain.js'
export { createWorkprocessService } from './service.js'
export type { WorkprocessService, WorkprocessStatus } from './service.js'
export { agentOf, authorityResolverOf } from './authority.js'
export { DEFAULT_MAX_ROUNDS, askDeliveryOf, effectiveMaxRoundsOf, factsOf, planDeliveryOf, roundDeliveryOf, tickWorkprocess } from './driver.js'
export type { StorageDomainCtx, DomainTableHandle } from './domain.js'
export type { HostAgent, HostEvent, HostSession } from './authority.js'
export type { RoundDelivery } from './driver.js'

/** 插件名（日志前缀与装载层条目 id 同源）。 */
export const name = 'workprocess'

/** 装配依赖：会话/agent 面（授权 + 投递）、工具注册面、会话投影（回合边界）、存储域（归属记录）。 */
export const inject = ['agents', 'tools', 'sessionProjections', 'storageDomain', 'systemPrompt']

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
  /** 已经问过**阶段规划轮**的阶段键（同一阶段只问一次：问过就停手等人，不空转）。 */
  readonly planAsked: Set<string>
  /** 已经问过人的**收口确认**键（`stage-done:<阶段键>` / `close`：同一件事只问一次，不刷屏）。 */
  readonly askAsked: Set<string>
}

interface PluginCtx extends AuthorityHostCtx, StorageDomainCtx {
  readonly agents: AuthorityHostCtx['agents'] & { get(id: string): unknown }
  readonly tools: { register(tool: unknown): () => void }
  on(event: 'session/event', cb: (session: HostSession, event: unknown) => void | Promise<void>): unknown
  /** agent 生命周期事件（宿主 `agent/status`：`{ agent, status }`）——空闲边界的权威信号。 */
  on(event: 'agent/status', cb: (payload: { agent?: HostAgent; status?: string }) => void | Promise<void>): unknown
  /** 提供服务面（宿主 cordis：`ctx.provide(name, value)`；消费方按名注入）。 */
  provide(name: string, value: unknown): unknown
  /** 按名取服务（cordis：`ctx.get('userQuestions')` 等）。 */
  get?(name: string): unknown
  /** 系统提示词面（注册常驻策略段；缺省 = 不注册，插件其余面照常）。 */
  readonly systemPrompt?: {
    section(section: { name: string; order: number; text: string }): unknown
    getSectionOrder(name: string): number
  }
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
    // 工具回执之后的**通告**（宿主 `exec.deferContext`）：落成一条自署 `work-tool` 的消息，
    // 附在该次 tool/result 之后（离决策点最近）。
    deferNotice: (exec, n) => deferNoticeOf(exec, n),
    // **人机确认口**（宿主 `ctx.userQuestions`）：策略 human 的阶段收口由**工具自己问人**——
    // 宿主把人的答复只记成 `ask_user_question` 的工具结果（没有 user/message 事件），
    // 靠"模型问完再自己落章"是落不了的；`plan-mode` 的 exit 工具也是这个路子。
    askHuman: (exec, request) => askHumanOf(ctx, exec, request),
  }
  for (const entry of WORK_TOOL_REGISTRY) {
    const build = WORK_TOOL_FACTORIES[entry.handler as keyof typeof WORK_TOOL_FACTORIES]
    ctx.tools.register(build(deps))
  }
  // 把"读 + 人可做的三种干预"提供成服务：命令行包（dsh-command-workprocess）只消费它，
  // 不自己再开一次存储域（同名域重复 open 是响亮拒绝），也不绕内核改状态。
  ctx.provide('workprocess', createWorkprocessService(store))
  // **常驻策略段**（对齐宿主 `dsh-tool-goal` 的 `ctx.systemPrompt.section`）：
  // 工具自述只在模型"打算调工具"时被读到，而"阶段串行 / 谁能落 done / 回合预算"这些纪律
  // 得在每轮都在场。槽位紧跟 TOOL_GOAL（同族工具，顺序数相同由名字定先后）。
  try {
    ctx.systemPrompt?.section({
      name: 'tool:workprocess',
      order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
      text: WORK_POLICY_TEXT,
    })
  } catch (err) {
    console.warn('[workprocess] 策略段注册失败（工具面照常）：' + String((err as Error)?.message ?? err))
  }
  if (config?.tick !== false) {
    const driveCtx: DriveCtx = {
      drive: config?.drive === true,
      defaultMaxRounds: config?.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS,
      pending: new Set<string>(),
      planAsked: new Set<string>(),
      askAsked: new Set<string>(),
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
        stagePlanAsked: (stageKey) => drive.planAsked.has(stageKey),
        humanAskAsked: (askKey) => drive.askAsked.has(askKey),
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
  ctx: PluginCtx, store: WorkToolDeps['store'], session: HostSession, stageKey: string,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const delivery = planDeliveryOf(process, stageKey)
  if (delivery === undefined) return undefined
  const agent = ctx.agents.get(session.id) as { followup?: (message: unknown) => void } | undefined
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
  ctx: PluginCtx, store: WorkToolDeps['store'], session: HostSession,
  kind: 'ask-stage-done' | 'ask-close', stageKey?: string,
): Promise<RoundDelivery | undefined> {
  const process = await workProcessOf({ store }, session.id)
  if (process === undefined) return undefined
  const delivery = askDeliveryOf(process, kind === 'ask-close' ? 'close' : 'stage-done', stageKey)
  if (delivery === undefined) return undefined
  const agent = ctx.agents.get(session.id) as { followup?: (message: unknown) => void } | undefined
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

/** 常驻策略段（模型面）：工具自述读不到的那几条纪律，放这里每轮都在场。 */
export const WORK_POLICY_TEXT = [
  '## workprocess（两层工作模型：流程 → 阶段 → 任务）',
  '- **阶段严格串行**：前序阶段全部收口后才轮到下一阶段；不要越阶段开工，也不要提前给后续阶段建任务。',
  '- **阶段开工不是你的动作**：串行门放行后由驱动器在空闲边界落；你只管任务（`create_worktask` / `update_worktask`）。',
  '- **每个阶段开始时驱动器会提醒你规划**该阶段的任务（1–3 个、写成可核验的陈述）。',
  '- **收口策略决定谁落 done**：`human`（缺省）——你**只提议**，由人确认（agent 自写会被拒）；',
  '  `auto`——任务全达成后由驱动器自动收口，你不要自己写。',
  '- **任务有回合预算**（`max_rounds`，缺省由配置兜底）：到顶会落盘 block，等人裁；不要靠反复重试绕过它。',
  '- 自动续跑回合会以一条带 `<workprocess_round>` / `<workprocess_plan>` / `<workprocess_ask>` 语义的',
  '  指令出现（来源自署 `work`）：只做那一轮说的事，做完停手，下一轮由驱动器投递。',
].join('\n')

/**
 * 把工具通告落成一条**自署来源**的消息，附在该次工具回执之后（宿主 `exec.deferContext`）。
 *
 * 【必须方法调用】`exec.deferContext(...)`——摘成变量再调会让 `this` 丢（与 `followup` 同款的坑）。
 * 【来源自署】`kind: 'work-tool'`：既不是人（`user`）也不是自动回合（`work`），
 * 授权面据此不授任何权限——通告只是说明，不是授权凭据。
 */
export function deferNoticeOf(exec: unknown, notice: { summary: string; text: string }): void {
  const surface = exec as { deferContext?: (message: unknown) => void } | undefined
  if (typeof surface?.deferContext !== 'function') return
  surface.deferContext(createUserMessage({
    content: [{ type: 'text', text: notice.text }],
    source: { kind: 'work-tool', form: 'notice', summary: notice.summary },
  }))
}

/** 宿主 `ctx.userQuestions` 的**最小读取面**（`ask` 是唯一用到的入口）。 */
interface UserQuestionsLike {
  ask(request: {
    readonly questions: readonly {
      readonly id: string
      readonly header?: string
      readonly question: string
      readonly detail?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
    }[]
    readonly agent?: unknown
    readonly signal?: unknown
  }): Promise<{ readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] }>
}

/**
 * 把工具面的人机确认请求接到宿主的问题服务上（对齐宿主 `plan-mode` 的 `exit_plan_mode`）。
 *
 * 【四种结局都要如实回收】同意 = `approved`；选了别的 / 自定义输入 = `declined`（带反馈）；
 * 人打断去说话（`ASK_CANCELLED`）、没有弹框通道（`NO_PROVIDER`）、调用者不是活跃根
 * （`CALLER_NOT_LIVE` / `DELEGATED_CALLER`，子 agent 问不了人）——一律 `cancelled`，
 * **绝不把"没问成"当成"同意"**（那才是真正危险的默认值）。
 */
export async function askHumanOf(
  ctx: PluginCtx, exec: unknown, request: WorkHumanAsk,
): Promise<WorkHumanVerdict> {
  const service = ctx.get?.('userQuestions') as UserQuestionsLike | undefined
  if (typeof service?.ask !== 'function') return { kind: 'no-channel' }
  const agent = agentOf(exec)
  const signal = (exec as { signal?: unknown } | undefined)?.signal
  try {
    const answer = await service.ask({
      questions: [{
        id: request.id,
        header: request.header,
        question: request.question,
        ...(request.detail === undefined ? {} : { detail: request.detail }),
        options: request.options.map((o) => (
          o.description === undefined ? { label: o.label } : { label: o.label, description: o.description }
        )),
      }],
      ...(agent === undefined ? {} : { agent }),
      ...(signal === undefined ? {} : { signal }),
    })
    const item = answer.answers.find((a) => a.id === request.id)
    if (item === undefined) return { kind: 'cancelled', reason: 'no-answer' }
    if (item.selected.includes(request.approve) && item.custom === undefined) return { kind: 'approved' }
    return item.custom === undefined || item.custom === ''
      ? { kind: 'declined' }
      : { kind: 'declined', feedback: item.custom }
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code
    const reason = typeof code === 'string' ? code : 'ask-failed'
    // 有服务但没人接这一问 ⇒ 等价于"没有通道"（退回拒绝并指路）；其余（打断 / 中止 / 非活跃根）才是 cancelled。
    return reason === 'NO_PROVIDER' ? { kind: 'no-channel' } : { kind: 'cancelled', reason }
  }
}
