/**
 * **不变量伴生插件**（对齐宿主 `dsh-goal/lib/invariant.js`：独立入口、`inject: ['invariants']`、
 * 以包名注册进宿主的 invariants 服务）。
 *
 * 【它守什么——两件写路径守卫**拦不住**的事】
 *   ① **发布前的流校验**：挂 `internal/dispatch`，在每一格 `work/changed` **发布给监听器之前**，
 *      拿载荷里的"事件 + 快照"做**影子折叠**——事件必须能把上一份快照折成载荷里那一份
 *      （`applyWorkEvent` → `sameProcess`）。写路径的守卫是"自己折完自己验"；这一层验的是
 *      **外部流**：漏发 / 乱序 / 重复 / 事件与快照不一致 / 有东西绕过领域服务直接改状态，
 *      都会在这里现形。
 *   ② **启动时重放已落盘的历史**：从服务面把整张表审一遍（严格解码 + 归属边界 + 读数合法性），
 *      通过审计的快照拿来做影子折叠的**播种**——于是"上一版留下的 / 被人手改过的"坏记录
 *      在装载那一刻就被点名，而不是等它某天被读出来才炸。
 *
 * 【为什么它必须是独立插件】它要 `inject: ['invariants']`：宿主**没挂**那个服务时它根本不激活
 * （桌面 profile 就是这个情况——宿主自己的 goal / session 伴生件同样是休眠的）。
 * 装法（开发/CI）：profile 里既挂 `@deepseek-ai/dsh-invariants`，也挂本入口 `workprocess/invariant`。
 *
 * 【文件名的讲究】本文件就叫 `invariant.ts`（对齐宿主 `dsh-goal/src/invariant.ts`）：
 * 这个名字留给**伴生入口**，域不变量本身的**纯检查**在 `fold.ts` 里（同宿主：严格校验沉在折叠层）。
 *
 * @module workprocess/invariant
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyWorkEvent, decodeWorkProcess, sameProcess } from './kernel.js'
import type { WorkProcess } from './kernel.js'
import { onWorkChanged, workprocessOf, type WorkChangedPayload } from './events.js'

/** 伴生插件名（宿主同款命名：`<包>-invariant`）。 */
export const name = 'workprocess-invariant'

/** 只有宿主挂了不变量服务才激活。 */
export const inject = ['invariants']

/** 宿主 invariants 服务的**最小面**（`register(packageName, installer)`）。 */
interface InvariantsService {
  register(packageName: string, installer: ((ctx: Context, fail: (message: string) => never) => unknown) & {
    readonly inject?: readonly string[]
  }): () => void
}

/** 本包在 invariants 服务里占的包名（= 领域包名，一个包只能注册一次）。 */
const PACKAGE_NAME = 'workprocess'

/**
 * 装配：把本包的不变量注册进宿主服务。返回 `register` 的处置器（随插件卸载）。
 *
 * `installer.inject = ['workprocess']`：校验要经**服务面**读状态（域由领域插件独占打开）。
 */
export const apply = (ctx: Context): unknown =>
  (ctx.get('invariants') as InvariantsService | undefined)?.register(PACKAGE_NAME, install)

/**
 * 安装器（跑在子 fiber 里；`fail` 抛 `InvariantError` 并点名本包）。
 *
 * @param ctx 子上下文（只带 `invariants` + 声明注入的服务）。
 * @param fail 违规上报口（抛；宿主会拆掉这个子 fiber 并留痕）。
 */
const install = ((ctx: Context, fail: (message: string) => never): void => {
  const domain = workprocessOf(ctx)
  /** 影子折叠状态（每归属域一份）：只由**事件**推出来，与盘上快照互为校验。 */
  const shadow = new Map<string, WorkProcess | undefined>()
  /** 发布前暂存的候选状态（键 = 载荷对象本身；宿主同款两段式：先验、发布时提交）。 */
  const staged = new Map<WorkChangedPayload, { scope: string; state: WorkProcess | undefined }>()

  // ── ② 启动重放：审计整张表，并把通过审计的快照播种进影子状态 ──
  void domain.audit().then((report) => {
    for (const finding of report.findings) {
      fail(`已落盘的归属记录不自洽（${finding.scope}）：${finding.problem}`)
    }
    for (const snapshot of report.snapshots) shadow.set(snapshot.scope, snapshot.process)
  }).catch((error: unknown) => {
    // fail 自身会抛（点名即拒载）：then 里 fail 抛出的拒绝落到这里时问题**已点名**，
    // 再原样抛一次只会变成 unhandled rejection（vitest 整机报红、真机日志噪音）。
    // 仍要 fail 一拍：审计通道本身坏了（audit 拒绝）且 fail 不抛的实现形态下，不留静默缺口。
    try {
      fail(`审计已落盘归属记录失败：${String((error as Error)?.message ?? error)}`)
    } catch {
      /* 上一轮 fail 已把问题点名；拒绝链到此为止。 */
    }
  })

  // ── ① 发布前校验：`internal/dispatch` 拦截每一格 work/changed ──
  ctx.on('internal/dispatch', (_mode: string, eventName: string, args: readonly unknown[]) => {
    if (eventName !== 'work/changed') return
    const payload = args[0] as WorkChangedPayload | undefined
    if (payload === undefined || typeof payload.scope !== 'string') return
    const current = shadow.get(payload.scope)
    // 丢弃墓碑：整条流程没了 ⇒ 影子状态随之清空（没有"事件 + 快照"可折）。
    if (payload.change === undefined) {
      staged.set(payload, { scope: payload.scope, state: undefined })
      return
    }
    const { event, process } = payload.change
    if (process.id !== 'wp:' + payload.scope) {
      return fail(`work/changed 的归属边界不符：快照 id ${JSON.stringify(process.id)} 与 scope 不一致`)
    }
    let result: ReturnType<typeof applyWorkEvent>
    try {
      result = applyWorkEvent(current, event)
    } catch (error) {
      return fail(`work/changed 的事件折不过去（上一份快照上不成立）：${String((error as Error)?.message ?? error)}`)
    }
    if (!result.changed || result.next === undefined) {
      // 事件在上一份快照上不成立 = 漏发 / 乱序 / 重复通知，之一。
      return fail(`work/changed 的事件在影子状态上不成立（漏发 / 乱序 / 重复？）：`
        + `${event.kind} @ revision ${String(current?.revision ?? 0)}`)
    }
    if (!sameProcess(result.next, process)) {
      return fail(`work/changed 的事件折叠结果与载荷快照不一致（${event.kind}）：`
        + `折出 revision ${result.next.revision}，载荷 revision ${process.revision}`)
    }
    staged.set(payload, { scope: payload.scope, state: result.next })
  }, { global: true })

  // ── ① 提交：真事件发布时核对暂存候选并落到影子状态 ──
  onWorkChanged(ctx, (payload) => {
    const candidate = staged.get(payload)
    if (candidate === undefined) {
      return fail('work/changed 未经影子折叠校验就发布了（internal/dispatch 那一拍没拦到）')
    }
    staged.delete(payload)
    shadow.set(candidate.scope, candidate.state)
    return undefined
  })
}) as ((ctx: Context, fail: (message: string) => never) => void) & { inject: readonly string[] }

/**
 * 安装器的自注入面（宿主 invariants 服务读它来建子 fiber）：
 * 校验要经**服务面**读状态——域由领域插件独占打开，伴生件拿不到表句柄。
 */
install.inject = ['workprocess']

export * from './events.js'
export { decodeWorkProcess }
