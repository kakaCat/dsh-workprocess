/**
 * workprocess-round-driver：**回合驱动器插件**（结构照宿主 `@deepseek-ai/dsh-goal-round-driver` 一比一）。
 *
 * 【一个模块一件事】宿主那个包源码是三个模块（`index` / `prompt` / `invariant`），我们同粒度：
 *   · 本模块 = 插件壳（`name` / `inject` / `apply`）+ 运行时（事实投影 · 一拍 · 投递）+ 消息来源声明；
 *   · `decide.ts` = 契约类型 + 决策树（纯层，可穷举单测）；
 *   · `prompt.ts` = 三种轮次的提示词渲染（纯字符串）；
 *   · `invariant.ts` = 不变量伴生件（**独立入口** `workprocess-round-driver/invariant`，对齐宿主
 *     `goal-round-driver/invariant`）：每条自称 `kind:'work'` 的会话消息必须与驱动器给定持久状态
 *     会渲染的载荷**逐字节一致**——没有它，`kind:'work'` 就是"自动回合冒充人话"的口子。
 *
 * 【壳的设计（与宿主逐条对应）】
 * | 宿主 goal driver | 本插件 |
 * | --- | --- |
 * | `name` / `inject = ['agents','goals','sessions']` / `apply(ctx)` | `name` / `inject = ['agents','sessions','workprocess']` / `apply(ctx, config?)` |
 * | 每 agent 一张 state（`attempt` / `competingQueued` / `needsCheckpoint` / `requested` / `run` / `stopping`） | 同 |
 * | `readyToDrive`：fiber 活跃 + agent 仍活着 + `status === 'idle'` + 无竞争排队 | 同 |
 * | `requestDrive`：触发合并成**一条** agent 局部串行 run（`withoutInitiator` + while + retire） | 同 |
 * | `drive`：耐久检查点 → 收尾上一轮预约 → 读现状 → 落副作用 / 投下一轮 | 同（读现状经 `ctx.workprocess`） |
 * | `agent.followup(createUserMessage(...))` + `attempt` 预约（消息身份精确比对） | 同（来源自署 `kind:'work'`） |
 * | `turn/end`：停止信号（`aborted` ⇒ 没跑成的回合把任务落盘暂停；`max-tokens` ⇒ 收回续跑许可） | 同（goal ⇔ 任务/流程许可） |
 * | `agent/inbox/inserted｜claimed｜discarded` 竞态围栏（`sameQueued` 深比对） | 同 |
 * | `agent/pre-step` waterfall：进步骤前验预约（过期 / 被插队 ⇒ 拒），拿到 enter 后再验一次 | 同（七核映射见 `validReservation`） |
 * | `agent/error` / 驱动失败 / 投递失败 ⇒ 收回许可或落盘 block（不许静默重试） | 同（goal block ⇔ 任务 block） |
 * | 卸载：收许可 + 预约置 stale + cancel 在跑回合 + 等 idle/run 收尾 | 同 |
 * | `ctx.effect(function* () { ... })` 挂监听 + `ctx.logger.warn` | 同 |
 *
 * 【我们多出来的三件事（goal 没有阶段概念）】阶段规划轮（`plan-stage`）、收口确认轮（`ask-*`）、
 * 流程自动收口（`close-process`）——投递走同一套 `attempt` 预约与围栏，去重键在 state 里
 * （`planAsked` / `askAsked`，语义等价于宿主"同一 goal 只推进一轮"）；耐久"已经问过"记号的
 * 比对修订（`askedRevision`）也在每 agent 的 state 上——多会话并发驱动时各读各的，互不串扰。
 *
 * 【数据从哪来】只经 `ctx.workprocess`（存储域由领域插件独占打开）；回合计数也是域服务的一部分。
 *
 * @module workprocess-round-driver
 */
import { isDeepStrictEqual } from 'node:util'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { currentStageOf, onWorkChanged, stageAllowsStart, workprocessOf } from 'workprocess'
import type { WorkProcess, WorkprocessService, WorkTask, WorkTaskRounds } from 'workprocess'
import { decideWorkRound } from './decide.js'
import type { DecideInput, GateFacts, RoundDecision, StageFacts, WorkFacts } from './decide.js'
import { reconstructDelivery } from './invariant.js'
import { DEFAULT_BLOCKED_AFTER_ROUNDS, renderWorkAskPrompt, renderWorkPlanPrompt, renderWorkRoundPrompt, renderWorkWrapupPrompt } from './prompt.js'

//#region 消息来源（仓外插件必须自己声明这一格）
/** 续跑回合的来源载荷（进程 / 阶段 / 任务 / 修订 / 回合号：授权面按它精确匹配）。 */
export interface WorkRoundMessageSource {
  readonly kind: 'work'
  readonly processId: string
  /** 本轮所在的阶段（任务轮与**阶段规划轮**都带）。 */
  readonly stageKey?: string
  /**
   * 这一轮跑的**任务**；**阶段规划轮没有任务**（它在请 agent 给本阶段建任务），
   * 也因此没有 `round`——规划轮不消耗任务的回合预算，不该推进 `rounds.started`。
   */
  readonly taskId?: string
  readonly revision: number
  readonly round?: number
  /**
   * 生效回合上限（**任务轮才带**；投递时算好自署）：`defaultMaxRounds` 是装载配置、不在持久状态里，
   * 不变量伴生件重建提示词要靠它（见 `invariant.ts`）。
   */
  readonly maxRounds?: number
  /**
   * 落 `block` 的轮数门槛（**任务轮才带**，理由同 `maxRounds`）：`blockedAfterRounds` 也是装载配置，
   * 不变量伴生件重建提示词要靠它。
   */
  readonly blockedAfterRounds?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** workprocess 的自动续跑回合（**不是人**）。 */
    work: WorkRoundMessageSource
  }
}
//#endregion

//#region 运行时：事实投影 · 一拍 · 投递载荷
// type-only import：官方包的 `declare module` 增强（ctx.agents / agent/status / agent 族事件）随包入程序。

/** 任务没写 `max_rounds` 时的**生效上限**（缺省 20）：自动续跑必须有刹车，不许默认无限。 */
export const DEFAULT_MAX_ROUNDS = 20

/** 一个任务的**基础**回合上限（任务自己写的优先，否则兜底）。 */
export function effectiveMaxRoundsOf(task: WorkTask, fallback = DEFAULT_MAX_ROUNDS): number {
  return task.maxRounds ?? fallback
}

/**
 * **生效上限** = 基础上限 × (1 + 人追加的预算份数)。
 *
 * 人被 `round-limit` 挡下后 `resume` 一次就 +1 份（见服务面 `resumeTask`）：不这么算，
 * `resume` 把任务放回 `active`、下一拍又判到顶——恢复路径等于没做。份数由归属记录给，
 * 折算在这里（唯一一处），免得驱动器与工具面各算一套。
 */
export function effectiveCapOf(base: number, grants = 0): number {
  return base * (1 + Math.max(0, grants))
}

/** 把流程快照投影成驱动拍要读的**窄事实**（`taskRounds` = 归属记录里的逐任务回合账）。 */
export function factsOf(
  process: WorkProcess, sessionKey?: string, fallbackMaxRounds = DEFAULT_MAX_ROUNDS,
  taskRounds?: Readonly<Record<string, WorkTaskRounds>>,
): WorkFacts {
  const current = currentStageOf(process)
  return {
    processId: process.id,
    processRevision: process.revision,
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(process.closedAt === undefined ? {} : { processClosed: true }),
    ...(current === undefined ? {} : {
      currentStage: {
        key: current.key,
        statement: current.statement,
        doneCriteria: current.doneCriteria,
        state: current.state,
        allowsStart: stageAllowsStart(process, current.key),
        ...(current.closePolicy === undefined ? {} : { closePolicy: current.closePolicy }),
        tasks: current.tasks.map((t) => {
          const ledger = taskRounds?.[t.id]
          return {
            id: t.id, objective: t.objective, phase: t.phase, revision: t.revision,
            // 生效上限（缺省回落 + 人追加的份数）：回合上限闸靠它——否则"没写 max_rounds"就成了无限续跑。
            maxRounds: effectiveCapOf(effectiveMaxRoundsOf(t, fallbackMaxRounds), ledger?.grants),
            // **预算按任务计**：闸比的是这个任务自己花掉的回合，不是整条流程的累计数。
            rounds: ledger?.rounds ?? 0,
          }
        }),
      } satisfies StageFacts,
    }),
  }
}

export interface TickDeps {
  /** 域服务（`ctx.workprocess`）：读现状 + 落副作用都经它。 */
  readonly domain: WorkprocessService
  /** 一拍的时间源（缺省系统时钟；测试可注入）。 */
  readonly now?: () => number
  /** 任务没写 `max_rounds` 时的生效上限（缺省 {@link DEFAULT_MAX_ROUNDS}）。 */
  readonly defaultMaxRounds?: number
  /**
   * 本阶段的**规划轮是否已经问过**（内存态）：问过就不再问（否则每个空闲边界都投 = 空转），
   * 决策树改为停手等人（`wait-human`）——把"阶段空着"这件事露出来。
   */
  readonly stagePlanAsked?: (stageKey: string) => boolean
  /**
   * **收口确认是否已经问过人**（同一件事只问一次）：问过就不再投，避免每个空闲边界都刷一轮。
   * 键：`stage-done:<阶段键>` / `close`。
   */
  readonly humanAskAsked?: (askKey: string) => boolean
  /** **流程自动收口**（`close: 'auto'`）：最后一段 done 后驱动器直接落 close，不问人。 */
  readonly autoClose?: boolean
}

/**
 * 一拍：读现状 → 决策 → 只落"不需要人"的副作用。
 * @returns 本拍的结论（`drive` / `plan-stage` / `ask-*` 的投递由调用方做）；该归属没有流程 ⇒ `undefined`。
 */
export async function tickWorkprocess(
  deps: TickDeps, scope: string, sessionKey?: string,
): Promise<RoundDecision | undefined> {
  const process = await deps.domain.process(scope)
  if (process === undefined) return undefined
  const taskRounds = await deps.domain.taskRounds(scope)
  const work = factsOf(process, sessionKey, deps.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS, taskRounds)
  const planAsked = deps.stagePlanAsked
  const askAsked = deps.humanAskAsked
  const gates: GateFacts = {
    ...(deps.autoClose === true ? { autoClose: true } : {}),
    ...(planAsked === undefined || work.currentStage === undefined
      ? {}
      : { stagePlanBlocked: planAsked(work.currentStage.key) === true }),
    ...(askAsked === undefined
      ? {}
      : {
        humanAskBlocked: askAsked(
          work.currentStage === undefined ? 'close' : 'stage-done:' + work.currentStage.key,
        ) === true,
      }),
  }
  const input: DecideInput = {
    now: (deps.now ?? Date.now)(),
    scope: { id: scope, drivable: true },
    work,
    ...(Object.keys(gates).length === 0 ? {} : { gates }),
  }
  const decision = decideWorkRound(input)
  switch (decision.kind) {
    case 'start-stage':
      await deps.domain.startStage(scope, decision.stageKey)
      break
    case 'close-stage':
      await deps.domain.closeStage(scope, decision.stageKey)
      break
    case 'block-task':
      await deps.domain.blockTask(scope, decision.taskId, decision.reason)
      break
    case 'close-process':
      await deps.domain.closeProcess(scope)
      break
    default:
      // drive / plan-stage：只**返回**结论（投递由本模块的 deliver* 做，需要会话）；
      // ask-* / wait-human / hold：没有对应能力就不假装有。
      break
  }
  return decision
}

/** 一轮续跑的**载荷**（提示词 + 授权来源）。 */
export interface RoundDelivery {
  readonly processId: string
  /**
   * 这一轮跑的**任务**；**阶段规划轮没有任务**（`undefined` = 让 agent 先给本阶段建任务）。
   * 规划轮也不带 `round`：它不消耗任何任务的回合预算。
   */
  readonly taskId?: string
  /** 本轮的阶段（任务轮与规划轮都带：投递来源与日志同源）。 */
  readonly stageKey: string
  /** 授权判据的第三维：任务轮 = 任务 revision；规划轮 = 流程 revision。 */
  readonly revision: number
  readonly round?: number
  /**
   * 生效回合上限（**任务轮才带**）：和 `round` 一起自署进消息来源——`defaultMaxRounds` 是装载配置、
   * 不在持久状态里，不变量伴生件重建提示词要靠它（见 `invariant.ts`）。
   */
  readonly maxRounds?: number
  /**
   * 落 `block` 的轮数门槛（**任务轮才带**，理由同 `maxRounds`：`blockedAfterRounds` 是装载配置、
   * 不在持久状态里，不变量伴生件重建提示词要靠它）。**必须与工具面那份取同一个数**。
   */
  readonly blockedAfterRounds?: number
  readonly prompt: string
}

/**
 * 造"下一轮"的载荷：`round` = **该任务**已准入回合数 + 1（轮号按任务从 1 起），
 * 提示词由 `renderWorkRoundPrompt` 渲染（流程目标 / 当前阶段与判据 / 本轮任务 / 边界与停手条件）。
 * 任务不在当前阶段 / 阶段已收口 ⇒ `undefined`（没得投）。
 *
 * @param rounds - 该任务已准入的回合数（归属记录的逐任务账）
 * @param cap - 该任务的**生效**上限（基础 × (1+grants)，由调用方按 {@link effectiveCapOf} 算好）
 */
export function roundDeliveryOf(
  process: WorkProcess, taskId: string, rounds: number, cap: number,
  blockedAfterRounds = DEFAULT_BLOCKED_AFTER_ROUNDS,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (stage === undefined) return undefined
  const task = stage.tasks.find((t) => t.id === taskId)
  if (task === undefined) return undefined
  const round = rounds + 1
  const prompt = renderWorkRoundPrompt({
    processObjective: process.objective,
    stage: {
      key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria,
      ...(stage.closePolicy === undefined ? {} : { closePolicy: stage.closePolicy }),
    },
    task: { id: task.id, objective: task.objective },
    round,
    maxRounds: cap,
    blockedAfterRounds,
  })
  return {
    processId: process.id, taskId: task.id, stageKey: stage.key, revision: task.revision,
    round, maxRounds: cap, blockedAfterRounds, prompt,
  }
}

/**
 * 造**阶段规划轮**的载荷：当前阶段已开工但还没有任务 ⇒ 让 agent 给本阶段建任务。
 *
 * 刹车**不在回合数上**（规划轮不消耗任务的回合预算），而在"同一阶段只问一次"：
 * 驱动器按阶段键记一次（`stagePlanAsked`），问过之后决策树改成停手等人。
 */
export function planDeliveryOf(
  process: WorkProcess, stageKey: string,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (stage === undefined || stage.key !== stageKey || stage.tasks.length > 0) return undefined
  return {
    processId: process.id,
    stageKey: stage.key,
    revision: process.revision,
    prompt: renderWorkPlanPrompt({
      processObjective: process.objective,
      stage: {
        key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria,
        ...(stage.closePolicy === undefined ? {} : { closePolicy: stage.closePolicy }),
      },
    }),
  }
}

/**
 * 造**终局收束轮**的载荷：流程已收口（complete）或停住等人（blocked）⇒ 请 agent 写结束语。
 *
 * 【为什么静默不行】阶段/流程收口都是写库、不投轮 —— 对话里毫无痕迹，"跑完了"与"卡死了"在人看来
 * 一模一样（真机两次被误判）。宿主 goal 的 `wrapup` 模块就是为这件事存在的，本函数是它的同款。
 */
export function wrapupDeliveryOf(
  process: WorkProcess, kind: 'complete' | 'blocked', blockedReason?: string,
): RoundDelivery | undefined {
  const doneStages = process.stages
    .filter((stage) => stage.state === 'done')
    .map((stage) => ({ key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria }))
  if (kind === 'complete' && process.closedAt === undefined && process.stages.some((s) => s.state !== 'done')) {
    return undefined   // 还没全收口：不是"落幕"，别报喜
  }
  return {
    processId: process.id,
    stageKey: '',
    revision: process.revision,
    prompt: renderWorkWrapupPrompt({
      processObjective: process.objective,
      kind,
      ...(doneStages.length === 0 ? {} : { doneStages }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
    }),
  }
}

/**
 * 造**收口确认轮**的载荷：到这一步机器能做的都做完了，剩下的是人的判断。
 * 与规划轮同理：来源自署 `work`、**不带 `round`**（不消耗任务预算）。
 */
export function askDeliveryOf(
  process: WorkProcess, kind: 'stage-done' | 'close', stageKey?: string,
): RoundDelivery | undefined {
  const stage = currentStageOf(process)
  if (kind === 'stage-done') {
    if (stage === undefined || stage.key !== stageKey) return undefined
    return {
      processId: process.id,
      stageKey: stage.key,
      revision: process.revision,
      prompt: renderWorkAskPrompt({
        processObjective: process.objective,
        kind: 'stage-done',
        stage: { key: stage.key, statement: stage.statement, doneCriteria: stage.doneCriteria },
      }),
    }
  }
  if (stage !== undefined) return undefined   // 还有阶段没 done：不是流程级收口
  return {
    processId: process.id,
    stageKey: '',
    revision: process.revision,
    prompt: renderWorkAskPrompt({ processObjective: process.objective, kind: 'close' }),
  }
}
//#endregion

//#region 驱动器插件
// 引入模块增强（MessageSourceMap 加 'work' 一格）：类型面的事，运行时不需要它。

/** 插件名（装载层条目 id 同源）。 */
export const name = 'workprocess-round-driver'

/** 装配依赖：agent 面（投递 / 空闲信号 / 竞态事件）、会话面（耐久检查点）、域服务（读写）。 */
export const inject = ['agents', 'sessions', 'workprocess']

/** 装载层配置（`cordis.patch.yml` 的 config 段）。 */
export interface WorkRoundDriverConfig {
  /** 回合边界是否自动驱动（缺省 true；关掉 = 只留领域服务与工具面，状态迁移全靠人/模型显式调）。 */
  readonly tick?: boolean
  /**
   * 空闲边界是否**自动投递续跑回合**（缺省 false；本仓的装载层把它打开）。
   * 打开它 = 任务会自己往下跑（受 `defaultMaxRounds` / 任务 `max_rounds` 硬刹车）。
   */
  readonly drive?: boolean
  /** 任务没写 `max_rounds` 时的生效上限（缺省 {@link DEFAULT_MAX_ROUNDS}）。 */
  readonly defaultMaxRounds?: number
  /**
   * 落 `block` 的前置轮数门槛（缺省 {@link DEFAULT_BLOCKED_AFTER_ROUNDS} = 3）。
   *
   * 【必须与工具面同值】真正拒 `block` 的是**工具面**（`tool-workprocess` 的 `blockedAfterRounds`：
   * `WORK_TOOL_BLOCK_THRESHOLD`）。本项只决定**投递给模型的提示词里写几轮**——两处取不同的数，
   * 模型就会按一个错的数去试、被拒、白跑一轮。两个包各自独立装载（一包一 patch），驱动器读不到
   * 工具面的配置，故只能靠装载层写同一个数，并由全栈测试钉住"两边的缺省值一致"。
   */
  readonly blockedAfterRounds?: number
  /**
   * **流程收口**（方案 B）：'auto'（缺省）= 最后一段 done 后驱动器直接落 close，记录终止；
   * 'human' = 全阶段 done 后投「请判」轮（方案 B 口径：判了不落定，与旧行为等价）。
   */
  readonly close?: 'human' | 'auto'
  /**
   * 会话 **`resume`**（宿主重启后从盘上加载）时是否**自动收回续跑许可**（缺省 true，对齐宿主 goal：
   * "After session resume or fork, an active goal is disarmed"）。
   *
   * 打开 = 重启后不被自动续跑（要人说一句"继续"才 rearm）——无人值守的流程不会在你不知情时继续动。
   * 关掉 = 重启后接着自动跑（适合长时间无人值守的流程）。
   */
  readonly disarmOnResume?: boolean
}

/** cordis `FiberState.ACTIVE` 的数值（const enum 在 isolatedModules 下不能当值用，宿主同款写法）。 */
const FIBER_ACTIVE = 2

/** 一次投递的**预约**：消息身份精确比对（竞态围栏靠它，绝不靠"内容差不多"）。 */
interface Attempt {
  readonly kind: 'drive' | 'plan' | 'ask' | 'wrap'
  readonly messageId: string
  /**
   * 投出去的消息**内容块**全量（`sameQueued` 逐字节深比对的那一份）。
   * 存内容而不是只存 id：id 是"哪一条"，内容 + 来源才是"这一轮该长什么样"——
   * 被篡改 / 被掉包的消息撞得过 id，撞不过全字段。
   */
  readonly content: UserMessage['content']
  /** 投出去的**自署来源**全量（`sameQueued` 逐字节深比对覆盖我们自署的每一个字段）。 */
  readonly source: WorkRoundMessageSource
  readonly processId: string
  readonly revision: number
  readonly stageKey?: string
  readonly taskId?: string
  readonly round?: number
  /**
   * 投递生命周期：queued（在收件箱排队）→ claimed（被认领）→ admitted（进了步骤、真的开跑）。
   * `admitted` 是"这一轮跑成过"的记号：空闲边界据此区分"正常跑完的上一轮"（接着投下一轮）与
   * "没跑成的上一轮"（人点了停止 / 被丢弃——落盘暂停任务，不接着投）。宿主 goal driver 同款。
   */
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  /**
   * 排队 / 认领期间被**别的消息插队**（`agent/inbox/inserted` 落笔）或预约被围栏判死
   * （pre-step 拒收 / 卸载）。pre-step 围栏的 `validReservation` 读它拒收过期回合——
   * 写了从不读的日子（M1 前）到此为止。
   */
  stale: boolean
}

/** 单个 agent 的驱动状态（对齐宿主 goal driver 的 state）。 */
interface State {
  readonly agent: Agent
  attempt?: Attempt
  /** 有**别的**消息排在了 next-turn（本驱动器让路，不与它抢）。 */
  competingQueued: boolean
  /** 需要做一次耐久检查点（`ctx.sessions.flush`）再继续驱动。 */
  needsCheckpoint: boolean
  /** 已请求再拍一拍（请求合并：多个触发只跑一条 run）。 */
  requested: boolean
  /** 当前那条 agent 局部串行 run（同一 agent 同时只有一条）。 */
  run?: Promise<void>
  stopping: boolean
  /** 已投递的**回合键**（`taskId:revision:round`）：域没变时同一轮绝不重复投。 */
  readonly queued: Set<string>
  /** 已经问过**阶段规划轮**的阶段键（同一修订只问一次；域变更即清空，口径同耐久记号）。 */
  readonly planAsked: Set<string>
  /** 已经问过人的**收口确认**键（`stage-done:<阶段键>` / `close`；域变更即清空）。 */
  readonly askAsked: Set<string>
  /**
   * **本 agent** 这一拍读到的流程修订（耐久"已经问过"记号按它判定有效性）。
   * 必须长在每 agent 的 State 上：曾经是 apply 级共享变量，两个会话的驱动拍在 `await` 点
   * 交错时互相覆盖——A 会话的修订会被拿去判 B 会话的"已问过"（重复打扰，或误判已问而停死）。
   * 每拍 `drive()` 开头重读，故域变更时**不用**随 planAsked/askAsked 一起清。
   */
  askedRevision?: number
}

/** 会话事件的**最小读取面**（只读得出"这一轮是不是我们自署的回合"与"回合怎么结束的"）。 */
interface SessionEventLike {
  readonly type?: string
  readonly data?: {
    /** `user/message` 事件的数据就是那条消息本身：`id` 是预约身份比对用的消息身份。 */
    readonly id?: string
    /** 任务轮的来源要 `taskId` 才记得上账（**预算按任务计**）。 */
    readonly source?: { readonly kind?: string; readonly round?: number; readonly taskId?: string }
    /** `turn/end` 的结束原因（`completed` / `aborted` / `max-tokens` / …）。 */
    readonly reason?: { readonly kind?: string }
  }
}

/**
 * 这条消息是不是我投的那一轮（**内容 + 来源逐字节深比对**，宿主 `sameQueued` 同款）：
 * 来源比对覆盖我们自署的**全部**字段（processId/stageKey/taskId/revision/round/maxRounds/
 * blockedAfterRounds）——绝不靠"内容差不多"，也不只靠消息 id。
 */
function sameQueued(content: unknown, source: unknown, attempt: Attempt | undefined): boolean {
  return attempt !== undefined
    && isDeepStrictEqual(content, attempt.content)
    && isDeepStrictEqual(source, attempt.source)
}

/** 来源指向的是不是预约的那一轮（**逻辑回合身份**：流程 + 修订 + 任务 + 轮号；宿主 `sameRound` 同款）。 */
function sameReservedRound(source: WorkRoundMessageSource, attempt: Attempt): boolean {
  return source.processId === attempt.processId
    && source.revision === attempt.revision
    && source.taskId === attempt.taskId
    && source.round === attempt.round
}

/**
 * pre-step 拒收**只丢弃我们自己的那一条**：同批被认领的其它消息放回 `next-step`
 * （宿主 `restoreOtherClaimed` 同款）。`agent/pre-step` 是 waterfall——reject 会丢弃
 * **整个**提议步骤，所以把别人的消息放回去不是善后，是正确性的一部分。
 */
function restoreOtherClaimed(agent: Agent, messages: readonly UserMessage[], messageId: string): void {
  const retained = messages.filter((message) => message.id !== messageId)
  for (const message of [...retained].reverse()) {
    if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id)
      || agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) continue
    agent.inbox.prepend('next-step', message)
  }
}

/**
 * 轻闸判据（规划 / 确认 / 收束轮：来源不带 `round`）：**直接复用不变量伴生件的重建判据**
 * （`invariant.ts` 的 `reconstructDelivery`）——锚流程 revision + 形状与当前流程状态
 * 相符才放行；两处共用一个实现，不会漂移。重建失败（fail 抛出）⇒ false（fail closed）。
 */
function matchesCurrentState(process: WorkProcess, source: WorkRoundMessageSource): boolean {
  try {
    reconstructDelivery(process, source, (message): never => {
      throw new Error(message)
    })
    return true
  } catch {
    return false
  }
}

/** 安装同会话自动续跑：触发 → 合并 → 串行驱动 → 投递 → 围栏。 */
export function apply(ctx: Context, config?: WorkRoundDriverConfig): void {
  if (config?.tick === false) return
  const domain = workprocessOf(ctx)
  const driveEnabled = config?.drive === true
  const defaultMaxRounds = config?.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS
  /** 落 `block` 的门槛（**必须与工具面同值**；见 `WorkRoundDriverConfig.blockedAfterRounds`）。 */
  const blockedAfterRounds = config?.blockedAfterRounds ?? DEFAULT_BLOCKED_AFTER_ROUNDS
  const autoClose = config?.close !== 'human'
  /** 会话 resume ⇒ 自动收回续跑许可（缺省开；goal 同款纪律）。 */
  const disarmOnResume = config?.disarmOnResume !== false
  const states = new Map<Agent, State>()

  const warn = (message: string): void => {
    try {
      ctx.logger.warn('[workprocess-round-driver] ' + message)
    } catch {
      console.warn('[workprocess-round-driver] ' + message)
    }
  }
  const renderThrown = (value: unknown): string => (value instanceof Error ? value.message : String(value))

  /** 取（或建）某 agent 的状态。 */
  function stateFor(agent: Agent): State {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: State = {
      agent,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      stopping: false,
      queued: new Set<string>(),
      planAsked: new Set<string>(),
      askAsked: new Set<string>(),
    }
    states.set(agent, state)
    return state
  }

  /** 仅在**这个** agent 仍活着时认它（防 dispose 之后的僵尸引用）。 */
  function liveAgent(state: State): Agent | undefined {
    return ctx.agents.get(state.agent.session.id) === state.agent ? state.agent : undefined
  }

  /** 是否到了可以驱动的静止点（宿主 goal driver 同款判据）。 */
  function readyToDrive(state: State): boolean {
    return ctx.fiber.state === FIBER_ACTIVE
      && !state.stopping
      && liveAgent(state) !== undefined
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** 检查点等待期间可能变天：等完再核一遍每个条件。 */
  function readyAfterCheckpoint(state: State): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }



  /**
   * 拒收 = 这一轮**没送到**：撤预约（置 stale）并把投递期记下的**去重记号一并作废**——
   * 任务轮按回合键（`taskId:revision:round`），规划 / 确认轮按内存记号；作废后重拍才投得出
   * 新的一份（否则被拒的那一轮永久占住名额，流程静默停死）。
   *
   * 【如实承认的边界】规划 / 确认轮的**耐久**"已问过"记号（`markAsked`）在投递时就落了盘，
   * 同修订下它仍会挡住重问——被拒的规划 / 确认轮要等下一次域变更（修订前进）才会自动重投。
   * 任务轮没有这个问题：它的去重键只在内存里（域没变 ⇒ 键有效 ⇒ 不重复投；被拒 ⇒ 键作废）。
   */
  function dropReservation(state: State, attempt: Attempt): void {
    attempt.stale = true
    state.attempt = undefined
    if (attempt.taskId !== undefined && attempt.round !== undefined) {
      state.queued.delete(attempt.taskId + ':' + String(attempt.revision) + ':' + String(attempt.round))
    }
    if (attempt.kind === 'plan' && attempt.stageKey !== undefined) state.planAsked.delete(attempt.stageKey)
    if (attempt.kind === 'ask') {
      state.askAsked.delete(attempt.stageKey === undefined ? 'close' : 'stage-done:' + attempt.stageKey)
    }
  }

  /**
   * 一轮**没到模型**（投递失败 / 进步骤前被下游驳回）⇒ 把该任务**落盘 block**（域服务直调，
   * **不受工具面"撑满 N 轮"门槛约束**——那是管 agent 的纪律，这里管的是驱动器自己的投递；
   * 宿主 goal driver 的 `queue-failed` / `prompt-rejected` 同款）。
   *
   * 校验精确到任务修订：域已前进时不替旧轮次落 block。规划 / 确认 / 收束轮没有任务可落 ⇒ 跳过。
   */
  async function blockUndeliveredRound(
    state: State,
    round: { readonly processId: string; readonly revision: number; readonly taskId?: string; readonly round?: number },
    code: 'queue-failed' | 'prompt-rejected',
    message: string,
  ): Promise<void> {
    if (round.taskId === undefined || round.round === undefined) return
    const scope = state.agent.session.id
    try {
      if (await domain.activation(scope) !== 'armed') return
      const process = await domain.process(scope)
      if (process === undefined || process.id !== round.processId) return
      const task = currentStageOf(process)?.tasks.find((t) => t.id === round.taskId)
      if (task === undefined || task.phase !== 'active' || task.revision !== round.revision) return
      await domain.blockTask(scope, round.taskId, { code, message }, process.revision)
    } catch (error) {
      warn(`could not block task (${code}) for "${scope}": ${renderThrown(error)}`)
      await disarm(state)
    }
  }

  /**
   * 预留一轮并投递：**先记预约再投**（投失败就撤销）——投出去的消息身份就是预约身份，
   * 竞态围栏据此判"这条是不是我投的"。投递失败 ⇒ 任务落盘 block（`queue-failed`）：
   * 只 warn 等于把流程丢在半路（宿主 goal driver 同款纪律）。
   */
  async function reserveAndQueue(state: State, kind: Attempt['kind'], delivery: RoundDelivery): Promise<boolean> {
    const content = [{ type: 'text' as const, text: delivery.prompt }]
    // **自署来源**：这一轮不是人打的字（授权面据此判自治），也绝不许冒充人。
    const source: WorkRoundMessageSource = {
      kind: 'work',
      processId: delivery.processId,
      ...(delivery.stageKey === '' ? {} : { stageKey: delivery.stageKey }),
      ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
      revision: delivery.revision,
      ...(delivery.round === undefined ? {} : { round: delivery.round }),
      ...(delivery.maxRounds === undefined ? {} : { maxRounds: delivery.maxRounds }),
      // 门槛数字也是装载配置、不在持久状态里：与 `maxRounds` 同款自署，不变量伴生件重建提示词靠它。
      ...(delivery.blockedAfterRounds === undefined ? {} : { blockedAfterRounds: delivery.blockedAfterRounds }),
    }
    const message = createUserMessage({ content, source })
    state.attempt = {
      kind,
      messageId: message.id,
      content,
      source,
      processId: delivery.processId,
      revision: delivery.revision,
      ...(delivery.stageKey === '' ? {} : { stageKey: delivery.stageKey }),
      ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
      ...(delivery.round === undefined ? {} : { round: delivery.round }),
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    try {
      state.agent.followup(message)
      return true
    } catch (error) {
      state.attempt = undefined
      warn(`could not queue ${kind} round for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      await blockUndeliveredRound(state, delivery, 'queue-failed',
        `回合 ${String(delivery.round)} 投递失败：${renderThrown(error)}`)
      return false
    }
  }

  /**
   * **预约校验**（fail closed——宿主 `validReservation` 七核的本域映射，逐条对应）：
   *   ① fiber active；② !stopping；③ 预约在且 `phase === 'claimed'`；④ !stale；
   *   ⑤ `sameQueued`：content + source 逐字节深比对（不是只比对 id）；
   *   ⑥ 流程仍是那个 id 且续跑许可 `armed`（宿主 "goal 仍 active+armed"）；
   *   ⑦a **任务轮**（带 round）：任务仍 active 且 revision 相符，且
   *      `round === 该任务已准入回合数 + 1`（**预算按任务计，闸也按任务判**——宿主
   *      `source.round === goal.roundsStarted + 1` 的本域映射）；
   *   ⑦b **规划 / 确认 / 收束轮**（无 round）：锚流程 revision + 形状与当前流程状态相符
   *      （`matchesCurrentState`，与不变量伴生件同一份判据）。
   */
  async function validReservation(state: State, content: unknown, source: WorkRoundMessageSource): Promise<boolean> {
    const attempt = state.attempt
    if (ctx.fiber.state !== FIBER_ACTIVE || state.stopping
      || attempt === undefined || attempt.phase !== 'claimed' || attempt.stale
      || !sameQueued(content, source, attempt)) return false
    const scope = state.agent.session.id
    if (await domain.activation(scope) !== 'armed') return false
    const process = await domain.process(scope)
    if (process === undefined || process.id !== source.processId) return false
    if (source.round !== undefined) {
      if (source.taskId === undefined) return false
      const task = currentStageOf(process)?.tasks.find((t) => t.id === source.taskId)
      if (task === undefined || task.phase !== 'active' || task.revision !== source.revision) return false
      const rounds = (await domain.taskRounds(scope))[source.taskId]?.rounds ?? 0
      return source.round === rounds + 1
    }
    return matchesCurrentState(process, source)
  }

  /** 读现状 → 决策 → 落"不需要人"的副作用 / 投一轮；返回是否请求再拍一拍。 */
  async function driveOnce(state: State): Promise<boolean> {
    const scope = state.agent.session.id
    // **"已经问过"的耐久记号**：跨重启只在"没有任何状态变更"时继续算数（修订一变即作废）。
    // 内存集合保留作**进程内快挡**：耐久写可能还没落盘，先挡住重复投递。
    const asked = await domain.asked(scope)
    const askedAt = (kind: 'plan' | 'ask', key: string): boolean =>
      asked?.[kind] !== undefined && asked[kind]!.key === key && asked[kind]!.revision === state.askedRevision
    const decision = await tickWorkprocess({
      domain,
      defaultMaxRounds,
      stagePlanAsked: (stageKey) => state.planAsked.has(stageKey) || askedAt('plan', stageKey),
      humanAskAsked: (askKey) => state.askAsked.has(askKey) || askedAt('ask', askKey),
      autoClose,
    }, scope, scope)
    if (decision === undefined) return false
    switch (decision.kind) {
      case 'drive': {
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const task = currentStageOf(process)?.tasks.find((t) => t.id === decision.taskId)
        if (task === undefined) return false
        const ledger = (await domain.taskRounds(scope))[decision.taskId]
        // 轮号与上限都按**这个任务**算：`round` = 它已准入的回合数 + 1，上限 = 基础 × (1+grants)。
        const cap = effectiveCapOf(effectiveMaxRoundsOf(task, defaultMaxRounds), ledger?.grants)
        const delivery = roundDeliveryOf(process, decision.taskId, ledger?.rounds ?? 0, cap, blockedAfterRounds)
        if (delivery === undefined) return false
        // 同一轮只投一次（`taskId:revision:round`）：宿主靠 goal 服务的耐久回合计数挡住重复，
        // 我们额外在进程内挡一道——域没变（没有 work/changed）时这一轮就是"已投出去的那一轮"。
        const key = delivery.taskId + ':' + String(delivery.revision) + ':' + String(delivery.round)
        if (state.queued.has(key)) return false
        if (await reserveAndQueue(state, 'drive', delivery)) state.queued.add(key)
        return false
      }
      case 'plan-stage': {
        // **阶段规划轮**：本阶段开工了却没任务 ⇒ 投一轮让 agent 给本阶段建任务。
        // 记下"已经问过"（决策树下一拍会改成停手等人），不消耗任何任务的回合预算。
        state.planAsked.add(decision.stageKey)
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = planDeliveryOf(process, decision.stageKey)
        if (delivery === undefined) return false
        if (await reserveAndQueue(state, 'plan', delivery)) {
          void domain.markAsked(scope, 'plan', decision.stageKey, delivery.revision)
        }
        return false
      }
      case 'ask-stage-done':
      case 'ask-close': {
        // **收口确认轮**：机器能做的都做完了 ⇒ 请 agent 向人确认（不说出口 = 看起来卡死）。
        const askKey = decision.kind === 'ask-close' ? 'close' : 'stage-done:' + decision.stageKey
        state.askAsked.add(askKey)
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = askDeliveryOf(
          process, decision.kind === 'ask-close' ? 'close' : 'stage-done',
          decision.kind === 'ask-close' ? undefined : decision.stageKey,
        )
        if (delivery === undefined) return false
        if (await reserveAndQueue(state, 'ask', delivery)) {
          void domain.markAsked(scope, 'ask', askKey, delivery.revision)
        }
        return false
      }
      case 'close-process': {
        // 推进态结论已落盘（流程收口）。**收口是静默写**——不投一轮话说清楚，
        // 人在对话里看到的"跑完了"与"卡死了"一模一样（真机两次误判）。投终局收束轮。
        state.needsCheckpoint = true
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = wrapupDeliveryOf(process, 'complete')
        if (delivery === undefined) return true
        await reserveAndQueue(state, 'wrap', delivery)
        return false
      }
      case 'block-task': {
        // 回合作顶落盘 block ⇒ 机器停住等人：同样要说出口（goal 的 `<goal_blocked>` 同款）。
        state.needsCheckpoint = true
        if (!driveEnabled) return false
        const process = await domain.process(scope)
        if (process === undefined) return false
        const delivery = wrapupDeliveryOf(process, 'blocked', decision.reason?.code + ': ' + String(decision.reason?.message ?? ''))
        if (delivery === undefined) return true
        await reserveAndQueue(state, 'wrap', delivery)
        return false
      }
      case 'start-stage':
      case 'close-stage':
        // 推进态结论（副作用已由 `tickWorkprocess` 经域服务落盘）⇒ 再拍一拍接着推进。
        state.needsCheckpoint = true
        return true
      default:
        // hold / wait-human：没有可做的了，停手等人。
        return false
    }
  }

  /** 一拍的完整语义（宿主 goal driver 的 `drive`：许可 → 检查点 → 收尾上一轮 → 决策）。 */
  async function drive(state: State): Promise<void> {
    if (!readyToDrive(state)) return
    // **续跑许可**（耐久）：recall 后是 disarmed ⇒ 一拍都不推进（goal：`activation !== 'armed'` 就返回）。
    // 与 goal 的差别只有一处：它读 goal 的相位，我们读归属记录里的 `rounds.activation`。
    const scope = state.agent.session.id
    const activation = await domain.activation(scope)
    if (activation === 'disarmed') return
    // 当前流程修订（耐久记号只在与之相符时算数）：这一读也顺手确认流程还在。
    // **每 agent 各记各的**（见 State.askedRevision）：多会话并发驱动时互不串扰。
    state.askedRevision = (await domain.process(scope))?.revision
    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(state.agent.session)
      } catch (error) {
        warn(`durability checkpoint failed for agent "${state.agent.session.id}": ${renderThrown(error)}`)
        // 检查点落不了盘 ⇒ 收回许可（宿主同款）：耐久性没保证时不许接着自动跑。
        await disarm(state)
        return
      }
      if (!readyAfterCheckpoint(state)) return
    }
    if (state.attempt !== undefined) {
      // 上一轮**还挂着**（投出去还没被接手 / 还没等到空闲转换）⇒ 一拍都不再投。
      //
      // 【为什么撤预约不在这里做】`drive()` 会被很多触发调到，包括**我们自己投递那条消息**
      // 产生的 `session/event`。那一刻 agent 往往还是 idle，若在这里判"agent 空闲 ⇒ 上一轮跑完了"，
      // 就会当场撤掉预约、立刻跑下一拍 —— 真机症状：任务轮与 blocked 收束轮**同时**到手，
      // 回合预算被"投递即消耗"烧光，agent 一次手都没动（第三种真机 bug）。
      // 宿主的做法是只在 `agent/status → idle`（真·空闲**转换**）里撤预约，本模块照办。
      return
    }
    if (await driveOnce(state)) state.requested = true
  }

  /** 触发合并：多个触发只跑**一条** agent 局部串行 run（宿主同款 `requestDrive`）。 */
  function requestDrive(state: State): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error) {
            warn(`driver failed for agent "${state.agent.session.id}": ${renderThrown(error)}`)
            // drive() 失败 ⇒ 收回许可（宿主同款：**不许静默重试**——失败原因没查清前不接着跑）。
            await disarm(state)
          }
        }
      })
    } catch (error) {
      warn(`could not start driver for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      void disarm(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    run.then(retire, (error) => {
      warn(`driver task rejected for agent "${state.agent.session.id}": ${renderThrown(error)}`)
      void disarm(state)
      retire()
    })
  }

  /**
   * 收回续跑许可（耐久）：驱动器不再自动往下推，任务相位原样保留（宿主 goal driver 的 disarm 同款）。
   * 人要说一句"继续"（arm）才重新发许可。
   */
  async function disarm(state: State): Promise<void> {
    const scope = state.agent.session.id
    try {
      if (await domain.activation(scope) === 'armed') await domain.setActivation(scope, 'disarmed')
    } catch (error) {
      warn(`could not disarm on abort for "${scope}": ${renderThrown(error)}`)
    }
  }

  /**
   * 一轮**没跑成**（排队中被丢弃 / 被认领没进步骤 / 中途被人停止）⇒ 把该任务**落盘暂停**：
   * 停得看得见（`/work` 显示已暂停）、`/work resume` 放行。宿主 goal driver 的"暂停被取消的 goal"
   * 同款——人点了停止就必须真的停住，否则下一拍立刻又投一轮（"停了又跑"的真机 bug）。
   *
   * 校验精确到任务修订：人若在空闲转换前已 resume 落定（修订前进），这里不会把新起的回合重暂停。
   * 规划/确认/收束轮没有任务可暂停（taskId 缺省）⇒ 静默跳过（它们的重投被"只问一次"记号挡住）。
   */
  async function pauseDroppedRound(state: State, attempt: Attempt): Promise<void> {
    if (attempt.taskId === undefined) return
    const scope = state.agent.session.id
    try {
      if (await domain.activation(scope) !== 'armed') return
      const process = await domain.process(scope)
      if (process === undefined) return
      const task = currentStageOf(process)?.tasks.find((t) => t.id === attempt.taskId)
      if (task === undefined || task.phase !== 'active' || task.revision !== attempt.revision) return
      await domain.pauseTask(scope, attempt.taskId, process.revision)
    } catch (error) {
      warn(`could not pause aborted round's task for "${scope}": ${renderThrown(error)}`)
      await disarm(state)
    }
  }

  /**
   * 回合事实（耐久计数）+ 投递生命周期 + 停止信号，每条会话事件都看一眼：
   *   · `user/message`：我们那条被**受理进步骤** ⇒ 预约记 `admitted`（这一轮跑成过的记号）；
   *     自署 `work` 且带轮号的才算一次被接手的回合（计数前进）。
   *   · `turn/end`：**人点了停止**（`aborted`）⇒ 中止的是我们投的那一轮就记 `cancelled`
   *     （空闲边界落盘暂停任务）；不是我们那一轮 ⇒ 收回续跑许可，自动推进就此停住。
   *     `max-tokens` ⇒ 同样收回许可（模型在给定预算内说不完 = 配置不适配，不许无限自动续跑）。
   */
  async function observeSessionEvent(scope: string, state: State, event: unknown): Promise<void> {
    const ev = event as SessionEventLike | undefined
    if (ev?.type === 'user/message') {
      const attempt = state.attempt
      if (attempt !== undefined && ev.data?.id === attempt.messageId) attempt.phase = 'admitted'
      const source = ev.data?.source
      if (source?.kind === 'work' && typeof source.round === 'number' && typeof source.taskId === 'string') {
        await domain.observeRound(scope, source.round, source.taskId)
      }
      return
    }
    if (ev?.type !== 'turn/end') return
    const reason = ev.data?.reason
    if (reason?.kind === 'max-tokens') {
      await disarm(state)
      return
    }
    if (reason?.kind !== 'aborted') return
    const attempt = state.attempt
    if (attempt !== undefined && (attempt.phase === 'claimed' || attempt.phase === 'admitted')) {
      // 人停止的正是我们投的那一轮：记 cancelled——回合没跑成，空闲边界把任务落盘暂停。
      attempt.cancelled = true
    } else {
      // 中止的回合不是我们投的（人在自己的消息回合里点了停止）：自动推进就此停住。
      await disarm(state)
    }
  }

  ctx.effect(function* () {
    ctx.on('agent/created', ({ agent, source }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
      // 会话 `resume`（宿主重启后从盘上加载）⇒ **收回续跑许可**：无人值守的流程不会在你
      // 不知情时接着动；人要继续说一句就 arm（对齐宿主 goal 的 disarm-on-resume 纪律）。
      if (disarmOnResume && source === 'resume') {
        return domain.setActivation(agent.session.id, 'disarmed')
          .then(() => undefined)
          .catch((error: unknown) => {
            warn(`could not disarm on resume for "${agent.session.id}": ${renderThrown(error)}`)
            return undefined
          })
      }
      return undefined   // 该事件的监听器签名要求 promise | undefined（宿主同款）
    })
    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent)
    })
    ctx.on('agent/error', ({ agent }) => {
      // 出错 ⇒ **收回续跑许可**（宿主同款）：出错的那一轮没有可信的接续状态，不许自动重试。
      const state = stateFor(agent)
      state.attempt = undefined
      return disarm(state)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const state = stateFor(agent)
      state.competingQueued = false
      const dropped = state.attempt
      // **真·空闲转换**（宿主同款）：上一轮（若还挂着）到此为止 —— 撤预约、要求一次耐久检查点。
      // 只有这条路径撤预约：`session/event` 之类的触发不许代劳（那是"投递即消耗"的坑）。
      if (state.attempt !== undefined) {
        state.attempt = undefined
        state.needsCheckpoint = true
      }
      // 投出去的那一轮**没跑成**（排队中被丢弃 / 被认领没进步骤 / 中途被人停止）⇒ 先把任务
      // 落盘暂停，再考虑下一拍——否则人点了停止，下一拍立刻又投一轮（"停了又跑"的真机 bug）。
      // 跑成过的一轮（`admitted`）不暂停：正常完成的回合不该把人卡在 resume 上。
      if (dropped !== undefined
        && (dropped.phase === 'queued' || dropped.phase === 'claimed' || dropped.cancelled)) {
        // 暂停落盘先于下一拍（否则暂停还没落地，下一轮已经投出去了）。返回 promise 供宿主/测试等待。
        return pauseDroppedRound(state, dropped)
          .catch((error: unknown) => { warn(`pause of dropped round failed: ${renderThrown(error)}`) })
          .then(() => { requestDrive(state) })
      }
      requestDrive(state)
    })
    // **空闲信号与域变更都触发驱动**（对齐宿主 `goal/changed → requestDrive`）：
    // 别的插件写了流程时未必有本会话的回合结束事件，变更本身就该叫醒驱动器。
    onWorkChanged(ctx, ({ scope }) => {
      const agent = ctx.agents.get(scope as never)
      if (agent === undefined) return
      const state = stateFor(agent)
      // 域变了 ⇒ 旧的"已投递轮次"作废（修订前进后，同一任务可以再投新的一轮）。
      state.queued.clear()
      // 域变了 ⇒ 旧的"已经问过"也作废——与耐久记号同一口径（修订一变即失效，域写必发
      // work/changed 且必顶修订；markAsked / 许可这类控制面写不发事件，不会误清）。
      // 不清的话：人拒绝收口 → 补任务 → 再次全 complete，内存集仍命中 ⇒ 永远 wait-human，
      // 流程静默停死（/work clear 重建同键阶段同样踩中）。
      // 快挡语义不丢：投出去但 markAsked 还没落盘的那一瞬，由 attempt 预约挡住重投
      // （预约在 reserveAndQueue 里同步落，早于 markAsked；同一修订无域变更时本集仍在）。
      state.planAsked.clear()
      state.askAsked.clear()
      state.needsCheckpoint = true
      requestDrive(state)
    })
    // 回合事实（耐久计数）+ 停止信号：每条会话事件都看一眼——受理记 `admitted`、
    // 停止（turn/end aborted）记 cancelled 或收回许可；只有自署 `work` 的回合才计数。
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id as never)
      if (agent === undefined) return undefined
      const state = stateFor(agent)
      // 返回 promise 供宿主/测试等待（cordis 不看返回值，等不到也不影响宿主）。
      return observeSessionEvent(session.id, state, event)
        .then(() => { if (agent.status === 'idle') requestDrive(state) })
        .catch((error: unknown) => { warn(`round observation failed for "${session.id}": ${renderThrown(error)}`) })
    })
    // 竞态围栏：别的消息排进 next-turn ⇒ 让路；我们那条被认领 / 丢弃 ⇒ 如实记账。
    // 身份比对用 sameQueued（内容 + 来源逐字节深比对，宿主同款）——不只看消息 id。
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const state = stateFor(agent)
      if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return
      const attempt = state.attempt
      if (sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const attempt = stateFor(agent).attempt
      if (sameQueued(message.content, message.source, attempt)) attempt!.phase = 'claimed'
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const attempt = stateFor(agent).attempt
      if (sameQueued(message.content, message.source, attempt)) attempt!.cancelled = true
    })
    /**
     * **pre-step 围栏**（宿主 goal driver 的三段式 waterfall）：过期 / 被插队的预约不许进步骤。
     * reject 会丢弃**整个**提议步骤，所以同批其它消息必须放回 `next-step`
     * （`restoreOtherClaimed` 是正确性的一部分，不是可选项）。
     */
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message) => message.source.kind === 'work')
      if (submitted === undefined) return next()   // 不是我们的轮次 ⇒ 放行
      const { content, source } = submitted
      const state = stateFor(agent)
      // 进步骤前验一次：不过 ⇒ 置 stale、清预约、放回同批其它消息、重拍、拒。
      let valid = false
      try {
        valid = await validReservation(state, content, source as WorkRoundMessageSource)
      } catch (error) {
        warn(`pre-step check failed for agent "${agent.session.id}": ${renderThrown(error)}`)
        await disarm(state)   // 校验自身抛错 ⇒ 收回许可（宿主同款）
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameReservedRound(source as WorkRoundMessageSource, attempt)) {
          dropReservation(state, attempt)
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error) {
        if (signal.aborted) throw error
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        // 下游 reject ⇒ 清预约 + 任务落盘 block（prompt-rejected；域服务直调，不走工具面门槛）。
        state.attempt = undefined
        await blockUndeliveredRound(state, source as WorkRoundMessageSource, 'prompt-rejected',
          '回合在进步骤前被驳回（pre-step waterfall 下游 reject）')
        return decision
      }
      // 拿到 enter 决策后**再验一次**：等待下游的期间状态可能已变（宿主同款二验）。
      try {
        valid = await validReservation(state, content, source as WorkRoundMessageSource)
      } catch (error) {
        warn(`post-decision check failed for agent "${agent.session.id}": ${renderThrown(error)}`)
        await disarm(state)
        valid = false
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameReservedRound(source as WorkRoundMessageSource, attempt)) {
          dropReservation(state, attempt)
        } else {
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      return { ...decision, startsRequestSeries: true }
    })
    // 装载时对**已经在场**的 agent 一律收回续跑许可（宿主同款）：插件热重载时在场的 agent
    // 没有经过 `agent/created` 的 disarm-on-resume 路径——不能带着旧许可接着自动跑，
    // 人要继续说一句就 arm。正常冷启动时这里拿到的是空列表（插件先于 agent 装载）。
    for (const agent of ctx.agents.list()) void disarm(stateFor(agent))
    yield async () => {
      // 卸载（宿主同款）：收回许可 → 挂着的预约置 stale → cancel 在跑的回合 →
      // 等 idle 与驱动 run 收尾。只置 stopping 会把在跑的回合留在半空。
      const waits: Promise<unknown>[] = []
      for (const state of states.values()) {
        state.stopping = true
        // 先落许可收回、再 cancel：否则空闲边界的"落盘暂停"可能抢到许可收回之前。
        await disarm(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  })
}

//#endregion

export * from './decide.js'
export * from './prompt.js'
