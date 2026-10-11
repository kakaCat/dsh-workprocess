/**
 * `/work` 命令行（独立包）：语法 / 排版 / 分派 / **真服务接线**。
 *
 * 【守护什么】
 *   ① 语法：只认 show（缺省）/ pause / resume / discard，别的如实报错；
 *   ② 排版：走到哪了 / 谁该动 / 能做什么——人一眼能读懂；
 *   ③ 接线：`apply` 真的把它注册进 `ctx.commands`（inject 只要 commands + workprocess）；
 *   ④ 动作真的落到内核上：pause / resume / discard 改的是真流程（不是演示用的假话）。
 */
import { describe, it, expect } from 'vitest'
import { apply, inject, name, parseWorkCommand, renderWorkStatus, workCommandHandler } from 'dsh-command-workprocess'
import { createWorkprocessService } from 'dsh-workprocess'
import type { WorkprocessService, WorkprocessStatus } from 'dsh-workprocess'
import {
  createWorkProcess, createWorkTask, startWorkStage, workProcessOf,
} from 'workprocess-core'
import type { WorkRecordLike, WorkStoreLike } from 'workprocess-core'

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

const AGENT = { session: { id: 'session-1' } }
const invocation = (rawInput: string) => ({ rawInput, agent: AGENT })

/** 假命令面：留住注册项，供断言与调用。 */
function fakeCommands() {
  const registered: Array<{ name: string; input: { hint: string }; handler: (i: { rawInput: string; agent: unknown }) => Promise<{ kind: string; text: string }> }> = []
  return { registered, surface: { register: (d: never) => { registered.push(d); return undefined } } }
}

describe('\`/work\` · 语法与声明', () => {
  it('缺省 = 看状态；只认 pause / resume / discard，其余如实报 unknown', () => {
    expect(parseWorkCommand('')).toEqual({ kind: 'show' })
    expect(parseWorkCommand('PAUSE')).toEqual({ kind: 'pause' })
    expect(parseWorkCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseWorkCommand('discard')).toEqual({ kind: 'discard' })
    expect(parseWorkCommand('全部推倒')).toEqual({ kind: 'unknown', raw: '全部推倒' })
  })

  it('声明 name / inject（命令面 + 领域服务）', () => {
    expect(name).toBe('command-workprocess')
    expect(inject).toEqual(['commands', 'workprocess'])
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

  it('没有流程时：看状态给人话，动作用 error（不假装成功）', async () => {
    const handler = workCommandHandler(stub())
    expect((await handler(invocation(''))).text).toContain('还没有流程')
    expect((await handler(invocation('pause'))).kind).toBe('error')
    expect((await handler(invocation('瞎写'))).kind).toBe('error')
  })

  it('discard / pause / resume 如实回报（含"无事可做"）', async () => {
    const view: WorkprocessStatus = { objective: 'x', stages: [], roundsStarted: 0 }
    const handler = workCommandHandler(stub({ view: async () => view, discard: async () => true, pauseActive: async () => ['wt:a:1'] }))
    expect((await handler(invocation('discard'))).text).toContain('已丢弃')
    expect((await handler(invocation('pause'))).text).toContain('已暂停：wt:a:1')
    expect((await handler(invocation('resume'))).text).toContain('没有被暂停的任务')
  })

  it('服务拒绝变成人话错误（不甩栈）', async () => {
    const handler = workCommandHandler(stub({ view: async () => { throw new Error('归属记录损坏') } }))
    const out = await handler(invocation(''))
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

  it('注册 /work；看状态能看到真阶段表，pause/resume/discard 真改状态', async () => {
    const { store, commands } = await seeded()
    expect(commands.registered.map((c) => c.name)).toEqual(['work'])
    expect(commands.registered[0].input.hint).toContain('pause')

    const show = await commands.registered[0].handler(invocation(''))
    expect(show.kind).toBe('success')
    expect(show.text).toContain('repro：active')
    expect(show.text).toContain('· wt:repro:1 active —— 抓栈')

    expect((await commands.registered[0].handler(invocation('pause'))).text).toContain('已暂停：wt:repro:1')
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('paused')

    expect((await commands.registered[0].handler(invocation('resume'))).text).toContain('已恢复：wt:repro:1')
    expect((await workProcessOf({ store }, 'session-1'))!.stages[0].tasks[0].phase).toBe('active')

    expect((await commands.registered[0].handler(invocation('discard'))).text).toContain('已丢弃')
    expect(await workProcessOf({ store }, 'session-1')).toBeUndefined()
  })
})
