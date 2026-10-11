/**
 * 端到端：**驱动器环** —— 一拍一拍地把一条流程从"刚建好"推到"该收口"。
 *
 * 【这条用例证明什么】`decideWorkRound` 是纯函数，单测喂的是**静态事实**；
 * 这条把事实换成**从真实内核快照投影出来的**（就是组合根适配器该写的那段），
 * 再把结论施加回内核，形成一个真环：决策 → 副作用 → 新事实 → 下一拍。
 *
 * 【顺带的文档价值】`factsOf()` 就是"组合根要写的适配器"的最小样本：
 *   当前阶段 = `currentStageOf`；串行门读数 = `stageAllowsStart`；任务 = 阶段下的 tasks。
 *
 * 模拟口径：`drive` 这一拍由"agent 完成了该任务"来兑现（真实系统里是投递一条回合提示词）。
 */
import { describe, it, expect } from 'vitest'
import {
  completeWorkStage, completeWorkTask, createWorkProcess, createWorkTask, currentStageOf,
  processAllowsClose, stageAllowsStart, startWorkStage, workProcessOf,
} from 'workprocess'
import type { WorkProcess, WorkRecordLike } from 'workprocess'
import { decideWorkRound } from 'workprocess-round-driver'
import type { RoundDecision, WorkFacts, RoundScopeFacts } from 'workprocess-round-driver'

function storeOf(records: Record<string, WorkRecordLike>) {
  return {
    get: async (scope: string) => records[scope],
    mutate: async (scope: string, fn: (draft: WorkRecordLike) => unknown) => {
      const record = records[scope]
      if (record === undefined) return { changed: false }
      const out = fn(record)
      return { changed: (out as { changed?: boolean } | undefined)?.changed === true }
    },
  }
}

/** 组合根要写的适配器：把内核快照投影成驱动拍要读的窄事实。 */
function factsOf(process: WorkProcess): WorkFacts {
  const current = currentStageOf(process)
  return {
    processId: process.id,
    processRevision: process.revision,
    sessionKey: 'sess-1',
    ...(current === undefined ? {} : {
      currentStage: {
        key: current.key,
        statement: current.statement,
        doneCriteria: current.doneCriteria,
        state: current.state,
        allowsStart: stageAllowsStart(process, current.key),
        tasks: current.tasks.map((t) => ({
          id: t.id, objective: t.objective, phase: t.phase, revision: t.revision,
          ...(t.maxRounds === undefined ? {} : { maxRounds: t.maxRounds }),
        })),
      },
    }),
  }
}

/** 决策的人话标签（断言序列用；顺序即驱动纪律的可观测面）。 */
function label(d: RoundDecision): string {
  switch (d.kind) {
    case 'start-stage': return 'start-stage:' + d.stageKey
    case 'drive': return 'drive:' + d.taskId
    case 'ask-stage-done': return 'ask-stage-done:' + d.stageKey
    case 'ask-close': return 'ask-close'
    case 'block-task': return 'block-task:' + d.taskId
    case 'wait-human': return 'wait-human:' + d.reason
    case 'hold': return 'hold:' + d.reason
  }
}

const SCOPE: RoundScopeFacts = { id: 'ws-a', ownerSessionId: 'sess-1', drivable: true }

describe('端到端 · 驱动器环', () => {
  it('两段流程：开工 → 跑任务 → 请人确认 → 开工 → 跑任务 → 请人收口', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const deps = { store: storeOf(records) as never, now: () => 1_000 }
    const stages = [
      { key: 'prep', statement: '准备数据', doneCriteria: ['数据可用'] },
      { key: 'train', statement: '训练模型' },
    ]
    // 布线：建流程 + 每段各建一个任务（**pending 阶段也允许建任务**——计划先落任务，开工归驱动器）
    await createWorkProcess(deps, 'ws-a', { objective: '把模型发上线', stages })
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: '清洗数据' })
    await createWorkTask(deps, 'ws-a', { stageKey: 'train', objective: '调参' })

    const seen: string[] = []
    let rounds = 0
    let ticks = 0
    for (;;) {
      ticks += 1
      expect(ticks).toBeLessThan(20)   // 环不收敛就是缺陷，不许无限跑
      const process = await workProcessOf(deps, 'ws-a')
      expect(process).toBeDefined()
      const decision = decideWorkRound({ now: 1_000, scope: SCOPE, gates: {}, work: factsOf(process!), roundsStarted: rounds })
      seen.push(label(decision))

      if (decision.kind === 'ask-close') break
      if (decision.kind === 'start-stage') await startWorkStage(deps, 'ws-a', decision.stageKey)
      else if (decision.kind === 'drive') {
        rounds += 1                                   // 准入了一个回合
        await completeWorkTask(deps, 'ws-a', decision.taskId)   // 该回合真的把任务干完了
      } else if (decision.kind === 'ask-stage-done') {
        await completeWorkStage(deps, 'ws-a', decision.stageKey) // 这里模拟的是**人**确认
      } else {
        throw new Error('驱动拍给出了不该出现的结论：' + label(decision))
      }
    }

    expect(seen).toEqual([
      'start-stage:prep',      // 串行门放行 → 先开工
      'drive:wt:prep:1',       // 层2：跑这个任务
      'ask-stage-done:prep',   // 任务全 complete → 请人确认（agent 不自写）
      'start-stage:train',     // 确认后串行门放行下一段
      'drive:wt:train:1',
      'ask-stage-done:train',
      'ask-close',             // 全阶段 done → 请人收口
    ])
    expect(rounds).toBe(2)     // 两拍真起轮（虚拍不算）

    const end = await workProcessOf(deps, 'ws-a')
    expect(end!.stages.map((s) => s.state)).toEqual(['done', 'done'])
    expect(processAllowsClose(end!)).toBe(true)
  })

  it('阶段已开工但没有任务 → hold（决策层不臆造任务）；有任务在跑就不许偷下一步', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const deps = { store: storeOf(records) as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', {
      objective: 'x',
      stages: [{ key: 'prep', statement: '准备' }, { key: 'train', statement: '训练' }],
    })
    await startWorkStage(deps, 'ws-a', 'prep')
    const empty = await workProcessOf(deps, 'ws-a')
    expect(decideWorkRound({ now: 1_000, scope: SCOPE, gates: {}, work: factsOf(empty!) }))
      .toEqual({ kind: 'hold', reason: 'stage-has-no-runnable-task:prep', processId: 'wp:ws-a' })

    // 有在跑的任务：下一段仍然 pending → 一拍只干一件事（drive），不会顺手开工下一段
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: '清洗数据' })
    const one = await workProcessOf(deps, 'ws-a')
    expect(decideWorkRound({ now: 1_000, scope: SCOPE, gates: {}, work: factsOf(one!) }))
      .toEqual({ kind: 'drive', processId: 'wp:ws-a', stageKey: 'prep', taskId: 'wt:prep:1' })
    expect((await workProcessOf(deps, 'ws-a'))!.stages[1].state).toBe('pending')
  })
})
