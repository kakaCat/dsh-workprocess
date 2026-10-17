/**
 * **驱动器的不变量伴生插件**（对齐宿主 `dsh-goal-round-driver/lib/invariant.js`）：
 * 独立入口、`inject: ['invariants']`、以包名注册进宿主的 invariants 服务。
 *
 * 【它守什么——域伴生件（`workprocess/invariant`）守不到的东西】域伴生件守的是**状态流**
 * （work/changed 的事件能把上一份快照折成下一份）；这一件守的是**驱动器注入会话日志的
 * 自动回合消息**：每条自称 `source.kind === 'work'` 的 `user/message`，内容必须和
 * "驱动器给定持久状态会渲染出的载荷"**逐字节一致**（`roundDeliveryOf` / `planDeliveryOf` /
 * `askDeliveryOf` / `wrapupDeliveryOf` 重建 + 深比较）。伪造来源（别的插件冒充自动回合）、
 * 篡改投递内容、手搓 `work` 来源的消息，都会在这里现形——没有它，`kind:'work'` 就是
 * "自动回合冒充人话"的口子（授权面 / 接手侦测 / 回合计数都在认这个来源）。
 *
 * 【重建的锚：修订相等】宿主从会话日志前缀 `foldGoal(events)` 重建（goal 状态存在会话里）；
 * 我们的状态在存储域、只有**最新快照**。锚 = `source.revision === 当前 process.revision`：
 * 投递那一拍读过同一修订，之后到发布前没有任何写动过流程（`markAsked` / `observeRound`
 * 只碰归属记录的 asked / rounds 字段、不动快照——已核），修订相等即"状态还是投递时那份"。
 * 修订已前进的旧轮次**结构上无法重建**：发布前校验里它是违规（投递那一刻锚必成立），
 * 启动重放里它跳过——这是与宿主的实质覆盖差异（持久状态不带历史），如实承认。
 *
 * 【round 的上限从哪来】`defaultMaxRounds` 是驱动器的装载配置、不在持久状态里，任务没写
 * `max_rounds` 时伴生件无从猜中。所以任务轮的来源**自署生效上限**（`maxRounds`，投递时
 * 算好）；伴生件优先取它，旧消息没有该字段时回落"任务自身 `max_rounds` ?? 缺省 20"——
 * 装载层改过缺省值的**老会话日志**可能因此误报（伴生件只装开发/CI，认这个边界）。
 *
 * 【为什么必须是独立插件】它要 `inject: ['invariants']`：宿主没挂那个服务时它根本不激活
 * （桌面 profile 就是这个情况——宿主自己的 goal / session 伴生件同样因此休眠）。
 * 装法（开发/CI）：profile 里既挂 `@deepseek-ai/dsh-invariants`，也挂本入口
 * `workprocess-round-driver/invariant`。
 *
 * @module workprocess-round-driver/invariant
 */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { currentStageOf, stageClosePolicyOf, workprocessOf } from 'workprocess'
import type { WorkprocessService, WorkProcess } from 'workprocess'
import { askDeliveryOf, DEFAULT_BLOCKED_AFTER_ROUNDS, DEFAULT_MAX_ROUNDS, effectiveMaxRoundsOf, noticeDeliveryOf, planDeliveryOf, roundDeliveryOf, wrapupDeliveryOf } from './index.js'
import type { RoundDelivery, WorkRoundMessageSource } from './index.js'

/** 伴生插件名（宿主同款命名：`<包>-invariant`）。 */
export const name = 'workprocess-round-driver-invariant'

/** 只有宿主挂了不变量服务才激活。 */
export const inject = ['invariants']

/** 本包在 invariants 服务里占的包名（= 包名，一个包只能注册一次）。 */
const PACKAGE_NAME = 'workprocess-round-driver'

/** 宿主 invariants 服务的**最小面**（`register(packageName, installer)`）。 */
interface InvariantsService {
  register(packageName: string, installer: ((ctx: Context, fail: (message: string) => never) => unknown) & {
    readonly inject?: readonly string[]
  }): () => void
}

/** 装配：把本包的不变量注册进宿主服务。返回 `register` 的处置器（随插件卸载）。 */
export const apply = (ctx: Context): unknown =>
  (ctx.get('invariants') as InvariantsService | undefined)?.register(PACKAGE_NAME, install)

//#region 消息校验（核心逻辑独立成纯函数，便于穷举单测）

/** 一条 `user/message` 会话事件的**最小读取面**（读得出"是不是自称 work 来源的回合"）。 */
export interface WorkRoundMessageLike {
  readonly type?: string
  readonly data?: {
    readonly source?: { readonly kind?: string } & Partial<WorkRoundMessageSource>
    readonly content?: unknown
  }
}

/** 来源的**人话标签**（违规上报里点名用）。 */
function describeSource(source: NonNullable<WorkRoundMessageLike['data']>['source']): string {
  if (source?.notice !== undefined) return `停手通告轮（${source.notice}）`
  if (source?.round !== undefined) return `任务轮 ${source.taskId ?? '?'} 第 ${source.round} 轮`
  if (source?.stageKey !== undefined) return `阶段轮 ${source.stageKey}`
  return '流程级轮次'
}

/**
 * 校验一条"自称 work 来源"的会话消息：必须与驱动器给定持久状态会渲染的载荷逐字节一致。
 *
 * 非 `user/message` / 非 `kind:'work'` 的消息**直接放行**（不归本包管，也不读域状态）。
 * `fail` 抛出即点名本包（宿主 invariants 服务负责拆掉子 fiber 并留痕）。
 */
export async function validateWorkRoundMessage(
  domain: Pick<WorkprocessService, 'process'>,
  scope: string,
  event: WorkRoundMessageLike,
  fail: (message: string) => never,
): Promise<void> {
  const source = event.data?.source
  if (event.type !== 'user/message' || source?.kind !== 'work') return

  // ── 形状门槛（同步可判的先判，全过了才读域状态）──
  if (typeof source.processId !== 'string' || source.processId === '') {
    return fail('work 来源消息缺少 processId（形状不成立）')
  }
  if (typeof source.revision !== 'number' || !Number.isSafeInteger(source.revision) || source.revision < 1) {
    return fail('work 来源消息的 revision 非法')
  }
  if (source.round !== undefined
    && (typeof source.round !== 'number' || !Number.isSafeInteger(source.round) || source.round < 1)) {
    return fail('work 来源消息的 round 非法')
  }
  if (source.taskId !== undefined && typeof source.taskId !== 'string') {
    return fail('work 来源消息的 taskId 非法')
  }
  if (source.stageKey !== undefined && typeof source.stageKey !== 'string') {
    return fail('work 来源消息的 stageKey 非法')
  }

  // ── 重建的锚：修订相等（见文件头；投递那一刻锚必成立）──
  const process = await domain.process(scope)
  if (process === undefined) {
    return fail(`work 来源消息指向的归属（${scope}）没有流程`)
  }
  if (process.id !== source.processId) {
    return fail(`work 来源消息的 processId（${source.processId}）与该归属的流程（${process.id}）不符`)
  }
  const delivery = reconstructDelivery(process, source, fail)
  const expected: unknown = [{ type: 'text', text: delivery.prompt }]
  if (!isDeepStrictEqual(event.data?.content, expected)) {
    const actual = event.data?.content
    const actualText = Array.isArray(actual) && actual.length === 1 && typeof actual[0] === 'object'
      && actual[0] !== null && 'text' in actual[0] && typeof (actual[0] as { text?: unknown }).text === 'string'
      ? (actual[0] as { text: string }).text
      : JSON.stringify(actual)
    return fail(`work 来源消息（${describeSource(source)}）的内容与驱动器重建的载荷不一致`
      + `（伪造 / 篡改 / 手搓的自动回合？）：消息 ${actualText.length} 字符，重建 ${delivery.prompt.length} 字符`)
  }
}

/**
 * 该来源消息的**重建锚**（= `source.revision` 应当等于的当前修订）：
 * 任务轮锚**任务** revision（`roundDeliveryOf` 的 `revision: task.revision`）；
 * 规划 / 确认 / 收束轮锚**流程** revision。
 * 目标不在当前快照里（任务已不在当前阶段）⇒ `undefined`（结构上无法重建）。
 *
 * 启动重放用它判"这一格还该不该验"（修订已前进的旧轮次跳过）；发布前校验不跳过——直接点名。
 */
export function reconstructAnchorOf(
  process: WorkProcess,
  source: { readonly round?: number; readonly taskId?: string },
): number | undefined {
  if (source.round !== undefined) {
    return currentStageOf(process)?.tasks.find((t) => t.id === source.taskId)?.revision
  }
  return process.revision
}

/**
 * 按来源形状从**当前快照**重建驱动器会投的载荷；形状与状态对不上 ⇒ fail（点名本包）。
 *
 * 两种锚见 `reconstructAnchorOf`：任务轮锚任务 revision，其余锚流程 revision。来源语言本身
 * 还有歧义（收口确认轮 / 终局收束轮都长这样：只有 processId + revision），用流程状态消歧。
 * 这也正是校验的意义：状态对不上的"work 消息"必然是假的。
 *
 * 【第二个消费方】驱动器的 pre-step 围栏对**规划 / 确认 / 收束轮**（无 round）用的就是这份
 * 判据（`matchesCurrentState`，见 `index.ts`）——两处共用一个实现，不会漂移。
 */
export function reconstructDelivery(
  process: WorkProcess,
  source: NonNullable<WorkRoundMessageLike['data']>['source'] & object,
  fail: (message: string) => never,
): RoundDelivery {
  // ① 任务轮：带 round（必有 taskId）——锚**任务** revision。
  if (source.round !== undefined) {
    if (source.taskId === undefined) return fail('任务轮来源缺少 taskId')
    const anchor = reconstructAnchorOf(process, source)
    if (anchor === undefined) return fail('任务轮重建失败：任务 ' + source.taskId + ' 不在当前阶段')
    if (anchor !== source.revision) {
      return fail('任务轮无法重建：投递时的任务修订（' + source.revision + '）已前进到 ' + anchor
        + '——发布那一刻锚必须成立（旧轮次的消息走启动重放口径）')
    }
    // 生效上限 / 落 block 门槛：来源自署优先（投递时算好的那份，**含人追加的预算份数**——那部分
    // 在归属记录里，伴生件看不到）；旧消息没有该字段 ⇒ 回落任务自身 maxRounds ?? 缺省 20、
    // 以及缺省门槛（装载层改过缺省值的老日志可能误报，认）。
    const task = currentStageOf(process)?.tasks.find((t) => t.id === source.taskId)
    const delivery = roundDeliveryOf(
      process, source.taskId, source.round - 1,
      source.maxRounds ?? (task === undefined ? DEFAULT_MAX_ROUNDS : effectiveMaxRoundsOf(task)),
      source.blockedAfterRounds ?? DEFAULT_BLOCKED_AFTER_ROUNDS,
    )
    if (delivery === undefined) return fail('任务轮重建失败：任务 ' + source.taskId + ' 不在当前阶段')
    if (delivery.round !== source.round) {
      return fail('任务轮来源的 round 与重建结果不符（来源 ' + source.round + '，重建 ' + delivery.round + '）')
    }
    return delivery
  }
  if (source.taskId !== undefined) {
    return fail('来源形状不对应驱动器的任何投递：带 taskId 却不带 round（任务轮必带 round）')
  }

  // 其余种类的锚都在**流程** revision 上（见 reconstructAnchorOf）。
  const requireProcessRevision = (): void => {
    if (process.revision !== source.revision) {
      fail('无法重建：投递时的流程修订（' + source.revision + '）已前进到 ' + process.revision
        + '——发布那一刻锚必须成立（旧轮次的消息走启动重放口径）')
    }
  }
  // ①b **停手通告轮**：许可被收回时把停手说出口的那一轮。带 `notice` 标记，不带 round / taskId / stageKey。
  if (source.notice !== undefined) {
    requireProcessRevision()
    return noticeDeliveryOf(process)
  }

  const stage = currentStageOf(process)
  // ② 带 stageKey、不带 round / taskId：阶段规划轮（本阶段没任务）或阶段收口确认轮（任务全 complete 且策略 human）。
  if (source.stageKey !== undefined) {
    requireProcessRevision()
    if (stage === undefined) return fail('来源带 stageKey，但流程没有当前阶段（全收口了？）')
    if (stage.key !== source.stageKey) {
      return fail(`来源的 stageKey（${source.stageKey}）不是当前阶段（${stage.key}）`)
    }
    if (stage.tasks.length === 0) {
      const delivery = planDeliveryOf(process, source.stageKey)
      if (delivery === undefined) return fail('阶段规划轮重建失败')
      return delivery
    }
    if (stage.tasks.every((t) => t.phase === 'complete') && stageClosePolicyOf(stage) === 'human') {
      const delivery = askDeliveryOf(process, 'stage-done', source.stageKey)
      if (delivery === undefined) return fail('阶段收口确认轮重建失败')
      return delivery
    }
    return fail('来源形状与流程状态对不上：当前阶段有未完成的任务，既不该投规划轮也不该投收口确认轮')
  }

  // ③ 只剩 processId + revision：流程收口确认轮（全 done 未收口）/ 终局收束轮（已收口 = complete；未收口有 blocked = blocked）。
  if (process.closedAt !== undefined) {
    const delivery = wrapupDeliveryOf(process, 'complete')
    if (delivery === undefined) return fail('终局收束轮（complete）重建失败（阶段未全 done？）')
    return delivery
  }
  if (stage === undefined) {
    const delivery = askDeliveryOf(process, 'close')
    if (delivery === undefined) return fail('流程收口确认轮重建失败')
    return delivery
  }
  const blocked = stage.tasks.filter((t) => t.phase === 'blocked')
  if (blocked.length === 0) {
    return fail('终局收束轮（blocked）重建失败：当前阶段没有 blocked 任务')
  }
  const newest = Math.max(...blocked.map((t) => t.revision))
  const latest = blocked.filter((t) => t.revision === newest)
  const reason = latest.length === 1 ? latest[0].blockedReason : undefined
  if (reason === undefined) {
    return fail('终局收束轮（blocked）重建失败：blocked 任务的理由不唯一（同修订的 blocked 任务不止一个）')
  }
  const delivery = wrapupDeliveryOf(process, 'blocked', reason.code + ': ' + reason.message)
  if (delivery === undefined) return fail('终局收束轮（blocked）重建失败')
  return delivery
}

//#endregion

//#region 伴生插件壳（对齐域伴生件 `workprocess/invariant` 的装载形态）

/** 会话面的**最小读取面**（启动重放用）。 */
interface SessionsLike {
  list(): readonly { readonly id: string; snapshotEvents(): readonly unknown[] }[]
}

/**
 * 安装器（跑在子 fiber 里；`fail` 抛 `InvariantError` 并点名本包）。
 * 校验经**服务面**读状态（`install.inject`）：域由领域插件独占打开，伴生件拿不到表句柄。
 */
const install = ((ctx: Context, fail: (message: string) => never): void => {
  const domain = workprocessOf(ctx)
  const sessions = (ctx as unknown as { readonly sessions: SessionsLike }).sessions

  /** 异步校验的统一收尾：校验本身的 fail 会沿拒绝链浮上来；这里只兜"域读数通道坏了"的形态。 */
  const guard = (work: Promise<void>): void => {
    void work.catch((error: unknown) => {
      try {
        fail(`校验 work 来源消息失败（域读数异常）：${String((error as Error)?.message ?? error)}`)
      } catch {
        /* 上一轮 fail 已把问题点名；拒绝链到此为止。 */
      }
    })
  }

  // ── 启动重放：已有会话日志里的自动回合消息，**还能重建的**逐个验 ──
  // 覆盖边界（如实承认）：持久状态只有最新快照——修订已前进的旧轮次无法重建，跳过；
  // 锚还成立的消息（最近那一轮）与现状不符 ⇒ 点名（说明落盘日志被改过）。
  guard((async () => {
    for (const session of sessions.list()) {
      for (const event of session.snapshotEvents()) {
        const source = (event as WorkRoundMessageLike).data?.source
        if (source?.kind !== 'work') continue
        const current = await domain.process(session.id)
        if (current === undefined) continue
        if (reconstructAnchorOf(current, source) !== source.revision) continue
        await validateWorkRoundMessage(domain, session.id, event as WorkRoundMessageLike, fail)
      }
    }
  })())

  // ── 发布前校验：`internal/dispatch` 拦截每一格 `session/event` ──
  ctx.on('internal/dispatch', (_mode: string, eventName: string, args: readonly unknown[]) => {
    if (eventName !== 'session/event') return
    const [session, event] = args
    const scope = (session as { readonly id?: string } | undefined)?.id
    if (typeof scope !== 'string') return
    guard(validateWorkRoundMessage(domain, scope, event as WorkRoundMessageLike, fail))
  }, { global: true })
}) as ((ctx: Context, fail: (message: string) => never) => void) & { inject: readonly string[] }

/**
 * 安装器的自注入面（宿主 invariants 服务读它来建子 fiber）：
 * 会话面（重放历史）+ 域服务面（读持久状态重建载荷）。
 */
install.inject = ['sessions', 'workprocess']

//#endregion
