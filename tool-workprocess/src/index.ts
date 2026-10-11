/**
 * tool-workprocess：workprocess 的**工具面**（两层各三工具，见 `./registry.js`）。
 *
 * 【职责边界】工具壳只做协议转换（参数校验 / 回执形状 / 渲染）；状态规则全在 `workprocess` 内核；
 * 授权判据在 `./authority.js`（`task_resume` 恒为真人专属；`stage_done` 按阶段收口策略判：
 * `human` = 真人专属，`auto` = 自治回合放行）。
 *
 * 【装配】`./plugin.js` 是独立插件入口（把六个工具注册进宿主 `tools` 服务）；
 * 依赖由组合根注入（`WorkToolDeps`），本面不自行装配存储。
 *
 * @module tool-workprocess
 */
export * from './registry.js'
export * from './authority.js'
export * from './handlers.js'
export * from './tools.js'
