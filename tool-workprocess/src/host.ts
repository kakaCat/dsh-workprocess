/**
 * 工具面的**宿主适配层**：把官方 cordis 面的服务接到工具执行点上。
 *
 * 【为什么在工具包】这三件事都是**工具面自己的关切**——授权判据要读会话事件切面、
 * 通告要附在 `exec.deferContext` 之后、人机确认要调 `ctx.userQuestions`。
 * 它们原先寄居在领域插件（组合根）里，只是因为那时工具面还没有自己的 `apply(ctx)`。
 *
 * 【类型来源】直接吃官方 `Context`（`ctx.agents` / `ctx.sessionProjections` 的类型由
 * `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session-projection` 增强提供）。
 *
 * @module tool-workprocess/host
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
// type-only import：官方包的 `declare module` 增强（ctx.sessionProjections / ctx.agents）随包入程序。
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm'
import { authorityFromEvents, type WorkRoundRef, type WorkToolAuthority } from './authority.js'
import type { WorkHumanAsk, WorkHumanVerdict } from './handlers.js'

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
