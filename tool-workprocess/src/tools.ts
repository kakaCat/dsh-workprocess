/**
 * `defineTool` 工具壳（**协议转换层**）：把登记表的登记项与处理器的处理器绑成宿主工具。
 *
 * 【命名与形状对齐宿主 dsh】工具名 = `get_* / create_* / update_*`（动词在前）；
 * **状态变更收进 `update` 的 `action`**（对齐 `update_goal(action, …)`），
 * 不再为单个动词各开一个工具。
 *
 * 【单一手写清单仍是 registry】工具名与自述都从 `WORK_TOOL_REGISTRY` 取——缺条目在**装配期**
 * 就抛（不静默造壳）；参数表写在这里是因为它属于协议面（模型看的 schema），不属于领域登记。
 *
 * 【职责边界】壳不做任何状态判断：`execute` 直接转发给 `handlers.ts`。
 *
 * @module tool-workprocess/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WORK_TOOL_REGISTRY, type WorkToolRegistryEntry } from './registry.js'
import {
  createWorkstage, createWorktask, getWorkstage, getWorktask, updateWorkstage, updateWorktask,
  type WorkToolDeps, type WorkToolReply,
} from './handlers.js'

/** 处理器表（键与 `registry.handler` 逐字对应；用例逐条核可达性）。 */
const HANDLERS = {
  getWorkstage, createWorkstage, updateWorkstage, getWorktask, createWorktask, updateWorktask,
} as const

type WorkToolHandler = (deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown) => Promise<WorkToolReply>

/** 登记项查找（唯一手写清单是 registry；缺条目 = 装配期错误）。 */
function entryOf(handler: string): WorkToolRegistryEntry {
  const found = WORK_TOOL_REGISTRY.find((e) => e.handler === handler)
  if (found === undefined) throw new Error('工具登记表缺条目：' + handler + '（请同时补 src/registry.ts）')
  return found
}

/** 归属参数（六个工具共用；缺省 = 组合根注入本会话绑定的归属）。 */
const SCOPE_PARAM = { type: 'string', description: '归属域键：这条流程挂在谁名下（宿主可用会话 id，项目侧可用工作区/项目 id）；缺省 = 组合根注入的本会话绑定归属。' } as const
const STAGE_KEY_PARAM = { type: 'string', description: '阶段键（阶段表里的 key）；从 get_workstage 的回执取。action=discard（丢流程）时不需要。' } as const
const TASK_ID_PARAM = { type: 'string', description: '任务 id（wt:<阶段键>:<序号>）；从 create_worktask / get_worktask 的回执取。' } as const
const REVISION_PARAM = { type: 'number', description: 'CAS：给 get 里读到的 revision（旧值即拒——先 get 再改）。' } as const
const OBJECTIVE_PARAM = { type: 'string', description: '这个工作单元要达成什么（写成可核验的陈述）。' } as const
const MAX_ROUNDS_PARAM = { type: 'number', description: '自动续跑回合上限；缺省 = 由组合根按阶段回落。' } as const

/** 回执 schema：字段随工具不同，故放开；`render` 给宿主一行摘要。 */
const REPLY_SCHEMA = { type: 'object', additionalProperties: true } as const

/** 回执摘要（人看的一行；不改变语义）。 */
function renderReply(toolName: string, value: unknown): string {
  const o = (value ?? {}) as Record<string, unknown>
  if (o.success !== true) return toolName + ' 未成功：' + String(o.error ?? '未知原因')
  if (Array.isArray(o.stages)) {
    const list = o.stages as Array<{ state?: string }>
    return toolName + '：' + list.filter((s) => s.state === 'done').length + '/' + list.length + ' 阶段已收口'
      + (o.current_stage === undefined || o.current_stage === null ? '（全部收口）' : '（当前 ' + String(o.current_stage) + '）')
  }
  if (Array.isArray(o.tasks)) return toolName + '：' + o.tasks.length + ' 个任务'
  if (o.changed === false) {
    return toolName + '：无变更' + (o.reason === undefined ? '' : '（' + String(o.reason) + '）')
  }
  if (typeof o.task_id === 'string') return toolName + '：' + o.task_id
  return toolName + '：完成'
}

/** 造一个工具壳（名字与自述来自登记表；execute 直接转发处理器）。 */
function buildTool(deps: WorkToolDeps, handler: keyof typeof HANDLERS, parameters: Record<string, unknown>) {
  const entry = entryOf(handler)
  const run = HANDLERS[handler] as WorkToolHandler
  return defineTool({
    name: entry.toolName,
    description: entry.description,
    parameters,
    output: {
      schema: REPLY_SCHEMA,
      // 宿主口径（@deepseek-ai/dsh-tools 的 `output.render`）：**返回 ContentBlock[]**——
      // 喂给模型的是内容块，不是一行字符串。返回裸字符串会在宿主侧炸成 `content.some is not a function`。
      // 注意形参序：宿主是 `render(args, value)`——渲染的是**第二个**（回执值），读错了只会渲染出一行"未成功"。
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderReply(entry.toolName, value) }],
    },
    execute: async (args: Record<string, unknown>, exec: unknown) => run(deps, args, exec),
  } as never)
}

/** `get_workstage`：读阶段表 + 当前阶段 + 串行门 + 收口条件。 */
export function defineGetWorkstageTool(deps: WorkToolDeps) {
  return buildTool(deps, 'getWorkstage', { scope: SCOPE_PARAM })
}

/** `create_workstage`：建流程（带阶段表）或整体替换阶段表。 */
export function defineCreateWorkstageTool(deps: WorkToolDeps) {
  return buildTool(deps, 'createWorkstage', {
    scope: SCOPE_PARAM,
    objective: { type: 'string', description: '这条流程要达成什么（只在**建流程**时必填）。' },
    stages: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      description: '阶段表（数组顺序即**串行顺序**）：[{ key, statement, done_criteria?, close_policy? }]；'
        + 'close_policy: human（缺省，人工确认收口）/ auto（任务全完成即自动收口）。',
    },
    revision: REVISION_PARAM,
  })
}

/** `update_workstage`：阶段态变更（action=done 收口落定 / action=edit 改流程目标 / action=discard 丢弃整条流程）。 */
export function defineUpdateWorkstageTool(deps: WorkToolDeps) {
  return buildTool(deps, 'updateWorkstage', {
    scope: SCOPE_PARAM,
    stage_key: STAGE_KEY_PARAM,
    action: {
      type: 'string',
      enum: ['done', 'edit', 'discard'],
      description: 'done = 阶段收口落定，按**本阶段的收口策略**判谁来落：human（缺省）= **真人专属**（人工确认）；'
        + 'auto = 本回合（驱动器决策）可自动落 done。两条路都必须任务非空且全部 complete。'
        + 'edit = **改流程目标**（要 objective；对齐宿主 update_goal 的 edit；**真人专属**——阶段与任务原样保留）。'
        + 'discard = **丢弃整条流程**（不需要 stage_key；不可逆：流程与任务墓碑一起消失、回合计数归零；**真人专属**）。'
        + '注意**阶段开工不是本工具的动词**——串行门放行后由驱动器开工。',
    },
    objective: { type: 'string', description: 'edit 用：这条流程改成要达成什么（替换原目标）。' },
    revision: REVISION_PARAM,
  })
}

/** `get_worktask`：读任务（一条 / 一阶段 / 全部）。 */
export function defineGetWorktaskTool(deps: WorkToolDeps) {
  return buildTool(deps, 'getWorktask', { scope: SCOPE_PARAM, stage_key: STAGE_KEY_PARAM, task_id: TASK_ID_PARAM })
}

/** `create_worktask`：在某阶段建任务（身份由内核分配，回执给 task_id）。 */
export function defineCreateWorktaskTool(deps: WorkToolDeps) {
  return buildTool(deps, 'createWorktask', {
    scope: SCOPE_PARAM,
    stage_key: STAGE_KEY_PARAM,
    objective: OBJECTIVE_PARAM,
    max_rounds: MAX_ROUNDS_PARAM,
    revision: REVISION_PARAM,
  })
}

/** `update_worktask`：任务态变更（一个工具 + action，对齐宿主 `update_goal`）。 */
export function defineUpdateWorktaskTool(deps: WorkToolDeps) {
  return buildTool(deps, 'updateWorktask', {
    scope: SCOPE_PARAM,
    task_id: TASK_ID_PARAM,
    action: {
      type: 'string',
      enum: ['edit', 'pause', 'resume', 'block', 'complete', 'clear'],
      description: 'edit（改陈述 / 回合上限）与 resume（继续）需要**人直接发起**；'
        + 'pause（被中断）/ block（等依赖或等人裁，原因必填）/ complete（真的达成了）由 agent 发起；'
        + 'clear（撤掉误建的工作单元，编号不复用）。',
    },
    objective: { type: 'string', description: 'edit 用：换掉任务陈述（至少要给 objective 或 max_rounds 之一）。' },
    max_rounds: MAX_ROUNDS_PARAM,
    reason: { type: 'string', description: 'block 必填：被什么挡住、等谁。' },
    reason_code: { type: 'string', description: 'block 的原因分类（lower-kebab-case，缺省 blocked）。' },
    revision: REVISION_PARAM,
  })
}

/** 六个工具的工厂（键 = `registry.handler`，值 = 工厂）——插件按登记表顺序逐个装配。 */
export const WORK_TOOL_FACTORIES = {
  getWorkstage: defineGetWorkstageTool,
  createWorkstage: defineCreateWorkstageTool,
  updateWorkstage: defineUpdateWorkstageTool,
  getWorktask: defineGetWorktaskTool,
  createWorktask: defineCreateWorktaskTool,
  updateWorktask: defineUpdateWorktaskTool,
} as const
