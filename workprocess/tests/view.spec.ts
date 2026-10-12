/**
 * 只读线投影 `workWireOf` 的**字段契约测试**。
 *
 * 【守护什么】浏览器数据面（HTTP/SSE）与工具面（`get_workstage` / `get_worktask`）吃同一份字段——
 * 本测试把字段名钉成精确 key 集（逐字来自 `tool-workprocess/src/tools.ts` 的 `getWorkstage` /
 * `taskView` 回执），任何一边改名都会在这里红掉。
 */
import { describe, it, expect } from 'vitest'
import {
  blockWorkTask, closeWorkProcess, completeWorkStage, completeWorkTask, createWorkProcess, createWorkTask,
  startWorkStage, workProcessOf, workWireOf,
} from 'workprocess'
import type { WorkDeps, WorkProcess, WorkRecordLike, WorkStoreLike } from 'workprocess'

function mapStore(): WorkStoreLike & { records: Map<string, WorkRecordLike> } {
  const records = new Map<string, WorkRecordLike>()
  return {
    records,
    get: async (scope: string) => records.get(scope),
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records.get(scope) ?? {}
      const out = fn(record)
      if ((out as { changed?: boolean } | undefined)?.changed !== true) return { changed: false }
      records.set(scope, record)
      return { changed: true }
    },
  }
}

const STAGE_KEYS = ['key', 'statement', 'state', 'done_criteria', 'close_policy', 'tasks', 'tasks_done'] as const
const TASK_KEYS = ['id', 'stage_key', 'objective', 'phase', 'revision'] as const

async function seeded(): Promise<{ deps: WorkDeps; snapshot(): Promise<WorkProcess> }> {
  const store = mapStore()
  const deps: WorkDeps = { store, now: () => 1_000 }
  await createWorkProcess(deps, 'session-1', {
    objective: '修 bug',
    stages: [
      { key: 'repro', statement: '复现', doneCriteria: ['有栈'], closePolicy: 'auto' },
      { key: 'fix', statement: '修根因' },
    ],
  })
  await startWorkStage(deps, 'session-1', 'repro')
  await createWorkTask(deps, 'session-1', { stageKey: 'repro', objective: '抓栈', maxRounds: 5 })
  await createWorkTask(deps, 'session-1', { stageKey: 'repro', objective: '写测' })
  // 域层允许给后续阶段先落任务（工具面才拦 agent 这么做）——线投影必须吃得下这个状态。
  await createWorkTask(deps, 'session-1', { stageKey: 'fix', objective: '改码' })
  return { deps, snapshot: async () => (await workProcessOf(deps, 'session-1'))! }
}

describe('workWireOf：字段名与工具面回执逐字一致', () => {
  it('阶段线值的 key 集与取值口径', async () => {
    const { deps, snapshot } = await seeded()
    await completeWorkTask(deps, 'session-1', 'wt:repro:1')
    await blockWorkTask(deps, 'session-1', 'wt:repro:2', { code: 'needs-upstream', message: '等接口' })
    const wire = workWireOf(await snapshot())
    expect(Object.keys(wire.stages[0]).sort()).toEqual([...STAGE_KEYS].sort())
    expect(wire.stages[0]).toMatchObject({
      key: 'repro', state: 'active', close_policy: 'auto', tasks: 2, tasks_done: 1,
    })
    expect(wire.stages[0].done_criteria).toEqual(['有栈'])
    // 缺省 human 策略与空判据是显式形状（不省略、不编）。
    expect(wire.stages[1]).toMatchObject({ key: 'fix', state: 'pending', close_policy: 'human', done_criteria: [] })
  })

  it('任务线值的 key 集 + 条件字段（blocked / max_rounds）只在有时出现', async () => {
    const { deps, snapshot } = await seeded()
    await completeWorkTask(deps, 'session-1', 'wt:repro:1')
    await blockWorkTask(deps, 'session-1', 'wt:repro:2', { code: 'needs-upstream', message: '等接口' })
    const wire = workWireOf(await snapshot())
    expect(wire.tasks).toHaveLength(3)
    // 基键集：拿一条没有任何条件字段的任务来钉（completed 且带 maxRounds 的不算）。
    const bare = wire.tasks.find((t) => t.id === 'wt:fix:1')!
    expect(Object.keys(bare).sort()).toEqual([...TASK_KEYS].sort())
    const done = wire.tasks.find((t) => t.phase === 'complete')!
    expect(done.id).toBe('wt:repro:1')
    const blocked = wire.tasks.find((t) => t.phase === 'blocked')!
    expect(blocked.blocked_reason).toBe('needs-upstream')
    expect(blocked.blocked_message).toBe('等接口')
    expect(wire.tasks.find((t) => t.id === 'wt:repro:1')!.max_rounds).toBe(5)
    expect(wire.tasks.find((t) => t.id === 'wt:fix:1')!.max_rounds).toBeUndefined()
  })

  it('顶层读数：current_stage / allows_start / allows_close / activation', async () => {
    const { deps, snapshot } = await seeded()
    const before = workWireOf(await snapshot(), 'disarmed')
    expect(before.current_stage).toBe('repro')
    expect(before.allows_start).toBe(false)   // 当前阶段已 active
    expect(before.allows_close).toBe(false)
    expect(before.activation).toBe('disarmed')
    // 全阶段收口后：current_stage = null、allows_close = true。
    await completeWorkTask(deps, 'session-1', 'wt:repro:1')
    await completeWorkTask(deps, 'session-1', 'wt:repro:2')
    await completeWorkStage(deps, 'session-1', 'repro')
    await startWorkStage(deps, 'session-1', 'fix')
    await completeWorkTask(deps, 'session-1', 'wt:fix:1')
    await completeWorkStage(deps, 'session-1', 'fix')
    const after = workWireOf(await snapshot())
    expect(after.current_stage).toBeNull()
    expect(after.allows_close).toBe(true)
  })

  it('closed_at 只在流程收口后出现；activation 只在传入时出现', async () => {
    const { deps, snapshot } = await seeded()
    await completeWorkTask(deps, 'session-1', 'wt:repro:1')
    await completeWorkTask(deps, 'session-1', 'wt:repro:2')
    await completeWorkStage(deps, 'session-1', 'repro')
    const open = workWireOf(await snapshot())
    expect('closed_at' in open).toBe(false)
    expect('activation' in open).toBe(false)
    await startWorkStage(deps, 'session-1', 'fix')
    await completeWorkTask(deps, 'session-1', 'wt:fix:1')
    await completeWorkStage(deps, 'session-1', 'fix')
    await closeWorkProcess(deps, 'session-1')
    const closed = workWireOf(await snapshot())
    expect(typeof closed.closed_at).toBe('number')
  })
})
