/**
 * workprocess 的**域不变量**（对齐宿主 `@deepseek-ai/dsh-goal/src/invariant.ts`：
 * 宿主用独立折叠校验耐久事件流；本包把同一条纪律做成可单测的纯检查）。
 *
 * 【检查什么】折叠结果必须满足的不变量——违反即"规则实现坏了"，不是业务拒绝：
 *   INV-1 层2 终态：`complete` 的任务只能**原样保留**或被 `clear`，不得再被改写；
 *   INV-2 revision 单调：有效变更恰好 +1（`init` 为 1），无效变更**零变化**（幂等）；
 *   INV-3 blocked 必带非空结构化原因（code + message）；
 *   INV-4 身份稳定：流程 id 不变；存活的阶段键与任务 id / stageKey 不变；
 *         `objective` 只由 `init`（确立）与 `objective-edit`（人改目标）两个动词改写；
 *   INV-5 **串行门**：任一阶段非 `pending` 时，其前序阶段必须全 `done`（至多一个 active）；
 *   INV-6 **阶段收口自洽**：阶段 `done` ⇒ 其任务非空且全部 `complete`。
 *
 * INV-5 / INV-6 是本包相对宿主的**加层纪律**——两层模型里最容易出的错就是
 * "阶段态与任务态各说各话"（阶段标了 done 但任务还没完、后一阶段偷跑）。
 *
 * @module workprocess/invariant
 */
import type { WorkEventKind } from './domain.js'
import { processAllowsClose, sameProcess, sameTask, serialViolation, type WorkFoldResult } from './fold.js'
import { WorkError } from './runtime.js'
import type { WorkProcess, WorkTask } from './types.js'

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
