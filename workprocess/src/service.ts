/**
 * `ctx.workprocess` 服务面（**给别的插件消费**的那一层，与宿主 `ctx.goals` 同形）。
 *
 * 【为什么要它】存储域的 `open` 对同名域是**响亮拒绝**（`already-open`）——域只能由一个插件独占。
 * 工具面（`tool-workprocess`）与命令行（`workprocess`）都不能自己开域，也不该绕过内核直接改状态。
 * 于是本插件把**域 API**（读 + 全部写动词）做成服务提供出去：消费方拿 `ctx.workprocess` 就够了，
 * 不需要 store、不需要内核函数——这正是宿主 `tool-goal` 调 `ctx.goals.complete(...)` 的形状。
 *
 * 【两套键】写/读的**域 API 按 `scope` 键**（一个归属域一条流程；多流程并存时显式给 scope），
 * 人可直接做的干预**按 `agent` 键**（`agent.session.id` = 归属域，命令面用，同 `ctx.goals.get(agent)`）。
 *
 * @module workprocess/service
 */
import {
  blockWorkTask, clearWorkTask, closeWorkProcess, completeWorkStage, completeWorkTask, createWorkProcess,
  createWorkTask, currentStageOf, defineWorkStages, discardWorkProcess, editWorkObjective, editWorkTask,
  decodeWorkProcess, markWorkAsked, pauseWorkTask, resumeWorkTask, setWorkActivation, startWorkStage,
  workActivationOf, workAskedOf, workProcessOf,
} from './kernel.js'
import type {
  CreateWorkProcessRequest, CreateWorkTaskRequest, EditWorkTaskRequest, WorkActivation, WorkAskedState,
  WorkBlockReason, WorkProcess, WorkStage, WorkStageDraft,
} from './kernel.js'
import type { WorkDeps } from './kernel.js'

/** 会话的最小读取面（与 authority/message 同源的窄类型）。 */
interface AgentLike { readonly session?: { readonly id?: string } }

/** 审计发现（`audit()`）：一条已落盘记录的自洽性问题（**不是**运行期错误，是"历史里躺着坏数据"）。 */
export interface WorkAuditFinding {
  /** 归属域键。 */
  readonly scope: string
  /** 人可读的问题说明（含内核严格解码给出的原因）。 */
  readonly problem: string
}

/** 审计结果：发现 + 每一条**通过**审计的快照（不变量伴生插件用它给影子折叠播种）。 */
export interface WorkAuditReport {
  readonly findings: readonly WorkAuditFinding[]
  readonly snapshots: readonly { readonly scope: string; readonly process: WorkProcess }[]
}

/** 命令/看板要读的流程概览（够排版即可；没有 ⇒ undefined）。 */
export interface WorkprocessStatus {
  readonly objective: string
  readonly stages: readonly WorkStage[]
  /** 当前阶段（全阶段 done ⇒ 缺省）。 */
  readonly currentStageKey?: string
  /** 已准入回合数（耐久在归属记录里）。 */
  readonly roundsStarted: number
  /** 流程收口时间戳（缺省 = 未收口）：已收口的流程一切写被内核拒。 */
  readonly closedAt?: number
  /** 当前阶段首个任务生效的回合上限（没写 max_rounds ⇒ 缺省不展示）。 */
  readonly maxRounds?: number
  /** **续跑许可**（缺省 `armed`）：`disarmed` 时驱动器不自动往下推（会话 resume 后自动落）。 */
  readonly activation?: WorkActivation
}

/**
 * `ctx.workprocess`：**域 API**（scope 键：读 + 全部写动词）+ **人机干预**（agent 键）。
 *
 * 写方法一律返回内核的 `changed`（幂等是硬语义：`changed:false` = 一个字节都没写）；
 * 带 `revision` 时旧值即拒（CAS，抛 `WorkError('WORK_CONFLICT')`）。
 */
export interface WorkprocessService {
  // ── 读（域 API）────────────────────────────────────────────────
  /** 流程快照（缺省 = 该归属域没有流程）。 */
  process(scope: string): Promise<WorkProcess | undefined>
  /** 读该 agent 会话的流程概览（没有流程 ⇒ undefined；缺失 ≠ 空）。 */
  view(agent: unknown): Promise<WorkprocessStatus | undefined>

  // ── 写（域 API，与内核服务函数一一对应）─────────────────────────
  createProcess(scope: string, request: CreateWorkProcessRequest): Promise<boolean>
  defineStages(scope: string, stages: readonly WorkStageDraft[], revision?: number): Promise<boolean>
  /** 阶段开工（串行门放行才成立；**驱动器的动作**，不是模型的动词）。 */
  startStage(scope: string, stageKey: string, revision?: number): Promise<boolean>
  editObjective(scope: string, objective: string, revision?: number): Promise<boolean>
  closeStage(scope: string, stageKey: string, revision?: number): Promise<boolean>
  createTask(scope: string, request: CreateWorkTaskRequest, revision?: number): Promise<boolean>
  editTask(scope: string, taskId: string, patch: EditWorkTaskRequest, revision?: number): Promise<boolean>
  pauseTask(scope: string, taskId: string, revision?: number): Promise<boolean>
  resumeTask(scope: string, taskId: string, revision?: number): Promise<boolean>
  blockTask(scope: string, taskId: string, reason: WorkBlockReason, revision?: number): Promise<boolean>
  completeTask(scope: string, taskId: string, revision?: number): Promise<boolean>
  clearTask(scope: string, taskId: string, revision?: number): Promise<boolean>
  /** 丢弃整条流程（scope 键；幂等：没有流程 ⇒ false）。 */
  discardProcess(scope: string, revision?: number): Promise<boolean>
  /** 收口整条流程（全阶段 done 才成立；方案 B 的轻量终止水印）。 */
  closeProcess(scope: string, revision?: number): Promise<boolean>

  // ── 审计（"已落盘的历史还自洽吗"：不变量伴生插件用）────────────────
  /**
   * 遍历**整张归属记录表**：每条流程快照必须能过内核**严格解码**（形状 / 阶段串行 / id 唯一性），
   * 且归属边界与记录键一致、`rounds` 读数合法。返回发现 + 通过审计的快照。
   *
   * 【为什么必须由服务做】域由领域插件独占打开（同名域重复 `open` 是响亮拒绝），
   * 伴生插件拿不到表句柄——所以"审计"是服务面的一部分。
   */
  audit(): Promise<WorkAuditReport>

  // ── 续跑许可（耐久在归属记录里；驱动器的自动推进开关）────────────
  /** 读续跑许可（缺省 `armed`）；没有流程 ⇒ `undefined`。 */
  activation(scope: string): Promise<WorkActivation | undefined>
  /** 设置续跑许可（幂等：同值零写入；没有流程 ⇒ `false`）。 */
  setActivation(scope: string, activation: WorkActivation, revision?: number): Promise<boolean>

  // ── "已经问过"的耐久记号（驱动器的去重判据；跨重启不重复打扰）────────
  /** 读记号（没有流程 / 没记过 ⇒ `undefined`）；只在 `revision` 与当前流程相符时采信。 */
  asked(scope: string): Promise<WorkAskedState | undefined>
  /** 记下"这件问过了"（幂等；没有流程 ⇒ `false`）。 */
  markAsked(scope: string, kind: 'plan' | 'ask', key: string, revision: number): Promise<boolean>

  // ── 回合计数（驱动器的回合预算判据；耐久在归属记录里）────────────
  /** 该归属域**已准入回合数**（缺省 = 没记录过）。 */
  roundsStarted(scope: string): Promise<number | undefined>
  /**
   * 记一个**被接手的回合**（`round` 单调前进；旧回合/重复观察零写入）。
   * 只有自署 `work` 来源的回合才算——人的消息不是回合（判据在驱动器侧）。
   */
  observeRound(scope: string, round: number): Promise<void>

  // ── 人机干预（agent 键；命令面用）──────────────────────────────
  /** 丢弃该 agent 会话的整条流程（幂等：没有流程 ⇒ false）。 */
  discard(agent: unknown): Promise<boolean>
  /** 暂停**当前阶段**的活动任务；返回被暂停的任务 id。 */
  pauseActive(agent: unknown): Promise<readonly string[]>
  /** 恢复当前阶段被暂停的任务；返回被恢复的任务 id。 */
  resumePaused(agent: unknown): Promise<readonly string[]>
}

/** 归属域键 = 调用者会话（命令与动作都挂在这条会话上）。 */
function scopeOfAgent(agent: unknown): string | undefined {
  const id = (agent as AgentLike | undefined)?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 造服务面（组合根唯一实例：与打开的那个存储域同源）。
 *
 * @param deps - 内核依赖（store / now / onChanged）：服务持有它，消费方不必再碰 store。
 * @param onCleared - 整条流程被丢弃时的墓碑通知（组合根接到宿主 `work/changed`，change = undefined）。
 */
export function createWorkprocessService(
  deps: WorkDeps, onCleared?: (scope: string) => void,
): WorkprocessService {
  const process = (scope: string): Promise<WorkProcess | undefined> => workProcessOf(deps, scope)
  const stageOf = async (scope: string) => {
    const found = await process(scope)
    return found === undefined ? undefined : { process: found, stage: currentStageOf(found) }
  }
  const pauseOrResume = async (scope: string, from: 'active' | 'paused'): Promise<readonly string[]> => {
    const found = await stageOf(scope)
    if (found?.stage === undefined) return []
    const targets = found.stage.tasks.filter((t) => t.phase === from)
    const moved: string[] = []
    for (const task of targets) {
      const changed = from === 'active'
        ? await pauseWorkTask(deps, scope, task.id)
        : await resumeWorkTask(deps, scope, task.id)
      if (changed) moved.push(task.id)
    }
    return moved
  }
  /**
   * 审计整张表。检查项（都只读、不改）：严格解码 / 归属边界（`id === 'wp:' + scope`）/
   * `rounds.started` 是非负安全整数 / `rounds.activation` 合法。
   */
  const audit = async (): Promise<WorkAuditReport> => {
    const findings: WorkAuditFinding[] = []
    const snapshots: { scope: string; process: WorkProcess }[] = []
    const enumerated = deps.store.entries === undefined ? undefined : await deps.store.entries()
    for (const [scope, record] of enumerated ?? []) {
      const raw = record?.workProcess
      if (raw === undefined) continue                    // 空记录（只有 rounds）：不是流程
      let process: WorkProcess
      try {
        process = decodeWorkProcess(raw)
      } catch (err) {
        findings.push({ scope, problem: '快照过不了严格解码：' + String((err as Error)?.message ?? err) })
        continue
      }
      if (process.id !== 'wp:' + scope) {
        findings.push({ scope, problem: '归属边界不符：快照 id ' + JSON.stringify(process.id) + ' 与记录键不一致' })
      }
      const started = record?.rounds?.started
      if (started !== undefined && (!Number.isSafeInteger(started) || started < 0)) {
        findings.push({ scope, problem: '回合计数不合法：' + JSON.stringify(started) })
      }
      const activation = record?.rounds?.activation
      if (activation !== undefined && activation !== 'armed' && activation !== 'disarmed') {
        findings.push({ scope, problem: '续跑许可不合法：' + JSON.stringify(activation) })
      }
      snapshots.push({ scope, process })
    }
    return { findings, snapshots }
  }
  const discardProcess = async (scope: string, revision?: number): Promise<boolean> => {
    const changed = await discardWorkProcess(deps, scope, revision)
    if (changed) onCleared?.(scope)
    return changed
  }
  return {
    process,
    async view(agent) {
      const scope = scopeOfAgent(agent)
      if (scope === undefined) return undefined
      const found = await stageOf(scope)
      if (found === undefined) return undefined
      const activation = await workActivationOf(deps, scope)
      const cap = found.stage?.tasks[0]?.maxRounds
      return {
        objective: found.process.objective,
        stages: found.process.stages,
        ...(found.stage === undefined ? {} : { currentStageKey: found.stage.key }),
        roundsStarted: (await deps.store.get(scope))?.rounds?.started ?? 0,
        ...(cap === undefined ? {} : { maxRounds: cap }),
        ...(found.process.closedAt === undefined ? {} : { closedAt: found.process.closedAt }),
        ...(activation === undefined ? {} : { activation }),
      }
    },
    // 写：域 API（与内核服务函数一一对应，服务是唯一持有 store 的那一层）。
    createProcess: (scope, request) => createWorkProcess(deps, scope, request),
    startStage: (scope, stageKey, revision) => startWorkStage(deps, scope, stageKey, revision),
    audit,
    asked: (scope) => workAskedOf(deps, scope),
    markAsked: (scope, kind, key, revision) => markWorkAsked(deps, scope, kind, key, revision),
    activation: (scope) => workActivationOf(deps, scope),
    setActivation: (scope, activation, revision) => setWorkActivation(deps, scope, activation, revision),
    roundsStarted: async (scope) => (await deps.store.get(scope))?.rounds?.started,
    async observeRound(scope, round) {
      await deps.store.mutate(scope, (record) => {
        const current = record.rounds?.started ?? 0
        if (round <= current) return undefined   // 旧回合 / 重复观察：零写入
        record.rounds = { ...record.rounds, started: round }
        record.updatedAt = deps.now()
        return { changed: true }
      })
    },
    defineStages: (scope, stages, revision) => defineWorkStages(deps, scope, stages, revision),
    editObjective: (scope, objective, revision) => editWorkObjective(deps, scope, objective, revision),
    closeStage: (scope, stageKey, revision) => completeWorkStage(deps, scope, stageKey, revision),
    createTask: (scope, request, revision) => createWorkTask(deps, scope, request, revision),
    editTask: (scope, taskId, patch, revision) => editWorkTask(deps, scope, taskId, patch, revision),
    pauseTask: (scope, taskId, revision) => pauseWorkTask(deps, scope, taskId, revision),
    resumeTask: (scope, taskId, revision) => resumeWorkTask(deps, scope, taskId, revision),
    blockTask: (scope, taskId, reason, revision) => blockWorkTask(deps, scope, taskId, reason, revision),
    completeTask: (scope, taskId, revision) => completeWorkTask(deps, scope, taskId, revision),
    clearTask: (scope, taskId, revision) => clearWorkTask(deps, scope, taskId, revision),
    discardProcess,
    closeProcess: (scope, revision) => closeWorkProcess(deps, scope, revision),
    // 人机干预：agent 键。
    discard(agent) {
      const scope = scopeOfAgent(agent)
      return scope === undefined ? Promise.resolve(false) : discardProcess(scope)
    },
    async pauseActive(agent) {
      const scope = scopeOfAgent(agent)
      return scope === undefined ? [] : pauseOrResume(scope, 'active')
    },
    async resumePaused(agent) {
      const scope = scopeOfAgent(agent)
      return scope === undefined ? [] : pauseOrResume(scope, 'paused')
    },
  }
}
