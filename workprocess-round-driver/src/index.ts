/**
 * workprocess-round-driver：**回合驱动器插件**（对齐宿主 `@deepseek-ai/dsh-goal-round-driver`）。
 *
 * 【一个包，两种东西】同时导出**纯决策层**与**运行时壳**：
 *   · 纯层：`decideWorkRound`（决策树）/ `renderWork*Prompt`（提示词）/ 契约类型——零 I/O，可穷举单测；
 *   · 壳层：`apply(ctx, config)`（`plugin.ts`）——结构照宿主 `dsh-goal-round-driver`：每 agent 一张
 *     state、触发合并成一条串行 run、`agent/inbox/*` 竞态围栏、耐久检查点、`followup` 预约投递；
 *     数据只经 `ctx.workprocess`。
 *
 * 【为什么纯层留在这里而不是内核】决策树与提示词是**驱动器的规则**（闸顺序 / 收口策略 / 回合上限），
 * 与领域内核（两层快照 / 折叠 / 不变量）职责不同；分开之后两边都能穷举单测。
 *
 * @module workprocess-round-driver
 */
export * from './types.js'
export * from './decide.js'
export * from './prompt.js'
export * from './runtime.js'
export { name, inject, apply, type WorkRoundDriverConfig } from './plugin.js'
