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
import type { WorkChange } from './domain.js'
import type { WorkprocessService } from './service.js'

/** 变更载荷：有效变更带事件 + 快照；`change: undefined` = 整条流程被丢弃（墓碑）。 */
export interface WorkChangedPayload {
  /** 归属域键（缺省即会话 id）。 */
  readonly scope: string
  /** 有效变更（`work/change`：事件 + 变更后全量快照）；丢弃时为 `undefined`。 */
  readonly change: WorkChange | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** workprocess 领域服务（view / discard / pauseActive / resumePaused）。 */
    workprocess: WorkprocessService
  }
  interface Events {
    /**
     * workprocess 变更已落盘（对齐宿主 `goal/changed` 口径）。
     * @param payload - 归属域键 + 变更（或丢弃墓碑）。
     * @mode emit
     */
    'work/changed'(payload: WorkChangedPayload): void
  }
}
