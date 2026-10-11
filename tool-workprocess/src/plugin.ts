/**
 * workprocess 工具面的**独立插件入口**（自有 `name` + `apply*` 的形态）。
 *
 * 【边界】本面只做一件事：把六个 workprocess 工具注册进宿主的 `tools` 服务。注册名不加域前缀
 * （避免与宿主其它工具面撞名）——本面**不**并入宿主的其它工具登记块。
 *
 * 【deps 为什么由组合根注入】流程状态挂在归属对象的记录上（`workProcess` 字段），
 * 本面只消费结构化 `store` 端口，不自行装配存储。
 *
 * 【降级】宿主没有 `tools` 服务（或 ctx 没有 inject）时不抛，返回空数组并留一行日志——
 * 装不上只降级，不带崩插件其余面。
 *
 * @module tool-workprocess/plugin
 */
import { WORK_TOOL_FACTORIES } from './tools.js'
import { WORK_TOOL_REGISTRY } from './registry.js'
import type { WorkToolDeps } from './handlers.js'

/** 插件名（登记日志 / 日志前缀用）。 */
export const name = 'workprocess'

/** 宿主的 `tools` 服务面（结构类型：不 import 宿主 cordis 包）。 */
interface ToolsService {
  register(tool: unknown): () => void
}
interface ToolsCtx {
  effect?: (fn: () => void, label?: string) => void
  tools?: ToolsService
}
interface InjectCtx {
  inject?: (services: string[], cb: (c: ToolsCtx) => void) => void
}

/** 登记顺序（= 登记表顺序，稳定：日志与快照可比）。 */
const REGISTRATION_ORDER: readonly (keyof typeof WORK_TOOL_FACTORIES)[] =
  WORK_TOOL_REGISTRY.map((e) => e.handler as keyof typeof WORK_TOOL_FACTORIES)

/** 把六个 workprocess 工具注册进宿主 `tools` 服务；返回卸载器数组（装不上 = 空数组）。 */
export function applyWorkToolSurface(ctx: unknown, deps: WorkToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const inject = (ctx as InjectCtx | undefined)?.inject
  if (typeof inject !== 'function') {
    console.warn('[workprocess] 宿主 ctx 没有 inject，workprocess 工具面已降级（不注册）')
    return disposers
  }
  inject.call(ctx, ['tools'], (toolsCtx: ToolsCtx) => {
    const tools = toolsCtx.tools
    if (tools?.register === undefined) {
      console.warn('[workprocess] 宿主未提供 tools 服务，workprocess 工具面已降级（不注册）')
      return
    }
    toolsCtx.effect?.(() => {
      for (const handler of REGISTRATION_ORDER) {
        const factory = WORK_TOOL_FACTORIES[handler] as (d: WorkToolDeps) => unknown
        disposers.push(tools.register(factory(deps)))
      }
    }, name + ': tools')
  })
  return disposers
}

export type { WorkToolDeps } from './handlers.js'
