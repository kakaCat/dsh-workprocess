/**
 * workprocess 浏览器半的**模块面**（客户端插件入口）。
 *
 * 【产物契约】构建后 `lib/client.js` 是宿主模块加载器认的形态：
 * `window.__ModuleLoader__.load({ id: 'workprocess', factory: (require) => … })`——
 * `react` 与 `react/jsx-runtime` 走 `require`（宿主模块表提供），其余全部内联。
 *
 * 【依赖纪律】只 `require('react')`：状态点 / 图标是内联 SVG，样式由 CSS Modules
 * 在构建期编译并在本模块执行时注入 `<style data-plugin-css>`，不 require 任何 `@deepseek-ai/*`
 * 客户端包（模块表里有没有那个包不由我们决定）。
 *
 * 【数据面】`GET /workprocess/api/stages?scope=`（首次全量）+ `GET /workprocess/api/events?scope=`
 * （SSE）——字段见 `tool-workprocess/src/http.ts`，本层只消费不解释。
 *
 * 【为什么数据面不是会话投影】goal 的 UI 读 `useProjection('goal')`，但它**在仓内**：投影只吃
 * 会话事件，而仓外插件写不了自定义会话事件（见 `workprocess/README.md`「状态放在哪」）。
 *
 * @module workprocess/client
 */
import { StageDock } from './StageDock.js'
import { dockActivationBadge, stageDotState, taskDotState, viewModelOf } from './model.js'

/** 模块面名（宿主日志 / 诊断用；与包名区分开）。 */
export const name = 'workprocess/client'

/** 装配依赖：dock 槽服务。 */
export const inject = ['slots']

/**
 * 测试口：穷举映射与降级裁决是纯函数，node 里直接断言（不渲染 React）——
 * 见 `tests/client.spec.ts`。
 */
export const internals = { stageDotState, taskDotState, viewModelOf, dockActivationBadge }

/** dock 槽与条目的注册面（结构最小化：只声明本模块用到的两个动词）。 */
interface SlotRegistry {
  inject(key: string, thunk: () => void): void
  register(options: { name: string, id: string, order: number }, occupant: unknown): void
}

/** 本模块装配到的客户端上下文面。 */
export interface ClientContext {
  readonly slots: SlotRegistry
}

/**
 * 装配：把「阶段」条注册进 composer 上方的 dock 槽（与 todo / goal 并列，排在它们之后）。
 *
 * @param ctx - 客户端根上下文（只用到 `slots`）。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'workprocess', order: 20 },
    StageDock,
  ))
}
