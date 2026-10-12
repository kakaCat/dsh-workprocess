/**
 * workprocess：**领域插件**（对齐宿主 `@deepseek-ai/dsh-goal`）。
 *
 * 【这一层做什么】只有三件事：
 *   ① 打开**归属记录域**（宿主 `ctx.storageDomain`：schema 校验 + 写即耐久；域由本插件**独占**打开）；
 *   ② 提供 **`ctx.workprocess`** 域服务（读 + 全部写动词 + 人机干预）——工具面 / 命令行 / 驱动器都经它读写；
 *   ③ 每次有效写入发 **`work/changed`** typed 宿主事件（对齐 `goal/changed`），外部插件可订阅。
 *
 * 【域为什么必须独占】`storageDomain.open` 对同名域是响亮拒绝（`already-open`）：一个域只有一个主人，
 * 于是"谁开域"与"谁读写"分开了——本插件开域并提供服务，其余插件只消费服务（不需要 store）。
 *
 * 【状态为什么不进会话日志】goal 能进是因为它**在仓内**（事件类型进了生成的 KNOWN 列表）；
 * 仓外插件 append 自定义事件没有 `ignorable` 标记，会被持久化读路径判为"未知且必需"而
 * **拒绝解释整条会话日志**。本插件改用宿主给仓外插件准备的持久化面（`ctx.storageDomain`）。
 *
 * 【驱动与工具都不在这里】回合驱动在 `workprocess-round-driver`（插件），六个工具在
 * `tool-workprocess`（插件），命令行在 `command-workprocess`——四条独立装载行，
 * 与宿主 `dsh-goal` / `dsh-goal-round-driver` / `dsh-tool-goal` / `dsh-command-goal` 一一对应。
 *
 * @module workprocess
 */
import type { Context } from '@deepseek-ai/cordis'
import { emitWorkChanged, type WorkChangedPayload } from './events.js'
import { storageDomainStoreOf } from './storage.js'
import { createWorkprocessService } from './service.js'

export * from './kernel.js'
import './events.js'
export { emitWorkChanged, onWorkChanged, workprocessOf, WORKPROCESS_SERVICE } from './events.js'
export type { WorkChangedPayload } from './events.js'
export { storageDomainStoreOf, workprocessDomain, WORKPROCESS_DOMAIN, WORKPROCESS_DOMAIN_VERSION } from './storage.js'
export { createWorkprocessService } from './service.js'
export type { WorkprocessService, WorkprocessStatus } from './service.js'
export { workWireOf } from './view.js'
export type { WorkStageWire, WorkTaskWire, WorkWire } from './view.js'
export type { StorageDomainCtx, DomainTableHandle } from './storage.js'

/** 插件名（日志前缀与装载层条目 id 同源）。 */
export const name = 'workprocess'

/** 装配依赖：只需要存储域——域由本插件独占打开，其余面（工具/驱动/命令）都消费服务。 */
export const inject = ['storageDomain']

/** 装载层配置（本插件无可配项；保留形状与其它插件一致）。 */
export type WorkprocessConfig = Record<string, never>

/** 装配：打开归属记录域 + 提供 `ctx.workprocess` 服务 + 变更进 `work/changed` 事件总线。 */
export function apply(ctx: Context, _config?: WorkprocessConfig): void {
  const store = storageDomainStoreOf(ctx)
  /** 内核变更通知 → 宿主事件：所有写路径（工具 / 命令 / 驱动拍）统一在这里进事件总线。 */
  const emitChanged = (scope: string, change: WorkChangedPayload['change']): void => {
    try {
      emitWorkChanged(ctx, { scope, change })
    } catch (err) {
      // 监听器故障由宿主兜底；这里再兜一层，绝不让通知中断写路径。
      console.warn('[workprocess] work/changed 投递失败：' + String((err as Error)?.message ?? err))
    }
  }
  const service = createWorkprocessService(
    { store, now: () => Date.now(), onChanged: (n) => emitChanged(n.scope, n.change as WorkChangedPayload['change']) },
    (scope) => emitChanged(scope, undefined),
  )
  ctx.provide('workprocess', service)
  // **装载时自审一遍已落盘的历史**：坏记录（上一版留下的 / 被人手改过的）当场记一行，
  // 不等它某天被读出来才炸。不阻断装载——审计是诊断，不是门禁。
  void service.audit().then((report) => {
    for (const finding of report.findings) {
      warn(ctx, '归属记录不自洽（' + finding.scope + '）：' + finding.problem)
    }
  }).catch((err: unknown) => {
    warn(ctx, '装载时审计失败：' + String((err as Error)?.message ?? err))
  })
}

/** 记一行警告（优先走宿主 logger；假 ctx / 没接 logger 时回落 console）。 */
function warn(ctx: Context, message: string): void {
  const line = '[workprocess] ' + message
  try {
    ctx.logger?.warn(line)
  } catch {
    console.warn(line)
  }
}
