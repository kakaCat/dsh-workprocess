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
import { decideWorkRound, renderWorkPlanPrompt, renderWorkRoundPrompt, renderWorkWrapupPrompt } from 'workprocess-round-driver'
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
        ...(current.closePolicy === undefined ? {} : { closePolicy: current.closePolicy }),
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
    case 'plan-stage': return 'plan-stage:' + d.stageKey
    case 'ask-stage-done': return 'ask-stage-done:' + d.stageKey
    case 'close-stage': return 'close-stage:' + d.stageKey
    case 'ask-close': return 'ask-close'
    case 'close-process': return 'close-process'
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
      else if (decision.kind === 'close-stage') {
        await completeWorkStage(deps, 'ws-a', decision.stageKey) // 策略 auto：驱动器自己落 done，不等人
      } else if (decision.kind === 'drive') {
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

  it('收口策略 auto：任务全完成即由驱动器自动收口，阶段边界不等人工确认', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const deps = { store: storeOf(records) as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', {
      objective: '把模型发上线',
      stages: [
        { key: 'prep', statement: '准备数据', closePolicy: 'auto' },
        { key: 'train', statement: '训练模型', closePolicy: 'auto' },
      ],
    })
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: '清洗数据' })
    await createWorkTask(deps, 'ws-a', { stageKey: 'train', objective: '调参' })

    const seen: string[] = []
    let ticks = 0
    for (;;) {
      ticks += 1
      expect(ticks).toBeLessThan(20)
      const process = await workProcessOf(deps, 'ws-a')
      const decision = decideWorkRound({
        now: 1_000, scope: SCOPE, gates: {}, work: factsOf(process!), roundsStarted: ticks,
      })
      seen.push(label(decision))
      if (decision.kind === 'ask-close') break
      if (decision.kind === 'start-stage') await startWorkStage(deps, 'ws-a', decision.stageKey)
      else if (decision.kind === 'close-stage') await completeWorkStage(deps, 'ws-a', decision.stageKey)
      else if (decision.kind === 'drive') await completeWorkTask(deps, 'ws-a', decision.taskId)
      else if (decision.kind === 'ask-stage-done') await completeWorkStage(deps, 'ws-a', decision.stageKey)
      else throw new Error('驱动拍给出了不该出现的结论：' + label(decision))
    }

    // 两段策略都是 auto：收口由驱动器落，全程没有一拍是"请人确认"
    expect(seen).toEqual([
      'start-stage:prep',
      'drive:wt:prep:1',
      'close-stage:prep',      // 自动收口（人工确认那条路没有被触发）
      'start-stage:train',
      'drive:wt:train:1',
      'close-stage:train',
      'ask-close',             // 流程级收口仍是人的判断（流程没有"完成"态）
    ])
    expect(seen.some((s) => s.startsWith('ask-stage-done'))).toBe(false)
  })

  it('阶段已开工但没有任务 → plan-stage（让 agent 建任务）；有任务在跑就不许偷下一步', async () => {
    const records = { 'ws-a': { updatedAt: 1 } }
    const deps = { store: storeOf(records) as never, now: () => 1_000 }
    await createWorkProcess(deps, 'ws-a', {
      objective: 'x',
      stages: [{ key: 'prep', statement: '准备' }, { key: 'train', statement: '训练' }],
    })
    await startWorkStage(deps, 'ws-a', 'prep')
    const empty = await workProcessOf(deps, 'ws-a')
    expect(decideWorkRound({ now: 1_000, scope: SCOPE, gates: {}, work: factsOf(empty!) }))
      .toEqual({ kind: 'plan-stage', processId: 'wp:ws-a', stageKey: 'prep' })

    // 有在跑的任务：下一段仍然 pending → 一拍只干一件事（drive），不会顺手开工下一段
    await createWorkTask(deps, 'ws-a', { stageKey: 'prep', objective: '清洗数据' })
    const one = await workProcessOf(deps, 'ws-a')
    expect(decideWorkRound({ now: 1_000, scope: SCOPE, gates: {}, work: factsOf(one!) }))
      .toEqual({ kind: 'drive', processId: 'wp:ws-a', stageKey: 'prep', taskId: 'wt:prep:1' })
    expect((await workProcessOf(deps, 'ws-a'))!.stages[1].state).toBe('pending')
  })
})

describe('两种轮次的分工口径（防"规划轮把活干完、回合预算形同虚设"）', () => {
  // 真机踩过：规划轮提示词写着"建完直接动手"，于是两阶段流程跑完 `rounds.started` 还是 0——
  // 预算与"落 block 要先跑满 N 轮"的门槛都按**任务轮**计数，被挤掉就等于没启用。
  const stage = { key: 'v1', statement: '写文件', doneCriteria: ['文件在'] }

  it('规划轮只建任务，明确叫停手等任务轮（理由压成一行，不复述策略段规则）', () => {
    const text = renderWorkPlanPrompt({ processObjective: 'x', stage, round: 1 })
    expect(text).toContain('只建任务，这一轮不要动手')
    expect(text).toContain('任务轮会由驱动器投给你')
    expect(text).toContain('理由一行')            // 只说一句为什么，踩坑史留在代码注释里
    expect(text).not.toContain('前一阶段全部达成后才轮到下一阶段')   // 串行规则属策略段
  })

  it('终局收束轮：收口/停住两种口径都要"只说话、不再调工具"', () => {
    const done = renderWorkWrapupPrompt({
      processObjective: 'x', kind: 'complete', doneStages: [{ key: 'v1', statement: '写文件' }],
    })
    expect(done).toContain('<workprocess_done>')
    expect(done).toContain('已经全部收口落幕')
    expect(done).toContain('不要再调任何工具')

    const blocked = renderWorkWrapupPrompt({
      processObjective: 'x', kind: 'blocked', blockedReason: 'round-limit: 到了回合上限',
    })
    expect(blocked).toContain('<workprocess_blocked>')
    expect(blocked).toContain('round-limit')
    expect(blocked).toContain('不要再调任何工具')
  })

  it('任务轮才是干活的那一轮（带任务、带轮号、说明做完停手）', () => {
    const text = renderWorkRoundPrompt({
      processObjective: 'x', stage, task: { id: 'wt:v1:1', objective: '写文件' }, round: 1, maxRounds: 2,
    })
    expect(text).toContain('wt:v1:1')
    expect(text).toContain('第 1 轮（上限 2）')      // 轮号 + 生效预算都在提示词里
    expect(text).toContain('收口策略 `human`')      // 收口策略是**逐阶段数据**，必须在本轮报出（夹具没写 ⇒ 缺省 human）
    // 真机踩过：投递叫模型 block、却没提门槛 ⇒ 照做被拒、白跑一轮。门槛必须在本轮说明里。
    expect(text).toContain('先撑满 3 轮')
    expect(text).not.toContain('不越阶段开工')      // 串行规则属策略段，不在每轮复述
  })
})
