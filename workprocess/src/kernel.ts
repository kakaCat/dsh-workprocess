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
 *   ③ 阶段收口（`stage-done`）的**授权**由收口策略定（`human` = 只有人能落、agent 只提议；
 *      `auto` = 会话回合 / 驱动器也能落）——本包只管状态规则，不判"谁在调"（那是授权面的事）。
 *
 * @module workprocess/kernel
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
  WorkStageClosePolicy, WorkStageState, WorkTask, WorkTaskDraft, WorkTaskPhase, WorkTaskRef, WorkTaskTombstone,
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
  /**
   * **快照遍历**（`[scope, 记录]` 对）。只有"审计已落盘历史"需要它（不变量伴生插件 / 装载自审）；
   * 省略 = 该 store 不支持遍历（读路径照常，审计降级为空）。
   *
   * 返回 promise：域句柄是**异步解析**的（`open` 之后再 `table()`），同步签名会在
   * "还没人读过表"时遍历到空——装载时自审恰好就是那个时刻（真机踩过）。
   */
  entries?(): Promise<IterableIterator<readonly [string, WorkRecordLike]>>
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
async function emitChanged(deps: WorkDeps, scope: string, event: WorkEvent, process: WorkProcess): Promise<void> {
  await deps.onChanged?.({
    processId: process.id,
    scope,
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
  if (changed && next !== undefined && event !== undefined) await emitChanged(deps, scope, event, next)
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
 * **流程收口**（方案 B 的轻量落点）：全部阶段 done 后落终止水印，记录随之终结。
 * 判据在 fold（`process-close:stages-open`）；幂等：已收口 ⇒ 零写入（`already-closed`）。
 * 收口后一切写被拒（`process-closed`）；重建须先 `discard`。给 `expectedRevision` 时旧值即拒。
 */
export async function closeWorkProcess(
  deps: WorkDeps, scope: string, expectedRevision?: number,
): Promise<boolean> {
  return mutateWork(deps, scope, () => ({ kind: 'process-close', closedAt: deps.now() }), expectedRevision)
}

/**
 * **改流程目标**（对齐宿主 `update_goal` 的 `edit`；授权面把它判成**真人专属**）。
 *
 * 为什么它是状态动作而不是"丢弃重来"：丢弃会连着任务与墓碑一起没（历史被抹掉），
 * 而改目标只是把"这条流程现在要达成什么"换掉——阶段与任务该保留就保留。
 * 幂等：同值重放零写入；给 `expectedRevision` 时旧值即拒（CAS 同款）。
 */
export async function editWorkObjective(
  deps: WorkDeps, scope: string, objective: string, expectedRevision?: number,
): Promise<boolean> {
  if (objective.trim() === '') {
    throw new WorkError('改目标需要非空 objective（写清这条流程现在要达成什么）', 'WORK_OBJECTIVE_REQUIRED')
  }
  return mutateWork(deps, scope, () => ({ kind: 'objective-edit', objective }), expectedRevision)
}

/**
 * 设置**续跑许可**（`rounds.activation`，耐久）——goal 那套 arm/disarm 的落点。
 *
 * 【为什么在记录里而不在流程快照里】许可不是"这条流程是什么样"，而是"此刻允不允许它自己往下跑"：
 * 它不进事件表、不发 `work/changed`（与 `rounds.started` 同类：控制面读数，不是领域值）。
 *
 * 【谁来写】驱动器在会话 `resume`（宿主重启后加载）时落 `disarmed`；真人（或其指令下的模型）
 * 用 `update_workstage action=arm|disarm` 改。没有流程 ⇒ 零写入 `false`（没有可授权的对象）。
 * 幂等：同值零写入。
 */
export async function setWorkActivation(
  deps: WorkDeps, scope: string, activation: WorkActivation, expectedRevision?: number,
): Promise<boolean> {
  if (expectedRevision !== undefined) {
    const current = await deps.store.get(scope)
    assertRevision(decodeExisting(current?.workProcess), expectedRevision)
  }
  let changed = false
  await deps.store.mutate(scope, (r) => {
    const prev = decodeExisting(r.workProcess)
    if (prev === undefined) return undefined
    if ((r.rounds?.activation ?? 'armed') === activation) return undefined
    r.rounds = { ...r.rounds, activation }
    r.updatedAt = deps.now()
    changed = true
    return { changed: true }
  })
  return changed
}

/** 读**续跑许可**（缺省 `armed`，与 `workProcessViewOf` 的派生同源）；没有流程 ⇒ `undefined`。 */
export async function workActivationOf(deps: WorkDeps, scope: string): Promise<WorkActivation | undefined> {
  const record = await deps.store.get(scope)
  if (decodeExisting(record?.workProcess) === undefined) return undefined
  return record?.rounds?.activation ?? 'armed'
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
 * **丢弃流程**（连根拔掉，不是状态迁移）。幂等：没有流程 ⇒ 零写入。
 *
 * 【为什么不经事件表】事件表描述"聚合怎么变"，而这条是把聚合**整个摘掉**——没有"变更后的快照"
 * （`WorkChange` 必带快照），硬塞进事件流会让"记录 = 事件重算"那条不变量自相矛盾。
 * 故它是**服务层动作**：状态规则仍只有一份（事件表管迁移，本函数管摘除）。
 *
 * 语义：流程没了（再建是 revision 1 的**新**流程）、回合计数归零、任务墓碑一并消失
 * （那不是"清一个任务"，是整条流程不再存在）。给 `expectedRevision` 时旧值即拒（CAS 同款）。
 */
export async function discardWorkProcess(
  deps: WorkDeps, scope: string, expectedRevision?: number,
): Promise<boolean> {
  if (expectedRevision !== undefined) {
    const current = await deps.store.get(scope)
    assertRevision(decodeExisting(current?.workProcess), expectedRevision)
  }
  let changed = false
  await deps.store.mutate(scope, (r) => {
    const prev = decodeExisting(r.workProcess)
    if (prev === undefined) return undefined
    delete r.workProcess
    if (r.rounds !== undefined) r.rounds = { ...r.rounds, started: 0 }
    r.updatedAt = deps.now()
    changed = true
    return { changed: true }
  })
  return changed
}

/**
 * 阶段收口（本阶段任务须非空且全 complete）。幂等：已 done ⇒ 零写入。
 *
 * 这里不判"谁在调"：`human` 策略下由授权面（工具面 / 驱动器）拦 agent 自写，`auto` 策略下放行——
 * 内核只落状态，授权是调用方的事。
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
