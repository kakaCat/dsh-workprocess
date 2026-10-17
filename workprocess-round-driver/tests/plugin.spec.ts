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

interface Sent { readonly id?: string; readonly source?: Record<string, unknown>; readonly content?: unknown }

/** 真会**推进**流程的那几条投递（任务轮 / 规划轮 / 确认轮 / 收束轮）。 */
const advancing = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter((m) => (m.source as { notice?: string } | undefined)?.notice === undefined)

/** **停手通告轮**（`notice: 'disarmed'`）：它不推进任何东西，只是把"驱动器停手了"说出口。 */
const notices = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter((m) => (m.source as { notice?: string } | undefined)?.notice === 'disarmed')

/** 极简宿主：够驱动器决策 + 投递 + 围栏即可（流程状态用一个假域服务喂）。 */
function harness(options: {
  status?: string
  process?: unknown
  activation?: string
  /** 「谁收回的」耐久记号（只在 disarmed 时有意义）：'human' = 人亲手按的（粘性）；'driver' = 驱动器落的。 */
  activationBy?: 'driver' | 'human'
  asked?: { plan?: { key: string; revision: number }; ask?: { key: string; revision: number } }
  /** 投递即抛错（queue-failed 纪律的观测面）。 */
  followupThrows?: boolean
  /** 域读数（process）即抛错（"校验自身抛错 ⇒ disarm" 的观测面）。 */
  processThrows?: boolean
  /**
   * 模拟**插件热重载**：apply 时 agent 已经在场（ctx.agents.list 能列到）。
   * 缺省 false = 冷启动时序（插件先于 agent 装载，list 为空）——注意 get 不受此影响
   * （极简面的妥协：get 永远找得到这个 agent，够驱动路径用即可）。
   */
  preexisting?: boolean
} = {}) {
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
  /** cancel / whenIdle 的观测面（卸载路径用）。 */
  const cancels: unknown[] = []
  const whenIdleCalls: number[] = []
  const inbox = {
    nextStep: [] as unknown[],
    nextTurn: [] as unknown[],
    prepend(target: 'next-step' | 'next-turn', message: unknown): void {
      (target === 'next-step' ? this.nextStep : this.nextTurn).unshift(message)
    },
  }
  const agent: Record<string, unknown> = {
    id: 'session-1',
    get status() { return status },
    session: { id: 'session-1' },
    inbox,
    followup: (message: Sent): void => {
      if (options.followupThrows === true) throw new Error('inbox closed')
      sent.push(message)
    },
    cancel: (cause: unknown): void => { cancels.push(cause) },
    whenIdle: async (): Promise<void> => { whenIdleCalls.push(1) },
  }
  let activation = options.activation ?? 'armed'
  /** 域读数（process）是否抛错（可中途打开：模拟"投递成功后通道才坏"）。 */
  let processThrows = options.processThrows ?? false
  /** 许可写盘是否抛错（模拟"放回许可时落不了盘"）。 */
  let activationThrows = false
  /** 逐任务回合账（与归属记录同形：预算按任务计）。 */
  let taskRounds: Record<string, { rounds: number; grants: number }> = {}
  let asked: { plan?: { key: string; revision: number }; ask?: { key: string; revision: number } } | undefined
    = options.asked
  const disarms: string[] = []
  const marks: string[] = []
  /** 被落盘暂停的任务 id（`pauseDroppedRound` 的观测面；桩顺带把流程里的任务相位改掉，模拟域折叠）。 */
  const pauses: string[] = []
  /** 被落盘 block 的任务（`queue-failed` / `prompt-rejected` 的观测面；桩同样模拟域折叠）。 */
  const blocks: Array<{ taskId: string; code?: string }> = []
  /** 阶段开工 / 收口（`start-stage` / `close-stage` 的观测面；桩顺带折叠阶段态，让决策环走得下去）。 */
  const starts: string[] = []
  const closes: string[] = []
  /** 「谁收回的」记号（与内核 `setWorkActivation` 同一套规则：human 粘性、armed 清零、值没变时人可认领）。 */
  let activationBy: 'driver' | 'human' | undefined = options.activationBy
  const domain = {
    activation: async (): Promise<string> => activation,
    activationBy: async (): Promise<typeof activationBy> => activationBy,
    asked: async (): Promise<typeof asked> => asked,
    markAsked: async (_scope: string, kind: 'plan' | 'ask', key: string, revision: number): Promise<boolean> => {
      if (asked?.[kind]?.key === key && asked[kind]!.revision === revision) return false
      asked = { ...asked, [kind]: { key, revision } }
      marks.push(kind + ':' + key + '@' + String(revision))
      return true
    },
    setActivation: async (_scope: string, next: string, _revision?: number, by?: 'driver' | 'human'): Promise<boolean> => {
      if (activationThrows) throw new Error('store offline')
      disarms.push(next)
      // 与内核同规则：armed 清记号；armed→disarmed 记谁按的；同值再写时人可认领（'human' 粘性）、
      // 驱动器不许覆盖人记号（否则宿主重启的自动再收会把人记号抹成机器的——审查发现的那条）。
      const nextBy = next === 'armed' ? undefined
        : activation !== 'disarmed' ? by ?? 'driver'
        : by === 'human' ? 'human' : activationBy
      if (activation === next && activationBy === nextBy) return false
      activation = next
      activationBy = nextBy
      return true
    },
    pauseTask: async (_scope: string, taskId: string, _revision?: number): Promise<boolean> => {
      pauses.push(taskId)
      // 模拟域折叠：任务 paused、任务修订与流程修订各前进一格（pauseDroppedRound 靠它判重）。
      const current = process as {
        revision: number
        stages: Array<{ tasks: Array<{ id: string; phase: string; revision: number }> }>
      }
      current.revision += 1
      for (const stage of current.stages) {
        for (const task of stage.tasks) {
          if (task.id === taskId && task.phase === 'active') {
            task.phase = 'paused'
            task.revision += 1
          }
        }
      }
      return true
    },
    process: async (): Promise<unknown> => {
      if (processThrows) throw new Error('store offline')
      return process
    },
    roundsStarted: async (): Promise<number> =>
      Object.values(taskRounds).reduce((sum, entry) => sum + entry.rounds, 0),
    taskRounds: async (): Promise<typeof taskRounds> => taskRounds,
    observeRound: async (_scope: string, round: number, taskId: string): Promise<void> => {
      const used = taskRounds[taskId]?.rounds ?? 0
      if (round <= used) return
      taskRounds = { ...taskRounds, [taskId]: { rounds: round, grants: taskRounds[taskId]?.grants ?? 0 } }
    },
    startStage: async (_scope: string, stageKey: string): Promise<boolean> => {
      starts.push(stageKey)
      // 模拟域折叠：该阶段开工、流程修订前进一格（决策环据此走到下一个结论）。
      const current = process as { revision: number; stages: Array<{ key: string; state: string }> }
      current.revision += 1
      for (const stage of current.stages) {
        if (stage.key === stageKey && stage.state === 'pending') stage.state = 'active'
      }
      return true
    },
    closeStage: async (_scope: string, stageKey: string): Promise<boolean> => {
      closes.push(stageKey)
      // 模拟域折叠：该阶段收口、流程修订前进一格。
      const current = process as { revision: number; stages: Array<{ key: string; state: string }> }
      current.revision += 1
      for (const stage of current.stages) {
        if (stage.key === stageKey && stage.state === 'active') stage.state = 'done'
      }
      return true
    },
    blockTask: async (_scope: string, taskId: string, reason?: { code?: string }): Promise<boolean> => {
      blocks.push({ taskId, code: reason?.code })
      // 模拟域折叠：任务 blocked、任务修订与流程修订各前进一格。
      const current = process as {
        revision: number
        stages: Array<{ tasks: Array<{ id: string; phase: string; revision: number }> }>
      }
      current.revision += 1
      for (const stage of current.stages) {
        for (const task of stage.tasks) {
          if (task.id === taskId && task.phase === 'active') {
            task.phase = 'blocked'
            task.revision += 1
          }
        }
      }
      return true
    },
    closeProcess: async (): Promise<boolean> => false,
  }
  const ctx = {
    workprocess: domain,
    fiber: { state: 2 },
    sessions: { flush: async (): Promise<boolean> => true },
    logger: { warn: (): void => {} },
    agents: {
      get: (id: string) => (id === 'session-1' ? agent : undefined),
      // 装载时在场清单（热重载模拟；见 harness 选项 preexisting）。
      list: () => (options.preexisting === true ? [agent] : []),
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
      let cleanup: unknown
      for (let next = iter.next(); !next.done; next = iter.next()) cleanup = next.value
      cleanups.push(cleanup)
      return (): void => {}
    },
  }
  /** ctx.effect 产出的卸载回调（宿主卸载插件时跑的那个）。 */
  const cleanups: unknown[] = []
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      const pending = runs.splice(0)
      if (pending.length === 0) {
        // 宏任务一拍：把不在 runs 里的 fire-and-forget 链（disarm 等）也等完。
        await new Promise((r) => setTimeout(r, 0))
        if (runs.length === 0) return
        continue
      }
      await Promise.allSettled(pending)
    }
  }
  /** 投一条会话事件（`session/event` 监听器的签名是 (session, event)）。 */
  const fireSession = async (event: unknown): Promise<void> => {
    for (const h of handlers.get('session/event') ?? []) await h({ id: 'session-1' }, event)
    await settle()
  }
  return {
    ctx: ctx as unknown as Context, sent, hooks, settle,
    setStatus: (next: string) => { status = next },
    // 流程没了 ⇒ 模拟内核 discardWorkProcess 的摘除：耐久"已经问过"记号随流程一起清
    // （kernel.ts：否则重建的流程可能撞上旧记号——同阶段键 + 同 revision）。
    setProcess: (next: typeof process) => { if (next === undefined) asked = undefined; process = next },
    agent,
    competing: (message: unknown) => { (agent.inbox as { nextTurn: unknown[] }).nextTurn.push(message) },
    disarms,
    marks,
    pauses,
    blocks,
    starts,
    closes,
    cancels,
    whenIdleCalls,
    setProcessThrows: (next: boolean) => { processThrows = next },
    setActivationThrows: (next: boolean) => { activationThrows = next },
    /** 跑宿主卸载路径（ctx.effect 的清理回调，异步）+ **摘掉监听器**（宿主卸载插件时监听器一并
        摘除——本桩原来只跑清理不摘监听，等于"卸载了但还活着"，会把 unload 之后的状态机测歪）。 */
    dispose: async (): Promise<void> => {
      for (const cleanup of cleanups) await (cleanup as () => Promise<void>)()
      handlers.clear()
      await settle()
    },
    /**
     * 跑一次 `agent/pre-step` waterfall：messages = 本批被认领的消息；
     * behavior.next 扮下游（缺省放行 enter），behavior.signal 可给中止信号。
     */
    firePreStep: async (messages: unknown[], behavior?: {
      next?: () => Promise<unknown>
      signal?: AbortSignal
    }): Promise<unknown> => {
      const signal = behavior?.signal ?? new AbortController().signal
      const next = behavior?.next ?? (async () => ({ kind: 'enter', messages }))
      let result: unknown
      for (const h of handlers.get('agent/pre-step') ?? []) {
        result = await h({ agent, messages, turn: 1, step: 1, signal }, next)
      }
      await settle()
      return result
    },
    setRounds: (n: number, taskId = 't-1') => {
      taskRounds = { ...taskRounds, [taskId]: { rounds: n, grants: taskRounds[taskId]?.grants ?? 0 } }
    },
    setGrants: (n: number, taskId = 't-1') => {
      taskRounds = { ...taskRounds, [taskId]: { rounds: taskRounds[taskId]?.rounds ?? 0, grants: n } }
    },
    fire: async (event: string, payload: unknown): Promise<void> => {
      for (const h of handlers.get(event) ?? []) await h(payload)
      await settle()
    },
    fireSession,
    /** 我们那条被受理：按消息身份记 admitted，顺带让回合计数前进（模拟宿主真事件）。 */
    fireAdmitted: async (): Promise<void> => {
      const message = sent.at(-1) as { id: string; source: { round?: number; taskId?: string } }
      await fireSession({
        type: 'user/message',
        data: { id: message.id, source: { kind: 'work', round: message.source.round, taskId: message.source.taskId } },
      })
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

  // 【跨会话真机踩过】goal 的许可与流程的许可各管各的，而恢复口令只有一个"继续"：
  // 只 resume 了 goal ⇒ goal 轮照跑、模型照干活，流程这一半却仍冻着（disarmed 时 drive() 连副作用
  // 都不落：auto 收口 / 开工 / 规划轮全停）。症状是"看着很忙，流程停在半路"——5/5 任务全达成、
  // auto 收口永远不落、下一阶段永远开不了工。
  it('目标 resume（人说"继续"）⇒ 流程许可跟着放回，并在空闲边界立刻推一拍', async () => {
    const h = harness({ activation: 'disarmed' })
    apply(h.ctx, { drive: true })
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.disarms).toContain('armed')          // 许可真放回了
    expect(h.sent).toHaveLength(1)                // 不用等人再说一句话：该投的那一轮已经投出
    expect((h.sent[0].source as Record<string, unknown>).kind).toBe('work')
  })

  it('goal 的其它操作（create / block / complete）不动流程许可：那是 goal 自己的账', async () => {
    const h = harness({ activation: 'disarmed' })
    apply(h.ctx, { drive: true })
    for (const operation of ['create', 'block', 'complete']) {
      await h.fireSession({ type: 'goal/change', data: { operation } })
    }
    expect(h.disarms).toEqual([])
    expect(h.sent).toHaveLength(0)                // 仍停手
  })

  it('许可本来就是 armed ⇒ resume 零写入（幂等，不刷状态）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.disarms).toEqual([])
  })

  // 真机那条流程的形状（盯盘升级的 engine 阶段）：**任务 5/5 达成 + `auto` + 下一段 pending**。
  // 冻结发生在**重启那一刻**：会话 resume ⇒ 驱动器自己收回许可（记 by='driver'）⇒ 一个副作用都不落、
  // 但要把停手说出口；人说"继续"（goal resume）后整条链（收口 → 开工 → 规划轮）要自己走完。
  it('真机形状：5/5 达成 + auto + 下一段 pending——重启收许可（零副作用但说出口），"继续"后收口 → 开工 → 规划轮', async () => {
    const h = harness({
      process: {
        id: 'wp:session-1', revision: 40, objective: '盯盘升级',
        stages: [
          {
            key: 'engine', statement: '引擎修正', doneCriteria: [], state: 'active', closePolicy: 'auto',
            tasks: [1, 2, 3, 4, 5].map((n) => ({
              id: 'wt:engine:' + String(n), objective: 't' + String(n), phase: 'complete', revision: 2, maxRounds: 8,
            })),
          },
          { key: 'validate', statement: '整体验收', doneCriteria: [], state: 'pending', closePolicy: 'human', tasks: [] },
        ],
      },
    })
    apply(h.ctx, { drive: true })

    // ① 宿主重启 ⇒ 会话 resume ⇒ **驱动器自己**收回许可：仍然一个副作用都不落，但要说出口
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    await h.fireStatus('idle')
    expect(h.closes).toEqual([])                  // 通告**不是**推进：收口照样没落
    expect(h.starts).toEqual([])                  //    下一段不开工
    expect(advancing(h.sent)).toHaveLength(0)
    expect(notices(h.sent)).toHaveLength(1)       // 但"驱动器停手了"必须让人看见
    expect(String((notices(h.sent)[0].content as Array<{ text?: string }>)[0]?.text))
      .toContain('<workprocess_disarmed>')
    // 通告被接手（模型跑完那一轮）后回到空闲：预约撤掉，但许可仍不在 ⇒ 依旧不推进、不重复喊
    await h.fireAdmitted()
    await h.fireStatus('idle')
    expect(h.closes).toEqual([])
    expect(notices(h.sent)).toHaveLength(1)

    // ② 人说"继续"（goal resume）⇒ 记号是 'driver' ⇒ 放行：收口 engine → 开工 validate → 投 validate 的规划轮
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.closes).toEqual(['engine'])
    expect(h.starts).toEqual(['validate'])
    expect(advancing(h.sent)).toHaveLength(1)
    const plan = advancing(h.sent)[0]
    expect((plan.source as Record<string, unknown>).stageKey).toBe('validate')
    expect((plan.source as Record<string, unknown>).kind).toBe('work')
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

  it('预约还挂着时，别的触发不许再投一轮（真机 bug：投递即消耗，预算被烧光）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    // 我们投出去的那条消息落进会话、别的插件改了流程……这些**都不是**"上一轮跑完了"的证据：
    // 此刻 agent 仍是 idle，若在这里撤预约并再拍，就会当场把预算烧光（真机症状：任务轮与
    // blocked 收束轮同时到手，agent 一次手都没动）。
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(1)                    // ← 关键：旧实现在这里会当场投第 2 轮（预算被烧光）
    // 真机时序：上一轮被受理跑完（admitted + turn/end completed），才轮到下一次空闲转换。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    // 真·空闲转换 + 这一轮确实被接手（计数前进）⇒ 才撤预约、投下一轮。
    h.setRounds(1)
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as { round?: number }).round).toBe(2)
  })

  it('"已经问过"耐久：进程重启后（内存集合空）也不重复投规划轮', async () => {
    // 场景：上一进程已为 prep 投过规划轮（修订 1），现在是新进程、内存集合是空的。
    const h = harness({
      asked: { plan: { key: 'prep', revision: 1 } },
      process: {
        id: 'wp:session-1', revision: 1, objective: 'x',
        stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [] }],
      },
    })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)      // 不重复打扰（旧实现会再投一条）
  })

  it('"已经问过"随修订作废：流程变了（revision 前进）就重新问', async () => {
    const h = harness({
      asked: { plan: { key: 'prep', revision: 1 } },       // 记的是修订 1
      process: {                                            // 现在是修订 2（状态变过）
        id: 'wp:session-1', revision: 2, objective: 'x',
        stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [] }],
      },
    })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                        // 修订不符 ⇒ 记号失效，该问就问
    expect(h.marks).toEqual(['plan:prep@2'])              // 并且把新记号落下去
  })

  it('人拒绝收口 → 补任务 → 再次全 complete ⇒ 必须**再次**提请收口（内存"已问过"随域变更作废）', async () => {
    // S3 回归：旧实现的 planAsked/askAsked 只加不清——人拒绝一次收口后内存集永久命中，
    // 决策树永远 wait-human，流程静默停死（会话内无解，重启才恢复）。
    const processWith = (revision: number, extra: unknown[] = []) => ({
      id: 'wp:session-1', revision, objective: 'x',
      stages: [{
        key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active',
        tasks: [{ id: 't-1', objective: '清洗', phase: 'complete', revision: 1, maxRounds: 5 }, ...extra],
      }],
    })
    const h = harness({ process: processWith(1) })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                          // 任务全 complete ⇒ 第一次提请收口
    expect(h.marks).toEqual(['ask:stage-done:prep@1'])
    // 同一修订无变更：这一轮跑完后的空闲边界不重复投（进程内快挡语义保住）。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    // 人拒绝收口、补了一个任务（修订前进）⇒ 驱动器转而推新任务。
    h.setProcess(processWith(2, [{ id: 't-2', objective: '补做', phase: 'active', revision: 1, maxRounds: 5 }]))
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as { taskId?: string }).taskId).toBe('t-2')
    // 补做的任务跑完（修订再前进）⇒ 再次全 complete ⇒ 再次提请收口。
    // 旧实现：内存集仍命中 'stage-done:prep' ⇒ 永远 wait-human，这条断言红。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    h.setProcess(processWith(3, [{ id: 't-2', objective: '补做', phase: 'complete', revision: 2, maxRounds: 5 }]))
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(3)
    expect(h.marks).toEqual(['ask:stage-done:prep@1', 'ask:stage-done:prep@3'])
    // 第二次提请之后：同修订依旧不重复投（快挡不是"问过一次就废"）。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(3)
  })

  it('阶段规划轮同款：域变更（修订前进）后再次提请规划，不永久停手', async () => {
    const emptyStage = (revision: number) => ({
      id: 'wp:session-1', revision, objective: 'x',
      stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [] }],
    })
    const h = harness({ process: emptyStage(1) })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                          // 阶段空着 ⇒ 第一次提请规划
    expect(h.marks).toEqual(['plan:prep@1'])
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                          // 同修订不重复投
    // 域变了（人改了目标 / 别的插件动过流程：修订前进）⇒ 规划轮该重新提请。
    h.setProcess(emptyStage(2))
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(2)
    expect(h.marks).toEqual(['plan:prep@1', 'plan:prep@2'])
  })

  it('/work clear 后重建同键阶段 ⇒ 内存"已问过"不挡新流程（墓碑通知同样清快挡）', async () => {
    const emptyStage = (revision: number) => ({
      id: 'wp:session-1', revision, objective: 'x',
      stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [] }],
    })
    const h = harness({ process: emptyStage(1) })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)                          // 旧流程已为 prep 投过规划轮
    expect(h.marks).toEqual(['plan:prep@1'])
    // 旧流程那轮跑完、撤掉预约（否则后续触发都被挂着的预约挡住——那不是本用例要看的东西）。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    // 整条丢弃（墓碑通知 change=undefined）→ 重建同键阶段（revision 从 1 重新计）。
    // 旧实现：内存集按阶段键命中 ⇒ 新流程的规划轮被"上一辈子的记号"挡死。
    h.setProcess(undefined as never)
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(1)                          // 流程没了：一拍都不投
    h.setProcess(emptyStage(1))
    await h.fire('work/changed', { scope: 'session-1', change: undefined })
    expect(h.sent).toHaveLength(2)                          // 新流程的规划轮照常提请
    expect(h.marks).toEqual(['plan:prep@1', 'plan:prep@1'])
  })

  it('tick:false ⇒ 一条监听都不挂（等于没装驱动器）', () => {
    const h = harness()
    apply(h.ctx, { tick: false })
    expect(h.hooks).toEqual([])
  })
})

/**
 * 双 agent 宿主：复刻单 agent 版的极小面（流程/记号按 scope 分账），只为钉住
 * "askedRevision 是**每 agent** 的"——它曾经是 apply 级共享变量，两个会话的驱动拍
 * 在 await 点交错时互相覆盖（A 的修订被拿去判 B 的"已问过"，或反过来）。
 */
function twoAgentHarness() {
  type Asked = { plan?: { key: string; revision: number }; ask?: { key: string; revision: number } }
  const emptyStage = (id: string, revision: number) => ({
    id, revision, objective: 'x',
    stages: [{ key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [] }],
  })
  const processes: Record<string, unknown> = {}
  const askedStore: Record<string, Asked | undefined> = {}
  const sent: Record<string, Sent[]> = { 'session-a': [], 'session-b': [] }
  const marks: string[] = []
  const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>()
  const agents: Record<string, Record<string, unknown>> = {}
  for (const id of ['session-a', 'session-b']) {
    agents[id] = {
      id, status: 'idle',
      session: { id },
      inbox: { nextStep: [], nextTurn: [] },
      followup: (message: Sent): void => { sent[id].push(message) },
    }
  }
  /** 某个 scope 的下一次 asked() 挂起，直到 releaseAsked 放行——用来排出确定的交错顺序。 */
  const askedGates = new Map<string, Promise<void>>()
  const askedReleases = new Map<string, () => void>()
  /** 域方法调用计数（交错断言的同步点：不靠"刷几拍应该够了"猜时序）。 */
  const calls: Record<string, { asked: number; process: number }> = {
    'session-a': { asked: 0, process: 0 },
    'session-b': { asked: 0, process: 0 },
  }
  const domain = {
    activation: async (): Promise<string> => 'armed',
    asked: async (scope: string): Promise<Asked | undefined> => {
      calls[scope].asked += 1
      const gate = askedGates.get(scope)
      if (gate !== undefined) {
        askedGates.delete(scope)
        await gate
      }
      return askedStore[scope]
    },
    markAsked: async (scope: string, kind: 'plan' | 'ask', key: string, revision: number): Promise<boolean> => {
      askedStore[scope] = { ...askedStore[scope], [kind]: { key, revision } }
      marks.push(scope + ' ' + kind + ':' + key + '@' + String(revision))
      return true
    },
    setActivation: async (): Promise<boolean> => false,
    pauseTask: async (): Promise<boolean> => false,
    process: async (scope: string): Promise<unknown> => {
      calls[scope].process += 1
      return processes[scope]
    },
    roundsStarted: async (): Promise<number> => 0,
    taskRounds: async (): Promise<Record<string, never>> => ({}),
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
      get: (id: string) => agents[id],
      list: () => [],          // 冷启动时序：插件先于 agent 装载
      currentInitiator: () => undefined,
      withoutInitiator: <T,>(fn: () => T): T => fn(),
    },
    on: (event: string, cb: (a: unknown, b?: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
    },
    effect: (fn: () => Generator<unknown, void, unknown>) => {
      const iter = fn()
      for (let next = iter.next(); !next.done; next = iter.next()) void next.value
      return (): void => {}
    },
  }
  /** 刷宏观任务直到条件成立（ gated 的那条 run 不设条件时绝不能 await 它——会挂死）。 */
  const flushUntil = async (cond: () => boolean, max = 100): Promise<void> => {
    for (let i = 0; i < max && !cond(); i += 1) await new Promise((r) => setTimeout(r, 0))
  }
  return {
    ctx: ctx as unknown as Context, sent, marks, calls,
    setProcess: (which: 'a' | 'b', revision: number): void => {
      processes['session-' + which] = emptyStage('wp:session-' + which, revision)
    },
    setAsked: (which: 'a' | 'b', asked: Asked): void => { askedStore['session-' + which] = asked },
    /** 下一次该 scope 的 asked() 挂起（驱动拍已读出修订、正要决策的那一瞬）。 */
    suspendAsked: (which: 'a' | 'b'): void => {
      const scope = 'session-' + which
      askedGates.set(scope, new Promise<void>((resolve) => askedReleases.set(scope, resolve)))
    },
    releaseAsked: (which: 'a' | 'b'): void => { askedReleases.get('session-' + which)?.() },
    idle: async (which: 'a' | 'b'): Promise<void> => {
      const agent = agents['session-' + which]
      for (const h of handlers.get('agent/status') ?? []) await h({ agent, status: 'idle' })
    },
    flushUntil,
  }
}

describe('多会话并发：askedRevision 是每 agent 的（驱动拍交错也不串扰）', () => {
  it('A 的记号有效、B 没问过：交错后 A 不因 B 的修订误判"没问过"（不重复打扰）', async () => {
    const h = twoAgentHarness()
    // A：修订 2，耐久记号 plan:prep@2（**已问过** ⇒ 一拍都不该投）。
    h.setProcess('a', 2)
    h.setAsked('a', { plan: { key: 'prep', revision: 2 } })
    // B：修订 3，没问过（该投一条规划轮）。
    h.setProcess('b', 3)
    apply(h.ctx, { drive: true })

    // 交错：A 先驱动（读出修订 2）并卡在 asked() 上；B 完整跑完一拍（修订 3 投出规划轮）；
    // 然后放行 A。旧实现里 askedRevision 是共享变量——此刻它是 B 写的 3，
    // A 拿自己的记号(2)去比 ⇒ 误判"没问过"而重复打扰。每 agent 各记各的之后：A 比对的是 2。
    h.suspendAsked('a')
    await h.idle('a')
    await h.flushUntil(() => h.calls['session-a'].asked === 1)  // A 已读出修订、卡在门前
    await h.idle('b')
    await h.flushUntil(() => h.sent['session-b'].length === 1)
    expect(h.marks).toEqual(['session-b plan:prep@3'])
    h.releaseAsked('a')
    // A 的一拍跑完（drive 读一次 process、tick 再读一次；其后无投递、无记号）。
    await h.flushUntil(() => h.calls['session-a'].process >= 2)
    await h.flushUntil(() => false, 10)
    expect(h.sent['session-a']).toHaveLength(0)                // 记号有效 ⇒ 不重复打扰
    expect(h.sent['session-b']).toHaveLength(1)                // B 的规划轮照常投出
    expect(h.marks).toEqual(['session-b plan:prep@3'])         // A 没落任何新记号
  })

  it('A 的修订恰好等于 B 的记号修订：B 不误判"已问过"而停死（该问照问）', async () => {
    const h = twoAgentHarness()
    // A：修订 2，没问过（该投一条规划轮）。
    h.setProcess('a', 2)
    // B：修订 5，带着旧修订的记号 plan:prep@2（**已作废** ⇒ 也该重新问）。
    h.setProcess('b', 5)
    h.setAsked('b', { plan: { key: 'prep', revision: 2 } })
    apply(h.ctx, { drive: true })

    // 交错：B 先驱动（读出修订 5）并卡在 asked() 上；A 完整跑完一拍（修订 2 投出规划轮）；
    // 然后放行 B。旧实现：共享 askedRevision 此刻是 A 写的 2，恰好等于 B 的记号修订 ⇒
    // B 误判"已问过" ⇒ 决策停手等人，规划轮永远投不出去（流程静默停死）。
    h.suspendAsked('b')
    await h.idle('b')
    await h.flushUntil(() => h.calls['session-b'].asked === 1)  // B 已读出修订、卡在门前
    await h.idle('a')
    await h.flushUntil(() => h.sent['session-a'].length === 1)
    expect(h.marks).toEqual(['session-a plan:prep@2'])
    h.releaseAsked('b')
    await h.flushUntil(() => h.sent['session-b'].length === 1)
    expect(h.sent['session-a']).toHaveLength(1)
    expect(h.sent['session-b']).toHaveLength(1)                // 记号作废 ⇒ 该问就问
    expect(h.marks).toEqual(['session-a plan:prep@2', 'session-b plan:prep@5'])
  })
})

describe('停止语义（宿主 stop 按钮：turn/end aborted ⇒ 真的停住，对齐宿主 goal driver）', () => {
  it('人停止正在跑的回合 ⇒ 任务落盘暂停，且不再投下一轮', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')                  // 投第 1 轮
    expect(h.sent).toHaveLength(1)
    await h.fireAdmitted()                      // 被受理、开跑
    // 宿主 stop 按钮：中止当回合（来源 kind:'user'）。
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await h.fireStatus('idle')                  // 空闲边界：旧实现在这里立刻投第 2 轮（"停了又跑"）
    expect(h.pauses).toEqual(['t-1'])           // 任务落盘暂停：停得看得见、/work resume 放行
    expect(h.sent).toHaveLength(1)              // 没有下一轮
  })

  it('正常跑完的回合（completed）⇒ 不暂停，接着投下一轮', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.pauses).toEqual([])                // 跑成过的轮次不暂停（否则每个回合都要人 resume）
    expect(h.sent).toHaveLength(2)
  })

  it('中止的回合不是我们投的 ⇒ 收回续跑许可（disarmed），自动推进停住', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')                  // 投第 1 轮（随后该空闲转换已撤预约）
    expect(h.sent).toHaveLength(1)
    // 人在自己的消息回合里点了停止：中止的回合与我们挂着的预约无关。
    await h.fireSession({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    expect(h.disarms).toEqual(['disarmed'])
    await h.fireStatus('idle')
    expect(advancing(h.sent)).toHaveLength(1)   // 许可已收回：不再推进（只剩刚才那一条）
    expect(notices(h.sent)).toHaveLength(1)     // 但"驱动器停手了"要说出口
  })

  it('回合到输出上限（max-tokens）⇒ 收回续跑许可（配置不适配，不许无限自动续跑）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    expect(h.disarms).toEqual(['disarmed'])
    await h.fireStatus('idle')
    expect(advancing(h.sent)).toHaveLength(1)
    expect(notices(h.sent)).toHaveLength(1)
  })

  // 【故意不处理的闭合标记】宿主类型文档：`interrupted` 是"crash-orphaned turn was closed after the
  // fact…the loop never emits this marker live"（agent-loop resume 给没收尾的日志补的），`forked` 同源。
  // 按 `aborted` 处理会在**每次崩溃修复 / fork**时误落暂停、误收许可——比不处理更糟。
  it('turn/end = interrupted（崩溃孤儿的补记）⇒ 不暂停、不收许可，自动推进照旧', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
    expect(h.pauses).toEqual([])
    expect(h.disarms).toEqual([])
    // 许可与任务相位都没被这个标记动过 ⇒ 下一个空闲边界照常续投下一轮
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as Record<string, unknown>).round).toBe(2)
  })

  it('排队中就被丢弃的回合 ⇒ 空闲边界同样把任务落盘暂停（fail closed）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')                  // 投第 1 轮（仍在收件箱排队，未开跑）
    expect(h.sent).toHaveLength(1)
    // 围栏身份比对是 sameQueued（内容 + 来源逐字节深比对）：丢弃事件要带**整条**消息。
    await h.fire('agent/inbox/discarded', { agent: h.agent, message: h.sent[0] })
    await h.fireStatus('idle')
    expect(h.pauses).toEqual(['t-1'])
    expect(h.sent).toHaveLength(1)
  })

  it('许可已收回（disarmed）时 dropped 回合不落盘暂停：驱动器不碰状态', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')                  // 投第 1 轮
    expect(h.sent).toHaveLength(1)
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })   // resume ⇒ 自动收回许可
    expect(h.disarms).toEqual(['disarmed'])
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await h.fireStatus('idle')
    expect(h.pauses).toEqual([])                // 许可不在 ⇒ 不替人落暂停（停手就够了）
    expect(advancing(h.sent)).toHaveLength(1)
    expect(notices(h.sent)).toHaveLength(1)     // 停手通告照投（resume 收的许可，人不知情）
  })
})

/**
 * **pre-step 围栏**（M1：宿主 `validReservation` 七核 + 三段式 waterfall 的本域移植）。
 * 预约校验 fail closed：过期修订 / 竞争插队（stale）/ 校验异常，都进步骤前拦下——
 * reject 丢弃整个提议步骤，所以同批其它消息必须放回 `next-step`（restoreOtherClaimed）。
 */
describe('pre-step 围栏（宿主 validReservation + 三段式 waterfall）', () => {
  /** 投出第 1 轮并让它被认领（phase: queued → claimed），返回那条消息。 */
  const deliverAndClaim = async (h: ReturnType<typeof harness>): Promise<unknown> => {
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]
    await h.fire('agent/inbox/claimed', { agent: h.agent, message })
    return message
  }

  it('claimed → admitted：预约有效 ⇒ 正常进入步骤且带 startsRequestSeries', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    const decision = await h.firePreStep([message])
    expect(decision).toEqual({ kind: 'enter', messages: [message], startsRequestSeries: true })
    // 受理 ⇒ admitted + 回合记数前进；跑完后空闲边界正常投下一轮（围栏不误伤好回合）。
    await h.fireAdmitted()
    await h.fireSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as { round?: number }).round).toBe(2)
  })

  it('拒过期回合（投递后修订已前进）：reject + 同批其它消息放回 inbox + 重拍投出新修订的一轮', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    // 等待认领/进步的期间域前进了（人改过任务：修订 1 → 2）。
    h.setProcess({
      id: 'wp:session-1', revision: 2, objective: '把数据洗干净',
      stages: [{
        key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [{
          id: 't-1', objective: '清洗', phase: 'active', revision: 2, maxRounds: 5,
        }],
      }],
    })
    const other = { id: 'other-1', content: [{ type: 'text', text: '人插的话' }], source: { kind: 'user' } }
    let nextCalled = false
    const decision = await h.firePreStep([message, other], {
      next: async () => { nextCalled = true; return { kind: 'enter', messages: [message, other] } },
    })
    expect(nextCalled).toBe(false)                       // 没过闸：下游一步都不走
    expect(decision).toEqual({ kind: 'reject' })
    // 同批的人的消息被放回 next-step（reject 丢弃整个步骤，不放回 = 把人的话弄丢）。
    expect((h.agent.inbox as { nextStep: unknown[] }).nextStep).toEqual([other])
    // 重拍：预约已撤、去重键作废 ⇒ 按新修订投出新一轮（不是空转，也不是旧轮重投）。
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as { revision?: number }).revision).toBe(2)
  })

  it('拒 stale（排队期间被别的消息插队）：stale 字段不再是写了不读的死代码', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    const message = h.sent[0]
    // 别的消息排进 next-turn ⇒ 竞争插队：我们的预约被落 stale（此刻还在 queued）。
    h.competing({ id: 'someone-else', source: { kind: 'user' } })
    await h.fire('agent/inbox/inserted', { agent: h.agent, message: { id: 'someone-else' } })
    // 随后我们的消息被认领、进步骤 ⇒ 围栏读 stale 拒收。
    await h.fire('agent/inbox/claimed', { agent: h.agent, message })
    const decision = await h.firePreStep([message])
    expect(decision).toEqual({ kind: 'reject' })
    // 竞争消息还没跑完（competingQueued 在）：重拍不投新轮（让路纪律不变）。
    expect(h.sent).toHaveLength(1)
    // 竞争消息跑完、真·空闲转换 ⇒ 去重键已作废，同一轮重新投出（不停死）。
    ;(h.agent.inbox as { nextTurn: unknown[] }).nextTurn.length = 0
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(2)
    expect((h.sent[1].source as { round?: number }).round).toBe(1)
    expect(h.pauses).toEqual([])                         // 围栏拒收 ≠ 跑丢：不落盘暂停
  })

  it('拒收时同批消息按原顺序放回 next-step 队首（restoreOtherClaimed 是正确性的一部分）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    h.setProcess({
      id: 'wp:session-1', revision: 2, objective: '把数据洗干净',
      stages: [{
        key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [{
          id: 't-1', objective: '清洗', phase: 'active', revision: 2, maxRounds: 5,
        }],
      }],
    })
    const first = { id: 'other-1', content: [], source: { kind: 'user' } }
    const second = { id: 'other-2', content: [], source: { kind: 'user' } }
    const decision = await h.firePreStep([first, message, second])
    expect(decision).toEqual({ kind: 'reject' })
    expect((h.agent.inbox as { nextStep: unknown[] }).nextStep).toEqual([first, second])
  })

  it('下游 reject ⇒ 清预约 + 任务落盘 block（prompt-rejected；域服务直调，不走工具面门槛）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    const decision = await h.firePreStep([message], { next: async () => ({ kind: 'reject' }) })
    expect(decision).toEqual({ kind: 'reject' })
    expect(h.blocks).toEqual([{ taskId: 't-1', code: 'prompt-rejected' }])
    // 任务已 blocked ⇒ 停手等人：不再投下一轮（域折叠由桩模拟：phase → blocked）。
    expect(h.sent).toHaveLength(1)
  })

  it('校验自身抛错 ⇒ 收回续跑许可（disarm）且拒收（fail closed）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    h.setProcessThrows(true)                             // 域读数通道坏了
    const decision = await h.firePreStep([message])
    expect(decision).toEqual({ kind: 'reject' })
    expect(h.disarms).toEqual(['disarmed'])
  })

  it('拿到 enter 后二验不过（等待下游期间修订变了）⇒ 同样拒收并放回同批消息', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const message = await deliverAndClaim(h)
    const other = { id: 'other-1', content: [], source: { kind: 'user' } }
    const decision = await h.firePreStep([message], {
      next: async () => {
        // 等下游决策的期间域前进了（真机时序：pre-step waterfall 里别的监听器写了域）。
        h.setProcess({
          id: 'wp:session-1', revision: 2, objective: '把数据洗干净',
          stages: [{
            key: 'prep', statement: '准备', doneCriteria: ['就绪'], state: 'active', tasks: [{
              id: 't-1', objective: '清洗', phase: 'active', revision: 2, maxRounds: 5,
            }],
          }],
        })
        return { kind: 'enter', messages: [message, other] }
      },
    })
    expect(decision).toEqual({ kind: 'reject' })
    expect((h.agent.inbox as { nextStep: unknown[] }).nextStep).toEqual([other])
  })

  it('不是我们的轮次 ⇒ 原样放行（不加 startsRequestSeries，不动预约）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const human = { id: 'human-1', content: [{ type: 'text', text: '人话' }], source: { kind: 'user' } }
    const decision = await h.firePreStep([human])
    expect(decision).toEqual({ kind: 'enter', messages: [human] })
  })

  it('手搓的 work 消息（没有对应预约）⇒ 拒（fail closed：授权面只认预约过的回合）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    const forged = {
      id: 'forged-1',
      content: [{ type: 'text', text: '冒充的自动回合' }],
      source: { kind: 'work', processId: 'wp:session-1', revision: 1, taskId: 't-1', round: 1 },
    }
    const decision = await h.firePreStep([forged])
    expect(decision).toEqual({ kind: 'reject' })
    // 没有预约可撤（sameReservedRound 不符 ⇒ 不动 state.attempt）；重拍投出的是**真预约**的
    // 那一轮（它自己还要过同一道闸）——拒掉冒牌货不等于停住正常流程。
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].id).not.toBe('forged-1')
  })
})

/**
 * **围栏纪律一揽子对齐宿主**（M1）：agent/error 与驱动失败 ⇒ 收许可（不许静默重试）；
 * 投递失败 ⇒ 任务落 block（queue-failed）；装载 / 卸载两侧的许可与收尾纪律。
 */
describe('围栏纪律对齐宿主（disarm / block / 装载与卸载）', () => {
  it('agent/error ⇒ 收回续跑许可（不再只是撤预约）：出错的那一轮不许自动重试', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
    await h.fire('agent/error', { agent: h.agent })
    expect(h.disarms).toEqual(['disarmed'])
    await h.fireStatus('idle')
    expect(advancing(h.sent)).toHaveLength(1)            // 许可已收回：不再推进
    expect(notices(h.sent)).toHaveLength(1)              // 停手通告照投
  })

  it('投递失败（followup 抛错）⇒ 任务落盘 block（queue-failed），不只 warn', async () => {
    const h = harness({ followupThrows: true })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)
    expect(h.blocks).toEqual([{ taskId: 't-1', code: 'queue-failed' }])
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)                       // 任务已 blocked：不再反复投递
  })

  it('drive() 失败（域读数通道坏了）⇒ 收回续跑许可（不许静默重试）', async () => {
    const h = harness({ processThrows: true })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.disarms).toEqual(['disarmed'])
    expect(h.sent).toHaveLength(0)
  })

  it('装载时对已经在场的 agent 收回许可（热重载不偷跑；冷启动 list 为空不受影响）', async () => {
    const h = harness({ preexisting: true })
    apply(h.ctx, { drive: true })
    await h.settle()
    expect(h.disarms).toEqual(['disarmed'])
    await h.fireStatus('idle')
    expect(advancing(h.sent)).toHaveLength(0)            // 冷/热装载都不偷跑
    expect(notices(h.sent)).toHaveLength(1)              // 但要说一句为什么不动
  })

  // ── 停手通告轮（`disarmOnResume` 不该是静默的）────────────────────────────
  // 真机：机器重启 ⇒ 会话 resume ⇒ 自动收回许可 ⇒ 驱动器连副作用都不落，可会话里**看不出异常**
  // （模型照跑、阶段照显示进行中），流程在 engine 阶段冻了半天。回执与 /work 给了"看得见"，
  // 这一轮给"被推着知道"。
  it('停手通告：驱动器自己收的许可 + 有该推进的事 ⇒ 投一轮说出口，且**只投一次**', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    await h.fireStatus('idle')
    const sent = notices(h.sent)
    expect(sent).toHaveLength(1)
    expect(sent[0].source?.notice).toBe('disarmed')
    expect(sent[0].source?.round).toBeUndefined()        // 不消耗任何任务的回合预算
    expect(sent[0].source?.taskId).toBeUndefined()
    expect(String((sent[0].content as Array<{ text?: string }>)[0]?.text))
      .toContain('<workprocess_disarmed>')
    // 再空闲两次：同一条流程同一次停手不再重复喊（不刷屏）
    await h.fireStatus('idle')
    await h.fireStatus('idle')
    expect(notices(h.sent)).toHaveLength(1)
  })

  it('人自己按的停手（activationBy = human）：不喊，且"继续"口令（goal resume）也**不放回**——人收的要人放', async () => {
    const h = harness({ activation: 'disarmed', activationBy: 'human' })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)                 // 不喊（明确意图不打扰）
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.disarms).toEqual([])                  // 不放回
    expect(h.sent).toHaveLength(0)                 // 也不推进
  })

  it('"问过了、在等人答"不是"停手卡住" ⇒ 不喊（闸与 driveOnce 同一份）', async () => {
    const h = harness({
      activation: 'disarmed',
      process: {
        id: 'wp:session-1', revision: 1, objective: 'x',
        stages: [{
          key: 'prep', statement: '准备', doneCriteria: [], state: 'active', closePolicy: 'human',
          tasks: [{ id: 't-1', objective: '清洗', phase: 'complete', revision: 1, maxRounds: 5 }],
        }],
      },
      asked: { ask: { key: 'stage-done:prep', revision: 1 } },
    })
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(0)
  })

  it('围栏放行停手通告轮：许可被收回也不拦它（它不是"推进"）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    await h.fireStatus('idle')
    const notice = notices(h.sent)[0]
    expect(notice).toBeDefined()
    await h.fire('agent/inbox/claimed', { agent: h.agent, message: notice })
    expect(await h.firePreStep([notice])).toMatchObject({ kind: 'enter', startsRequestSeries: true })
  })

  it('围栏反核：通告投递后许可已被放回 ⇒ 拒收过期的停手通告（不许谎报停手）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fire('agent/created', { agent: h.agent, source: 'resume' })
    await h.fireStatus('idle')
    const notice = notices(h.sent)[0]
    expect(notice).toBeDefined()
    await h.fire('agent/inbox/claimed', { agent: h.agent, message: notice })
    // 通告在认领后、进步骤前，许可被放回了（人说"继续"）——`running` 挡掉驱动的推进拍，
    // 好让围栏单独面对"同一条预约 + 许可已 armed"这个组合。
    h.setStatus('running')
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(await h.firePreStep([notice])).toMatchObject({ kind: 'reject' })
  })

  it('goal resume 的写盘失败 ⇒ 许可原样、不刷状态，修好后再说一次"继续"照样放回', async () => {
    const h = harness({ activation: 'disarmed', activationBy: 'driver' })
    apply(h.ctx, { drive: true })
    h.setActivationThrows(true)
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.disarms).toEqual([])                  // 写失败：没有"armed"这一笔
    h.setActivationThrows(false)
    await h.fireSession({ type: 'goal/change', data: { operation: 'resume' } })
    expect(h.disarms).toEqual(['armed'])           // 重试照常放回
    expect(h.sent).toHaveLength(1)                 // 且推进立刻跟上（不用人再说一次）
  })

  it('卸载：收许可 + 预约置 stale + cancel 在跑回合 + 等 idle/run 收尾（不只置 stopping）', async () => {
    const h = harness()
    apply(h.ctx, { drive: true })
    await h.fireStatus('idle')                           // 投第 1 轮，预约挂着
    expect(h.sent).toHaveLength(1)
    h.setStatus('running')                               // 回合在跑
    await h.dispose()
    expect(h.disarms).toEqual(['disarmed'])              // 许可收回
    expect(h.cancels).toEqual([{ kind: 'parent' }])      // 在跑回合被 cancel
    expect(h.whenIdleCalls).toHaveLength(1)              // 等它收尾
    // 卸载后再来空闲信号也不投（stopping + 许可已收回）。
    h.setStatus('idle')
    await h.fireStatus('idle')
    expect(h.sent).toHaveLength(1)
  })
})
