/**
 * **工具面的拒绝码**（对齐宿主 `@deepseek-ai/dsh-tool-goal` 的分工与命名）。
 *
 * 【两套词汇，各回各家】宿主 goal 是这样分的：
 *   · **域规则** → `GoalErrorCode`（`GOAL_*`，闭联合，住在域词汇表 `goal/src/domain.ts`，
 *     随 `GoalError` 抛出）；
 *   · **工具面政策** → `GOAL_TOOL_*` 前缀（`GOAL_TOOL_AUTHORITY_REQUIRED` /
 *     `GOAL_TOOL_BLOCK_THRESHOLD` / `GOAL_TOOL_INVALID_UPDATE` / `GOAL_TOOL_AGENT_REQUIRED`…），
 *     抛在判据旁边（`tool-goal/src/authority.ts` / `index.ts`），**不并进域联合**。
 * 本仓照此办理：域码在 `workprocess` 的 `WORK_ERROR_CODES`（`WORK_*`），工具码在这一本
 * （`WORK_TOOL_*`）。判据：**域码 = 状态规则说"这样不成"；工具码 = 工具面自己加的牙**
 * （授权、agent 纪律、参数形状、人机确认的结局）。
 *
 * 【有意的例外：域码可以**冒泡**进回执】工具面不把域错误重包装成工具码——`WorkError` 的
 * `code` 原样进回执（机器可路由的分类来自域，工具面只是搬运）。所以回执里的码 =
 * `WorkReceiptCode`（两本的并集）；**工具自己拦下的一律用本表**，这条由类型守着：
 * `denyTool()` 只收 `WorkToolCode`，`denyDomain()` 只收 `WorkErrorCode`。
 *
 * 【为什么做成登记表而不是宿主的裸字面量】宿主靠前缀约定（写在使用点）；本仓把它做成闭联合
 * 常量表，于是"拒绝必须带码、码必须已登记、两本不许串门"能被编译器与守卫测试机械检查
 * （`tests/tools.spec.ts` 的「两套词汇」那组）。
 *
 * 【第三套词：HTTP wire 级错误名】浏览器数据面（`http.ts`）另有一套**小写 kebab** 的错误名
 * （`missing-host` / `cross-origin` / `cross-site` / `host-not-allowed` / `method-not-allowed` /
 * `missing-scope` / `no-process` / `unknown-path`）——那是**浏览器半的协议**（客户端据它决定怎么退），
 * 不是给模型看的回执码，故不收进这两本。改它要连客户端一起改（见 `client/useWorkWire.ts`）。
 *
 * @module tool-workprocess/codes
 */
import type { WorkErrorCode } from 'workprocess'

/** 工具码登记表（唯一手写清单；每个拒绝点从这里取码）。 */
export const WORK_TOOL_CODES = [
  /** 本动作需要人显式发起（agent 自行调用会推翻人的意图或越权确认）——宿主 `GOAL_TOOL_AUTHORITY_REQUIRED`。 */
  'WORK_TOOL_AUTHORITY_REQUIRED',
  /** 调用者不是当前正在运行的根 agent（子 agent / 已死的回合调不动）——宿主 `GOAL_TOOL_AGENT_REQUIRED`。 */
  'WORK_TOOL_CALLER_REQUIRED',
  /** 参数形状不合（缺必填 / action 非法 / 至少要给一项 / 需要 kebab-case 的给了别的）——宿主 `GOAL_TOOL_INVALID_UPDATE`。 */
  'WORK_TOOL_INVALID_ARGS',
  /** **agent 行为纪律**：不许给非当前阶段建任务（域层有意允许，牙长在工具面）。 */
  'WORK_TOOL_NOT_CURRENT_STAGE',
  /** **agent 行为纪律**：落 `block` 前必须在这个任务上撑满 N 轮——宿主 `GOAL_TOOL_BLOCK_THRESHOLD`。 */
  'WORK_TOOL_BLOCK_THRESHOLD',
  /** 收口确认弹框：人没选肯定项（给了反馈或选了别的）。 */
  'WORK_TOOL_HUMAN_DECLINED',
  /** 收口确认弹框：没有弹框通道（CLI / 无头 / 子 agent），退回拒绝并指路。 */
  'WORK_TOOL_HUMAN_UNAVAILABLE',
] as const

/** 工具面政策码（{@link WORK_TOOL_CODES} 的联合）。 */
export type WorkToolCode = (typeof WORK_TOOL_CODES)[number]

/** 回执里的机器可路由码：**域码（从 `WorkError` 冒泡）∪ 工具码**。 */
export type WorkReceiptCode = WorkErrorCode | WorkToolCode

/**
 * 工具面政策拒绝（**不是**域错误）：带 `WORK_TOOL_*` 码。
 *
 * 与 `WorkError`（域边界错误，码来自域词汇表）分开是刻意的：本仓的两本码表各回各家，
 * 混用一个类就等于又合回一本。宿主那边同理——工具面抛的是共享基类 `HarnessError`，
 * 而不是域自己的 `GoalError`。
 */
export class WorkToolError extends Error {
  readonly code: WorkToolCode
  constructor(message: string, code: WorkToolCode) {
    super(message)
    this.name = 'WorkToolError'
    this.code = code
  }
}
