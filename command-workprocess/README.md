# dsh-command-workprocess

`/work` 命令行（**独立包、独立装载行**，与宿主 `@deepseek-ai/dsh-command-goal` 同形）。

## 语法（与 `/goal [<目标>|edit <目标>|pause|resume|clear]` 逐字同形）

| 命令 | 谁来做 | 作用 |
|---|---|---|
| `/work` | 命令直读 | 看：目标 / 各阶段（key · 态 · 收口策略 · 任务 done/total）/ 当前阶段的任务 / 已准入回合 / 谁该动 |
| `/work <目标>` | **agent** | 把目标投给 agent（`agent.followup`），由它用 `create_workstage` **自己拆阶段**建流程 |
| `/work edit <目标>` | **agent** | 让 agent 改流程目标（`update_workstage action=edit`，阶段与任务保留；要重排它再用 `create_workstage`） |
| `/work pause` | 命令直落 | 暂停**当前阶段**的活动任务（自动续跑随之停下） |
| `/work resume` | 命令直落 | 恢复当前阶段被暂停的任务 |
| `/work clear` | 命令直落 | 丢弃整条流程（不可逆；幂等）。`discard` 作老写法别名仍认 |

**只有自己的控制词被吃掉，其余一律当目标**（同 `/goal`）——所以 `/work 全部推倒重来` 是目标，不是命令。

## 为什么创建是"投话"而不是命令自己建

goal 的目标是一句话，命令自己就能落库；workprocess 的流程**必须带阶段表**，而"这条目标该拆成哪几段"
是判断，不是机械转换。所以命令只把目标转成一条投给会话的指令，由 agent 用工具面自己拆：
**命令绝不替它猜阶段表**（猜出来的结构会把模型绑在它没同意过的东西上）。

控制动作（`pause` / `resume` / `clear`）反过来——机械、可判定，命令**直接落领域**，模型不在也能用。

## 投出去的消息来源自署 `user`

这一轮是**人敲了命令**才发生的（`/goal` 提交附件同款）。授权面据此判"本回合由人发起"，
于是 `update_workstage action=edit`、`human` 策略的阶段收口这类**真人专属**动作才落得下章；
`workprocess` 驱动的自动续跑回合则自署 `work`（判为自治）——两者绝不混淆。

## 其它纪律

- **只消费 `ctx.workprocess`**（由 `dsh-workprocess` 提供的领域服务）：不自己开存储域
  （同名域重复 `open` 会被响亮拒绝），也不绕内核改状态。
- 宿主 agent 不支持 `followup` 时**如实报错**（不假装建成，也不偷偷自己建）。
- 装载：`dsh-workprocess/cordis.patch.yml` 里插两行（`workprocess` + `dsh-command-workprocess`），
  与宿主 base bundle 里 `dsh-goal` / `dsh-command-goal` 的关系一致；profile 只需装好这两个包。

## 测试

```bash
pnpm test   # 语法（与 /goal 同形）/ 排版 / 分派（投话 vs 直落）/ 真服务接线
```
