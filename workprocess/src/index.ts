/**
 * workprocess 服务本体（对齐宿主 `@deepseek-ai/dsh-goal/src/index.ts`：宿主在该文件装配服务，
 * 这里装配流程读写；区别是宿主用 cordis 注入，本包用**结构化端口契约**注入）。
 *
 * 分层：`types`（纯类型）→ `domain`（事件词汇）→ `fold`（纯折叠/判据）→ `runtime`（构造器/常量）
 * → `invariant`（不变量）→ 本文件（I/O 编排 + 幂等 + 身份分配）。
 *
 * 【流程挂在哪】一个**归属对象**（scope）一条当前 `WorkProcess`（挂该对象的记录字段 `workProcess`）——
 * 与宿主"一会话一 goal"同构，只是归属键由调用方给。**两层的写共用同一个 CAS revision**：
 * 阶段开工要读前序阶段的任务态，任务完成要改所属阶段的可收口性，分开两个版本号必然打架。
 *
 * 【三条纪律】
 *   ① 写一律经 `applyWorkEvent` 纯函数——本文件不自己拼状态；
 *   ② 幂等：纯函数说 `changed:false` → 本文件零写入（不写盘、不 bump revision）；
 *   ③ 阶段收口（`stage-done`）**只允许人工确认路径调用**（agent 自写 = 越权）。
 *
 * @module workprocess
 */
import {
  allTasksOf, applyWorkEvent, clearedTaskIdsOf, decodeWorkProcess, workProgressOf,
} from './fold.js'
import { assertWorkInvariants } from './invariant.js'
import { WORK_CHANGE_VERSION, WorkError, WorkProcessId, WorkTaskId } from './runtime.js'
import type { WorkChangedNotification, WorkEvent } from './domain.js'
import type {
  CreateWorkProcessRequest, CreateWorkTaskRequest, EditWorkTaskRequest, WorkActivation, WorkBlockReason,
  WorkProcess, WorkProcessView, WorkProgress, WorkStage, WorkStageDraft, WorkTask, WorkTaskPhase,
} from './types.js'

// 选择性再导出（对齐宿主 index 的做法）：types 的 `WorkProcessId` / `WorkTaskId`（类型）与
// runtime 的同名构造器会撞——类型改以 `…Type` 露出。
export type {
  WorkActivation, WorkBlockReason, WorkProcess, WorkProcessView, WorkProgress, WorkStage, WorkStageDraft,
  WorkStageState, WorkTask, WorkTaskDraft, WorkTaskPhase, WorkTaskRef, WorkTaskTombstone,
  CreateWorkProcessRequest, CreateWorkTaskRequest, EditWorkTaskRequest,
  WorkProcessId as WorkProcessIdType, WorkTaskId as WorkTaskIdType,
} from './types.js'
export type {
  WorkChange, WorkChangedNotification, WorkEvent, WorkEventKind, WorkMessageSource, WorkOperation,
  WorkProcessOperation, WorkRejection, WorkTaskOperation,
} from './domain.js'
export * from './fold.js'
export * from './runtime.js'
export * from './invariant.js'
// 阶段表投影（当前阶段 / 串行顺序 / 串行门前半）：驱动与工具面读的同一份判据。
export * from './stages.js'

/** 归属记录的**最小读取面**（组合根注入的 store 返回它）。 */
export interface WorkRecordLike {
  /** **当前流程**（一个归属对象至多一条；缺失 = 未启用 workprocess 能力）。 */
  workProcess?: WorkProcess
  updatedAt?: number
  /** 回合事实（已准入回合数 + 进程内续跑许可）：**真相在归属记录**，本包只做派生读。 */
  rounds?: { started?: number; activation?: WorkActivation }
}

/** store 读写通道（`mutate` 返回 `changed`；幂等判据以它为准）。 */
export interface WorkStoreLike {
  get(scope: string): Promise<WorkRecordLike | undefined>
  mutate(
    scope: string,
    fn: (draft: WorkRecordLike) => unknown,
  ): Promise<{ readonly changed?: boolean }>
}

/** 服务依赖（对齐宿主服务构造期注入的 ctx 面）。 */
export interface WorkDeps {
  store: WorkStoreLike
  /** 时间源由调用方注入（本包不读系统时钟）。 */
  now: () => number
  /**
   * `work/changed` 通知口（对齐宿主 cordis 事件；缺省 = 无监听器）。
   * 每次**有效写入**后调用（`changed:false` 的幂等重放不发）。
   * 监听器抛错会**冒泡**给调用方（写入已落盘；监听故障不许静默——监听方必须自己健壮）。
   */
  onChanged?: (notification: WorkChangedNotification) => void | Promise<void>
}

/**
 * CAS 校验（对齐宿主 `goalRef(goal_id, revision)` 的乐观锁）：
 * 调用方给了期望 revision 就必须对上——对不上说明**它是照着旧快照在改**，必须拒。
 */
function assertRevision(current: WorkProcess | undefined, expected?: number): void {
  if (expected === undefined) return
  if (current === undefined) throw new WorkError('流程不存在，无法按 revision 更新', 'WORK_NOT_FOUND')
  if (current.revision !== expected) {
    throw new WorkError(
      '流程已被别处改过（期望 revision=' + expected + '，当前=' + current.revision + '）——请先 get 再改',
      'WORK_CONFLICT',
    )
  }
}

/** 记录里那份快照的严格解码（坏了当场响，不带着坏快照继续改）。 */
function decodeExisting(raw: WorkProcess | undefined): WorkProcess | undefined {
  return raw === undefined ? undefined : decodeWorkProcess(raw)
}

/**
 * 有效写入后的变更通知（载荷与耐久状态同源：事件 + 全量快照），
 * 形状对齐宿主 `GoalSnapshotChangeMeta`，使监听器可以把它直接喂给 `foldWorkProcess` 重放校验。
 */
async function emitChanged(deps: WorkDeps, event: WorkEvent, process: WorkProcess): Promise<void> {
  await deps.onChanged?.({
    processId: process.id,
    change: { kind: 'work/change', version: WORK_CHANGE_VERSION, event, process },
  })
}

/**
 * 两层的**公共写路径**：CAS 前置 → 严格解码 → 事件折叠 → 不变量 → 幂等 → 通知。
 *
 * `buildEvent` 在拿到当前快照后才构造事件（任务身份 `wt:<stage>:<seq>` 要按现有任务与墓碑分配）；
 * 它可以抛 `WorkError`（如"还没有流程"）——写前拒，不落半份状态。
 */
async function mutateWork(
  deps: WorkDeps, scope: string,
  buildEvent: (prev: WorkProcess | undefined) => WorkEvent,
  expectedRevision?: number,
): Promise<boolean> {
  // CAS 在 mutate **之前**校验（写前拒，而不是写完再回滚）。
  if (expectedRevision !== undefined) {
    const current = await deps.store.get(scope)
    assertRevision(decodeExisting(current?.workProcess), expectedRevision)
  }
  let changed = false
  let next: WorkProcess | undefined
  let event: WorkEvent | undefined
  await deps.store.mutate(scope, (r) => {
    // 写前严格解码既有快照：记录损坏当场抛 WORK_CORRUPT，零写入。
    const prev = decodeExisting(r.workProcess)
    const ev = buildEvent(prev)
    const result = applyWorkEvent(prev, ev)
    // 不变量接线（对齐宿主不变量伴生插件）：折叠违反 INV-1~6 → 抛 WORK_INVARIANT，零写入。
    assertWorkInvariants(prev, result, ev.kind)
    if (!result.changed || result.next === undefined) return undefined
    r.workProcess = result.next
    r.updatedAt = deps.now()
    changed = true
    next = result.next
    event = ev
    return { changed: true }
  })
  if (changed && next !== undefined && event !== undefined) await emitChanged(deps, event, next)
  return changed
}

/**
 * 建流程（这段流程要达成什么 + 它的阶段表）。
 * 幂等：同 id 同陈述同阶段表重放零写入（`applyWorkEvent` 的 init 幂等分支）。
 */
export async function createWorkProcess(
  deps: WorkDeps, scope: string, request: CreateWorkProcessRequest,
): Promise<boolean> {
  if (request.objective.trim() === '') {
    throw new WorkError('建流程需要非空 objective（写清这条流程要达成什么）', 'WORK_OBJECTIVE_REQUIRED')
  }
  return mutateWork(deps, scope, () => ({
    kind: 'init', id: WorkProcessId(scope), objective: request.objective, stages: request.stages,
  }))
}

/**
 * 整体替换阶段表（同名阶段保留其任务与态；会被丢掉的非空阶段一律拒）。
 * 幂等：同值零写入。
 */
export async function defineWorkStages(
  deps: WorkDeps, scope: string, stages: readonly WorkStageDraft[], expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'stage-define', stages }), expectedRevision)
}

/** 阶段开工（串行门：前序阶段必须全 done）。幂等：已非 pending ⇒ 零写入。 */
export async function startWorkStage(
  deps: WorkDeps, scope: string, stageKey: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'stage-start', stageKey }), expectedRevision)
}

/**
 * 阶段收口（**人工确认路径专属**：本阶段任务须非空且全 complete）。幂等：已 done ⇒ 零写入。
 */
export async function completeWorkStage(
  deps: WorkDeps, scope: string, stageKey: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'stage-done', stageKey }), expectedRevision)
}

/**
 * 任务身份分配：`wt:<stageKey>:<seq>`，`seq` = 该阶段**历史上**（含墓碑）用过的最大编号 + 1。
 * 清掉的身份不复用——否则重建会伪装成"从未有过这个任务"。
 */
function nextTaskSeq(process: WorkProcess, stageKey: string): number {
  const prefix = 'wt:' + stageKey + ':'
  const seqs = [...allTasksOf(process).map((t) => t.id), ...clearedTaskIdsOf(process)]
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
  return (seqs.length === 0 ? 0 : Math.max(...seqs)) + 1
}

/** 建任务（层2）：id 由服务分配，相位与 revision 由 fold 定（初态 `active`/1）。 */
export async function createWorkTask(
  deps: WorkDeps, scope: string, request: CreateWorkTaskRequest, expectedRevision?: number,
): Promise<boolean> {
  if (request.objective.trim() === '') {
    throw new WorkError('建任务需要非空 objective（写清这个工作单元要达成什么）', 'WORK_OBJECTIVE_REQUIRED')
  }
  return mutateWork(deps, scope, (prev) => {
    if (prev === undefined) throw new WorkError('该归属域还没有流程（先 createWorkProcess）', 'WORK_NO_PROCESS')
    return {
      kind: 'task-create',
      task: {
        id: WorkTaskId(request.stageKey, nextTaskSeq(prev, request.stageKey)),
        stageKey: request.stageKey,
        objective: request.objective,
        ...(request.maxRounds === undefined ? {} : { maxRounds: request.maxRounds }),
      },
    }
  }, expectedRevision)
}

/** 改任务（换陈述 / 换回合上限，至少一项）。幂等：同值零写入。 */
export async function editWorkTask(
  deps: WorkDeps, scope: string, taskId: string, edit: EditWorkTaskRequest, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({
    kind: 'task-edit', taskId,
    ...(edit.objective === undefined ? {} : { objective: edit.objective }),
    ...(edit.maxRounds === undefined ? {} : { maxRounds: edit.maxRounds }),
  }), expectedRevision)
}

/** 暂停任务（active → paused）。 */
export async function pauseWorkTask(
  deps: WorkDeps, scope: string, taskId: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'task-pause', taskId }), expectedRevision)
}

/** 继续任务（paused / blocked → active）。 */
export async function resumeWorkTask(
  deps: WorkDeps, scope: string, taskId: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'task-resume', taskId }), expectedRevision)
}

/** 阻塞任务（必须给结构化原因）。 */
export async function blockWorkTask(
  deps: WorkDeps, scope: string, taskId: string, reason: WorkBlockReason, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'task-block', taskId, reason }), expectedRevision)
}

/** 达成任务（终态，不可逆；重开 = 新建任务）。 */
export async function completeWorkTask(
  deps: WorkDeps, scope: string, taskId: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'task-complete', taskId }), expectedRevision)
}

/** 清任务（摘掉且编号不复用；墓碑留在流程快照里）。 */
export async function clearWorkTask(
  deps: WorkDeps, scope: string, taskId: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'task-clear', taskId, clearedAt: deps.now() }), expectedRevision)
}

/** 当前流程读（不存在 / 未启用 ⇒ undefined；缺失 ≠ 未开始）。 */
export async function workProcessOf(
  deps: Pick<WorkDeps, 'store'>, scope: string,
): Promise<WorkProcess | undefined> {
  const record = await deps.store.get(scope)
  const process = record?.workProcess
  return process === undefined ? undefined : decodeWorkProcess(process)
}

/** 某阶段读（无 ⇒ undefined）。 */
export async function workStageOf(
  deps: Pick<WorkDeps, 'store'>, scope: string, stageKey: string,
): Promise<WorkStage | undefined> {
  return (await workProcessOf(deps, scope))?.stages.find((s) => s.key === stageKey)
}

/** 某任务读（无 ⇒ undefined）。 */
export async function workTaskOf(
  deps: Pick<WorkDeps, 'store'>, scope: string, taskId: string,
): Promise<WorkTask | undefined> {
  const process = await workProcessOf(deps, scope)
  if (process === undefined) return undefined
  return allTasksOf(process).find((t) => t.id === taskId)
}

/**
 * 层2 相位读（驱动的 `taskAllowsRound` 判据实现）。
 * 无流程 / 无该任务 ⇒ `undefined` = 未启用 → 驱动放行（缺失语义）。
 */
export async function workTaskPhaseOf(
  deps: Pick<WorkDeps, 'store'>, scope: string, taskId: string,
): Promise<WorkTaskPhase | undefined> {
  return (await workTaskOf(deps, scope, taskId))?.phase
}

/** 有界进度投影（未启用 ⇒ undefined；缺失 ≠ 0/0）。 */
export async function progressOf(
  deps: Pick<WorkDeps, 'store'>, scope: string,
): Promise<WorkProgress | undefined> {
  const process = await workProcessOf(deps, scope)
  return process === undefined ? undefined : workProgressOf(process)
}

/**
 * 聚合视图（对齐宿主 `GoalView`）：快照 + **派生只读**的计数与许可。
 * 回合数与许可都来自归属记录（`WorkRecordLike.rounds`）：本包**不另存**第二份。
 */
export async function workProcessViewOf(
  deps: WorkDeps, scope: string,
): Promise<WorkProcessView | undefined> {
  const process = await workProcessOf(deps, scope)
  if (process === undefined) return undefined
  const record = await deps.store.get(scope)
  return {
    process,
    roundsStarted: record?.rounds?.started ?? 0,
    activation: record?.rounds?.activation ?? 'armed',
  }
}
