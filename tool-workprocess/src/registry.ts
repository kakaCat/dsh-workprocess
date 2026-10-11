/**
 * workprocess 工具登记面 —— **唯一手写清单**。
 *
 * 【命名口径：对齐宿主 dsh】`get_* / create_* / update_*`（**动词在前**），
 * 且**状态变更收进 `update` 的 `action`**（对齐宿主 `get_goal / create_goal / update_goal`）：
 *   · `get_workstage` / `create_workstage` / `update_workstage`（层1：阶段表与收口确认）
 *   · `get_worktask` / `create_worktask` / `update_worktask`（层2：任务的相位迁移）
 *
 * 【与宿主的两处必然差异】
 *   ① 六个而不是三个：workprocess **分两层**（宿主只有单层 goal），故两层各一套；
 *   ② 动词集不同：`resume` 与 `edit` 是真人专属（同宿主），`clear` 是本包加项
 *      （撤掉误建的工作单元；宿主"一会话一 goal"没有这个动作）。
 *
 * 同款纪律：注册名与处理器名的期望值都从本表派生，
 * 漏登记当场被门禁点名。加工具 = 本表补一条 + `handlers.ts` 补一个处理器 + `tools.ts` 补一个壳。
 *
 * @module tool-workprocess/registry
 */

export interface WorkToolRegistryEntry {
  /** 处理器键（`handlers.ts` 的导出名，门禁用逐字扫它；也是 `WORK_TOOL_FACTORIES` 的键）。 */
  handler: string
  /** 宿主的工具注册名。 */
  toolName: string
  /** 属于哪一层（自述 + 门禁据此核对两层都有）。 */
  layer: 'stage' | 'task'
  /** 一句话自述（进提示词与门禁快照）。 */
  description: string
}

/** 6 条 = 两层 × 三工具（get / create / update）。 */
export const WORK_TOOL_REGISTRY: readonly WorkToolRegistryEntry[] = [
  {
    handler: 'getWorkstage',
    toolName: 'get_workstage',
    layer: 'stage',
    description: '读阶段表（数组顺序即串行顺序）与当前阶段 / 串行门 / 是否具备收口条件',
  },
  {
    handler: 'createWorkstage',
    toolName: 'create_workstage',
    layer: 'stage',
    description: '建流程（带阶段表：key / statement / done_criteria? / close_policy?）或整体替换阶段表：同名阶段保留其任务与态，会丢掉非空阶段的一律拒',
  },
  {
    handler: 'updateWorkstage',
    toolName: 'update_workstage',
    layer: 'stage',
    description: '阶段态变更：action=done（阶段收口，本阶段任务须非空且全部 complete）——策略 human 时**真人专属**，策略 auto 时可由驱动器自动落；action=discard（丢弃整条流程，不可逆，**真人专属**）',
  },
  {
    handler: 'getWorktask',
    toolName: 'get_worktask',
    layer: 'task',
    description: '读任务（层2：相位 / 陈述 / revision / 阻塞原因）',
  },
  {
    handler: 'createWorktask',
    toolName: 'create_worktask',
    layer: 'task',
    description: '在某阶段建任务（身份由服务分配 `wt:<阶段键>:<序号>`，清掉的不复用）',
  },
  {
    handler: 'updateWorktask',
    toolName: 'update_worktask',
    layer: 'task',
    description: '任务态变更：edit / pause / resume / block / complete / clear（edit 与 resume = **真人专属**；block 必填原因）',
  },
]
