/**
 * **六个工具**：登记表（唯一手写清单）+ `defineTool` 壳（协议面）+ 处理器（实现）。
 *
 * 【为什么同在一个模块】宿主 `dsh-tool-goal` 的 `index` 区也是"工具定义 + 处理器"放一起
 * （它 3 个工具、逻辑薄）；我们 6 个工具、校验与回执成形更厚，所以把这块整体独立成
 * `tools` 模块，让 `index` 只留装配与常驻策略段。
 *
 * 【命名口径：对齐宿主 dsh】`get_* / create_* / update_*`（动词在前），状态变更收进 `update` 的
 * `action`（对齐 `get_goal / create_goal / update_goal`）：两层各三个工具。
 *
 * @module tool-workprocess/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  WorkError, allTasksOf, applyWorkEvent, currentStageOf, processAllowsClose, stageAllowsStart,
  stageClosePolicyOf, stageIsFinishable,
} from 'workprocess'
import type { WorkprocessService } from 'workprocess'
import type { WorkStage, WorkStageClosePolicy, WorkStageDraft, WorkTask } from 'workprocess'
import {
  isActionAuthorized, requireActionAuthority, workToolExecution,
  type WorkAuthorityAction, type WorkAuthorityContext, type WorkRoundRef, type WorkToolAuthority,
} from './authority.js'

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
    description: '阶段态变更：action=done（阶段收口，本阶段任务须非空且全部 complete）——策略 human 时**真人专属**，策略 auto 时可由驱动器自动落；action=edit（**改流程目标**，要 objective，真人专属）；action=discard（丢弃整条流程，不可逆，**真人专属**）',
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

/** 组合根可注入的依赖（`domain` = `ctx.workprocess` 域服务；判据钩子见 `authority.ts`）。 */
export interface WorkToolDeps {
  /**
   * **领域服务**（`ctx.workprocess`）：工具面**唯一**的数据出入口——不碰 store、不绕内核。
   * 存储域的 `open` 对同名域是响亮拒绝（`already-open`），域只能由领域插件独占，
   * 故工具面经服务读写（对齐宿主 `tool-goal` 调 `ctx.goals.*` 的形状）。
   */
  readonly domain: WorkprocessService
  /** 本回合授权判定（给了就按它判；缺省 = 保守的 autonomous）。 */
  readonly resolveAuthority?: (exec: unknown, expected?: WorkRoundRef) => WorkToolAuthority | undefined
  /** 调用者存活校验（缺省 = 不校验）。 */
  readonly verifyCaller?: (exec: unknown) => { readonly ok: boolean; readonly reason?: string }
  /**
   * **归属域键的缺省**（组合根按调用者投影，如"本会话 id"）。
   * 缺省不接 = 调用方必须显式给 `scope`（工具面不替调用方猜归属）。
   */
  readonly defaultScope?: (exec: unknown) => string | undefined
  /**
   * **落 block 的前置轮数**（缺省 {@link DEFAULT_BLOCKED_AFTER_ROUNDS}，对齐宿主 goal 的
   * `blockedAfterConsecutiveRounds`）：自治回合里，没跑满这么多轮就不许宣告"被挡住"——
   * 防的是"第一轮遇到点难处就停手等人"。真人直接发起不受此限（人在场，随时可以叫停）。
   */
  readonly blockedAfterRounds?: number
  /**
   * 把一条**通告**追加到本次工具回执之后（宿主 `exec.deferContext` 的适配口；缺省 = 不发）。
   *
   * 【为什么需要它（对齐宿主 `dsh-tool-goal`）】宿主 goal 在模型刚落完 `complete` / `blocked`
   * 的那一拍，用 `deferContext` 塞一条 `<goal_complete>` 指令——**收尾消息怎么写、别再调工具**。
   * 位置很关键：通告紧跟在 `tool/result` 之后，**离决策点最近**；写进下一轮的投递提示词就晚了
   * （模型已经多做了好几步）。本面只产出"摘要 + 文本"，**消息形状与来源由组合根定**
   * （本面不 import 宿主 llm 包，端口保持结构化）。
   */
  readonly deferNotice?: (exec: unknown, notice: WorkToolNotice) => void
  /**
   * **工具自己问人**（宿主 `ctx.userQuestions.ask` 的适配口；缺省 = 没弹框通道）。
   *
   * 【为什么要这一口，而不是"让模型用 ask_user_question 问完再自己落章"】宿主把人的答复
   * **只记成 `ask_user_question` 的工具结果**，不产生 `user/message` 事件 ⇒ 授权面看不见，
   * 模型拿到"确认收口"后仍然落不了章（真机踩过）。宿主自己的做法是 **工具内部直接问人**：
   * `plan-mode` 的 `exit_plan_mode` 就是 `ctx.get('userQuestions').ask(...)`，
   * 人同意才动作。本口照此办理：**§人机确认的裁决由工具拿，不由模型转述§**。
   */
  readonly askHuman?: (exec: unknown, request: WorkHumanAsk) => Promise<WorkHumanVerdict>
}

/** 一条人机确认请求（工具问人时给弹框的内容）。 */
export interface WorkHumanAsk {
  /** 问题 id（答案按它回收）。 */
  readonly id: string
  /** 弹框标题。 */
  readonly header: string
  /** 一句话问题。 */
  readonly question: string
  /** 供人复核的细节（阶段陈述 / 达成判据 / 任务清单）。 */
  readonly detail?: string
  /** 选项（第一个之外的顺序由调用方定；`approve` 指向哪个算同意）。 */
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  /** 哪个选项算"同意"。 */
  readonly approve: string
}

/** 人机确认的裁决（四种；**只有 `approved` 算同意**）。 */
export type WorkHumanVerdict =
  | { readonly kind: 'approved' }
  | { readonly kind: 'declined'; readonly feedback?: string }
  /** 人打断了（要去说话）/ 请求被中止 —— 停手等人开口。 */
  | { readonly kind: 'cancelled'; readonly reason: string }
  /**
   * 宿主**没有**弹框通道（或没有 answerer 接下这一问）⇒ 调用方退回原来的"拒绝并指路"路径
   * （CLI / 无头 / 子 agent 场景仍靠它），而不是把"没问成"报成人拒绝了。
   */
  | { readonly kind: 'no-channel' }

/** 一条工具通告（自署来源的模型面指令；形状由组合根落成一条消息）。 */
export interface WorkToolNotice {
  /** 一行摘要（宿主侧进来源的 `summary`，供日志与投影辨认）。 */
  readonly summary: string
  /** 给模型看的话（人话指令；不带宿主专有 API）。 */
  readonly text: string
}

/** 工具回执（普通对象；`success:false` 时带 `code`/`error`）。 */
export type WorkToolReply = Record<string, unknown>

/**
 * 归属域键解析：显式 `scope` 优先；缺省 = 组合根注入的**本调用者归属**（`defaultScope`）。
 * 两处都没有 = 明说的缺失（不猜一个默认归属——那会把两条流程悄悄并成一条）。
 */
function scopeOf(args: Record<string, unknown>, deps: WorkToolDeps, exec?: unknown): string | undefined {
  const raw = args.scope
  if (raw !== undefined) return String(raw)
  const fallback = deps.defaultScope?.(exec)
  return fallback === undefined ? undefined : String(fallback)
}

/** 调用者存活（缺省不校验；接线后由宿主 agents 句柄给判据）。 */
function callerRejection(deps: WorkToolDeps, exec: unknown): string | undefined {
  const verdict = deps.verifyCaller?.(exec)
  if (verdict === undefined || verdict.ok) return undefined
  return verdict.reason ?? 'workprocess 工具要求调用者是当前正在运行的 agent'
}

/** 本回合授权：缺省 autonomous（未接线）；接线后 `undefined` = 无授权。 */
function authorityOf(deps: WorkToolDeps, exec: unknown, expected?: WorkRoundRef): WorkToolAuthority {
  if (deps.resolveAuthority === undefined) return { kind: 'autonomous' }
  return workToolExecution(exec, deps.resolveAuthority, expected).authority
}

/** 收口确认弹框里给人复核的细节（阶段陈述 + 达成判据 + 任务清单）。 */
function stageDetailOf(stage: WorkStage): string {
  const criteria = stage.doneCriteria.length === 0 ? ['（未登记达成判据）'] : stage.doneCriteria.map((c) => '- ' + c)
  const tasks = stage.tasks.length === 0
    ? ['（本阶段没有任务）']
    : stage.tasks.map((t) => '- ' + t.id + ' [' + t.phase + '] ' + t.objective)
  return [
    stage.statement,
    '',
    '达成判据：',
    ...criteria,
    '',
    '本阶段任务：',
    ...tasks,
  ].join('\n')
}

/** 授权门（唯一一份在 `authority.ts`）。 */
function authorize(action: WorkAuthorityAction, authority: WorkToolAuthority, ctx?: WorkAuthorityContext): void {
  requireActionAuthority(action, authority, ctx)
}

/**
 * 记一条**通告**（宿主 `exec.deferContext` 的适配口；没接就静默不发——工具本身照常成功）。
 *
 * 与 `agent.followup` 同款的坑：必须以**方法调用**发出（`exec.deferContext(...)`），
 * 摘成变量再调会让 `this` 变 undefined。故这里只把 exec 原样传给组合根，本面不自己取方法。
 */
function notice(deps: WorkToolDeps, exec: unknown, summary: string, text: string): void {
  deps.deferNotice?.(exec, { summary, text })
}

/** 内核错误 → 结构化回执（不吞不编）。 */
async function guarded(fn: () => Promise<WorkToolReply>): Promise<WorkToolReply> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof WorkError) return { success: false, code: err.code, error: err.message }
    throw err
  }
}

/** 阶段表参数解析（非法即返回人话原因）。 */
function parseStages(args: Record<string, unknown>): readonly WorkStageDraft[] | string {
  const raw = args.stages
  if (!Array.isArray(raw) || raw.length === 0) return 'stages 必填（至少一个阶段：{ key, statement, done_criteria?, close_policy? }）'
  const out: WorkStageDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'stages 里每一项都必须是对象'
    const o = item as Record<string, unknown>
    const key = o.key === undefined ? '' : String(o.key)
    const statement = o.statement === undefined ? '' : String(o.statement)
    if (key.trim() === '' || statement.trim() === '') return '每个阶段都要有非空 key 与 statement'
    const rawPolicy = o.close_policy === undefined ? undefined : String(o.close_policy)
    if (rawPolicy !== undefined && rawPolicy !== 'human' && rawPolicy !== 'auto') {
      return '阶段收口策略只认 human / auto（key=' + key + '，实际 ' + JSON.stringify(rawPolicy) + '）'
    }
    const closePolicy = rawPolicy as WorkStageClosePolicy | undefined
    out.push({
      key, statement,
      ...(Array.isArray(o.done_criteria) ? { doneCriteria: o.done_criteria.map((c) => String(c)) } : {}),
      ...(closePolicy === undefined ? {} : { closePolicy }),
    })
  }
  return out
}

/** 层2 的对外投影（相位 / 陈述 / revision / 阻塞原因）。 */
function taskView(task: WorkTask): Record<string, unknown> {
  return {
    id: task.id,
    stage_key: task.stageKey,
    objective: task.objective,
    phase: task.phase,
    revision: task.revision,
    ...(task.blockedReason === undefined ? {} : { blocked_reason: task.blockedReason.code, blocked_message: task.blockedReason.message }),
    ...(task.maxRounds === undefined ? {} : { max_rounds: task.maxRounds }),
  }
}

/** block 的原因码必须 lower-kebab-case（与严格解码器同一条口径）。 */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/* -------------------------------------------------------------------------- */
/* 层1：get / create / update（update 只含 done——开工是驱动器的动作）              */

/**
 * `get_workstage`：读阶段表（顺序即串行顺序）+ 当前阶段 + 串行门 + 收口条件。
 * 无流程不是错误值而是**明说的缺失**（缺失 ≠ 空表）。
 */
export async function getWorkstage(deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const process = await deps.domain.process(scope)
  if (process === undefined) {
    return { success: false, scope, error: '该归属域还没有流程（先调 create_workstage 建流程）' }
  }
  const activation = await deps.domain.activation(scope)
  // 当前阶段 = 串行顺序里第一个非 done 的阶段（口径在 stages.js 单点，工具面不自己找）。
  const current = currentStageOf(process)
  return {
    success: true,
    scope,
    process_id: process.id,
    objective: process.objective,
    revision: process.revision,
    stages: process.stages.map((s) => ({
      key: s.key, statement: s.statement, state: s.state, done_criteria: s.doneCriteria,
      close_policy: stageClosePolicyOf(s),
      tasks: s.tasks.length, tasks_done: s.tasks.filter((t) => t.phase === 'complete').length,
    })),
    current_stage: current?.key ?? null,
    /** 串行门读数：当前阶段 pending 且前序阶段全 done ⇒ 可开工。 */
    allows_start: current !== undefined && stageAllowsStart(process, current.key),
    allows_close: processAllowsClose(process),
    /** 流程收口时间戳（缺省 = 未收口）：已收口的流程一切写被内核拒（'process-closed'）。 */
    ...(process.closedAt === undefined ? {} : { closed_at: process.closedAt }),
    // **续跑许可**（耐久）：disarmed = 驱动器停手（会话 resume 后自动落），等人 arm。
    ...(activation === undefined ? {} : { activation }),
  }
}

/**
 * `create_workstage`：没有流程 → 建流程（带阶段表，`objective` 必填）；
 * 已有流程 → 整体替换阶段表（同名阶段保留任务与态；会丢掉非空阶段的一律被内核拒）。
 */
export async function createWorkstage(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const stages = parseStages(args)
  if (typeof stages === 'string') return { success: false, scope, error: stages }
  const objective = args.objective === undefined ? '' : String(args.objective)
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    const existing = await deps.domain.process(scope)
    if (existing === undefined) {
      if (objective.trim() === '') {
        return { success: false, scope, error: '建流程需要 objective（写清这条流程要达成什么）' }
      }
      const changed = await deps.domain.createProcess(scope, { objective, stages })
      // **新建 = 许可打开**（限本轮由人发起时）：新流程是"人明确要开一条"，
      // 但归属记录里可能残留着上一条流程的 `disarmed`（真机场景：宿主重启 ⇒ resume 自动 disarm；
      // 随后新建的流程会一开就静默停住——真机复现过）。自治回合不动这个开关：不许自己给自己发通行证。
      if (changed && authorityOf(deps, exec).kind === 'direct-human') {
        await deps.domain.setActivation(scope, 'armed')
      }
      const built = await deps.domain.process(scope)
      const first = built === undefined ? undefined : currentStageOf(built)
      return {
        success: true, scope, created: true, changed,
        ...(built === undefined ? {} : { process_id: built.id, revision: built.revision }),
        current_stage: first?.key ?? null,
        allows_start: built !== undefined && first !== undefined && stageAllowsStart(built, first.key),
        // 下一步归谁：**开工不是模型的动词**（驱动器在空闲边界落）。
        next_step: '阶段开工由驱动器在空闲边界自动落（不要自己找开工动词）；'
          + '开工后驱动器会提醒你给该阶段建任务（create_worktask）。',
      }
    }
    // 先干跑一次拿到**内核给的原因**（规则的唯一权威在 fold，本层不另写一份判据）：
    // `changed:false` 的幂等重放与"会被拒"（丢非空阶段 / 串行门被破）在回执里必须分得清。
    const dry = applyWorkEvent(existing, { kind: 'stage-define', stages })
    if (!dry.changed) return { success: true, scope, created: false, changed: false, reason: dry.reason }
    const changed = await deps.domain.defineStages(scope, stages, revision)
    return { success: true, scope, created: false, changed }
  })
}

/**
 * `update_workstage` 认的动词：
 *   · `done` —— 阶段收口（要 stage_key）；
 *   · `edit` —— **改流程目标**（要 objective；对齐宿主 `update_goal` 的 `edit`）；
 *   · `discard` —— **丢弃整条流程**（不要 stage_key；误建流程的补救口，见下）。
 * 阶段开工不是本工具的动词：串行门放行后由驱动器开工。
 */
/** 自治回合落 block 的前置轮数（缺省 3，对齐宿主 goal）。 */
export const DEFAULT_BLOCKED_AFTER_ROUNDS = 3

/**
 * `update_workstage` 认的动作（**单一来源**）：运行期白名单与工具 schema 的 `enum` 都从这里派生。
 * 曾经只改白名单没改 schema ⇒ 宿主在 schema 层就把新动词（`arm`）拒了，handler 根本没轮到（真机踩过）。
 */
export const STAGE_ACTIONS = ['done', 'edit', 'discard', 'arm', 'disarm'] as const

/**
 * `update_workstage`：阶段态变更（对齐宿主 `update_goal` 的 `action` 形状）。
 *
 * `done` = 阶段收口；**谁来落**看目标阶段的收口策略（`stageClosePolicyOf`）：
 *   · `human`（缺省）——人工确认（真人专属；agent 自写 = 越权）；
 *   · `auto`——自动收口，自治回合（驱动器决策）也放行。
 * 两条路都要过内核的收口判据（任务非空且全 complete）；授权拒绝只是第一道。
 *
 * `discard` = **连根拔掉这条流程**（不可逆：流程与任务墓碑一起消失、回合计数归零）；
 * 刻意做成**真人专属**——建流程要想清楚，误建也只能由人来撤。幂等：没有流程 ⇒ `changed:false`。
 *
 * `arm` / `disarm` = **续跑许可**（耐久，落在归属记录的 `rounds.activation`）：
 *   · `disarm`——让驱动器不再自动往下推这条流程（会话 `resume`（宿主重启后加载）时由驱动器**自动**落）；
 *   · `arm`——人说要继续时把许可放回去。
 * 两者都是**真人专属**：agent 自行放行自己 = 自己给自己发通行证（与 goal 的 arm/resume 口径一致）。
 */
export async function updateWorkstage(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const stageKey = args.stage_key === undefined ? '' : String(args.stage_key)
  const action = String(args.action ?? '')
  const objective = args.objective === undefined ? '' : String(args.objective)
  // stage_key 只对 done 必需：edit / arm / disarm 改的都是整条流程，discard 丢的是整条流程。
  if (action === 'done' && stageKey.trim() === '') {
    return { success: false, scope, error: '缺少 stage_key（收口哪个阶段；edit / discard 才不需要）' }
  }
  if (action === 'edit' && objective.trim() === '') {
    return { success: false, scope, action, error: 'edit 需要 objective（这条流程改成要达成什么）' }
  }
  if (!(STAGE_ACTIONS as readonly string[]).includes(action)) {
    return {
      success: false, scope, stage_key: stageKey, action,
      error: 'action 非法（只认 ' + STAGE_ACTIONS.join(' / ') + '；**阶段开工是驱动器的动作**——'
        + '串行门放行后由驱动器开工，不经工具面。实际给的是 ' + JSON.stringify(action) + '）',
    }
  }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    if (action === 'discard') {
      // 真人专属（删掉的是整条流程，不可逆）；内核负责"没有流程就零写入"的幂等。
      authorize('process_discard', authorityOf(deps, exec))
      const changed = await deps.domain.discardProcess(scope, revision)
      if (changed) {
        notice(deps, exec, 'process-discard',
          '<workprocess_discarded>\n整条流程已丢弃（不可逆：阶段、任务与任务编号墓碑一并消失，回合计数归零）。\n'
          + '不要再引用原来的阶段键或任务 id；需要重来就用 create_workstage 新起一条。\n'
          + '</workprocess_discarded>')
      }
      return { success: true, scope, action, changed }
    }
    if (action === 'edit') {
      // 真人专属（改的是"这条流程要达成什么"——同宿主 `update_goal` 的 edit 口径）。
      authorize('process_edit', authorityOf(deps, exec))
      const changed = await deps.domain.editObjective(scope, objective, revision)
      return { success: true, scope, action, objective, changed }
    }
    if (action === 'arm' || action === 'disarm') {
      // 真人专属（"要不要让它自己往下跑"是人的决定）：agent 自行放行自己 = 自签通行证。
      authorize('process_arm', authorityOf(deps, exec))
      const activation = action === 'arm' ? 'armed' as const : 'disarmed' as const
      const changed = await deps.domain.setActivation(scope, activation, revision)
      if (changed) {
        notice(deps, exec, 'process-' + action,
          action === 'arm'
            ? '<workprocess_armed>\n续跑许可已放回（armed）：驱动器会在空闲边界继续自动推进这条流程。\n</workprocess_armed>'
            : '<workprocess_disarmed>\n续跑许可已收回（disarmed）：驱动器不再自动往下推——'
              + '需要继续时说一声（arm）或由人继续手动推进。\n</workprocess_disarmed>')
      }
      return { success: true, scope, action, activation, changed }
    }
    // 先读目标阶段：授权判据要按它的收口策略判（策略不在参数里，在流程里）。
    const process = await deps.domain.process(scope)
    const stage = process?.stages.find((s) => s.key === stageKey)
    if (stage === undefined) return { success: false, scope, stage_key: stageKey, error: '阶段不存在' }
    const closePolicy = stageClosePolicyOf(stage)
    // 授权：**先判权，再判状态**（越权者不该从回执里读出阶段处于什么态）；
    // 策略 human 且本轮不是人发起的 ⇒ **工具自己问人**（宿主 userQuestions 弹框）。
    const authority = authorityOf(deps, exec)
    if (!isActionAuthorized('stage_done', authority, { stageClosePolicy: closePolicy })) {
      // 能弹框、且这件事**确实做得成**（active 且任务全达成）时才去打扰人——
      // 做不到的事不拿去问人，直接把内核给的原因说清楚。
      const askable = deps.askHuman !== undefined && closePolicy === 'human'
        && stage.state === 'active' && stageIsFinishable(stage)
      if (!askable) {
        requireActionAuthority('stage_done', authority, { stageClosePolicy: closePolicy })
      } else {
        const verdict = await deps.askHuman!(exec, {
          id: 'workprocess-stage-done:' + stageKey,
          header: '阶段收口确认',
          question: '阶段 `' + stageKey + '` 的任务已全部达成，是否收口？',
          detail: stageDetailOf(stage),
          options: [
            { label: '确认收口', description: '本阶段落 done；下一阶段由驱动器开工与规划。' },
            { label: '还要补做', description: '不收口——在自定义输入里写清还差什么，我会建成新任务继续做。' },
          ],
          approve: '确认收口',
        })
        if (verdict.kind === 'declined') {
          return {
            success: false, scope, stage_key: stageKey, action, code: 'WORK_HUMAN_DECLINED',
            error: '人在弹框里选了「还要补做」，本阶段不收口'
              + (verdict.feedback === undefined || verdict.feedback === '' ? '' : '；人的补充：' + verdict.feedback)
              + '——请按人说的用 create_worktask 补任务，做完再提请收口。',
          }
        }
        if (verdict.kind === 'cancelled') {
          return {
            success: false, scope, stage_key: stageKey, action, code: 'WORK_HUMAN_UNAVAILABLE',
            error: '收口确认没问成人（' + verdict.reason + '）：本阶段不收口。'
              + '若人顺手回了话，先按人说的办；否则请人在会话里回一句。',
          }
        }
        if (verdict.kind === 'no-channel') {
          // 没弹框通道：退回原来的拒绝（带指路），不假装问过。
          requireActionAuthority('stage_done', authority, { stageClosePolicy: closePolicy })
        }
        // approved：人已确认 ⇒ 继续落章（与"人直接在会话里说一句"等价，只是路径更短）。
      }
    }
    // 收口条件用内核判据先说清楚（`changed:false` 不能只有"没变"三个字）。
    if (stage.state !== 'active') {
      return {
        success: true, scope, stage_key: stageKey, action, close_policy: closePolicy,
        changed: false, reason: '阶段不是 active（当前 ' + stage.state + '）',
      }
    }
    if (!stageIsFinishable(stage)) {
      return {
        success: true, scope, stage_key: stageKey, action, close_policy: closePolicy,
        changed: false, reason: '本阶段任务未全部 complete（缺失 ≠ 达成）',
      }
    }
    const changed = await deps.domain.closeStage(scope, stageKey, revision)
    if (changed) {
      notice(deps, exec, 'stage-done: ' + stageKey,
        '<workprocess_stage_done>\n阶段 ' + stageKey + ' 已收口。\n'
        + '下一阶段由驱动器在空闲边界开工，并在需要时提醒你规划它的任务——'
        + '你不要越阶段开工，也不要提前给后续阶段建任务。\n'
        + '</workprocess_stage_done>')
    }
    return { success: true, scope, stage_key: stageKey, action, close_policy: closePolicy, changed }
  })
}

/* -------------------------------------------------------------------------- */
/* 层2：get / create / update                                                      */

/** `get_worktask`：读任务（给 task_id 读一条；给 stage_key 读一阶段；都不给读全部）。 */
export async function getWorktask(deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const process = await deps.domain.process(scope)
  if (process === undefined) return { success: false, scope, error: '该归属域还没有流程' }
  const taskId = args.task_id === undefined ? undefined : String(args.task_id)
  const stageKey = args.stage_key === undefined ? undefined : String(args.stage_key)
  let tasks: readonly WorkTask[]
  if (taskId !== undefined) {
    tasks = allTasksOf(process).filter((t) => t.id === taskId)
    if (tasks.length === 0) return { success: false, scope, task_id: taskId, error: '任务不存在（可能已被 clear）' }
  } else if (stageKey !== undefined) {
    const stage = process.stages.find((s) => s.key === stageKey)
    if (stage === undefined) return { success: false, scope, stage_key: stageKey, error: '阶段不存在' }
    tasks = stage.tasks
  } else {
    tasks = allTasksOf(process)
  }
  return { success: true, scope, process_id: process.id, revision: process.revision, tasks: tasks.map(taskView) }
}

/** `create_worktask`：在某阶段建任务（身份由内核分配，清掉的不复用）。 */
export async function createWorktask(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const stageKey = args.stage_key === undefined ? '' : String(args.stage_key)
  if (stageKey.trim() === '') return { success: false, scope, error: '缺少 stage_key（任务挂在哪个阶段下）' }
  const objective = args.objective === undefined ? '' : String(args.objective)
  if (objective.trim() === '') return { success: false, scope, error: 'objective 必填：写清这个工作单元要达成什么' }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const maxRounds = typeof args.max_rounds === 'number' ? args.max_rounds : undefined
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  return guarded(async () => {
    const changed = await deps.domain.createTask(scope, {
      stageKey, objective, ...(maxRounds === undefined ? {} : { maxRounds }),
    }, revision)
    // 回执带上新任务的 id（调用方下一句就要用它，不该再去猜编号）。
    const process = await deps.domain.process(scope)
    const stage = process?.stages.find((s) => s.key === stageKey)
    const created = stage === undefined ? undefined : stage.tasks[stage.tasks.length - 1]
    return {
      success: true, scope, stage_key: stageKey, changed,
      ...(changed && created !== undefined ? { task_id: created.id, revision: created.revision } : {}),
      next_step: '直接动手做这个任务；做完调 update_worktask(action: "complete")。不要顺手把后续阶段的任务也建满。',
    }
  })
}

/** `update_worktask` 认的动词（对齐宿主 `update_goal` 的 `action`，另加本包的 `clear`）。 */
const TASK_ACTIONS = ['edit', 'pause', 'resume', 'block', 'complete', 'clear'] as const
type TaskAction = (typeof TASK_ACTIONS)[number]

/**
 * `update_worktask`：任务态变更（一个工具 + `action`，对齐宿主 `update_goal`）。
 *   · `edit` / `resume` = **真人专属**（改目标 / 继续——同宿主口径）；
 *   · `block` 必须给原因（`reason` + 可选 `reason_code`，缺省 `blocked`）；
 *   · `clear` 是本包加项（撤掉误建的工作单元，编号不复用）。
 */
export async function updateWorktask(
  deps: WorkToolDeps, args: Record<string, unknown>, exec?: unknown,
): Promise<WorkToolReply> {
  const scope = scopeOf(args, deps, exec)
  if (scope === undefined) return { success: false, error: '缺少 scope（归属域键：这条流程挂在谁名下；未接默认归属时请显式给）' }
  const taskId = args.task_id === undefined ? '' : String(args.task_id)
  if (taskId.trim() === '') return { success: false, scope, error: '缺少 task_id' }
  const action = String(args.action ?? '')
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) {
    return {
      success: false, scope, action,
      error: 'action 非法（只认 ' + TASK_ACTIONS.join(' / ') + '；实际给的是 ' + JSON.stringify(action) + '）',
    }
  }
  const callerBad = callerRejection(deps, exec)
  if (callerBad !== undefined) return { success: false, scope, error: callerBad }
  const revision = typeof args.revision === 'number' ? args.revision : undefined
  const reason = args.reason === undefined ? '' : String(args.reason)
  const reasonCode = args.reason_code === undefined ? 'blocked' : String(args.reason_code)
  const objective = args.objective === undefined ? '' : String(args.objective)
  const maxRounds = typeof args.max_rounds === 'number' ? args.max_rounds : undefined
  return guarded(async () => {
    const act = action as TaskAction
    const base = { scope, task_id: taskId, action: act }
    if (act === 'edit' && objective.trim() === '' && maxRounds === undefined) {
      return { ...base, success: false, error: 'edit 至少要给一项（objective / max_rounds）' }
    }
    if (act === 'block' && reason.trim() === '') {
      return { ...base, success: false, error: 'block 必须给原因（reason）：被什么挡住、等谁' }
    }
    if (act === 'block' && !KEBAB.test(reasonCode)) {
      return { ...base, success: false, error: 'reason_code 必须是 lower-kebab-case（如 wait-human）' }
    }
    const authority = authorityOf(deps, exec)
    authorize(('task_' + act) as WorkAuthorityAction, authority)
    if (act === 'block' && authority.kind !== 'direct-human') {
      // 对齐宿主 goal 的 `GOAL_TOOL_BLOCK_THRESHOLD`：**同一件事至少撑过 N 轮**才允许宣告被挡住。
      // 判据用归属域已准入回合数（耐久，重启不丢）；真人直接发起不受此限（人在场随时可叫停）。
      const threshold = deps.blockedAfterRounds ?? DEFAULT_BLOCKED_AFTER_ROUNDS
      const rounds = (await deps.domain.roundsStarted(scope)) ?? 0
      if (rounds < threshold) {
        return {
          ...base, success: false,
          error: `落 block 前至少要跑满 ${threshold} 轮（当前 ${rounds} 轮）——`
            + '先继续做（把卡点写进回执），或由人直接叫停（真人发起不受此限）。',
          code: 'WORK_TOOL_BLOCK_THRESHOLD',
        }
      }
    }
    const changed = act === 'edit'
      ? await deps.domain.editTask(scope, taskId, {
        ...(objective.trim() === '' ? {} : { objective }),
        ...(maxRounds === undefined ? {} : { maxRounds }),
      }, revision)
      : act === 'pause' ? await deps.domain.pauseTask(scope, taskId, revision)
        : act === 'resume' ? await deps.domain.resumeTask(scope, taskId, revision)
          : act === 'complete' ? await deps.domain.completeTask(scope, taskId, revision)
            : act === 'clear' ? await deps.domain.clearTask(scope, taskId, revision)
              : await deps.domain.blockTask(scope, taskId, { code: reasonCode, message: reason }, revision)
    // **收尾通告**（对齐宿主 goal 的 `<goal_complete>`）：任务刚达成的那一拍就说清"到此为止"。
    if (act === 'complete' && changed) {
      notice(deps, exec, 'task-complete: ' + taskId,
        '<workprocess_task_complete>\n任务 ' + taskId + ' 已达成（终态，不可逆）。\n'
        + '本轮到此为止：不要顺手开新任务、不要替后续阶段建任务，也不要自己给阶段落 done'
        + '（收口由人确认或由驱动器按策略自动落）。\n'
        + '需要继续的话，驱动器会在空闲边界投下一轮；先把这一步的结果说清楚给用户。\n'
        + '</workprocess_task_complete>')
    }
    return { ...base, success: true, changed }
  })
}

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
      // enum 从**单一来源**派生（`STAGE_ACTIONS`）：schema 与运行期白名单不许各写一份
      //（真机踩过：只改白名单 ⇒ 宿主在 schema 层就把 `arm` 拒了，handler 根本没轮到）。
      enum: [...STAGE_ACTIONS],
      description: 'done = 阶段收口落定，按**本阶段的收口策略**判谁来落：human（缺省）= **真人专属**（人工确认）；'
        + 'auto = 本回合（驱动器决策）可自动落 done。两条路都必须任务非空且全部 complete。'
        + 'edit = **改流程目标**（要 objective；对齐宿主 update_goal 的 edit；**真人专属**——阶段与任务原样保留）。'
        + 'discard = **丢弃整条流程**（不需要 stage_key；不可逆：流程与任务墓碑一起消失、回合计数归零；**真人专属**）。'
        + 'arm / disarm = **续跑许可**（真人专属）：disarm 让驱动器停手（会话 resume 时驱动器自动落），'
        + 'arm 在人说"继续"时放回去。'
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
