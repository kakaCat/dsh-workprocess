/**
 * 把宿主会话的"这一轮是谁发起的"投影成**授权判据**（授权规则的唯一一份仍在 `tool-workprocess/authority`）。
 *
 * 【为什么必须有这一段】不接线时工具面的缺省是保守的 `autonomous`——于是 `human` 策略的阶段收口、
 * `task_edit`、`task_resume` 会被**永远**拒。判据本身早就有（`authorityFromEvents`），缺的是
 * "从宿主拿到事件切面"这半步。
 *
 * 【口径对齐宿主 tool-goal】同款三重校验：agent 必须正是注册表里那个、状态 running、
 * 且正是本回合的发起者（`currentInitiator()`）——三个都不满足就**不授任何授权**。
 *
 * 【类型来源】直接吃官方 cordis `Context`（`ctx.agents` / `ctx.sessionProjections` 的类型
 * 由 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session-projection` 增强提供）——
 * 手写的 HostAgent/HostSession/AuthorityHostCtx 假面随之退役；事件切面在边界处一次性收窄
 * 成判据要的窄形状。
 *
 * @module workprocess/authority
 */
import type { Context } from '@deepseek-ai/cordis'
// type-only import：把官方包拉进编译程序，其 `declare module` 增强（ctx.sessionProjections）随之生效。
import type {} from '@deepseek-ai/dsh-session-projection'
import { authorityFromEvents, type WorkRoundRef, type WorkToolAuthority } from 'tool-workprocess'

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
 * 造 `WorkToolDeps.resolveAuthority`（组合根注入）。
 * 返回 `undefined` = **判不出 / 不达标**，调用方按 conservative 的 `autonomous` 处理。
 */
export function authorityResolverOf(
  ctx: Context,
): (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined {
  return (exec: unknown, expected?: WorkRoundRef): WorkToolAuthority | undefined => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    if (agent === undefined || agent === null) return undefined
    // 三重校验（官方类型：agents 注册表 / status / currentInitiator）。
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
