/**
 * 浏览器半的**纯逻辑**（零 React、零 DOM）：穷举映射 + 降级三态裁决。
 *
 * 【为什么单独一层】这两件事是**设计契约**（`docs/workprocess-ui-design.md` 的 D-2/D-5）：
 * 映射表是闭集、裁决是纯函数，所以它们能在 node 里直接断言（`tests/client.spec.ts` 经模块面的
 * `internals` 取到），不需要渲染 React、不需要 jsdom。
 *
 * @module workprocess/client/model
 */
import type { WorkWire } from '../src/view.js'

/** 数据面一帧：`GET /workprocess/api/stages` 的响应体（`process: null` = 本归属没有流程）。 */
export interface WorkSnapshot {
  readonly scope: string
  readonly process: WorkWire | null | undefined
}

/**
 * 降级三态裁决的结果（闭集，无"其他"兜底）：
 * `loading` = 还没有任何帧（不渲染，与 goal 同款）；`none` = 帧说"无流程"（整条不渲染，不显示 0/0）；
 * `error` = 从未成功过就失败（灰化行）；`ready` = 正常渲染（`stale` = 有旧帧但当前断着，标灰保留）。
 */
export type WorkViewModel =
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready', readonly wire: WorkWire, readonly stale: boolean }

/** 阶段态（3 取值，来自内核 `WorkStageState`）→ `StateDot` 视觉态。 */
const STAGE_DOT: Readonly<Record<string, string | undefined>> = {
  pending: 'idle', active: 'ongoing', done: 'done',
}

/** 任务相位（4 取值，来自内核 `WorkTaskPhase`）→ `StateDot` 视觉态。 */
const TASK_DOT: Readonly<Record<string, string | undefined>> = {
  active: 'ongoing', paused: 'idle', blocked: 'warning', complete: 'done',
}

/** 阶段态文案。 */
export const STAGE_LABEL: Readonly<Record<string, string | undefined>> = {
  pending: '待开工', active: '进行中', done: '已收口',
}

/** 任务相位文案。 */
export const TASK_LABEL: Readonly<Record<string, string | undefined>> = {
  active: '进行中', paused: '已暂停', blocked: '被挡住', complete: '已完成',
}

/** 阶段态 → 视觉态（未知输入返回 `undefined`：**没有兜底**，穷举表就是契约）。 */
export function stageDotState(state: string): string | undefined {
  return STAGE_DOT[state]
}

/** 任务相位 → 视觉态（未知输入返回 `undefined`）。 */
export function taskDotState(phase: string): string | undefined {
  return TASK_DOT[phase]
}

/**
 * 降级三态裁决（纯函数）：输入 = 最近一帧快照（`undefined` = 尚未拿到）+ 取数是否失败。
 *
 * @param snapshot - 最近一帧（whole-value 语义：新帧整份盖掉旧帧）。
 * @param failed - 当前取数是否失败（SSE 断线 / fetch 失败）。
 */
export function viewModelOf(snapshot: WorkSnapshot | undefined, failed: boolean): WorkViewModel {
  if (snapshot === undefined) return failed ? { kind: 'error' } : { kind: 'loading' }
  if (snapshot.process === null || snapshot.process === undefined) return { kind: 'none' }
  return { kind: 'ready', wire: snapshot.process, stale: failed === true }
}
