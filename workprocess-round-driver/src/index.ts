/**
 * workprocess-round-driver：以**两层工作模型**为基础的回合驱动器。
 *
 * 本包是**库而非插件**（对齐宿主 `goal-round-driver`）：
 * 没有独立挂载项、没有配置项，由组合根接成驱动器后随插件生效。
 *
 * 导出的三件事：
 *   · `decideWorkRound` —— 纯决策树（闸 + 层1 串行门 + 层2 相位机）；
 *   · `renderWorkRoundPrompt` —— 纯提示词渲染；
 *   · 契约类型（事实 / 闸 / 结论）—— 端口与适配面的唯一形状来源。
 *
 * @module workprocess-round-driver
 */
export * from './types.js'
export * from './decide.js'
export * from './prompt.js'
