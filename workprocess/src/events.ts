/**
 * `work/changed` —— workprocess 域的**宿主事件**（对齐 `dsh-goal` 的 `goal/changed`：
 * typed cordis event、变更已落盘、监听器故障由宿主兜底、可 scope 过滤分发）。
 *
 * 【为什么是这层补而不是内核补】内核仍走结构化端口 `WorkDeps.onChanged`（零依赖纪律，
 * 模块边界由 kernel-purity 守卫）；组合根在装配 deps 时把端口接到 `ctx.emit` 上——
 * 同一份变更，内核不 import cordis，外部插件却能 `ctx.on('work/changed')` 订阅。
 *
 * @module workprocess/events
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkChange } from './domain.js'
import type { WorkprocessService } from './service.js'

/** 变更载荷：有效变更带事件 + 快照；`change: undefined` = 整条流程被丢弃（墓碑）。 */
export interface WorkChangedPayload {
  /** 归属域键（缺省即会话 id）。 */
  readonly scope: string
  /** 有效变更（`work/change`：事件 + 变更后全量快照）；丢弃时为 `undefined`。 */
  readonly change: WorkChange | undefined
}

/**
 * 【为什么不增强 `Context`】实测：给宿主 cordis 的 `Context` 加一格（哪怕只是加个服务属性），
 * **会把宿主自己的成员遮蔽掉**——`ctx.on` / `ctx.emit` / `ctx.get` 在消费方全部变成"不存在"
 * （`Context` 由 `export *` 再导出，增强声明会盖住原接口，而 `events.d.ts` 那些**相对路径**增强
 * 不会跟过来）。仓内插件（宿主 `dsh-goal`）随便增强是因为它跟 cordis 同一个程序；
 * **仓外插件不能这么干**——于是服务用访问器取（`workprocessOf`），事件用一对收发助手。
 * `interface Events` 的增强是安全的（实测宿主其它事件照常在），故事件名仍留在类型表里。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * workprocess 变更已落盘（对齐宿主 `goal/changed` 口径）。
     * @param payload - 归属域键 + 变更（或丢弃墓碑）。
     * @mode emit
     */
    'work/changed'(payload: WorkChangedPayload): void
  }
}

/** 服务名（provider 与 consumer 的唯一约定；写在一处）。 */
export const WORKPROCESS_SERVICE = 'workprocess'

/**
 * 取 `ctx.workprocess` 域服务（组合根由 `workprocess` 插件 provide）。
 *
 * 用访问器而不是 `declare module` 增强 `Context`：见上方注释（仓外插件增强宿主 `Context` 会遮蔽总线成员）。
 */
export function workprocessOf(ctx: Context): WorkprocessService {
  return (ctx as unknown as { readonly workprocess?: WorkprocessService }).workprocess
    ?? (() => { throw new Error('workprocess 服务不可用（领域插件未装载或 inject 未声明 workprocess）') })() as never
}

/** 订阅 `work/changed`（类型收窄只在这一处；事件名与载荷见 {@link WorkChangedPayload}）。 */
export function onWorkChanged(
  ctx: Context, listener: (payload: WorkChangedPayload) => void,
): () => boolean {
  return (ctx as unknown as { on(name: string, l: unknown): () => boolean }).on('work/changed', listener)
}

/** 发 `work/changed`（领域插件的写路径唯一出口）。 */
export function emitWorkChanged(ctx: Context, payload: WorkChangedPayload): void {
  (ctx as unknown as { emit(name: string, p: unknown): void }).emit('work/changed', payload)
}
