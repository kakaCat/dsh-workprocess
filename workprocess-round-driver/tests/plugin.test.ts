/**
 * 驱动器插件的**设计契约**（照宿主 `dsh-goal-round-driver` 一比一的那几条）：
 *   ① `name` / `inject` = `['agents','sessions','workprocess']`（宿主是 `['agents','goals','sessions']`）；
 *   ② **请求合并**：同一 agent 同时只有一条串行 run——多个触发叠在一起也只跑一条；
 *   ③ **竞态围栏**：`next-turn` 里排了别的消息 ⇒ 让路（一拍都不动）；
 *   ④ **预约身份**：投出去的那条带自署来源 `kind:'work'`，且同一轮不重复投；
 *   ⑤ `tick:false` ⇒ 一条监听都不挂（等于没装驱动器）。
 *
 * 【为什么单独测这些】它们是"宿主 driver 同款"的骨头：不靠这些围栏，驱动器会在
 * 人正在说话 / 模型正在跑的时候插话（真机踩过的坑）。
 */
import { describe, it, expect } from 'vitest'
import { apply, inject, name } from 'workprocess-round-driver'
import type { Context } from '@deepseek-ai/cordis'

interface Sent { readonly source?: Record<string, unknown>; readonly content?: unknown }

/** 极简宿主：够驱动器决策 + 投递 + 围栏即可（流程状态用一个假域服务喂）。 */
function harness(options: { status?: string; process?: unknown; activation?: string } = {}) {
  const sent: Sent[] = []
  const hooks: string[] = []
  const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>()
  const runs: Array<Promise<unknown>> = []
  let status = options.status ?? 'idle'
  let process = options.process ?? {
    id: 'wp:session-1', revision: 1, objective: '把数据洗干净',
    stages: [{
      key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [{
        id: 't-1', objective: '清洗', phase: 'active', revision: 1, maxRounds: 5,
      }],
    }],
  }
  const agent: Record<string, unknown> = {
    id: 'session-1',
    get status() { return status },
    session: { id: 'session-1' },
    inbox: { nextStep: [], nextTurn: [] as unknown[] },
    followup: (message: Sent): void => { sent.push(message) },
  }
  let activation = options.activation ?? 'armed'
  const disarms: string[] = []
  const domain = {
    activation: async (): Promise<string> => activation,
    setActivation: async (_scope: string, next: string): Promise<boolean> => {
      disarms.push(next)
      if (activation === next) return false
      activation = next
      return true
    },
    process: async (): Promise<unknown> => process,
    roundsStarted: async (): Promise<number> => 0,
    observeRound: async (): Promise<void> => {},
    startStage: async (): Promise<boolean> => false,
    closeStage: async (): Promise<boolean> => false,
    blockTask: async (): Promise<boolean> => false,
    closeProcess: async (): Promise<boolean> => false,
  }
  const ctx = {
    workprocess: domain,
    fiber: { state: 2 },
    sessions: { flush: async (): Promise<boolean> => true },
    logger: { warn: (): void => {} },
    agents: {
      get: (id: string) => (id === 'session-1' ? agent : undefined),
      currentInitiator: () => agent,
      withoutInitiator: <T,>(fn: () => T): T => {
        const out = fn()
        if (out instanceof Promise) runs.push(out as Promise<unknown>)
        return out
      },
    },
    on: (event: string, cb: (a: unknown, b?: unknown) => unknown) => {
      hooks.push(event)
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    },
    effect: (fn: () => Generator<unknown, void, unknown>) => {
      const iter = fn()
      for (let next = iter.next(); !next.done; next = iter.next()) void next.value
      return (): void => {}
    },
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      const pending = runs.splice(0)
      if (pending.length === 0) { await Promise.resolve(); if (runs.length === 0) return; continue }
      await Promise.allSettled(pending)
    }
  }
  return {
    ctx: ctx as unknown as Context, sent, hooks, settle,
    setStatus: (next: string) => { status = next },
    setProcess: (next: typeof process) => { process = next },
    agent,
    competing: (message: unknown) => { (agent.inbox as { nextTurn: unknown[] }).nextTurn.push(message) },
    disarms,
    fire: async (event: string, payload: unknown): Promise<void> => {
      for (const h of handlers.get(event) ?? []) await h(payload)
      await settle()
    },
    fireStatus: async (next: string): Promise<void> => {
      status = next
      for (const h of handlers.get('agent/status') ?? []) await h({ agent, status: next })
      await settle()
    },
  }
}

describe('驱动器插件：宿主 goal-round-driver 同款设计', () => {
  it('name / inject 与宿主同形（第三格换成本域的领域服务）', () => {
    expect(name).toBe('workprocess-round-driver')
    expect(inject).toEqual(['agents', 'sessions', 'workprocess'])
  })

  it('空闲边界投一轮：来源自署 work，且同一轮不重复投', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    const source = h.sent[0].source as Record<string, unknown>
    expect(source.kind).toBe('work')                 // 绝不冒充人
    expect(source.round).toBe(1)
    expect(source.taskId).toBe('t-1')
    // 再空闲一次：同一 (任务,修订,回合) 已经投过 ⇒ 不再投（重复投 = 烧回合预算）。
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
  })

  it('请求合并：同一 agent 同时只有一条串行 run', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    // 两个触发叠在一起（不 await 第一条）：合并成一条 run，只投一轮。
    const first = h.fireStatus('idle')
    const second = h.fireStatus('idle')
    await Promise.all([first, second])
    expect(h.sent).toHaveLength(1)
  })

  it('竞态围栏：next-turn 里有别的消息 ⇒ 域变更也不插话（等到下一次空闲才复位）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    h.competing({ id: 'someone-else', source: { kind: 'user' } })
    await h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: 'someone-else' } })
    // 别人（人 / 别的插件）排在 next-turn 里 ⇒ 即使此刻流程变了也不抢拍。
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(0)
    // 下一次空闲 = 那条竞争消息已经跑完 ⇒ 围栏复位，驱动器接着推（宿主同款语义）。
    ;(h.agent.inbox as { nextTurn: unknown[] }).nextTurn.length = 0
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
  })

  it('agent 不空闲 ⇒ 一拍都不动（不与模型正在做的事打架）', async () => {
    const h = harness({ status: 'running' })
    apply(h.ctx, { drive: true })
    await h.fireStatus('running')
    expect(h.sent).toHaveLength(0)
  })

  it('续跑许可 disarmed ⇒ 一拍都不投（重启后不会被自动续跑）', async () => {
    const h = harness({ activation: 'disarmed' })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)
  })

  it('会话 resume（宿主重启后加载）⇒ 自动收回许可（disarmed）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    expect(h.disarms).toEqual(['disarmed'])
  })

  it('disarmOnResume:false ⇒ 重启后接着自动跑（长时间无人值守用）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true, disarmOnResume: false })
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    expect(h.disarms).toEqual([])
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
  })

  it('新建会话（startup）不收许可：刚建的流程照常自动跑', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    expect(h.disarms).toEqual([])
  })

  it('流程收口（全阶段 done）⇒ 投终局收束轮，让"跑完了"在对话里看得见', async () => {
    const h = harness({
      process: {
        id: 'wp:session-1', revision: 9, objective: '把数据洗干净',
        stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'done', tasks: [] }],
      },
    })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                       // 收口是写库，但必须有一句话
    const text = JSON.stringify(h.sent[0])
    expect(text).toContain('workprocess_done')
    expect(text).toContain('不要再调任何工具')
  })

  it('tick:false ⇒ 一条监听都不挂（等于没装驱动器）', () => {
    const h = harness()
    apply(h.ctx, { tick: false })
    expect(h.hooks).toEqual([])
  })
})
