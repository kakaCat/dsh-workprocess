/**
 * 工具面**插件入口**的接线测试（第一等插件形态：`name` / `inject` / `apply(ctx, config)`）：
 *   ① 六个工具按登记表顺序注册进 `ctx.tools`，名字逐字一致（不带域前缀）；
 *   ② 策略段注册（`ctx.systemPrompt.section`，槽位取 `TOOL_GOAL`），关掉开关就不注册；
 *   ③ deps 组装：数据口只认 `ctx.workprocess`、归属缺省取本会话、授权/通告/人机确认接上宿主面。
 */
import { describe, it, expect } from 'vitest'
import { apply, inject, name, workToolDepsOf } from 'tool-workprocess'
import { WORK_POLICY_SECTION } from 'tool-workprocess'
import { WORK_TOOL_REGISTRY } from 'tool-workprocess'
import type { Context } from '@deepseek-ai/cordis'

interface Stub {
  registered: Array<{ name?: string }>
  sections: Array<{ name: string; order: number; text: string }>
}

/** 假宿主 ctx：只提供工具面装配要的那几件（结构等价于官方 Context 的对应面）。 */
function stubCtx(): Stub & { ctx: Context } {
  const s: Stub = { registered: [], sections: [] }
  const ctx = {
    workprocess: {
      process: async () => undefined,
      view: async () => undefined,
      createProcess: async () => false,
      defineStages: async () => false,
      editObjective: async () => false,
      closeStage: async () => false,
      createTask: async () => false,
      editTask: async () => false,
      pauseTask: async () => false,
      resumeTask: async () => false,
      blockTask: async () => false,
      completeTask: async () => false,
      clearTask: async () => false,
      discardProcess: async () => false,
      closeProcess: async () => false,
      discard: async () => false,
      pauseActive: async () => [],
      resumePaused: async () => [],
    },
    tools: { register: (t: { name?: string }) => { s.registered.push(t); return () => {} } },
    agents: { get: () => undefined, currentInitiator: () => undefined },
    sessionProjections: { stateOf: () => undefined },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => { s.sections.push(section); return () => {} },
      getSectionOrder: (key: string) => (key === 'TOOL_GOAL' ? 2400 : 0),
    },
    get: () => undefined,
  }
  return { ...s, ctx: ctx as unknown as Context }
}

describe('工具面插件入口（apply / name / inject）', () => {
  it('声明 name / inject：工具 + 领域服务 + 授权判据面 + 策略段面', () => {
    expect(name).toBe('tool-workprocess')
    expect(inject).toEqual(['tools', 'workprocess', 'agents', 'sessionProjections', 'systemPrompt'])
  })

  it('六个工具按登记表顺序注册，名字逐字一致', () => {
    const stub = stubCtx()
    apply(stub.ctx)
    expect(stub.registered.map((t) => t.name)).toEqual(WORK_TOOL_REGISTRY.map((e) => e.toolName))
  })

  it('策略段注册到 TOOL_GOAL 槽位；config.policySection=false ⇒ 不注册', () => {
    const on = stubCtx()
    apply(on.ctx)
    expect(on.sections.map((x) => x.name)).toEqual([WORK_POLICY_SECTION])
    expect(on.sections[0].order).toBe(2400)
    expect(on.sections[0].text).toContain('阶段严格串行')

    const off = stubCtx()
    apply(off.ctx, { policySection: false })
    expect(off.registered).toHaveLength(WORK_TOOL_REGISTRY.length)   // 工具照注册
    expect(off.sections).toEqual([])                                  // 只是没有策略段
  })

  it('deps 组装：数据口 = ctx.workprocess；归属缺省取本会话；授权/通告/人机确认已接上', () => {
    const stub = stubCtx()
    const deps = workToolDepsOf(stub.ctx)
    expect(deps.domain).toBe((stub.ctx as unknown as { workprocess: unknown }).workprocess)
    expect(deps.defaultScope?.({ agent: { session: { id: 'session-1' } } })).toBe('session-1')
    expect(deps.defaultScope?.({})).toBeUndefined()
    expect(typeof deps.resolveAuthority).toBe('function')
    expect(typeof deps.deferNotice).toBe('function')
    expect(typeof deps.askHuman).toBe('function')
    // 通告口在 exec 没有 deferContext 时静默不发（降级不抛）。
    expect(() => deps.deferNotice?.({}, { summary: 's', text: 't' })).not.toThrow()
    // 没有 userQuestions 服务 ⇒ no-channel（绝不把"没问成"当同意）。
    return deps.askHuman?.({}, {
      id: 'x', header: 'h', question: 'q', options: [{ label: 'ok' }], approve: 'ok',
    }).then((verdict) => expect(verdict).toEqual({ kind: 'no-channel' }))
  })
})
