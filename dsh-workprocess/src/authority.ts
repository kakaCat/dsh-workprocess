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
 * @module dsh-workprocess/authority
 */
import { authorityFromEvents, type WorkRoundRef, type WorkToolAuthority } from 'tool-workprocess'

/** 会话事件的**最小读取面**（不 import 宿主包：结构类型，缺字段 = 判不出）。 */
export interface HostEvent {
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

export interface HostSession {
  readonly id: string
  snapshotEvents(): readonly HostEvent[]
}

/** 宿主 Agent 的**最小读取面**。 */
export interface HostAgent {
  readonly id: string
  readonly status?: string
  /** 有父 = 子 agent（不授真人授权：子 agent 的回合不是人在打字）。 */
  readonly parentAgent?: unknown
  readonly session: HostSession
}

/** 授权判定要读的宿主服务（缺一个就退回保守侧）。 */
export interface AuthorityHostCtx {
  readonly agents: {
    get(id: string): unknown
    currentInitiator(): unknown
  }
  readonly sessionProjections?: {
    stateOf(session: unknown, kind: string): { readonly openTurnStartSeq?: unknown } | undefined
  }
}

/** 取本次工具调用的调用者 agent（不在会话里调 = undefined）。 */
export function agentOf(exec: unknown): HostAgent | undefined {
  const agent = (exec as { agent?: unknown } | undefined)?.agent
  return agent === undefined || agent === null ? undefined : agent as HostAgent
}

/**
 * 造 `WorkToolDeps.resolveAuthority`（组合根注入）。
 * 返回 `undefined` = **判不出 / 不达标**，调用方按 conservative 的 `autonomous` 处理。
 */
export function authorityResolverOf(
  ctx: AuthorityHostCtx,
): (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined {
  return (exec: unknown, expected?: WorkRoundRef): WorkToolAuthority | undefined => {
    const agent = agentOf(exec)
    if (agent === undefined) return undefined
    if (ctx.agents.get(agent.id) !== agent) return undefined
    if (agent.status !== undefined && agent.status !== 'running') return undefined
    if (ctx.agents.currentInitiator() !== agent) return undefined
    const boundary = ctx.sessionProjections?.stateOf(agent.session, 'turnBoundary')
    const start = boundary?.openTurnStartSeq
    // 无开放回合 / 判不出 ⇒ 不授自治（宿主 tool-goal 同款：判不出就别放行）
    if (typeof start !== 'number') return undefined
    return authorityFromEvents(agent.session.snapshotEvents(), start, agent.parentAgent === undefined, expected)
  }
}
