/**
 * **授权与宿主对话面**——本包唯一的"谁能做什么 / 怎么和宿主说话"模块。
 *
 * 上半：授权**判据**（纯函数，零 I/O）——`authorityFromEvents` 从会话事件切面判"这一轮是谁发起的"，
 *       `isActionAuthorized` / `requireActionAuthority` 按动作分级（`task_resume` 恒为真人专属；
 *       `stage_done` 按阶段收口策略：`human` = 真人专属，`auto` = 自治回合放行）。
 * 下半：**宿主适配**——把官方 cordis 面接到工具执行点上：授权判据读取（`authorityResolverOf`）、
 *       工具回执之后的通告（`exec.deferContext`）、人机确认（`ctx.userQuestions`）与通告的来源声明。
 *
 * 【与宿主的分工对照】宿主把"授权"独立成 `authority` 模块、把"回合结束话术"独立成 `wrapup` 模块
 * （见其 `lib/index.js` 的打包分区）；我们这两件事都落在本模块——它们的共同点是
 * **都在处理"工具与宿主/人的边界"**，而不是工具自己的参数与回执。
 *
 * @module tool-workprocess/authority
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
// type-only import：官方包的 `declare module` 增强（ctx.agents / ctx.sessionProjections）随包入程序。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm'
import { WorkError } from 'workprocess'
import type { WorkStageClosePolicy } from 'workprocess'
import type { WorkHumanAsk, WorkHumanVerdict } from './tools.js'

/** 一次状态变更调用获得的硬授权（对齐宿主 `GoalToolAuthority`）。 */
export type WorkToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'autonomous' }

/**
 * 续跑回合的**精确授权四元组**（对齐宿主 `isMatchingGoalRound`，本包加了 taskId 这一维）：
 * `taskId + revision + round` 三项都要与**当前**任务对得上，才算"正是该任务的续跑回合"：
 *   · taskId 不对   → 是别的任务的回合；
 *   · revision 不对 → 任务在回合开始后被改过（旧回合不代表当前目标）；
 *   · round 不对    → 不是最新准入的回合（旧回合 / 伪造回合）。
 */
export interface WorkRoundRef {
  readonly taskId: string
  readonly revision: number
  readonly round: number
}

/** 消息来源里与授权相关的字段（`taskId`/`revision` 是 `WorkMessageSource` 的对应半）。 */
interface AuthoritySource {
  readonly kind?: string
  readonly round?: number
  readonly taskId?: string
  readonly revision?: number
}

/** 来源是否**精确**命中四元组（缺 taskId 的旧消息：给了期望就不放行——严格侧）。 */
function isMatchingWorkRound(source: AuthoritySource | undefined, expected: WorkRoundRef): boolean {
  return source?.kind === 'work'
    && source.taskId === expected.taskId
    && source.revision === expected.revision
    && source.round === expected.round
}

/**
 * 从**会话事件**判定本回合的授权（对齐宿主 `hasDirectHumanInput` / `completionAuthority`）。
 *
 * 宿主扫 `user/message` 且 `source.kind === 'user'`；本包把它做成纯函数，
 * 组合根拿到事件切面后调用即可（缺省不判 = 退回 `autonomous`，见 `workToolExecution`）。
 *
 * @param events 有序事件数组（`seq` 即下标）
 * @param openTurnStartSeq 本回合起始 seq（**只扫它之后的事件**——历史里的人类消息不算本轮授权）
 * @param isRootAgent 调用者是否为顶层 agent
 * @param expected 当前任务的授权三元组（taskId + revision + round）
 */
export function authorityFromEvents(
  events: readonly { readonly type?: string; readonly data?: { readonly source?: AuthoritySource } }[],
  openTurnStartSeq: number,
  isRootAgent: boolean,
  expected?: WorkRoundRef,
): WorkToolAuthority | undefined {
  if (!isRootAgent) return undefined
  let workRound = false
  for (let seq = openTurnStartSeq + 1; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === 'user') return { kind: 'direct-human' }
    if (expected !== undefined ? isMatchingWorkRound(source, expected) : source?.kind === 'work') {
      workRound = true
    }
  }
  return workRound ? { kind: 'autonomous' } : undefined
}

/** 需要真人授权的**全部**动作（唯一一份：改这里即改全部调用点）。 */
export type WorkAuthorityAction =
  | 'task_edit' | 'task_pause' | 'task_resume' | 'task_block' | 'task_complete' | 'task_clear'
  | 'stage_done' | 'process_edit' | 'process_discard' | 'process_arm'

/** 调用者解析结果（对齐宿主 `GoalToolExecution` 的最小面）。 */
export interface WorkToolExecution {
  readonly authority: WorkToolAuthority
  readonly agentId?: string
}

/**
 * 解析本次调用的授权。
 * @param exec 工具执行元数据（本包侧可能只有 `agent.id`）
 * @param resolveAuthority 组合根注入的真人判定（缺省 = 保守的 autonomous）
 * @param expected 当前任务的授权三元组（给了就必须精确命中才授 autonomous）
 */
export function workToolExecution(
  exec: unknown,
  resolveAuthority?: (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined,
  expected?: WorkRoundRef,
): WorkToolExecution {
  const agent = (exec as { agent?: { id?: string } } | undefined)?.agent
  const granted = resolveAuthority?.(exec, expected)
  return {
    authority: granted ?? { kind: 'autonomous' },
    ...(typeof agent?.id === 'string' ? { agentId: agent.id } : {}),
  }
}

/**
 * 真人专属动作：改目标（`task_edit` / `process_edit`）、继续（`resume`）、**丢弃流程**（`process_discard`）。
 * 前三个是"改人的意图"（改的是要达成什么 / 要不要继续），第四个是"撤掉整条流程"，
 * 第五个是"要不要让它自己往下跑"（续跑许可）——都是 agent 自行发起就会推翻人的决定的那类。
 */
const HUMAN_ONLY: ReadonlySet<WorkAuthorityAction> = new Set<WorkAuthorityAction>(
  ['task_edit', 'task_resume', 'process_edit', 'process_discard', 'process_arm'],
)

/**
 * 判据的**上下文**（授权面不自己读流程：目标阶段的收口策略由调用方投影进来）。
 * 缺失 = 按 `human` 口径判（保守侧：拿不准就别放行自治）。
 */
export interface WorkAuthorityContext {
  /** `stage_done` 的目标阶段收口策略（缺省 `human` = 人工确认）。 */
  readonly stageClosePolicy?: WorkStageClosePolicy
}

/** 该动作在当前授权与上下文下是否放行（纯函数，可单测）。 */
export function isActionAuthorized(
  action: WorkAuthorityAction, authority: WorkToolAuthority, ctx?: WorkAuthorityContext,
): boolean {
  if (authority.kind === 'direct-human') return true
  // 策略 `auto` 的阶段：收口自治合法（阶段已声明任务全完成即自动收口）。
  if (action === 'stage_done') return (ctx?.stageClosePolicy ?? 'human') === 'auto'
  return !HUMAN_ONLY.has(action)
}

/** 放行判定；不放行则抛结构化错误（`WorkError`，机器可路由）。 */
export function requireActionAuthority(
  action: WorkAuthorityAction, authority: WorkToolAuthority, ctx?: WorkAuthorityContext,
): void {
  if (isActionAuthorized(action, authority, ctx)) return
  throw new WorkError(
    action === 'stage_done'
      ? '本阶段收口策略是 `human`（人工确认）：agent 自行 stage_done 等于替人判定"这一段算不算成了"'
        + '——请由人在宿主界面上确认，或由人把该阶段改成 auto（close_policy）后自动收口'
      : action === 'process_discard'
        ? '丢弃流程是不可逆的（流程与任务墓碑一起消失、回合计数归零）：只能由人直接发起'
          + '——agent 自撤流程会抹掉"这里曾经有一条流程"这段历史'
        : action === 'process_edit'
          ? '改流程目标是"改人的意图"：agent 自行改目标会让流程悄悄跑偏到另一件事上'
            + '——请由人直接发起（如 `/work edit <目标>`，命令行会以人的名义把这句交给 agent）'
          : '`' + action + '` 需要人显式发起（agent 自行 ' + action + ' 会推翻人的意图或越权确认）'
            + '——请由人在宿主界面上确认，或由人直接调本工具',
    'WORK_NO_PERMISSION',
  )
}

// type-only import：官方包的 `declare module` 增强（ctx.sessionProjections / ctx.agents）随包入程序。

/**
 * **工具通告**的来源载荷（对齐宿主 `dsh-tool-goal` 的 `{ kind: 'tool-goal', form: 'notice', summary }`）。
 *
 * 与 `work`（自动续跑回合）分开是**有意的**：通告只是挂在某次工具回执之后的说明——
 * **它不该授予任何人任何权限**（`kind` 既不是 `user` 也不是 `work`，授权面保持保守侧）。
 */
export interface WorkToolNoticeSource {
  readonly kind: 'work-tool'
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** workprocess 工具回执之后的通告（附在 tool/result 之后；不授任何权限）。 */
    'work-tool': WorkToolNoticeSource
  }
}

/** 授权判据要的会话事件**窄形状**（边界收窄：官方 SessionEvent 字段更宽，判据只用这几个）。 */
interface AuthorityEventSlice {
  readonly type?: string
  readonly data?: {
    readonly source?: {
      readonly kind?: string
      readonly round?: number
      readonly taskId?: string
      readonly revision?: number
    }
  }
}

/** 取本次工具调用的调用者 agent（不在会话里调 = undefined；只要归属缺省要的窄面）。 */
export function agentOf(exec: unknown): { readonly id: string; readonly session: { readonly id?: string } } | undefined {
  const agent = (exec as { agent?: unknown } | undefined)?.agent
  if (agent === undefined || agent === null) return undefined
  return agent as { readonly id: string; readonly session: { readonly id?: string } }
}

/**
 * 造 `WorkToolDeps.resolveAuthority`：把宿主会话的"这一轮是谁发起的"投影成授权判据。
 *
 * 【口径对齐宿主 tool-goal】三重校验：agent 必须正是注册表里那个、状态 running、
 * 且正是本回合的发起者（`currentInitiator()`）——三个都不满足就**不授任何授权**（保守侧）。
 */
export function authorityResolverOf(
  ctx: Context,
): (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined {
  return (exec: unknown, expected?: WorkRoundRef): WorkToolAuthority | undefined => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    if (agent === undefined || agent === null) return undefined
    if (ctx.agents.get((agent as { id: string }).id as never) !== agent) return undefined
    if ((agent as { status?: string }).status !== 'running') return undefined
    if (ctx.agents.currentInitiator() !== agent) return undefined
    const session = (agent as { session: unknown }).session
    const boundary = ctx.sessionProjections?.stateOf(session as never, 'turnBoundary')
    const start = boundary?.openTurnStartSeq
    // 无开放回合 / 判不出 ⇒ 不授自治（宿主 tool-goal 同款：判不出就别放行）
    if (typeof start !== 'number') return undefined
    const events = (session as { snapshotEvents(): readonly AuthorityEventSlice[] }).snapshotEvents()
    return authorityFromEvents(events, start, (agent as { parentAgent?: unknown }).parentAgent === undefined, expected)
  }
}

/**
 * 把工具通告落成一条**自署来源**的消息，附在该次工具回执之后（宿主 `exec.deferContext`）。
 *
 * 【必须方法调用】`exec.deferContext(...)`——摘成变量再调会让 `this` 丢（与 `followup` 同款的坑，
 * 真机踩过：`Cannot read properties of undefined (reading 'send')`）。
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
 * 【为什么必须由工具自己问】宿主把 `ask_user_question` 的答复**只记成工具结果**，不产生
 * `user/message` 事件 ⇒ 授权面看不见；"模型问完再自己落章"必然被拒（真机踩过）。
 *
 * 【四种结局都要如实回收】同意 = `approved`；选了别的 / 自定义输入 = `declined`（带反馈）；
 * 人打断去说话（`ASK_CANCELLED`）、调用者不是活跃根（`CALLER_NOT_LIVE` / `DELEGATED_CALLER`，
 * 子 agent 问不了人）——一律 `cancelled`；没弹框通道（`NO_PROVIDER`）⇒ `no-channel`（退回拒绝并指路）。
 * **绝不把"没问成"当成"同意"**。
 */
export async function askHumanOf(
  ctx: Context, exec: unknown, request: WorkHumanAsk,
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
    return reason === 'NO_PROVIDER' ? { kind: 'no-channel' } : { kind: 'cancelled', reason }
  }
}
