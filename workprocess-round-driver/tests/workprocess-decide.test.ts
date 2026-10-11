/**
 * workprocess 驱动拍的**决策矩阵**（纯函数穷举）。
 *
 * 【守护什么】顺序即纪律：归属 → 可驱动 → 闸（闭锁/退避/上游/人工确认/预算）→
 * 层1（串行门 + 收口）→ 层2（相位机 + 回合上限）。任一条被重排都会在这里红。
 */
import { describe, it, expect } from 'vitest'
import { decideWorkRound, renderWorkRoundPrompt } from 'workprocess-round-driver'
import type { DecideInput, RoundScopeFacts, StageFacts, TaskFacts } from 'workprocess-round-driver'

const SCOPE: RoundScopeFacts = { id: 'ws-a', ownerSessionId: 'sess-1', drivable: true }

function stage(over: Partial<StageFacts> = {}): StageFacts {
  return { key: 'prep', statement: '准备数据', doneCriteria: ['数据可用'], state: 'active', allowsStart: false, tasks: [], ...over }
}

function task(over: Partial<TaskFacts> = {}): TaskFacts {
  return { id: 'wt:prep:1', objective: '清洗数据', phase: 'active', revision: 1, ...over }
}

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    now: 1_000,
    scope: SCOPE,
    work: { processId: 'wp:ws-a', processRevision: 3, sessionKey: 'sess-1', currentStage: stage({ tasks: [task()] }) },
    ...over,
  }
}

describe('归属与前置', () => {
  it('无归属 / 无流程 / 非本会话 → hold（不是本会话的活）', () => {
    expect(decideWorkRound(input({ scope: undefined }))).toEqual({ kind: 'hold', reason: 'no-scope' })
    expect(decideWorkRound(input({ work: undefined }))).toEqual({ kind: 'hold', reason: 'no-process', processId: 'ws-a' })
    expect(decideWorkRound(input({ work: { processId: 'wp:ws-a', sessionKey: 'sess-9', currentStage: stage({ tasks: [task()] }) } })))
      .toEqual({ kind: 'hold', reason: 'not-owner-session', processId: 'ws-a' })
  })

  it('可驱动判据：人的意图 + 推进未告警', () => {
    expect(decideWorkRound(input({ scope: { ...SCOPE, drivable: false } }))).toEqual({ kind: 'hold', reason: 'not-drivable', processId: 'ws-a' })
    expect(decideWorkRound(input({ scope: { ...SCOPE, pauseReason: 'wait-confirm' } })))
      .toEqual({ kind: 'hold', reason: 'paused:wait-confirm', processId: 'ws-a' })
  })
})

describe('闸·顺序即纪律', () => {
  it('内存闭锁先于退避与上游闸', () => {
    const r = decideWorkRound(input({ gates: { latchOpen: true, backoffUntil: 9_999, providerLatchOpen: true } }))
    expect(r).toEqual({ kind: 'hold', reason: 'latch', processId: 'ws-a' })
  })

  it('退避期内停手；到点放行', () => {
    expect(decideWorkRound(input({ gates: { backoffUntil: 2_000 } }))).toEqual({ kind: 'hold', reason: 'backoff', processId: 'ws-a' })
    expect(decideWorkRound(input({ now: 2_000, gates: { backoffUntil: 2_000 } })).kind).toBe('drive')
  })

  it('人工确认 / 弹框在途 → wait-human（等人不是故障）', () => {
    expect(decideWorkRound(input({ gates: { humanGateOpen: true, humanGateReason: 'await-approval' } })))
      .toEqual({ kind: 'wait-human', processId: 'ws-a', reason: 'await-approval' })
    expect(decideWorkRound(input({ gates: { dialogInFlight: true } })))
      .toEqual({ kind: 'wait-human', processId: 'ws-a', reason: 'dialog-in-flight' })
  })

  it('起链预算用尽 → hold（带原因）', () => {
    expect(decideWorkRound(input({ gates: { chainBudgetAllowed: false, chainBudgetReason: 'no-window' } })))
      .toEqual({ kind: 'hold', reason: 'chain-budget:no-window', processId: 'ws-a' })
  })
})

describe('层1 · 串行门与收口', () => {
  it('全阶段 done → 请人收口', () => {
    expect(decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: undefined } })))
      .toEqual({ kind: 'ask-close', processId: 'wp:ws-a' })
  })

  it('阶段 pending 且串行门放行 → 先开工（不开工就不许跑任务）', () => {
    const r = decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: stage({ state: 'pending', allowsStart: true, tasks: [task()] }) } }))
    expect(r).toEqual({ kind: 'start-stage', processId: 'wp:ws-a', stageKey: 'prep' })
  })

  it('串行门未放行（前序没全 done）→ hold，不许偷跑', () => {
    const r = decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: stage({ key: 'train', state: 'pending', allowsStart: false, tasks: [task()] }) } }))
    expect(r).toEqual({ kind: 'hold', reason: 'stage-serial-blocked:train', processId: 'wp:ws-a' })
  })

  it('阶段已开工但任务全 complete → 请人确认（缺省策略 human，agent 不自写 done）', () => {
    const r = decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [task({ phase: 'complete' })] }) } }))
    expect(r).toEqual({ kind: 'ask-stage-done', processId: 'wp:ws-a', stageKey: 'prep' })
  })

  it('收口确认**问过一次**就不再问（humanAskBlocked）→ wait-human：不刷屏、也不自己收口', () => {
    const done = [task({ phase: 'complete' })]
    expect(decideWorkRound(input({
      gates: { humanAskBlocked: true },
      work: { processId: 'wp:ws-a', currentStage: stage({ tasks: done }) },
    }))).toEqual({ kind: 'wait-human', processId: 'wp:ws-a', reason: 'ask-stage-done-asked:prep' })

    expect(decideWorkRound(input({
      gates: { humanAskBlocked: true },
      work: { processId: 'wp:ws-a', currentStage: undefined },
    }))).toEqual({ kind: 'wait-human', processId: 'wp:ws-a', reason: 'ask-close-asked' })
  })

  it('阶段策略 auto：任务全 complete → close-stage（自动收口，不等人工确认）', () => {
    const r = decideWorkRound(input({
      work: { processId: 'wp:ws-a', currentStage: stage({ closePolicy: 'auto', tasks: [task({ phase: 'complete' })] }) },
    }))
    expect(r).toEqual({ kind: 'close-stage', processId: 'wp:ws-a', stageKey: 'prep' })
  })

  it('策略只管"谁落 done"，不改"没全完成就不许收口"', () => {
    const r = decideWorkRound(input({
      work: { processId: 'wp:ws-a', currentStage: stage({ closePolicy: 'auto', tasks: [task({ phase: 'complete' }), task({ id: 'wt:prep:2' })] }) },
    }))
    expect(r).toEqual({ kind: 'drive', processId: 'wp:ws-a', stageKey: 'prep', taskId: 'wt:prep:2' })
  })

  it('阶段已开工却没有任何任务 → plan-stage（投一轮让 agent 建任务；决策层仍不臆造任务）', () => {
    const r = decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [] }) } }))
    expect(r).toEqual({ kind: 'plan-stage', processId: 'wp:ws-a', stageKey: 'prep' })
  })

  it('规划轮已经问过（stagePlanBlocked）→ wait-human：不空转，把"阶段空着"这件事露出来', () => {
    const r = decideWorkRound(input({
      gates: { stagePlanBlocked: true },
      work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [] }) },
    }))
    expect(r).toEqual({ kind: 'wait-human', processId: 'wp:ws-a', reason: 'stage-plan-asked:prep' })
  })
})

describe('层2 · 相位机与回合上限', () => {
  it('active 任务 → drive（指名阶段与任务）', () => {
    expect(decideWorkRound(input())).toEqual({ kind: 'drive', processId: 'wp:ws-a', stageKey: 'prep', taskId: 'wt:prep:1' })
  })

  it('回合到顶 → block-task（落盘，不是内存停手）', () => {
    const r = decideWorkRound(input({
      roundsStarted: 3,
      work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [task({ maxRounds: 3 })] }) },
    }))
    expect(r.kind).toBe('block-task')
    expect((r as { reason: { code: string } }).reason.code).toBe('round-limit')
  })

  it('未到顶继续跑；上限缺省 = 不限', () => {
    expect(decideWorkRound(input({ roundsStarted: 2, work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [task({ maxRounds: 3 })] }) } })).kind).toBe('drive')
    expect(decideWorkRound(input({ roundsStarted: 99, work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [task()] }) } })).kind).toBe('drive')
  })

  it('paused / blocked 任务 → wait-human（等人，不故障）', () => {
    for (const phase of ['paused', 'blocked'] as const) {
      const r = decideWorkRound(input({ work: { processId: 'wp:ws-a', currentStage: stage({ tasks: [task({ phase })] }) } }))
      expect(r).toEqual({ kind: 'wait-human', processId: 'wp:ws-a', reason: 'task-' + phase + ':wt:prep:1' })
    }
  })

  it('一个阶段多个任务：跑 active 的那个，其余不干扰', () => {
    const r = decideWorkRound(input({
      work: {
        processId: 'wp:ws-a',
        currentStage: stage({ tasks: [task({ id: 'wt:prep:1', phase: 'complete' }), task({ id: 'wt:prep:2' })] }),
      },
    }))
    expect(r).toEqual({ kind: 'drive', processId: 'wp:ws-a', stageKey: 'prep', taskId: 'wt:prep:2' })
  })
})

describe('回合提示词：两层都要写进模型看得见的地方', () => {
  it('含流程目标 / 阶段与判据 / 本轮任务 / 边界与停手条件', () => {
    const text = renderWorkRoundPrompt({
      processObjective: '把模型发上线',
      stage: { key: 'prep', statement: '准备数据', doneCriteria: ['数据可用'] },
      task: { id: 'wt:prep:1', objective: '清洗数据' },
      round: 2,
      maxRounds: 5,
    })
    expect(text).toContain('把模型发上线')
    expect(text).toContain('阶段 `prep`：准备数据')
    expect(text).toContain('- 数据可用')
    expect(text).toContain('任务 `wt:prep:1`：清洗数据')
    expect(text).toContain('第 2 轮（上限 5）')
    expect(text).toContain('不越阶段开工')
  })

  it('没有登记判据时如实说明，不编造判据', () => {
    const text = renderWorkRoundPrompt({
      processObjective: 'x',
      stage: { key: 'train', statement: '训练', doneCriteria: [] },
      task: { id: 'wt:train:1', objective: 'y' },
      round: 1,
    })
    expect(text).toContain('未登记达成判据')
    expect(text).toContain('上限 不限')
  })

  it('边界按收口策略写：human 请人确认 / auto 由驱动器自动收口（缺省 = human）', () => {
    const base = {
      processObjective: 'x',
      task: { id: 'wt:prep:1', objective: 'y' },
      round: 1,
    }
    const human = renderWorkRoundPrompt({ ...base, stage: { key: 'prep', statement: '准备', doneCriteria: [] } })
    expect(human).toContain('人工确认')
    expect(human).not.toContain('自动收口')
    const auto = renderWorkRoundPrompt({
      ...base, stage: { key: 'prep', statement: '准备', doneCriteria: [], closePolicy: 'auto' },
    })
    expect(auto).toContain('自动收口')
    expect(auto).not.toContain('人工确认')
  })
})
