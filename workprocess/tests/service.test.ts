/**
 * `ctx.workprocess` 服务面（**给命令行等消费者用的那一层**）。
 *
 * 【守护什么】读与三种干预都在**真内核**上生效，且都按 `agent.session.id` 定位归属域：
 *   ① `view`：阶段表 / 当前阶段 / 任务 / 已准入回合（没有流程 ⇒ undefined，不编）；
 *   ② `pauseActive` / `resumePaused`：只动**当前阶段**的对应相位任务，返回真被改的 id；
 *   ③ `discard`：幂等（没有流程 ⇒ false），丢了就读不到。
 */
import { describe, it, expect } from 'vitest'
import { createWorkprocessService } from 'workprocess'
import { createWorkProcess, createWorkTask, startWorkStage, workProcessOf } from 'workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'

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

const agent = { session: { id: 'session-1' } }

async function seeded() {
  const store = mapStore()
  const deps = { store, now: () => 1_000 }
  await createWorkProcess(deps, 'session-1', {
    objective: '修 bug',
    stages: [{ key: 'repro', statement: '复现' }, { key: 'fix', statement: '修根因' }],
  })
  await startWorkStage(deps, 'session-1', 'repro')
  await createWorkTask(deps, 'session-1', { stageKey: 'repro', objective: '抓栈', maxRounds: 5 })
  await createWorkTask(deps, 'session-1', { stageKey: 'fix', objective: '改码' })
  return { store, service: createWorkprocessService({ store, now: () => 1_000 }) }
}

describe('ctx.workprocess 服务面', () => {
  it('view：读得到阶段表 / 当前阶段 / 任务 / 回合上限；没有流程 ⇒ undefined', async () => {
    const { service } = await seeded()
    const status = await service.view(agent)
    expect(status).toMatchObject({
      objective: '修 bug',
      currentStageKey: 'repro',
      roundsStarted: 0,
      maxRounds: 5,                       // 当前阶段首个任务写的上限
    })
    expect(status?.stages.map((s) => [s.key, s.state])).toEqual([['repro', 'active'], ['fix', 'pending']])
    expect(await service.view({ session: { id: 'nope' } })).toBeUndefined()
    expect(await service.view(undefined)).toBeUndefined()
  })

  it('pauseActive / resumePaused：只动当前阶段对应相位的任务，返回真被改的 id', async () => {
    const { store, service } = await seeded()
    expect(await service.pauseActive(agent)).toEqual(['wt:repro:1'])
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('paused')
    // 下一阶段的任务不受影响
    expect((await workProcessOf({ store }, 'session-1'))!.stages[1].tasks[0].phase).toBe('active')
    // 再暂停一次：没有活动任务 ⇒ 空数组（不假装成功）
    expect(await service.pauseActive(agent)).toEqual([])
    expect(await service.resumePaused(agent)).toEqual(['wt:repro:1'])
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('active')
    expect(await service.resumePaused(agent)).toEqual([])
  })

  it('discard：幂等（第一次 true、第二次 false），丢了就读不到', async () => {
    const { store, service } = await seeded()
    expect(await service.discard(agent)).toBe(true)
    expect(await workProcessOf({ store }, 'session-1')).toBeUndefined()
    expect(await service.discard(agent)).toBe(false)
    expect(await service.view(agent)).toBeUndefined()
  })
})
