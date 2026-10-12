/**
 * `/work` 命令行（独立包）：语法 / 排版 / 分派 / **真服务接线**。
 *
 * 【守护什么】
 *   ① 语法与 `/goal` 逐字同形：缺省 show、`<目标>` = 建、`edit <目标>` = 改目标、
 *      pause / resume / clear 直落；`edit` 缺目标如实报错；
 *   ② **结构化动作由 agent 做**：`<目标>` 与 `edit <目标>` 只投一条消息（followup），
 *      命令**不碰内核**（不猜阶段表、不自己建流程）；控制动作 pause / resume / clear 才直接落；
 *   ③ 投话的来源自署 `user`（这一轮是人敲的命令发起的，真人专属动作才落得下章）；
 *   ④ 排版：走到哪了 / 谁该动 / 能做什么——人一眼能读懂；
 *   ⑤ 接线：`apply` 真的把它注册进 `ctx.commands`（inject 只要 commands + workprocess）。
 */
import { describe, it, expect } from 'vitest'
import {
  apply, createInstruction, editInstruction, inject, name, parseWorkCommand, renderWorkStatus, workCommandHandler,
} from 'dsh-command-workprocess'
import { createWorkprocessService } from 'workprocess'
import type { WorkprocessService, WorkprocessStatus } from 'workprocess'
import {
  createWorkProcess, createWorkTask, startWorkStage, workProcessOf,
} from 'workprocess'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess'

/** 内存归属记录（够服务面用）。 */
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

/** 假 agent：留住投进来的消息（真宿主里是 `Agent.followup`）。 */
function fakeAgent() {
  const sent: Array<{ content: Array<{ type: string; text: string }>; source?: { kind?: string } }> = []
  return {
    sent,
    agent: { session: { id: 'session-1' }, followup: (m: unknown) => { sent.push(m as never) } },
  }
}

const invocation = (rawInput: string, agent: unknown) => ({ rawInput, agent })

/** 控制动作不需要 followup（命令直接落领域）。 */
const AGENTLESS = { session: { id: 'session-1' } }

/** 假命令面：留住注册项，供断言与调用。 */
function fakeCommands() {
  const registered: Array<{ name: string; input: { hint: string }; handler: (i: { rawInput: string; agent: unknown }) => Promise<{ kind: string; text: string }> }> = []
  return { registered, surface: { register: (d: never) => { registered.push(d); return undefined } } }
}

describe('\`/work\` · 语法与声明（与 /goal 逐字同形）', () => {
  it('缺省 = 看状态；控制词 pause / resume / clear（discard 作老写法别名）', () => {
    expect(parseWorkCommand('')).toEqual({ kind: 'show' })
    expect(parseWorkCommand('PAUSE')).toEqual({ kind: 'pause' })
    expect(parseWorkCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseWorkCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseWorkCommand('discard')).toEqual({ kind: 'clear' })
    expect(parseWorkCommand('EDIT')).toEqual({ kind: 'invalid-edit' })
  })

  it('其余一律当目标（只有自己的控制词被吃掉，同 goal）', () => {
    expect(parseWorkCommand('把登录偶发 500 修掉')).toEqual({ kind: 'create', objective: '把登录偶发 500 修掉' })
    expect(parseWorkCommand('  edit 换成另一个目标 ')).toEqual({ kind: 'edit', objective: '换成另一个目标' })
    // "edit" 开头的整句但不是 `edit ` 形式 ⇒ 是目标（不当成缺参数的 edit）
    expect(parseWorkCommand('editorial 重构')).toEqual({ kind: 'create', objective: 'editorial 重构' })
    expect(parseWorkCommand('全部推倒')).toEqual({ kind: 'create', objective: '全部推倒' })
  })

  it('声明 name / inject（命令面 + 领域服务）', () => {
    expect(name).toBe('command-workprocess')
    expect(inject).toEqual(['commands', 'workprocess'])
  })

  it('投给 agent 的指令：交代要什么与边界，但**不预设阶段表**', () => {
    const create = createInstruction('修掉登录偶发 500')
    expect(create).toContain('修掉登录偶发 500')
    expect(create).toContain('create_workstage')
    expect(create).toContain('自己拆阶段')
    expect(create).not.toContain('prep')      // 命令不替模型猜阶段
    const edit = editInstruction('改成另一件事')
    expect(edit).toContain('update_workstage')
    expect(edit).toContain('原样保留')
  })
})

describe('\`/work\` · 排版（人看的）', () => {
  const status: WorkprocessStatus = {
    objective: '修掉登录偶发 500',
    stages: [
      { key: 'repro', statement: '复现并定位', doneCriteria: [], state: 'active', tasks: [{ id: 'wt:repro:1', stageKey: 'repro', objective: '抓栈', phase: 'active', revision: 1 }] },
      { key: 'fix', statement: '修根因', doneCriteria: [], state: 'pending', tasks: [], closePolicy: 'auto' },
    ],
    currentStageKey: 'repro',
    roundsStarted: 2,
    maxRounds: 20,
  }

  it('状态里能看到：阶段与态、当前阶段、任务、回合、谁该动、能做什么', () => {
    const out = renderWorkStatus('流程（workprocess）', status)
    expect(out.kind).toBe('success')
    expect(out.text).toContain('修掉登录偶发 500')
    expect(out.text).toContain('▶ repro：active（收口 human，任务 0/1）—— 复现并定位')
    expect(out.text).toContain('  fix：pending（收口 auto，任务 0/0）—— 修根因')
    expect(out.text).toContain('· wt:repro:1 active —— 抓栈')
    expect(out.text).toContain('已准入回合：2/20')
    expect(out.text).toContain('自动投递续跑回合')
    expect(out.text).toContain('/work pause')
    expect(out.text).toContain('/work edit <目标>')
  })

  it('全阶段收口时不编"完成"，如实说"成没成是判据"', () => {
    const done: WorkprocessStatus = { ...status, currentStageKey: undefined, stages: status.stages.map((s) => ({ ...s, state: 'done' as const })) }
    expect(renderWorkStatus('流程', done).text).toContain('流程没有"完成"态')
  })
})

describe('\`/work\` · handler 分派（假服务）', () => {
  const stub = (over: Partial<WorkprocessService> = {}): WorkprocessService => ({
    view: async () => undefined,
    discard: async () => false,
    pauseActive: async () => [],
    resumePaused: async () => [],
    ...over,
  })
  const view: WorkprocessStatus = { objective: 'x', stages: [], roundsStarted: 0 }

  it('没有流程时：<目标> 投话建流程（不碰内核）；控制动作给人话错误', async () => {
    const { sent, agent } = fakeAgent()
    const handler = workCommandHandler(stub())
    const created = await handler(invocation('把登录 500 修掉', agent))
    expect(created.kind).toBe('success')
    expect(created.text).toContain('已把目标交给 agent')
    expect(sent).toHaveLength(1)
    expect(sent[0].content[0].text).toContain('把登录 500 修掉')
    // 来源自署 user（人敲的命令发起的一轮）——真人专属动作据此落章
    expect(sent[0].source).toEqual({ kind: 'user' })

    expect((await handler(invocation('', agent))).text).toContain('还没有流程')
    expect((await handler(invocation('pause', agent))).kind).toBe('error')
    expect((await handler(invocation('edit 换个目标', agent))).kind).toBe('error')
    expect((await handler(invocation('edit', agent))).kind).toBe('error')
    expect(sent).toHaveLength(1)   // 上面这些都没投话
  })

  it('已有流程时：<目标> 不再建（指路 edit / clear）；edit <目标> 才投话', async () => {
    const { sent, agent } = fakeAgent()
    const handler = workCommandHandler(stub({ view: async () => view }))
    const again = await handler(invocation('再建一条', agent))
    expect(again.kind).toBe('error')
    expect(again.text).toContain('已经有一条流程')
    expect(sent).toHaveLength(0)

    const edited = await handler(invocation('edit 换成新目标', agent))
    expect(edited.kind).toBe('success')
    expect(edited.text).toContain('已让 agent 把流程目标改成')
    expect(sent).toHaveLength(1)
    expect(sent[0].content[0].text).toContain('换成新目标')
  })

  it('agent 不支持 followup：如实报错（命令不替它建流程）', async () => {
    const handler = workCommandHandler(stub())
    const out = await handler(invocation('随便一个目标', { session: { id: 'session-1' } }))
    expect(out.kind).toBe('error')
    expect(out.text).toContain('不支持 followup')
  })

  it('回归：followup 必须**以方法调用**发出（宿主 AgentLoop.followup 内部走 this.send）', async () => {
    // 宿主的 followup 是原型方法（内部用 this）：把方法摘进变量再调会让 this 变 undefined，
    // 真机症状 = "Cannot read properties of undefined (reading 'send')"。
    class ProtoAgent {
      readonly session = { id: 'session-1' }
      readonly sent: unknown[] = []
      followup(message: unknown): void {
        this.sent.push(message)
      }
    }
    const agent = new ProtoAgent()
    const out = await workCommandHandler(stub())(invocation('把登录 500 修掉', agent))
    expect(out.kind).toBe('success')
    expect(agent.sent).toHaveLength(1)
  })

  it('clear / pause / resume 如实回报（含"无事可做"）', async () => {
    const handler = workCommandHandler(stub({
      view: async () => view, discard: async () => true, pauseActive: async () => ['wt:a:1'],
    }))
    expect((await handler(invocation('clear', AGENTLESS))).text).toContain('已丢弃')
    expect((await handler(invocation('pause', AGENTLESS))).text).toContain('已暂停：wt:a:1')
    expect((await handler(invocation('resume', AGENTLESS))).text).toContain('没有被暂停的任务')
  })

  it('服务拒绝变成人话错误（不甩栈）', async () => {
    const handler = workCommandHandler(stub({ view: async () => { throw new Error('归属记录损坏') } }))
    const out = await handler(invocation('', AGENTLESS))
    expect(out.kind).toBe('error')
    expect(out.text).toContain('归属记录损坏')
  })
})

describe('\`/work\` · 真接线（apply 注册 + 真服务 + 真内核）', () => {
  async function seeded() {
    const store = mapStore()
    const deps = { store, now: () => 1_000 }
    await createWorkProcess(deps, 'session-1', {
      objective: '修 bug', stages: [{ key: 'repro', statement: '复现' }],
    })
    await startWorkStage(deps, 'session-1', 'repro')
    await createWorkTask(deps, 'session-1', { stageKey: 'repro', objective: '抓栈' })
    const commands = fakeCommands()
    const service = createWorkprocessService(store)
    apply({ commands: commands.surface, workprocess: service } as never)
    return { store, commands, service }
  }

  it('注册 /work（hint 带目标与 edit）；看状态能看到真阶段表，pause/resume/clear 真改状态', async () => {
    const { store, commands } = await seeded()
    expect(commands.registered.map((c) => c.name)).toEqual(['work'])
    expect(commands.registered[0].input.hint).toContain('<目标>')
    expect(commands.registered[0].input.hint).toContain('edit')

    const show = await commands.registered[0].handler(invocation('', AGENTLESS))
    expect(show.kind).toBe('success')
    expect(show.text).toContain('repro：active')
    expect(show.text).toContain('· wt:repro:1 active —— 抓栈')

    expect((await commands.registered[0].handler(invocation('pause', AGENTLESS))).text).toContain('已暂停：wt:repro:1')
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('paused')

    expect((await commands.registered[0].handler(invocation('resume', AGENTLESS))).text).toContain('已恢复：wt:repro:1')
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('active')

    // 已有流程时给目标：不重建（命令不碰内核），只指路
    const again = await commands.registered[0].handler(invocation('换个目标重来', AGENTLESS))
    expect(again.kind).toBe('error')
    expect(await workProcessOf({ store }, 'session-1')).toBeDefined()

    expect((await commands.registered[0].handler(invocation('clear', AGENTLESS))).text).toContain('已丢弃')
    expect(await workProcessOf({ store }, 'session-1')).toBeUndefined()
  })
})
