/**
 * 常驻**策略段**（模型面）：工具自述只在模型"打算调工具"时被读到，而
 * "阶段串行 / 谁能落 done / 回合预算"这些纪律得在每轮都在场。
 *
 * 【为什么在工具包】宿主 `dsh-tool-goal` 也是自己注册自己的策略段（`ctx.systemPrompt.section`）——
 * 工具的行为纪律跟着工具走，而不是寄居在领域插件里。
 *
 * @module tool-workprocess/policy
 */

/** 策略段名（宿主 systemPrompt 的段名空间；与 goal 的 `tool:goal` 同族）。 */
export const WORK_POLICY_SECTION = 'tool:workprocess'

/** 段内容（纯文本；段顺序由装配期取 `TOOL_GOAL` 槽位决定）。 */
export const WORK_POLICY_TEXT = [
  '## workprocess（两层工作模型：流程 → 阶段 → 任务）',
  '- **阶段严格串行**：前序阶段全部收口后才轮到下一阶段；不要越阶段开工，也不要提前给后续阶段建任务。',
  '- **阶段开工不是你的动作**：串行门放行后由驱动器在空闲边界落；你只管任务（`create_worktask` / `update_worktask`）。',
  '- **每个阶段开始时驱动器会提醒你规划**该阶段的任务（1–3 个、写成可核验的陈述）。',
  '- **收口策略决定谁落 done**：`human`（缺省）——你**只提议**，由人确认（agent 自写会被拒）；',
  '  `auto`——任务全达成后由驱动器自动收口，你不要自己写。',
  '- **任务有回合预算**（`max_rounds`，缺省由配置兜底）：到顶会落盘 block，等人裁；不要靠反复重试绕过它。',
  '- 自动续跑回合会以一条带 `<workprocess_round>` / `<workprocess_plan>` / `<workprocess_ask>` 语义的',
  '  指令出现（来源自署 `work`）：只做那一轮说的事，做完停手，下一轮由驱动器投递。',
].join('\n')
