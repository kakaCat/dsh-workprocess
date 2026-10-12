/**
 * 浏览器半产物 `lib/client.js` 的**装载与映射契约测试**（node 环境，stub 掉 loader / React / DOM）。
 *
 * 【守护什么】（对应 implement:2 的验收）
 *   ① loader 形态：注册 id 必须 === 包名；factory 返回模块面（name / inject / apply）；
 *   ② `apply` 后**确实注册进 `conversation.input.dock`**（name / id / order 逐字）；
 *   ③ 穷举映射无兜底：阶段 3 态 / 任务 4 相位的取值表钉死，未知输入返回 undefined；
 *   ④ 降级三态裁决：loading（未拿到）/ none（无流程）/ error（未成功就失败）/ ready（含 stale 标灰）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'

interface LoaderSpec {
  id: string
  factory: (require: (id: string) => unknown) => {
    name: string
    inject: readonly string[]
    internals: {
      stageDotState: (state: string) => string | undefined
      taskDotState: (phase: string) => string | undefined
      viewModelOf: (snapshot: unknown, failed: boolean) => { kind: string; wire?: unknown; stale?: boolean }
    }
    apply: (ctx: unknown) => void
  }
}

let spec: LoaderSpec
const savedWindow = (globalThis as Record<string, unknown>).window

function loadSpec(): LoaderSpec {
  let captured: LoaderSpec | undefined
  ;(globalThis as Record<string, unknown>).window = {
    __ModuleLoader__: { load: (s: LoaderSpec) => { captured = s } },
  }
  try {
    const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    new Function(src)()
  } finally {
    ;(globalThis as Record<string, unknown>).window = savedWindow
  }
  return captured!
}

/** 最小 React stub：factory 只解构不调用（hooks 在组件渲染时才用，node 里不渲染）。
 *  自动 JSX 运行时（`jsx` / `jsxs` / `Fragment`）也在这里：产物是 CJS，顶层就会 `require('react/jsx-runtime')`。 */
const reactStub = {
  createElement: () => ({}),
  useEffect: () => undefined,
  useState: (v: unknown) => [v, () => undefined],
  jsx: () => ({}),
  jsxs: () => ({}),
  Fragment: () => ({}),
}

function face() {
  return spec.factory((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return reactStub
    throw new Error('意外的 require：' + id)
  })
}

beforeAll(() => {
  spec = loadSpec()
})

afterAll(() => {
  ;(globalThis as Record<string, unknown>).window = savedWindow
})

describe('loader 形态与槽位注册', () => {
  it('注册 id === 包名；模块面 name / inject 正确', () => {
    expect(spec.id).toBe('workprocess')
    const m = face()
    expect(m.name).toBe('workprocess/client')
    expect(m.inject).toEqual(['slots'])
  })

  it('apply 后注册 conversation.input.dock 条目（name / id / order 逐字）', () => {
    const m = face()
    const registered: Array<{ opts: Record<string, unknown>; occupant: unknown }> = []
    const ctx = {
      slots: {
        inject: (key: string, thunk: () => void) => {
          expect(key).toBe('conversation.input.dock')
          thunk()
        },
        register: (opts: Record<string, unknown>, occupant: unknown) => {
          registered.push({ opts, occupant })
        },
      },
    }
    m.apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0].opts).toEqual({ name: 'conversation.input.dock', id: 'workprocess', order: 20 })
    expect(typeof registered[0].occupant).toBe('function')
  })
})

describe('穷举映射（无兜底）', () => {
  it('阶段 3 态 → StateDot 视觉态，未知 ⇒ undefined', () => {
    const { stageDotState } = face().internals
    expect(stageDotState('pending')).toBe('idle')
    expect(stageDotState('active')).toBe('ongoing')
    expect(stageDotState('done')).toBe('done')
    expect(stageDotState('whatever')).toBeUndefined()
  })

  it('任务 4 相位 → StateDot 视觉态，未知 ⇒ undefined', () => {
    const { taskDotState } = face().internals
    expect(taskDotState('active')).toBe('ongoing')
    expect(taskDotState('paused')).toBe('idle')
    expect(taskDotState('blocked')).toBe('warning')
    expect(taskDotState('complete')).toBe('done')
    expect(taskDotState('whatever')).toBeUndefined()
  })
})

describe('降级三态裁决', () => {
  it('尚未拿到 + 未失败 = loading（不渲染）；尚未拿到 + 失败 = error（灰化行）', () => {
    const { viewModelOf } = face().internals
    expect(viewModelOf(undefined, false)).toEqual({ kind: 'loading' })
    expect(viewModelOf(undefined, true)).toEqual({ kind: 'error' })
  })

  it('帧说无流程 = none（整条不渲染，绝不显示 0/0）', () => {
    const { viewModelOf } = face().internals
    expect(viewModelOf({ scope: 's', process: null }, false)).toEqual({ kind: 'none' })
  })

  it('有帧 = ready；当前取数失败 = stale（保留上一帧并标灰）', () => {
    const { viewModelOf } = face().internals
    const wire = { process_id: 'p', stages: [], current_stage: null, tasks: [] }
    expect(viewModelOf({ scope: 's', process: wire }, false))
      .toEqual({ kind: 'ready', wire, stale: false })
    expect(viewModelOf({ scope: 's', process: wire }, true))
      .toEqual({ kind: 'ready', wire, stale: true })
  })
})
