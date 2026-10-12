/**
 * workprocess 工具面的**插件入口**（对齐宿主 `dsh-tool-goal`：`name` / `inject` / `apply(ctx, config)`）。
 *
 * 【边界】本面只做一件事：把六个 workprocess 工具注册进宿主的 `tools` 服务，并把模型面纪律
 * （策略段）与工具面适配（授权判据 / 通告 / 人机确认）接上。
 *
 * 【数据从哪来】只消费 **`ctx.workprocess`**（由 `workprocess` 领域插件 provide）：
 * 存储域的 `open` 对同名域是响亮拒绝（`already-open`），域只能由领域插件独占——
 * 工具面经服务读写，与宿主 `tool-goal` 调 `ctx.goals.*` 的形状一致。
 *
 * 【降级】宿主缺 `tools` / `workprocess` 服务时由 cordis 的 `inject` 等依赖，不会硬崩；
 * 策略段注册失败只留一行日志（工具面照常）。
 *
 * @module tool-workprocess/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
// type-only import：官方包的类型增强随包入程序（ctx.agents / ctx.sessionProjections / systemPrompt）。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WORK_TOOL_FACTORIES } from './tools.js'
import { WORK_TOOL_REGISTRY } from './registry.js'
import { authorityResolverOf, deferNoticeOf, askHumanOf, agentOf } from './host.js'
import { WORK_POLICY_SECTION, WORK_POLICY_TEXT } from './policy.js'
import type { WorkToolDeps } from './handlers.js'

/** 插件名（装载层条目 id 同源）。 */
export const name = 'tool-workprocess'

/** 装配依赖：工具注册面 + 领域服务 + 授权判据要的 agent/投影面 + 策略段要的 systemPrompt。 */
export const inject = ['tools', 'workprocess', 'agents', 'sessionProjections', 'systemPrompt']

/** 工具面配置（装载层 `config` 段；缺省全空）。 */
export interface WorkToolConfig {
  /** 策略段是否注册（缺省 true；关掉只影响模型面纪律，不影响工具）。 */
  readonly policySection?: boolean
}

/** 登记顺序（= 登记表顺序，稳定：日志与快照可比）。 */
const REGISTRATION_ORDER: readonly (keyof typeof WORK_TOOL_FACTORIES)[] =
  WORK_TOOL_REGISTRY.map((e) => e.handler as keyof typeof WORK_TOOL_FACTORIES)

/** 从宿主 ctx 组装工具面依赖（唯一装配点：工具面只认 `ctx.workprocess` 这个数据口）。 */
export function workToolDepsOf(ctx: Context): WorkToolDeps {
  return {
    domain: ctx.workprocess,
    // 归属缺省 = **本会话**（一个会话一条流程；多流程并存时要显式给 scope）。
    defaultScope: (exec) => agentOf(exec)?.session?.id,
    resolveAuthority: authorityResolverOf(ctx),
    // 工具回执之后的**通告**（宿主 `exec.deferContext`）：落成一条自署 `work-tool` 的消息。
    deferNotice: (exec, n) => deferNoticeOf(exec, n),
    // **人机确认口**（宿主 `ctx.userQuestions`）：策略 human 的阶段收口由**工具自己问人**。
    askHuman: (exec, request) => askHumanOf(ctx, exec, request),
  }
}

/** 把六个 workprocess 工具注册进宿主 `tools` 服务（返回卸载器数组）。 */
export function apply(ctx: Context, config?: WorkToolConfig): void {
  const deps = workToolDepsOf(ctx)
  for (const handler of REGISTRATION_ORDER) {
    const factory = WORK_TOOL_FACTORIES[handler] as (d: WorkToolDeps) => unknown
    ctx.tools.register(factory(deps) as never)
  }
  if (config?.policySection !== false) {
    try {
      ctx.systemPrompt?.section({
        name: WORK_POLICY_SECTION,
        order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
        text: WORK_POLICY_TEXT,
      })
    } catch (err) {
      console.warn('[workprocess] 策略段注册失败（工具面照常）：' + String((err as Error)?.message ?? err))
    }
  }
}

export type { WorkToolDeps } from './handlers.js'
