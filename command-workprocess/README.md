# dsh-command-workprocess

`/work` 命令行（**独立包、独立装载行**，与宿主 `@deepseek-ai/dsh-command-goal` 同形）。

| 命令 | 作用 |
|---|---|
| `/work` | 看：目标 / 各阶段（key · 态 · 收口策略 · 任务 done/total）/ 当前阶段的任务 / 已准入回合 / 谁该动 |
| `/work pause` | 暂停**当前阶段**的活动任务（自动续跑随之停下） |
| `/work resume` | 恢复当前阶段被暂停的任务 |
| `/work discard` | 丢弃整条流程（不可逆；幂等） |

- **只消费 `ctx.workprocess`**（由 `dsh-workprocess` 提供的领域服务）：不自己开存储域
  （同名域重复 `open` 会被响亮拒绝），也不绕内核改状态。
- **命令天然的授权**：由人敲出来，所以 `discard` / `resume` 这类真人专属动作在这一层合法
  （与工具面的授权口径同源）。
- 装载：`dsh-workprocess/cordis.patch.yml` 里插两行（`workprocess` + `dsh-command-workprocess`），
  与宿主 base bundle 里 `dsh-goal` / `dsh-command-goal` 的关系一致；profile 只需装好这两个包。

## 测试

```bash
pnpm test   # 语法 / 排版 / 分派 / 真服务接线
```
