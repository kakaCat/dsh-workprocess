/**
 * tool-workprocess：**工具插件**（对齐宿主 `@deepseek-ai/dsh-tool-goal`：`name` / `inject` / `apply`）。
 *
 * 【本模块只做装配】注册六个工具（`./tools.js`）+ 注册常驻**策略段**（模型面纪律）。
 * 授权与宿主对话面在 `./authority.js`；工具本体在 `./tools.js`。
 *
 * 【数据从哪来】只消费 **`ctx.workprocess`**（由 `workprocess` 领域插件 provide）：
 * 存储域的 `open` 对同名域是响亮拒绝（`already-open`），域只能由领域插件独占——
 * 工具面经服务读写，与宿主 `tool-goal` 调 `ctx.goals.*` 的形状一致。
 *
 * 【降级】宿主缺 `tools` / `workprocess` 服务时由 cordis 的 `inject` 等依赖，不会硬崩；
 * 策略段注册失败只留一行日志（工具面照常）。
 *
 * @module tool-workprocess
 */
import type { Context } from '@deepseek-ai/cordis'
// type-only import：官方包的类型增强随包入程序（ctx.agents / ctx.sessionProjections / systemPrompt）。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { workprocessOf } from 'workprocess'
import { WORK_TOOL_FACTORIES, WORK_TOOL_REGISTRY, DEFAULT_BLOCKED_AFTER_ROUNDS, type WorkToolDeps } from './tools.js'
import { registerWorkprocessApi } from './http.js'
import { agentOf, askHumanOf, authorityResolverOf, deferNoticeOf } from './authority.js'

//#region 常驻策略段（模型面纪律：工具自述只在"打算调工具"时被读到，纪律得每轮在场）
/** 策略段名（宿主 systemPrompt 的段名空间；与 goal 的 `tool:goal` 同族）。 */
export const WORK_POLICY_SECTION = 'tool:workprocess'

/**
 * 段内容（纯文本；段顺序由装配期取 `TOOL_GOAL` 槽位决定）。
 *
 * 【为什么是函数而不是常量】`block` 的轮数门槛是**装载配置**（`blockedAfterRounds`）。写死一个
 * 数字 = 配置一改，常驻策略段就开始教模型一个错的数（真机症状：模型按策略段说的轮数去落 block，
 * 被内核按配置的门槛拒掉，白跑一轮）。宿主 goal 的解法是 `guidance(blockedAfterConsecutiveRounds)`：
 * 策略文本由**生效配置**渲染——本面照此办理，与 `update_worktask` 的 action 自述用同一个数。
 */
export function workPolicyText(blockedAfter: number): string {
  return [
    '## workprocess（一条流程 = 一个目标；阶段串行，阶段下挂任务）',
    '- **阶段严格串行**：前序阶段全部收口后才轮到下一阶段；不要越阶段开工，也不要提前给后续阶段建任务',
    '  （后者会被工具拒：`WORK_TOOL_NOT_CURRENT_STAGE`——留到它成为当前阶段再拆）。',
    '- **阶段开工不是你的动作**：串行门放行后由驱动器在空闲边界落；你只管任务（`create_worktask` / `update_worktask`）。',
    '- **每个阶段开始时驱动器会提醒你规划**该阶段的任务（写成可核验的陈述；拆几个由你定）。',
    '- **收口策略决定谁落 done**：`human`（缺省）——你**只提议**，由人确认（agent 自写会被拒）；',
    '  `auto`——任务全达成后由驱动器自动收口，你不要自己写。',
    '- **任务有回合预算**（`max_rounds`，缺省由配置兜底）：到顶由内核落盘 block、等人裁'
      + '（恢复要人来：`update_worktask action=resume`）；不要靠反复重试绕过它。',
    '- **落 block 有门槛**（与预算到顶是两件事）：在**这个任务上**至少撑过 ' + String(blockedAfter) + ' 轮（该任务的回合账）才允许宣告"被挡住"——'
      + '第一轮遇到难处就停手会被拒（真人直接发起不受此限）。',
    '- 自动续跑回合会以一条带 `<workprocess_round>` / `<workprocess_plan>` / `<workprocess_ask>` 语义的',
    '  指令出现（来源自署 `work`）：只做那一轮说的事，做完停手，下一轮由驱动器投递。',
    '- **收口是写库、不投轮**：所以终局会专门投一条 `<workprocess_done>`（流程落幕）或',
    '  `<workprocess_blocked>`（停住等人）让你**给用户说一句结束语**——那一轮只说话、不要再调工具。',
    '- **续跑许可是耐久的**（`get_workstage` 回执里的 `activation`）：会话从盘上恢复（宿主重启）后',
    '  驱动器会自动把它置为 `disarmed` 并停手；**人说"继续 / 接着跑"时**，你调',
    '  `update_workstage action=arm` 把许可放回去（真人专属，agent 不能自己放行自己）。',
  ].join('\n')
}

/** 策略段文本（缺省门槛 = {@link DEFAULT_BLOCKED_AFTER_ROUNDS}）；装配期按生效配置重算。 */
export const WORK_POLICY_TEXT = workPolicyText(DEFAULT_BLOCKED_AFTER_ROUNDS)
//#endregion

//#region 插件装配
// type-only import：官方包的类型增强随包入程序（ctx.agents / ctx.sessionProjections / systemPrompt）。

/** 插件名（装载层条目 id 同源）。 */
export const name = 'tool-workprocess'

/** 装配依赖：工具注册面 + 领域服务 + 授权判据要的 agent/投影面 + 策略段要的 systemPrompt。 */
export const inject = ['tools', 'workprocess', 'agents', 'sessionProjections', 'systemPrompt']

/** 工具面配置（装载层 `config` 段；缺省全空）。 */
export interface WorkToolConfig {
  /** 策略段是否注册（缺省 true；关掉只影响模型面纪律，不影响工具）。 */
  readonly policySection?: boolean
  /**
   * 自治回合落 `block` 的前置轮数（缺省 {@link DEFAULT_BLOCKED_AFTER_ROUNDS} = 3，对齐宿主 goal 的
   * `blockedAfterConsecutiveRounds`）。真人直接发起不受此限。
   */
  readonly blockedAfterRounds?: number
  /**
   * 浏览器只读数据面**额外允许的 Host**（缺省空 = 只认 loopback：`localhost` / `127.0.0.1` / `::1`）。
   *
   * 这条面读的是本机流程数据，故默认只服务本机：从局域网地址 / 隧道域名 / 反代域名打开的界面，
   * 数据面会 403 并在消息里点名本配置项——把该主机名（可带端口，如 `mybox.lan:8080`）写进来即可；
   * `'*'` = 全放行（自己清楚暴露面时用）。跨源与跨站请求**不因此放行**（Origin 仍须与 Host 同源）。
   */
  readonly apiHosts?: readonly string[]
}

/** 登记顺序（= 登记表顺序，稳定：日志与快照可比）。 */
const REGISTRATION_ORDER: readonly (keyof typeof WORK_TOOL_FACTORIES)[] =
  WORK_TOOL_REGISTRY.map((e) => e.handler as keyof typeof WORK_TOOL_FACTORIES)

/** 从宿主 ctx 组装工具面依赖（唯一装配点：工具面只认 `ctx.workprocess` 这个数据口）。 */
export function workToolDepsOf(ctx: Context, config?: WorkToolConfig): WorkToolDeps {
  return {
    domain: workprocessOf(ctx),
    ...(config?.blockedAfterRounds === undefined ? {} : { blockedAfterRounds: config.blockedAfterRounds }),
    // 归属缺省 = **本会话**（一个会话一条流程；多流程并存时要显式给 scope）。
    defaultScope: (exec) => agentOf(exec)?.session?.id,
    resolveAuthority: authorityResolverOf(ctx),
    // 工具回执之后的**通告**（宿主 `exec.deferContext`）：落成一条自署 `work-tool` 的消息。
    deferNotice: (exec, n) => deferNoticeOf(exec, n),
    // **人机确认口**（宿主 `ctx.userQuestions`）：策略 human 的阶段收口由**工具自己问人**。
    askHuman: (exec, request) => askHumanOf(ctx, exec, request),
  }
}

/** 把六个 workprocess 工具注册进宿主 `tools` 服务（返回卸载器数组）。 */
export function apply(ctx: Context, config?: WorkToolConfig): void {
  const deps = workToolDepsOf(ctx, config)
  for (const handler of REGISTRATION_ORDER) {
    const factory = WORK_TOOL_FACTORIES[handler] as (d: WorkToolDeps) => unknown
    ctx.tools.register(factory(deps) as never)
  }
  // 浏览器只读数据面（惰性注入 webServer；宿主没有 web 载体时零行为）。
  // 访问判据：默认只认 loopback 主机 + 同源页面（见 http.ts 的 checkApiAccess）；
  // 要从别的地址访问，把主机名写进 `apiHosts`。
  registerWorkprocessApi(ctx, deps.domain, {
    ...(config?.apiHosts === undefined ? {} : { hosts: config.apiHosts }),
  })
  if (config?.policySection !== false) {
    try {
      ctx.systemPrompt?.section({
        name: WORK_POLICY_SECTION,
        order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
        // 门槛数字按**生效配置**渲染（与 `update_worktask` 的 action 自述同源）：写死就会与内核实际拦截面漂移。
        text: workPolicyText(config?.blockedAfterRounds ?? DEFAULT_BLOCKED_AFTER_ROUNDS),
      })
    } catch (err) {
      console.warn('[workprocess] 策略段注册失败（工具面照常）：' + String((err as Error)?.message ?? err))
    }
  }
}

//#endregion

export * from './authority.js'
export * from './codes.js'
export * from './tools.js'
export * from './http.js'
