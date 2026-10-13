/**
 * workprocess 的**纯折叠与判据**（对齐宿主 `@deepseek-ai/dsh-goal/src/fold.ts`：
 * 宿主在这里放 `emptyGoalFoldState` 与 `applyGoalEvent`——纯 replay 折叠）。
 *
 * 三条纪律（同宿主）：
 *   ① 事件表是**唯一一份**状态规则——两层的全部写路径都经这里；
 *   ② 事件在当前状态下不成立 → `changed:false`，调用方**必须零写入**（幂等是硬语义）；
 *   ③ 零 I/O、不读时钟、不抛异常（非法迁移返回原因；只有**解码**才抛 `WORK_CORRUPT`）。
 *
 * 【两层的折叠关系】层1（阶段）与层2（任务）在**同一个** `WorkProcess` 上折叠：
 *   · 层2 的事件只动"某阶段下的某个任务"；
 *   · 层1 的事件要么动阶段表（`stage-define`），要么动阶段态（`stage-start` / `stage-done`）；
 *   · 串行门（前序阶段全 done 才可开工）与"阶段收口要求任务全 complete"是**跨层判据**，
 *     由本模块的纯函数统一判定——两处各写一份必然漂移。
 *
 * @module workprocess/fold
 */
import type { WorkChange, WorkEvent, WorkEventKind } from './domain.js'
import { WORK_CHANGE_VERSION, WorkError } from './runtime.js'
import { previousStagesDone } from './stages.js'
import type {
  WorkBlockReason, WorkProcess, WorkProgress, WorkStage, WorkStageDraft, WorkTask, WorkTaskDraft,
  WorkTaskPhase, WorkTaskTombstone,
} from './types.js'

/** 折叠累加器（对齐宿主 `GoalFoldState` 的最小面）。 */
export interface WorkFoldState {
  process: WorkProcess | undefined
}

/** 折叠结果（`changed:false` 时调用方零写入）。 */
export interface WorkFoldResult {
  /** false = 事件在当前状态下不成立（调用方必须零写入）。 */
  changed: boolean
  /** 变更后的流程；`changed:false` 时与入参同值（含 undefined）。 */
  next: WorkProcess | undefined
  /** `changed:false` 的人话原因（进日志/诊断，不进记录）。 */
  reason?: string
}

/** 重放失败哨兵：坏在哪条变更、为什么。 */
export interface WorkFoldFailure {
  /** 失败变更在流里的下标（0 起）。 */
  readonly index: number
  readonly message: string
}

/** 折叠态（对齐宿主 `FoldedGoal`）。 */
export interface FoldedWorkProcess {
  readonly process: WorkProcess | undefined
  /**
   * 重放失败哨兵（对齐宿主 `GoalProjectionState.failure`）：**保留最后有效值 + 记录失败**。
   * 只在 `tryFoldWorkProcess` 里出现——严格版 `foldWorkProcess` 遇损坏直接抛。
   */
  readonly failure?: WorkFoldFailure
}

/** 空折叠态（对齐宿主 `emptyGoalFoldState`）。 */
export function emptyWorkState(): WorkFoldState {
  return { process: undefined }
}

function no(next: WorkProcess | undefined, reason: string): WorkFoldResult {
  return { changed: false, next, reason }
}

function yes(next: WorkProcess): WorkFoldResult {
  return { changed: true, next }
}

/** complete 是层2 的终态：重开 = 新建任务（不是把 done 改回去）。 */
function isOpenTaskPhase(phase: WorkTaskPhase): boolean {
  return phase !== 'complete'
}

/* -------------------------------------------------------------------------- */
/* 跨层判据（唯一一份：串行门 / 阶段收口 / 进度投影）                                */

/** 取某阶段（无 ⇒ undefined；缺失 ≠ pending）。 */
export function stageOf(process: WorkProcess, key: string): WorkStage | undefined {
  return process.stages.find((s) => s.key === key)
}

/** 取某任务（跨全部阶段找；任务 id 全局唯一由不变量守）。 */
export function taskOf(process: WorkProcess, taskId: string): WorkTask | undefined {
  for (const stage of process.stages) {
    const hit = stage.tasks.find((t) => t.id === taskId)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 全部任务（投影/计数用）。 */
export function allTasksOf(process: WorkProcess): readonly WorkTask[] {
  return process.stages.flatMap((s) => s.tasks)
}

/** 已被 clear 的任务身份（编号不复用的判据）。 */
export function clearedTaskIdsOf(process: WorkProcess): readonly string[] {
  return (process.cleared ?? []).map((t) => t.id)
}

/**
 * **串行门**：该阶段能否开工——本阶段 `pending`，且**前序阶段全部 `done`**。
 *
 * 这是"阶段间串行"这条语义的**唯一**落点（`stage-start` 事件、驱动与工具面都调它）；
 * 其中"前序全 done"这半由 `stages.js` 的 `previousStagesDone` 单点提供。
 */
export function stageAllowsStart(process: WorkProcess, key: string): boolean {
  const index = process.stages.findIndex((s) => s.key === key)
  if (index < 0) return false
  if (process.stages[index].state !== 'pending') return false
  return previousStagesDone(process, key)
}

/**
 * **阶段收口判据**：本阶段可以标 done 吗——态为 `active` 且**任务非空且全部 complete**。
 *
 * 为什么要求"任务非空"：空集"全完成"是平凡真值，会让一个没装任何工作的阶段直接收口——
 * 与本仓"缺失 ≠ 达成"同一条纪律（对齐宿主 `readyToClose` 的空数组判定）。
 *
 * 与收口策略（`human` / `auto`）**无关**：策略只决定"谁有权落 done"，不决定"够不够格落"——
 * 自动收口也必须任务非空且全 complete（否则 `auto` 会成为绕过判据的后门）。
 */
export function stageIsFinishable(stage: WorkStage): boolean {
  return stage.state === 'active' && stage.tasks.length > 0
    && stage.tasks.every((t) => t.phase === 'complete')
}

/** **流程收口判据**：全部阶段 done 且阶段表非空（缺失 ≠ 达成）。 */
export function processAllowsClose(process: WorkProcess): boolean {
  return process.stages.length > 0 && process.stages.every((s) => s.state === 'done')
}

/** 有界进度投影（归属记录只准带这个，正文不进城）。 */
export function workProgressOf(process: WorkProcess): WorkProgress {
  const tasks = allTasksOf(process)
  return {
    stages: { total: process.stages.length, done: process.stages.filter((s) => s.state === 'done').length },
    tasks: { total: tasks.length, done: tasks.filter((t) => t.phase === 'complete').length },
  }
}

/**
 * 层2 的 driver 视角判据：该相位是否**允许起轮**（只有 active）。
 * paused / blocked / complete / 缺失 一律不起轮——缺失语义由调用方决定回落。
 */
export function taskAllowsRound(phase: WorkTaskPhase | undefined): boolean {
  return phase === 'active'
}

/* -------------------------------------------------------------------------- */
/* 结构相等（幂等判据的唯一口径）                                                    */

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function sameTask(a: WorkTask, b: WorkTask): boolean {
  return a.id === b.id && a.stageKey === b.stageKey && a.objective === b.objective
    && a.phase === b.phase && a.revision === b.revision && a.maxRounds === b.maxRounds
    && a.blockedReason?.code === b.blockedReason?.code
    && a.blockedReason?.message === b.blockedReason?.message
}

function sameStage(a: WorkStage, b: WorkStage): boolean {
  return a.key === b.key && a.statement === b.statement && a.state === b.state
    && a.closePolicy === b.closePolicy
    && sameStringList(a.doneCriteria, b.doneCriteria)
    && a.tasks.length === b.tasks.length && a.tasks.every((t, i) => sameTask(t, b.tasks[i]))
}

function sameTombstones(a: readonly WorkTaskTombstone[], b: readonly WorkTaskTombstone[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.revision === b[i].revision && t.clearedAt === b[i].clearedAt)
}

/** 两个流程快照是否逐字段相等（幂等重放与"重算须与记录一致"的同一口径）。 */
export function sameProcess(a: WorkProcess, b: WorkProcess): boolean {
  return a.id === b.id && a.objective === b.objective && a.revision === b.revision
    && a.stages.length === b.stages.length && a.stages.every((s, i) => sameStage(s, b.stages[i]))
    && sameTombstones(a.cleared ?? [], b.cleared ?? [])
    // 终止水印也要逐字段对上：重放校验盖不住它，伪造的 closedAt 就会溜进来。
    && a.closedAt === b.closedAt
}

/* -------------------------------------------------------------------------- */
/* 阶段表构建与串行门体检                                                            */

/** 收口策略值域（唯一定义处：`buildStages` 与严格解码器共用）。 */
function isClosePolicy(v: unknown): v is 'human' | 'auto' {
  return v === 'human' || v === 'auto'
}

/** 把阶段定义建成初态阶段表；非法返回人话原因（fold 不抛）。 */
function buildStages(drafts: readonly WorkStageDraft[]): readonly WorkStage[] | string {
  const seen = new Set<string>()
  const out: WorkStage[] = []
  for (const d of drafts) {
    if (d.key.trim() === '') return '阶段缺 key'
    if (seen.has(d.key)) return '阶段键重复：' + d.key
    seen.add(d.key)
    if (d.statement.trim() === '') return '阶段缺 statement（key=' + d.key + '）'
    // 值域在此拦：写进去的东西必须读得回来（与严格解码器同一条口径，见 `KEBAB` 的同款理由）。
    if (d.closePolicy !== undefined && !isClosePolicy(d.closePolicy)) {
      return '阶段收口策略不认识（只认 human / auto；key=' + d.key + '）'
    }
    out.push({
      key: d.key, statement: d.statement, doneCriteria: [...(d.doneCriteria ?? [])],
      ...(d.closePolicy === undefined ? {} : { closePolicy: d.closePolicy }),
      state: 'pending', tasks: [],
    })
  }
  return out
}

/**
 * 串行门体检：合法形态只有 `[done…][active?][pending…]` 一种（最多一个 active）。
 * 返回人话原因（合法 ⇒ undefined）。`stage-define` 重排阶段表后必须过这一关。
 */
export function serialViolation(stages: readonly WorkStage[]): string | undefined {
  let sawOpen = false
  for (const s of stages) {
    if (sawOpen && s.state !== 'pending') {
      return '串行门被破坏：' + s.key + ' 处于 ' + s.state + '，但其前序阶段未全 done'
    }
    if (s.state !== 'done') sawOpen = true
  }
  return undefined
}

/** 替换某阶段并 bump 聚合 revision。 */
function mapStage(process: WorkProcess, key: string, fn: (s: WorkStage) => WorkStage): WorkProcess {
  return {
    ...process,
    revision: process.revision + 1,
    stages: process.stages.map((s) => (s.key === key ? fn(s) : s)),
  }
}

/** 替换某任务并 bump 聚合 revision。 */
function mapTask(process: WorkProcess, taskId: string, fn: (t: WorkTask) => WorkTask): WorkProcess {
  return {
    ...process,
    revision: process.revision + 1,
    stages: process.stages.map((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === taskId ? fn(t) : t)) })),
  }
}

/* -------------------------------------------------------------------------- */
/* 事件表（唯一一份状态规则）                                                        */

/**
 * 把一个事件折进当前流程（纯函数：同输入必同输出）。
 * 对齐宿主 `applyGoalEvent(state, event)` 的形态，但只返回折叠结果（不持有累加器）。
 */
export function applyWorkEvent(current: WorkProcess | undefined, event: WorkEvent): WorkFoldResult {
  // **收口总闸**：已收口的流程不再接受任何写（`process-close` 自身除外——它负责幂等判定）。
  // 重建须先 `discard`（丢弃走服务层、不经事件表，不受影响）。
  if (current !== undefined && current.closedAt !== undefined && event.kind !== 'process-close') {
    return no(current, 'process-closed')
  }
  switch (event.kind) {
    case 'process-close': {
      if (current === undefined) return no(undefined, 'process-close:no-process')
      if (current.closedAt !== undefined) return no(current, 'process-close:already-closed')
      if (!processAllowsClose(current)) return no(current, 'process-close:stages-open')
      return yes({ ...current, closedAt: event.closedAt, revision: current.revision + 1 })
    }
    case 'init': {
      if (event.objective.trim() === '') return no(current, 'init:objective-required')
      const built = buildStages(event.stages)
      if (typeof built === 'string') return no(current, 'init:' + built)
      if (current === undefined) {
        return yes({ id: event.id, objective: event.objective, revision: 1, stages: built })
      }
      const replay = current.id === event.id && current.objective === event.objective
        && sameStagesShape(current.stages, built)
      return no(current, replay ? 'init:idempotent-replay' : 'init:identity-conflict')
    }
    case 'objective-edit': {
      if (current === undefined) return no(undefined, 'objective-edit:no-process')
      if (event.objective.trim() === '') return no(current, 'objective-edit:objective-required')
      // 同值重放零写入（幂等是硬语义）；真改了才 +1 revision。
      if (current.objective === event.objective) return no(current, 'objective-edit:idempotent-replay')
      return yes({ ...current, objective: event.objective, revision: current.revision + 1 })
    }
    case 'stage-define': {
      if (current === undefined) return no(undefined, 'stage-define:no-process')
      const built = buildStages(event.stages)
      if (typeof built === 'string') return no(current, 'stage-define:' + built)
      const byKey = new Map(current.stages.map((s) => [s.key, s]))
      const merged: WorkStage[] = built.map((draft) => {
        const prev = byKey.get(draft.key)
        // 定义（statement / doneCriteria / 收口策略）以草案为准，运行态（state / tasks）保留 prev 的；
        // 策略**缺省即回到 `human`**——整体替换定义不该把上一版的 `auto` 悄悄留着。
        return prev === undefined ? draft : {
          ...prev, statement: draft.statement, doneCriteria: draft.doneCriteria, closePolicy: draft.closePolicy,
        }
      })
      // 被移除的阶段：空的无所谓，**有任务的一律拒**（静默丢任务是最坏的一类缺陷）。
      const droppedWithTasks = current.stages.find((s) => s.tasks.length > 0 && !merged.some((m) => m.key === s.key))
      if (droppedWithTasks !== undefined) {
        return no(current, 'stage-define:would-drop-tasks:' + droppedWithTasks.key)
      }
      const violation = serialViolation(merged)
      if (violation !== undefined) return no(current, 'stage-define:' + violation)
      const same = current.stages.length === merged.length && current.stages.every((s, i) => sameStage(s, merged[i]))
      if (same) return no(current, 'stage-define:idempotent-replay')
      return yes({ ...current, stages: merged, revision: current.revision + 1 })
    }
    case 'stage-start': {
      if (current === undefined) return no(undefined, 'stage-start:no-process')
      const stage = stageOf(current, event.stageKey)
      if (stage === undefined) return no(current, 'stage-start:unknown-stage:' + event.stageKey)
      if (stage.state !== 'pending') return no(current, 'stage-start:not-pending:' + stage.state)
      if (!stageAllowsStart(current, event.stageKey)) return no(current, 'stage-start:serial-blocked')
      return yes(mapStage(current, event.stageKey, (s) => ({ ...s, state: 'active' })))
    }
    case 'stage-done': {
      if (current === undefined) return no(undefined, 'stage-done:no-process')
      const stage = stageOf(current, event.stageKey)
      if (stage === undefined) return no(current, 'stage-done:unknown-stage:' + event.stageKey)
      if (stage.state !== 'active') return no(current, 'stage-done:not-active:' + stage.state)
      if (!stageIsFinishable(stage)) return no(current, 'stage-done:tasks-open')
      return yes(mapStage(current, event.stageKey, (s) => ({ ...s, state: 'done' })))
    }
    case 'task-create': {
      if (current === undefined) return no(undefined, 'task-create:no-process')
      const draft = event.task
      if (draft.objective.trim() === '') return no(current, 'task-create:objective-required')
      // 与 task-edit 同口径（decode 的 requirePositiveInt 就是这条线）：坏 maxRounds 一旦落盘，
      // 下一次 decodeExisting 就抛 WORK_CORRUPT——scope 的读/写/discard 全锁死，工具面没有恢复路径。
      if (draft.maxRounds !== undefined && (!Number.isSafeInteger(draft.maxRounds) || draft.maxRounds <= 0)) {
        return no(current, 'task-create:bad-round-cap')
      }
      const stage = stageOf(current, draft.stageKey)
      if (stage === undefined) return no(current, 'task-create:unknown-stage:' + draft.stageKey)
      // 已收口的阶段不许再塞任务：否则串行门会被"悄悄地"作废（要加活先重开阶段）。
      if (stage.state === 'done') return no(current, 'task-create:stage-done:' + draft.stageKey)
      const existing = taskOf(current, draft.id)
      if (existing !== undefined) {
        const replay = existing.stageKey === draft.stageKey && existing.objective === draft.objective
          && existing.maxRounds === draft.maxRounds
        return no(current, replay ? 'task-create:idempotent-replay' : 'task-create:identity-conflict:' + draft.id)
      }
      if (clearedTaskIdsOf(current).includes(draft.id)) {
        return no(current, 'task-create:identity-reuse:' + draft.id)
      }
      const task: WorkTask = { ...draft, phase: 'active', revision: 1 }
      return yes({
        ...current,
        revision: current.revision + 1,
        stages: current.stages.map((s) => (s.key === stage.key ? { ...s, tasks: [...s.tasks, task] } : s)),
      })
    }
    case 'task-edit': {
      if (current === undefined) return no(undefined, 'task-edit:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-edit:no-task:' + event.taskId)
      const objective = event.objective?.trim()
      if ((objective === undefined || objective === '') && event.maxRounds === undefined) {
        return no(current, 'task-edit:nothing-to-change')
      }
      if (event.maxRounds !== undefined && (!Number.isSafeInteger(event.maxRounds) || event.maxRounds <= 0)) {
        return no(current, 'task-edit:bad-round-cap')
      }
      const nextObjective = objective === undefined || objective === '' ? task.objective : objective
      const nextCap = event.maxRounds ?? task.maxRounds
      if (nextObjective === task.objective && nextCap === task.maxRounds) {
        return no(current, 'task-edit:idempotent-replay')
      }
      return yes(mapTask(current, task.id, (t) => ({ ...t, objective: nextObjective, maxRounds: nextCap, revision: t.revision + 1 })))
    }
    case 'task-pause': {
      if (current === undefined) return no(undefined, 'task-pause:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-pause:no-task:' + event.taskId)
      if (task.phase !== 'active') return no(current, 'task-pause:not-active:' + task.phase)
      return yes(mapTask(current, task.id, (t) => ({ ...t, phase: 'paused', revision: t.revision + 1 })))
    }
    case 'task-resume': {
      if (current === undefined) return no(undefined, 'task-resume:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-resume:no-task:' + event.taskId)
      if (task.phase !== 'paused' && task.phase !== 'blocked') {
        return no(current, 'task-resume:not-resumable:' + task.phase)
      }
      return yes(mapTask(current, task.id, (t) => ({ ...t, phase: 'active', blockedReason: undefined, revision: t.revision + 1 })))
    }
    case 'task-block': {
      if (current === undefined) return no(undefined, 'task-block:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-block:no-task:' + event.taskId)
      if (!isOpenTaskPhase(task.phase)) return no(current, 'task-block:terminal')
      const reason = normalizeReason(event.reason)
      if (reason === undefined) return no(current, 'task-block:reason-required')
      if (task.phase === 'blocked' && task.blockedReason?.code === reason.code
        && task.blockedReason.message === reason.message) {
        return no(current, 'task-block:idempotent-replay')
      }
      return yes(mapTask(current, task.id, (t) => ({ ...t, phase: 'blocked', blockedReason: reason, revision: t.revision + 1 })))
    }
    case 'task-complete': {
      if (current === undefined) return no(undefined, 'task-complete:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-complete:no-task:' + event.taskId)
      if (!isOpenTaskPhase(task.phase)) return no(current, 'task-complete:terminal')
      return yes(mapTask(current, task.id, (t) => ({ ...t, phase: 'complete', blockedReason: undefined, revision: t.revision + 1 })))
    }
    case 'task-clear': {
      if (current === undefined) return no(undefined, 'task-clear:no-process')
      const task = taskOf(current, event.taskId)
      if (task === undefined) return no(current, 'task-clear:no-task:' + event.taskId)
      const tombstone: WorkTaskTombstone = { id: task.id, revision: task.revision, clearedAt: event.clearedAt }
      return yes({
        ...current,
        revision: current.revision + 1,
        stages: current.stages.map((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== task.id) })),
        cleared: [...(current.cleared ?? []), tombstone],
      })
    }
  }
}

/** 阶段表形状相等（init 幂等判据：初态阶段表按定义比，不比运行态）。 */
function sameStagesShape(a: readonly WorkStage[], b: readonly WorkStage[]): boolean {
  return a.length === b.length && a.every((s, i) => s.key === b[i].key && s.statement === b[i].statement
    && s.closePolicy === b[i].closePolicy
    && sameStringList(s.doneCriteria, b[i].doneCriteria))
}

/** 结构化原因归一（两端 trim 后都必须非空；码还必须是 lower-kebab-case，否则视为没给原因）。 */
function normalizeReason(reason: WorkBlockReason): WorkBlockReason | undefined {
  const code = reason.code.trim()
  const message = reason.message.trim()
  if (code === '' || message === '') return undefined
  // 与严格解码器**同一条口径**：非 kebab 的码写进去，下次读快照就会 WORK_CORRUPT——
  // 写路径宁可当场拒，也不许亲手造出"写进去读不回来"的记录。
  if (!KEBAB.test(code)) return undefined
  return { code, message }
}

/* -------------------------------------------------------------------------- */
/* 严格解码器（对齐宿主 `decodeGoalChange`）：字段集精确、类型/编码校验，违例即抛。      */

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

function fail(message: string): never {
  throw new WorkError('workprocess 变更流损坏：' + message, 'WORK_CORRUPT')
}

function requireKeys(o: Record<string, unknown>, keys: readonly string[], what: string, optional: readonly string[] = []): void {
  // undefined 值的键按 JSON 语义视为"不存在"（落盘经 JSON 序列化会丢掉它们）。
  const actual = Object.keys(o).filter((k) => o[k] !== undefined)
  for (const k of keys) if (!actual.includes(k)) fail(what + ' 缺字段 ' + k)
  for (const k of actual) if (!keys.includes(k) && !optional.includes(k)) fail(what + ' 多出字段 ' + k)
}

function requireNonEmptyString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(what + ' 必须是非空字符串')
  return v as string
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string') fail(what + ' 必须是字符串')
  return v as string
}

function requirePositiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) fail(what + ' 必须是正整数')
  return v as number
}

function requireFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(what + ' 必须是有限数')
  return v as number
}

function requireStringList(v: unknown, what: string): readonly string[] {
  if (!Array.isArray(v)) fail(what + ' 必须是字符串数组')
  return (v as unknown[]).map((x) => requireString(x, what + '[]'))
}

/** 收口策略解码（严格：不认识的策略值不许读成缺省）。 */
function requireClosePolicy(v: unknown, what: string): 'human' | 'auto' {
  if (!isClosePolicy(v)) fail(what + ' 只认 human / auto：' + String(v))
  return v
}

function decodeReason(raw: unknown, what: string): WorkBlockReason {
  if (typeof raw !== 'object' || raw === null) fail(what + ' 必须是对象')
  const r = raw as Record<string, unknown>
  requireKeys(r, ['code', 'message'], what)
  const code = requireNonEmptyString(r.code, what + '.code')
  if (!KEBAB.test(code)) fail(what + '.code 必须 lower-kebab-case：' + code)
  return { code, message: requireNonEmptyString(r.message, what + '.message') }
}

/** 层2 任务的严格解码（相位枚举、blocked 必带结构化原因、revision 正整数）。 */
export function decodeWorkTask(raw: unknown, stageKey: string): WorkTask {
  if (typeof raw !== 'object' || raw === null) fail('任务不是对象')
  const o = raw as Record<string, unknown>
  requireKeys(o, ['id', 'stageKey', 'objective', 'phase', 'revision'], '任务', ['blockedReason', 'maxRounds'])
  const id = requireNonEmptyString(o.id, '任务 id')
  const owner = requireNonEmptyString(o.stageKey, '任务 stageKey')
  if (owner !== stageKey) fail('任务的 stageKey 与所在阶段不一致（' + owner + ' ≠ ' + stageKey + '）')
  const objective = requireNonEmptyString(o.objective, '任务 objective')
  const phase = o.phase
  if (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete') {
    fail('任务 phase 不认识：' + String(phase))
  }
  const revision = requirePositiveInt(o.revision, '任务 revision')
  const maxRounds = o.maxRounds === undefined ? undefined : requirePositiveInt(o.maxRounds, '任务 maxRounds')
  let blockedReason: WorkBlockReason | undefined
  if (phase === 'blocked') {
    blockedReason = decodeReason(o.blockedReason, '任务 blockedReason')
  } else if (o.blockedReason !== undefined) {
    fail('非 blocked 任务却带 blockedReason')
  }
  return {
    id, stageKey: owner, objective, phase, revision,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
  }
}

/** 层1 阶段的严格解码（态枚举 + 层2 逐条解码 + 阶段内任务 id 不重复）。 */
export function decodeWorkStage(raw: unknown): WorkStage {
  if (typeof raw !== 'object' || raw === null) fail('阶段不是对象')
  const o = raw as Record<string, unknown>
  requireKeys(o, ['key', 'statement', 'doneCriteria', 'state', 'tasks'], '阶段', ['closePolicy'])
  const key = requireNonEmptyString(o.key, '阶段 key')
  const statement = requireNonEmptyString(o.statement, '阶段 statement')
  const doneCriteria = requireStringList(o.doneCriteria, '阶段 doneCriteria')
  const closePolicy = o.closePolicy === undefined
    ? undefined : requireClosePolicy(o.closePolicy, '阶段 closePolicy')
  const state = o.state
  if (state !== 'pending' && state !== 'active' && state !== 'done') fail('阶段 state 不认识：' + String(state))
  if (!Array.isArray(o.tasks)) fail('阶段 tasks 必须是数组')
  const tasks = (o.tasks as unknown[]).map((t) => decodeWorkTask(t, key))
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) fail('阶段内任务 id 重复：' + t.id)
    ids.add(t.id)
  }
  return {
    key, statement, doneCriteria, state, tasks,
    ...(closePolicy === undefined ? {} : { closePolicy }),
  }
}

/**
 * 流程快照的**严格解码**（对齐宿主快照校验）：字段集精确、跨层一致性（任务 id 全局唯一、
 * 阶段键唯一、串行门成立、任务非空则阶段不许已收口）逐条校验。读路径用它把
 * "记录里那份流程坏了"变成**当场响亮**，而不是带着坏快照继续跑。
 */
export function decodeWorkProcess(raw: unknown): WorkProcess {
  if (typeof raw !== 'object' || raw === null) fail('快照不是对象')
  const o = raw as Record<string, unknown>
  requireKeys(o, ['id', 'objective', 'revision', 'stages'], '快照', ['cleared', 'closedAt'])
  const id = requireNonEmptyString(o.id, '快照 id')
  const objective = requireNonEmptyString(o.objective, '快照 objective')
  const revision = requirePositiveInt(o.revision, '快照 revision')
  const closedAt = o.closedAt === undefined ? undefined : requireFiniteNumber(o.closedAt, '快照 closedAt')
  if (!Array.isArray(o.stages)) fail('快照 stages 必须是数组')
  const stages = (o.stages as unknown[]).map(decodeWorkStage)
  const keys = new Set<string>()
  for (const s of stages) {
    if (keys.has(s.key)) fail('阶段键重复：' + s.key)
    keys.add(s.key)
  }
  const seenTaskIds = new Set<string>()
  for (const s of stages) {
    for (const t of s.tasks) {
      if (seenTaskIds.has(t.id)) fail('任务 id 跨阶段重复：' + t.id)
      seenTaskIds.add(t.id)
    }
  }
  const violation = serialViolation(stages)
  if (violation !== undefined) fail(violation)
  let cleared: WorkTaskTombstone[] | undefined
  if (o.cleared !== undefined) {
    if (!Array.isArray(o.cleared)) fail('快照 cleared 必须是数组')
    cleared = (o.cleared as unknown[]).map((raw) => {
      if (typeof raw !== 'object' || raw === null) fail('墓碑不是对象')
      const t = raw as Record<string, unknown>
      requireKeys(t, ['id', 'revision', 'clearedAt'], '墓碑')
      return {
        id: requireNonEmptyString(t.id, '墓碑 id'),
        revision: requirePositiveInt(t.revision, '墓碑 revision'),
        clearedAt: requireFiniteNumber(t.clearedAt, '墓碑 clearedAt'),
      }
    })
    const clearedIds = new Set(cleared.map((t) => t.id))
    for (const id2 of seenTaskIds) {
      if (clearedIds.has(id2)) fail('任务 id 既在表内又在墓碑里：' + id2)
    }
  }
  return {
    id, objective, revision, stages,
    ...(cleared === undefined ? {} : { cleared }),
    ...(closedAt === undefined ? {} : { closedAt }),
  }
}

/** 单条事件的**严格解码**（对齐宿主 `decodeGoalChange`；字段集精确、动词受控）。 */
export function decodeWorkEvent(raw: unknown): WorkEvent {
  if (typeof raw !== 'object' || raw === null) fail('事件不是对象')
  const o = raw as Record<string, unknown>
  const kind = o.kind
  switch (kind) {
    case 'init': {
      requireKeys(o, ['kind', 'id', 'objective', 'stages'], 'init 事件')
      if (!Array.isArray(o.stages)) fail('init.stages 必须是数组')
      return {
        kind: 'init',
        id: requireNonEmptyString(o.id, 'init.id'),
        objective: requireNonEmptyString(o.objective, 'init.objective'),
        stages: (o.stages as unknown[]).map(decodeStageDraft),
      }
    }
    case 'objective-edit': {
      requireKeys(o, ['kind', 'objective'], 'objective-edit 事件')
      return { kind: 'objective-edit', objective: requireNonEmptyString(o.objective, 'objective-edit.objective') }
    }
    case 'process-close': {
      requireKeys(o, ['kind', 'closedAt'], 'process-close 事件')
      return { kind: 'process-close', closedAt: requireFiniteNumber(o.closedAt, 'process-close.closedAt') }
    }
    case 'stage-define': {
      requireKeys(o, ['kind', 'stages'], 'stage-define 事件')
      if (!Array.isArray(o.stages)) fail('stage-define.stages 必须是数组')
      return { kind: 'stage-define', stages: (o.stages as unknown[]).map(decodeStageDraft) }
    }
    case 'stage-start':
    case 'stage-done': {
      requireKeys(o, ['kind', 'stageKey'], kind + ' 事件')
      return { kind, stageKey: requireNonEmptyString(o.stageKey, kind + '.stageKey') }
    }
    case 'task-create': {
      requireKeys(o, ['kind', 'task'], 'task-create 事件')
      if (typeof o.task !== 'object' || o.task === null) fail('task-create.task 必须是对象')
      const t = o.task as Record<string, unknown>
      requireKeys(t, ['id', 'stageKey', 'objective'], 'task-create.task', ['maxRounds'])
      return {
        kind: 'task-create',
        task: {
          id: requireNonEmptyString(t.id, 'task-create.task.id'),
          stageKey: requireNonEmptyString(t.stageKey, 'task-create.task.stageKey'),
          objective: requireNonEmptyString(t.objective, 'task-create.task.objective'),
          ...(t.maxRounds === undefined ? {} : { maxRounds: requirePositiveInt(t.maxRounds, 'task-create.task.maxRounds') }),
        },
      }
    }
    case 'task-edit': {
      requireKeys(o, ['kind', 'taskId'], 'task-edit 事件', ['objective', 'maxRounds'])
      return {
        kind: 'task-edit',
        taskId: requireNonEmptyString(o.taskId, 'task-edit.taskId'),
        ...(o.objective === undefined ? {} : { objective: requireNonEmptyString(o.objective, 'task-edit.objective') }),
        ...(o.maxRounds === undefined ? {} : { maxRounds: requirePositiveInt(o.maxRounds, 'task-edit.maxRounds') }),
      }
    }
    case 'task-pause':
    case 'task-resume':
    case 'task-complete': {
      requireKeys(o, ['kind', 'taskId'], kind + ' 事件')
      return { kind, taskId: requireNonEmptyString(o.taskId, kind + '.taskId') }
    }
    case 'task-block': {
      requireKeys(o, ['kind', 'taskId', 'reason'], 'task-block 事件')
      return {
        kind: 'task-block',
        taskId: requireNonEmptyString(o.taskId, 'task-block.taskId'),
        reason: decodeReason(o.reason, 'task-block.reason'),
      }
    }
    case 'task-clear': {
      requireKeys(o, ['kind', 'taskId', 'clearedAt'], 'task-clear 事件')
      return {
        kind: 'task-clear',
        taskId: requireNonEmptyString(o.taskId, 'task-clear.taskId'),
        clearedAt: requireFiniteNumber(o.clearedAt, 'task-clear.clearedAt'),
      }
    }
    default:
      fail('事件动词不认识：' + String(kind))
  }
}

function decodeStageDraft(raw: unknown): WorkStageDraft {
  if (typeof raw !== 'object' || raw === null) fail('阶段定义不是对象')
  const o = raw as Record<string, unknown>
  requireKeys(o, ['key', 'statement'], '阶段定义', ['doneCriteria', 'closePolicy'])
  return {
    key: requireNonEmptyString(o.key, '阶段定义.key'),
    statement: requireNonEmptyString(o.statement, '阶段定义.statement'),
    ...(o.doneCriteria === undefined ? {} : { doneCriteria: requireStringList(o.doneCriteria, '阶段定义.doneCriteria') }),
    ...(o.closePolicy === undefined ? {} : { closePolicy: requireClosePolicy(o.closePolicy, '阶段定义.closePolicy') }),
  }
}

/** 单条耐久变更的**严格解码**（对齐宿主 `decodeGoalChange`）。 */
export function decodeWorkChange(raw: unknown): WorkChange {
  if (typeof raw !== 'object' || raw === null) fail('变更不是对象')
  const o = raw as Record<string, unknown>
  if (o.kind !== 'work/change') fail('变更 kind 不认识：' + String(o.kind))
  if (o.version !== WORK_CHANGE_VERSION) {
    throw new WorkError(
      'workprocess 变更版本不认识：' + String(o.version) + '（本实现支持 ' + String(WORK_CHANGE_VERSION) + '）',
      'WORK_CORRUPT',
    )
  }
  requireKeys(o, ['kind', 'version', 'event', 'process'], '变更')
  return {
    kind: 'work/change',
    version: WORK_CHANGE_VERSION,
    event: decodeWorkEvent(o.event),
    process: decodeWorkProcess(o.process),
  }
}

/* -------------------------------------------------------------------------- */
/* 迁移链校验（对齐宿主 `applyGoalChange`）：revision 恰好 +1，且用事件重算的快照       */
/* 必须与记录逐字段一致——规则的唯一权威是 `applyWorkEvent`，记录只是它的产物。         */

export function applyWorkChange(prev: WorkProcess | undefined, change: WorkChange): WorkProcess | undefined {
  if (change.event.kind === 'init') {
    if (prev !== undefined) fail('init 之前已有流程（id=' + prev.id + '）')
    if (change.process.revision !== 1) fail('init 的 revision 必须是 1（实际 ' + change.process.revision + '）')
    if (change.process.stages.some((s) => s.state !== 'pending' || s.tasks.length > 0)) {
      fail('init 的初态必须全是 pending 且无任务')
    }
  } else {
    if (prev === undefined) fail(change.event.kind + ' 之前没有流程')
    if (change.process.id !== prev.id) fail('流程身份被改写（' + prev.id + ' → ' + change.process.id + '）')
    if (change.process.revision !== prev.revision + 1) {
      fail('revision 未恰好 +1（' + prev.revision + ' → ' + change.process.revision + '）')
    }
  }
  const r = applyWorkEvent(prev, change.event)
  if (!r.changed || r.next === undefined) {
    fail('迁移不成立（' + change.event.kind + '：' + (r.reason ?? '未知原因') + '）')
  }
  if (!sameProcess(r.next, change.process)) {
    fail('记录的快照与规则重算不一致（' + change.event.kind + '）')
  }
  return change.process
}

/**
 * **严格解码 + 折叠**（对齐宿主 `foldGoal(events)`）：把一串变更折成当前状态，
 * 遇到不认识的版本/动词/身份复用**直接抛**（严格解码器——不静默吞）。
 *
 * 为什么必须严格：变更是"只追加的历史"。宽容解码会把"版本不符"读成"没有变更"，
 * 于是"流程被清掉"与"从来没建过"变得无法区分（本仓"缺失 ≠ 0"的同一条纪律）。
 */
export function foldWorkProcess(changes: readonly WorkChange[]): FoldedWorkProcess {
  let state: WorkProcess | undefined
  for (const change of changes) {
    state = applyWorkChange(state, decodeWorkChange(change))
  }
  return { process: state }
}

/**
 * **非抛出版**折叠（对齐宿主投影的 `failure` 哨兵语义）：遇损坏**保留最后有效值 + 记录失败**，
 * 供读投影/诊断面用；写路径与判据路径仍必须用严格版 `foldWorkProcess`。
 */
export function tryFoldWorkProcess(changes: readonly WorkChange[]): FoldedWorkProcess {
  let state: WorkProcess | undefined
  for (let i = 0; i < changes.length; i += 1) {
    try {
      state = applyWorkChange(state, decodeWorkChange(changes[i]))
    } catch (err) {
      return { process: state, failure: { index: i, message: String((err as Error)?.message ?? err) } }
    }
  }
  return { process: state }
}

/** 折叠态 → 当前流程（对齐宿主 `foldedGoal(state)`；不存在 ⇒ undefined）。 */
export function foldedWorkProcess(state: WorkFoldState): WorkProcess | undefined {
  return state.process
}

/** 层2 任务的**初态**（create 折叠用；id/陈述由调用方给，相位与 revision 由 fold 定）。 */
export function initialTask(draft: WorkTaskDraft): WorkTask {
  return { ...draft, phase: 'active', revision: 1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// 域不变量（原 `src/invariant.ts` 并入）
//
// 【为什么并进 fold】对齐宿主 `dsh-goal`：严格校验沉在**折叠**这一层（宿主的
// `applyGoalEvent` 自己抛），`invariant.ts` 这个名字留给**伴生插件入口**
// （`workprocess/invariant`，形态与 `dsh-goal/lib/invariant.js` 逐字同构）。
//
// INV-1 层2 终态：`complete` 的任务只能原样保留或被 `clear`，不得再被改写；
// INV-2 revision 单调：有效变更恰好 +1（`init` 为 1），无效变更**零变化**（幂等）；
// INV-3 blocked 必带非空结构化原因（code + message）；
// INV-4 身份稳定：流程 id 不变；存活任务的 id / stageKey 不变；`objective` 只由
//       `init`（确立）与 `objective-edit`（人改目标）改写；`closedAt` 只由 `process-close` 写；
// INV-5 **串行门**：任一阶段非 `pending` 时，其前序阶段必须全 `done`（至多一个 active）；
// INV-6 **阶段收口自洽**：阶段 `done` ⇒ 其任务非空且全部 `complete`；
// INV-7 **流程收口自洽**：`closed` ⇒ 全阶段 `done`（与 `processAllowsClose` 同源）。
//
// INV-5~INV-7 是本包相对宿主的**加层纪律**——两层模型里最容易出的错就是
// "阶段态与任务态各说各话"（阶段标了 done 但任务还没完、后一阶段偷跑）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条不变量违反（人话；供测试与诊断面）。 */
export interface WorkInvariantViolation {
  readonly inv: 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4' | 'INV-5' | 'INV-6' | 'INV-7'
  readonly message: string
}

function tasksById(process: WorkProcess | undefined): Map<string, WorkTask> {
  const map = new Map<string, WorkTask>()
  for (const stage of process?.stages ?? []) for (const task of stage.tasks) map.set(task.id, task)
  return map
}

/**
 * 校验一次折叠是否守住不变量。
 *
 * @param prev 折叠前的快照（可能 undefined）
 * @param res 折叠结果
 * @param eventKind 触发事件（`init` 时 `objective` 允许确立；缺省按最严口径）
 */
export function checkWorkInvariants(
  prev: WorkProcess | undefined,
  res: WorkFoldResult,
  eventKind?: WorkEventKind,
): readonly WorkInvariantViolation[] {
  const out: WorkInvariantViolation[] = []
  const next = res.next
  if (!res.changed) {
    // 无效变更必须**零变化**（不得顺手 bump revision）。
    if (prev === undefined) {
      if (next !== undefined) out.push({ inv: 'INV-2', message: '无效变更却产出了流程快照' })
    } else if (next === undefined || !sameProcess(next, prev)) {
      out.push({ inv: 'INV-2', message: '无效变更却改动了快照（幂等被破坏）' })
    }
    return out
  }
  if (next === undefined) {
    out.push({ inv: 'INV-2', message: 'changed:true 却没有快照' })
    return out
  }
  if (prev === undefined) {
    if (next.revision !== 1) out.push({ inv: 'INV-2', message: '建流程的 revision 必须是 1（实际 ' + next.revision + '）' })
    return out
  }
  if (next.revision !== prev.revision + 1) {
    out.push({ inv: 'INV-2', message: 'revision 未恰好 +1（' + prev.revision + ' → ' + next.revision + '）' })
  }
  const before = tasksById(prev)
  const after = tasksById(next)

  if (next.id !== prev.id) out.push({ inv: 'INV-4', message: '流程身份被改写（' + prev.id + ' → ' + next.id + '）' })
  // objective 只能由两个**明说的**动词改写：`init`（确立）与 `objective-edit`（人改目标）。
  // 其余任何事件顺手改 objective 都是规则实现坏了——目标漂移会让"跑的是不是同一件事"无从判定。
  if (eventKind !== 'init' && eventKind !== 'objective-edit' && next.objective !== prev.objective) {
    out.push({ inv: 'INV-4', message: 'objective 被非 init / objective-edit 事件改写（应当稳定）' })
  }
  // closedAt 只能由 `process-close` 写：它是终止水印，任何别的动词顺手改它都是收口语义被架空。
  if (eventKind !== 'process-close' && next.closedAt !== prev.closedAt) {
    out.push({ inv: 'INV-4', message: 'closedAt 被非 process-close 事件改写（终止水印应当稳定）' })
  }

  // INV-1：已完成的任务只能原样保留，或被 clear 掉（不在 after 里）。
  for (const [id, task] of before) {
    if (task.phase !== 'complete') continue
    const kept = after.get(id)
    if (kept !== undefined && !sameTask(task, kept)) {
      out.push({ inv: 'INV-1', message: 'complete 的任务被改写（终态不可逆）：' + id })
    }
  }

  // INV-4：存活任务的身份不被改写（id 在 map 里已稳定，故只查归属跨层漂移）。
  for (const [id, task] of after) {
    const was = before.get(id)
    if (was !== undefined && was.stageKey !== task.stageKey) {
      out.push({ inv: 'INV-4', message: '任务跨阶段漂移（' + id + '：' + was.stageKey + ' → ' + task.stageKey + '）' })
    }
  }

  // INV-3：blocked 必带结构化原因（code 与 message 都非空）。
  for (const [id, task] of after) {
    if (task.phase !== 'blocked') continue
    if (task.blockedReason === undefined
      || task.blockedReason.code.trim() === '' || task.blockedReason.message.trim() === '') {
      out.push({ inv: 'INV-3', message: 'blocked 任务缺结构化原因（code + message）：' + id })
    }
  }

  // INV-5：串行门。
  const gate = serialViolation(next.stages)
  if (gate !== undefined) out.push({ inv: 'INV-5', message: gate })

  // INV-6：阶段收口自洽（done ⇒ 任务非空且全 complete）。
  for (const stage of next.stages) {
    if (stage.state !== 'done') continue
    if (stage.tasks.length === 0 || stage.tasks.some((t) => t.phase !== 'complete')) {
      out.push({ inv: 'INV-6', message: '阶段已收口但任务未全完成：' + stage.key })
    }
  }

  // INV-7：流程收口自洽（closed ⇒ 全阶段 done）。与 fold 的收口判据同源：规则坏了当场响。
  if (next.closedAt !== undefined && !processAllowsClose(next)) {
    out.push({ inv: 'INV-7', message: '流程已收口但阶段未全部 done' })
  }
  return out
}

/**
 * 写路径的**断言版**（生产接线入口）：违反不变量即抛 `WORK_INVARIANT`——
 * 规则实现坏了要当场响，不许把坏状态写进记录。
 */
export function assertWorkInvariants(
  prev: WorkProcess | undefined, res: WorkFoldResult, eventKind?: WorkEventKind,
): void {
  const violations = checkWorkInvariants(prev, res, eventKind)
  if (violations.length > 0) {
    throw new WorkError(
      'workprocess 折叠违反不变量：' + violations.map((v) => v.inv + ' ' + v.message).join('；'),
      'WORK_INVARIANT',
    )
  }
}
