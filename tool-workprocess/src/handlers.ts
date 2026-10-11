/**
 * workprocess 工具的**处理器**（协议无关：只吃参数对象 + deps，回执也是普通对象）。
 *
 * 【命名与形状对齐宿主 dsh】六个处理器 = 两层 × { get / create / update }，
 * 状态变更**收进 `update` 的 `action`**（对齐宿主 `update_goal` 的 `action` 枚举），
 * 不再为单个动词各开一个工具。
 *
 * 【为什么处理器与工具壳分开】`defineTool` 外壳只做 schema/渲染；判据与状态规则全在内核
 * （`workprocess`）。把编排放这里的好处：**不需要宿主即可穷举单测**。
 *
 * 【错误口径】内核抛 `WorkError`（结构化码）→ 这里如实转成 `{ success:false, code, error }`，
 * **不吞不编**；非 WorkError 继续冒泡（那是缺陷，不是业务拒绝）。
 *
 * @module tool-workprocess/handlers
 */
import {
  WorkError, allTasksOf, applyWorkEvent, blockWorkTask, clearWorkTask, completeWorkStage, completeWorkTask,
  createWorkProcess, createWorkTask, currentStageOf, defineWorkStages, editWorkTask, pauseWorkTask,
  processAllowsClose, resumeWorkTask, stageAllowsStart, stageIsFinishable, workProcessOf,
} from 'workprocess'
import type { WorkStageDraft, WorkStoreLike, WorkTask } from 'workprocess'
import {
  requireActionAuthority, workToolExecution,
  type WorkAuthorityAction, type WorkRoundRef, type WorkToolAuthority,
} from './authority.js'

/** 组合根可注入的依赖（`store` = 归属记录端口；判据钩子见 `authority.ts`）。 */
export interface WorkToolDeps {
  /** 归属记录的读写通道（本面只碰 `workProcess` 字段）。 */
  readonly store: WorkStoreLike
  /** 时间源（本包不读系统时钟）。 */
  readonly now: () => number
  /** 本回合授权判定（给了就按它判；缺省 = 保守的 autonomous）。 */
  readonly resolveAuthority?: (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined
  /** 调用者存活校验（缺省 = 不校验）。 */
  readonly verifyCaller?: (exec: unknown) => { readonly ok: boolean; readonly reason?: string }
}

/** 工具回执（普通对象；`success:false` 时带 `code`/`error`）。 */
export type WorkToolReply = Record<string, unknown>

/** 归属域键解析（`scope`：这条流程挂在谁名下——由组合根注入或调用方显式给）。 */
function scopeOf(args: Record<string, unknown>): string | undefined {
  const raw = args.scope
  return raw === undefined ? undefined : String(raw)
}

/** 调用者存活（缺省不校验；接线后由宿主 agents 句柄给判据）。 */
function callerRejection(deps: WorkToolDeps, exec: unknown): string | undefined {
  const verdict = deps.verifyCaller?.(exec)
  if (verdict === undefined || verdict.ok) return undefined
  return verdict.reason ?? 'workprocess 工具要求调用者是当前正在运行的 agent'
}

/** 本回合授权：缺省 autonomous（未接线）；接线后 `undefined` = 无授权。 */
function authorityOf(deps: WorkToolDeps, exec: unknown, expected?: WorkRoundRef): WorkToolAuthority {
  if (deps.resolveAuthority === undefined) return { kind: 'autonomous' }
  return workToolExecution(exec, deps.resolveAuthority, expected).authority
}

/** 授权门（唯一一份在 `authority.ts`）。 */
function authorize(action: WorkAuthorityAction, authority: WorkToolAuthority): void {
  requireActionAuthority(action, authority)
}

/** 内核错误 → 结构化回执（不吞不编）。 */
async function guarded(fn: () => Promise<WorkToolReply>): Promise<WorkToolReply> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorkError) return { success: false, code: err.code, error: err.message }
    throw err
  }
}

/** 阶段表参数解析（非法即返回人话原因）。 */
function parseStages(args: Record<string, unknown>): readonly WorkStageDraft[] | string {
  const raw = args.stages
  if (!Array.isArray(raw) || raw.length === 0) return 'stages 必填（至少一个阶段：{ key, statement, done_criteria? }）'
  const out: WorkStageDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'stages 里每一项都必须是对象'
    const o = item as Record<string, unknown>
    const key = o.key === undefined ? '' : String(o.key)
    const statement = o.statement === undefined ? '' : String(o.statement)
    if (key.trim() === '' || statement.trim() === '') return '每个阶段都要有非空 key 与 statement'
    out.push({
      key, statement,
      ...(Array.isArray(o.done_criteria) ? { doneCriteria: o.done_criteria.map((c) => String(c)) } : {}),
    })
  }
  return out
}

/** 层2 的对外投影（相位 / 陈述 / revision / 阻塞原因）。 */
function taskView(task: WorkTask): Record<string, unknown> {
  return {
    id: task.id,
    stage_key: task.stageKey,
    objective: task.objective,
    phase: task.phase,
    revision: task.revision,
    ...(task.blockedReason === undefined ? {} : { blocked_reason: task.blockedReason.code, blocked_message: task.blockedReason.message }),
    ...(task.maxRounds === undefined ? {} : { max_rounds: task.maxRounds }),
  }
}

/** block 的原因码必须 lower-kebab-case（与严格解码器同一条口径）。 */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/* -------------------------------------------------------------------------- */
/* 层1：get / create / update（update 只含 done——开工是驱动器的动作）              */

/**
 * `get_workstage`：读阶段表（顺序即串行顺序）+ 当前阶段 + 串行门 + 收口条件。
 * 无流程不是错误值而是**明说的缺失**（缺失 ≠ 空表）。
 */
export async function getWorkstage(deps: WorkToolDeps, args: Record<string, unknown>): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const process = await workProcessOf(deps, scope)
  if (process === undefined) {
    return { success: false, scope, error: '该归属域还没有流程（先调 create_workstage 建流程）' }
  }
  // 当前阶段 = 串行顺序里第一个非 done 的阶段（口径在 stages.js 单点，工具面不自己找）。
  const current = currentStageOf(process)
  return {
    success: true,
    scope,
    process_id: process.id,
    objective: process.objective,
    revision: process.revision,
    stages: process.stages.map((s) => ({
      key: s.key, statement: s.statement, state: s.state, done_criteria: s.doneCriteria,
      tasks: s.tasks.length, tasks_done: s.tasks.filter((t) => t.phase === 'complete').length,
    })),
    current_stage: current?.key ?? null,
    /** 串行门读数：当前阶段 pending 且前序阶段全 done ⇒ 可开工。 */
    allows_start: current !== undefined && stageAllowsStart(process, current.key),
    allows_close: processAllowsClose(process),
  }
}

/**
 * `create_workstage`：没有流程 → 建流程（带阶段表，`objective` 必填）；
 * 已有流程 → 整体替换阶段表（同名阶段保留任务与态；会丢掉非空阶段的一律被内核拒）。
 */
export async function createWorkstage(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const stages = parseStages(args)
  if (typeof stages === 'string') return { success: false, scope, error: stages }
  const objective = args.objective === undefined ? '' : String(args.objective)
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    const existing = await workProcessOf(deps, scope)
    if (existing === undefined) {
      if (objective.trim() === '') {
        return { success: false, scope, error: '建流程需要 objective（写清这条流程要达成什么）' }
      }
      const changed = await createWorkProcess(deps, scope, { objective, stages })
      return { success: true, scope, created: true, changed }
    }
    // 先干跑一次拿到**内核给的原因**（规则的唯一权威在 fold，本层不另写一份判据）：
    // `changed:false` 的幂等重放与"会被拒"（丢非空阶段 / 串行门被破）在回执里必须分得清。
    const dry = applyWorkEvent(existing, { kind: 'stage-define', stages })
    if (!dry.changed) return { success: true, scope, created: false, changed: false, reason: dry.reason }
    const changed = await defineWorkStages(deps, scope, stages, revision)
    return { success: true, scope, created: false, changed }
  })
}

/** `update_workstage` 认的动词（**只有 done**：阶段开工是驱动器的动作，不经工具面）。 */
const STAGE_ACTIONS = ['done'] as const

/**
 * `update_workstage`：阶段态变更（对齐宿主 `update_goal` 的 `action` 形状）。
 *
 * 当前只有一个动词 `done` = **人工确认**（真人专属）；内核仍会复核
 * "本阶段任务非空且全 complete"，此处的授权拒绝只是第一道。
 */
export async function updateWorkstage(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const stageKey = args.stage_key === undefined ? '' : String(args.stage_key)
  if (stageKey.trim() === '') return { success: false, scope, error: '缺少 stage_key（更新哪个阶段）' }
  const action = String(args.action ?? '')
  if (!(STAGE_ACTIONS as readonly string[]).includes(action)) {
    return {
      success: false, scope, stage_key: stageKey, action,
      error: 'action 非法（只认 ' + STAGE_ACTIONS.join(' / ') + '；**阶段开工是驱动器的动作**——'
        + '串行门放行后由驱动器开工，不经工具面。实际给的是 ' + JSON.stringify(action) + '）',
    }
  }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    authorize('stage_done', authorityOf(deps, exec))
    // 收口条件用内核判据先说清楚（`changed:false` 不能只有"没变"三个字）。
    const process = await workProcessOf(deps, scope)
    const stage = process?.stages.find((s) => s.key === stageKey)
    if (stage === undefined) return { success: false, scope, stage_key: stageKey, error: '阶段不存在' }
    if (stage.state !== 'active') {
      return { success: true, scope, stage_key: stageKey, action, changed: false, reason: '阶段不是 active（当前 ' + stage.state + '）' }
    }
    if (!stageIsFinishable(stage)) {
      return { success: true, scope, stage_key: stageKey, action, changed: false, reason: '本阶段任务未全部 complete（缺失 ≠ 达成）' }
    }
    const changed = await completeWorkStage(deps, scope, stageKey, revision)
    return { success: true, scope, stage_key: stageKey, action, changed }
  })
}

/* -------------------------------------------------------------------------- */
/* 层2：get / create / update                                                      */

/** `get_worktask`：读任务（给 task_id 读一条；给 stage_key 读一阶段；都不给读全部）。 */
export async function getWorktask(deps: WorkToolDeps, args: Record<string, unknown>): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const process = await workProcessOf(deps, scope)
  if (process === undefined) return { success: false, scope, error: '该归属域还没有流程' }
  const taskId = args.task_id === undefined ? undefined : String(args.task_id)
  const stageKey = args.stage_key === undefined ? undefined : String(args.stage_key)
  let tasks: readonly WorkTask[]
  if (taskId !== undefined) {
    tasks = allTasksOf(process).filter((t) => t.id === taskId)
    if (tasks.length === 0) return { success: false, scope, task_id: taskId, error: '任务不存在（可能已被 clear）' }
  } else if (stageKey !== undefined) {
    const stage = process.stages.find((s) => s.key === stageKey)
    if (stage === undefined) return { success: false, scope, stage_key: stageKey, error: '阶段不存在' }
    tasks = stage.tasks
  } else {
    tasks = allTasksOf(process)
  }
  return { success: true, scope, process_id: process.id, revision: process.revision, tasks: tasks.map(taskView) }
}

/** `create_worktask`：在某阶段建任务（身份由内核分配，清掉的不复用）。 */
export async function createWorktask(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const stageKey = args.stage_key === undefined ? '' : String(args.stage_key)
  if (stageKey.trim() === '') return { success: false, scope, error: '缺少 stage_key（任务挂在哪个阶段下）' }
  const objective = args.objective === undefined ? '' : String(args.objective)
  if (objective.trim() === '') return { success: false, scope, error: 'objective 必填：写清这个工作单元要达成什么' }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const maxRounds = typeof args.max_rounds === 'number' ? args.max_rounds : undefined
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    const changed = await createWorkTask(deps, scope, {
      stageKey, objective, ...(maxRounds === undefined ? {} : { maxRounds }),
    }, revision)
    // 回执带上新任务的 id（调用方下一句就要用它，不该再去猜编号）。
    const process = await workProcessOf(deps, scope)
    const stage = process?.stages.find((s) => s.key === stageKey)
    const created = stage === undefined ? undefined : stage.tasks[stage.tasks.length - 1]
    return {
      success: true, scope, stage_key: stageKey, changed,
      ...(changed && created !== undefined ? { task_id: created.id, revision: created.revision } : {}),
    }
  })
}

/** `update_worktask` 认的动词（对齐宿主 `update_goal` 的 `action`，另加本包的 `clear`）。 */
const TASK_ACTIONS = ['edit', 'pause', 'resume', 'block', 'complete', 'clear'] as const
type TaskAction = (typeof TASK_ACTIONS)[number]

/**
 * `update_worktask`：任务态变更（一个工具 + `action`，对齐宿主 `update_goal`）。
 *   · `edit` / `resume` = **真人专属**（改目标 / 继续——同宿主口径）；
 *   · `block` 必须给原因（`reason` + 可选 `reason_code`，缺省 `blocked`）；
 *   · `clear` 是本包加项（撤掉误建的工作单元，编号不复用）。
 */
export async function updateWorktask(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下）' }
  const taskId = args.task_id === undefined ? '' : String(args.task_id)
  if (taskId.trim() === '') return { success: false, scope, error: '缺少 task_id' }
  const action = String(args.action ?? '')
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) {
    return {
      success: false, scope, action,
      error: 'action 非法（只认 ' + TASK_ACTIONS.join(' / ') + '；实际给的是 ' + JSON.stringify(action) + '）',
    }
  }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  const reason = args.reason === undefined ? '' : String(args.reason)
  const reasonCode = args.reason_code === undefined ? 'blocked' : String(args.reason_code)
  const objective = args.objective === undefined ? '' : String(args.objective)
  const maxRounds = typeof args.max_rounds === 'number' ? args.max_rounds : undefined
  return guarded(async () => {
    const act = action as TaskAction
    const base = { scope, task_id: taskId, action: act }
    if (act === 'edit' && objective.trim() === '' && maxRounds === undefined) {
      return { ...base, success: false, error: 'edit 至少要给一项（objective / max_rounds）' }
    }
    if (act === 'block' && reason.trim() === '') {
      return { ...base, success: false, error: 'block 必须给原因（reason）：被什么挡住、等谁' }
    }
    if (act === 'block' && !KEBAB.test(reasonCode)) {
      return { ...base, success: false, error: 'reason_code 必须是 lower-kebab-case（如 wait-human）' }
    }
    authorize(('task_' + act) as WorkAuthorityAction, authorityOf(deps, exec))
    const changed = act === 'edit'
      ? await editWorkTask(deps, scope, taskId, {
        ...(objective.trim() === '' ? {} : { objective }),
        ...(maxRounds === undefined ? {} : { maxRounds }),
      }, revision)
      : act === 'pause' ? await pauseWorkTask(deps, scope, taskId, revision)
        : act === 'resume' ? await resumeWorkTask(deps, scope, taskId, revision)
          : act === 'complete' ? await completeWorkTask(deps, scope, taskId, revision)
            : act === 'clear' ? await clearWorkTask(deps, scope, taskId, revision)
              : await blockWorkTask(deps, scope, taskId, { code: reasonCode, message: reason }, revision)
    return { ...base, success: true, changed }
  })
}
