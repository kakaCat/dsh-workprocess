/**
 * `ctx.workprocess` 服务面（**给命令行等消费者用的那一层**）。
 *
 * 【守护什么】读与三种干预都在**真内核**上生效，且都按 `agent.session.id` 定位归属：
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
  // 域层允许给后续阶段先落任务（工具面才拦 agent 这么做）——读投影必须吃得下这个状态。
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

describe('续跑许可（服务面）', () => {
  it('读缺省 armed；disarm 后 view 与 activation 都能看到', async () => {
    const { service } = await seeded()
    expect(await service.activation('session-1')).toBe('armed')
    expect(await service.setActivation('session-1', 'disarmed')).toBe(true)
    expect(await service.activation('session-1')).toBe('disarmed')
    const status = await service.view({ session: { id: 'session-1' } })
    expect(status?.activation).toBe('disarmed')
    expect(await service.setActivation('session-1', 'armed')).toBe(true)
  })
})

describe('"已经问过"的记号（服务面）', () => {
  it('markAsked 落库、asked 读回；同键同修订幂等', async () => {
    const { service } = await seeded()
    expect(await service.asked('session-1')).toBeUndefined()
    expect(await service.markAsked('session-1', 'plan', 'repro', 1)).toBe(true)
    expect(await service.asked('session-1')).toEqual({ plan: { key: 'repro', revision: 1 } })
    expect(await service.markAsked('session-1', 'plan', 'repro', 1)).toBe(false)
  })
})

describe('回合账（服务面）：预算按任务计 + 人 resume 追加一份预算', () => {
  it('observeRound 按任务记；同一回合重复观察零写入；累计数按增量前进', async () => {
    const { service } = await seeded()
    await service.observeRound('session-1', 1, 'wt:repro:1')
    expect(await service.taskRounds('session-1')).toEqual({ 'wt:repro:1': { rounds: 1, grants: 0 } })
    expect(await service.roundsStarted('session-1')).toBe(1)
    await service.observeRound('session-1', 1, 'wt:repro:1')          // 重复观察：零写入
    expect(await service.roundsStarted('session-1')).toBe(1)
    await service.observeRound('session-1', 2, 'wt:repro:1')
    expect(await service.roundsStarted('session-1')).toBe(2)
    // 另一个任务从自己的第 1 轮起：轮号跨任务不可比，**累计数**才是"整条流程真跑过几轮"。
    await service.observeRound('session-1', 1, 'wt:fix:1')
    expect(await service.taskRounds('session-1')).toEqual({
      'wt:repro:1': { rounds: 2, grants: 0 },
      'wt:fix:1': { rounds: 1, grants: 0 },
    })
    expect(await service.roundsStarted('session-1')).toBe(3)
  })

  it('resume 一个 blocked 任务 ⇒ 追加一份预算（否则一开拍又到顶）；paused 任务只是继续', async () => {
    const { service } = await seeded()
    await service.pauseTask('session-1', 'wt:repro:1')
    expect(await service.resumeTask('session-1', 'wt:repro:1')).toBe(true)
    expect(await service.taskRounds('session-1')).toEqual({})          // 没有追加
    await service.blockTask('session-1', 'wt:repro:1', { code: 'round-limit', message: '到顶' })
    expect(await service.resumeTask('session-1', 'wt:repro:1')).toBe(true)
    expect((await service.taskRounds('session-1'))['wt:repro:1']).toEqual({ rounds: 0, grants: 1 })
  })

  it('discard 把整本回合账带走（累计数 / 逐任务账 / 续跑许可）：重建的流程不继承上一个对象的结论', async () => {
    const { store, service } = await seeded()
    await service.observeRound('session-1', 2, 'wt:repro:1')
    // 真机坑：宿主重启 ⇒ resume 自动落 disarmed；随后重建的流程若继承它，就一开就静默停住。
    await service.setActivation('session-1', 'disarmed')
    expect(await service.discard(agent)).toBe(true)
    await createWorkProcess({ store, now: () => 1_000 }, 'session-1', {
      objective: 'x', stages: [{ key: 's', statement: 's' }],
    })
    expect(await service.taskRounds('session-1')).toEqual({})
    expect(await service.roundsStarted('session-1')).toBeUndefined()   // 缺失 = 没记录过（不是 0：重建后没有上一个对象的读数）
    expect(await service.activation('session-1')).toBe('armed')
  })
})
