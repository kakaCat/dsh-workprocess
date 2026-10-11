# dsh-workprocess

workprocess 的**插件入口**（组合根）：把「内核 + 驱动 + 工具面」三个库接成宿主能装载的插件。

## 它补的正是那层接线

| 缺口 | 本包怎么补 |
|---|---|
| 没有 `store` 实现 | `src/domain.ts`：**用宿主的存储域**（`defineDomain` + `ctx.storageDomain`，域 `workprocess` v1、表 `processes`、键 = 归属域）。schema 校验、耐久、`domain/changed` 事件都由宿主后端负责——**不自造文件库**。`workProcess` 的权威校验器仍是**内核**的 `decodeWorkProcess`（schema 的 `superRefine` 调它） |
| 真人判定没接上 | `src/authority.ts`：从会话投影拿 `turnBoundary` + `session.snapshotEvents()`，喂给 `authorityFromEvents`；口径对齐宿主 `tool-goal`（agent 必须是注册表里那个、running、且是 `currentInitiator()`），判不出就不授自治 |
| `drive` 的结论没人执行 | `src/driver.ts` + `src/index.ts`：开工 / auto 收口 / 落盘 block 由 tick 直接落；**续跑回合**由 `roundDeliveryOf` 造载荷、`agent.followup` 投递 |
| 投递会冒充人话 | `src/message.ts`：往 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 加 `work` 一格并**自署来源**——自动回合 = `autonomous`，`human` 策略的收口照样落不了章（省略 source 会被当成 user，那正是"自动回合替人收口"的口子） |
| 没有插件形状 | `src/index.ts`：`export const name / inject / apply(ctx, config)`（与宿主 `tool-goal` 同形），注册六个工具 |

## 装配

```
inject = ['agents', 'tools', 'sessionProjections', 'storageDomain']
apply(ctx, config) ⇒
  · 打开归属记录域（storage domain `workprocess`）
  · 六个工具进 ctx.tools.register（get_/create_/update_ × workstage/worktask）
  · 归属缺省 = **本会话**（不传 scope 时用 agent.session.id；多流程并存仍可显式给 scope）
  · ctx.on('session/event') ⇒ 空闲边界一拍：记回合 → 驱动 → （可选）投递下一轮
```

**前置（composition 必须挂的行）**：`@deepseek-ai/dsh-storage` + 一个后端（`dsh-storage-json` / `dsh-storage-sqlite`）
+ `@deepseek-ai/dsh-storage-domain`。一行都没挂 ⇒ 本插件不激活（cordis 等依赖）。

配置（`cordis.patch.yml` 的 config 段）：

```yaml
- insert:
    - id: workprocess
      name: "dsh-workprocess"
      config:
        tick: true            # 回合边界是否自动驱动（缺省 true）
        drive: true           # 空闲边界是否**自动投递续跑回合**（缺省 false；本仓装载层打开）
        defaultMaxRounds: 20  # 任务没写 max_rounds 时的硬上限（防跑飞）
```

## 续跑是怎么跑的（刹车在哪）

1. **空闲边界**才动手（`turnBoundary.openTurnStartSeq === null`）：活动轮次里改流程会与模型正在做的事打架。
2. 一拍只做一件事：该开工就开工、该收口就收口、该跑任务就**投一轮**（`agent.followup`，source 自署 `work`）。
3. 同一轮（`taskId:revision:round`）**只投一次**；回合被接手（会话里出现该 source 的 `user/message`）才把
   `rounds.started` **耐久**前进一格。
4. **刹车**：任务写了 `max_rounds` 用它，没写用 `defaultMaxRounds`；到顶 ⇒ 驱动器 `block-task` **落盘**
   （重启不失忆、人可见可裁），不再投——不会无限自动续跑。

## 状态放在哪（为什么不是会话日志）

goal 把状态放**会话日志**（`session.append('goal/change')` + 自己的 session 投影），因为它**在仓内**：
事件类型进了**脚本生成**的 `KNOWN_SESSION_EVENT_TYPES`，读路径才认它。

仓外插件走同一条路在本 build 里不成立：`Session.append(type, data, ...opts)` 只对 surface 事件开放第三参数，
**没有任何地方能设 `ignorable: true`**；而持久化读路径 `validateStoredEvents`
（`session-persistence/src/storage-contract.ts`）规定"遇到本 build 不认识的类型 + 无 `ignorable` ⇒
**拒绝解释整条会话日志**"。真去 append 自定义类型，下次会话加载直接失败。
宿主为仓外插件准备的持久化面就是 `ctx.storageDomain`。

## 装进 profile（宿主装配）

```bash
pnpm install && pnpm build          # ① 仓内构建（宿主加载的是 JS）
# ② profile 登记：依赖 "dsh-workprocess": "link:<repo>/dsh-workprocess"、bundles 追加 "dsh-workprocess"
ln -sfn <repo>/dsh-workprocess ~/.dsh/profiles/desktop/node_modules/dsh-workprocess
# ③ 重启 DSH
```

回滚：删掉 profile `package.json` 里的依赖与 bundles 条目 + `node_modules/dsh-workprocess` 链接
（改动前的备份是 `package.json.bak-workprocess`），重启即恢复原状。

## 命令行：`/work`（**独立包** `dsh-command-workprocess`）

与宿主的 `/goal` 同构：**命令行也是一个独立包、独立装载行**，不塞在领域插件里。

- 装载：本包的 `cordis.patch.yml` 插两行——`dsh-workprocess`（本包）+ `dsh-command-workprocess`（命令行包），
  与宿主 base bundle 里 `dsh-goal` / `dsh-command-goal` 的关系一致。
- 数据来源：命令行只消费 **`ctx.workprocess`**（本包 `ctx.provide` 出去的领域服务：view / discard /
  pauseActive / resumePaused），不自己开存储域（同名域重复 `open` 会被响亮拒绝），也不绕内核改状态。
- 命令天然的授权：由人敲出来，所以 `discard` / `resume` 这类真人专属动作在那一层合法（与工具面同源）。
- 没装命令行包 = 只少一条命令行，六个工具照旧（两者是两条独立装载行）。


## 还没接的部分

- **`ask-*`（人机弹框确认）**：`human` 策略的收口目前靠人在会话里说一句 → 模型调
  `update_workstage(action=done)` 落章；没有弹框通道的接线。

## 工具面上与流程相关的两个动词（在 `tool-workprocess`）

- `update_workstage { action: 'done' }` —— 阶段收口（策略 human 时真人专属）。
- `update_workstage { action: 'discard' }` —— **丢弃整条流程**（不需要 stage_key；不可逆：流程与任务墓碑
  一起消失、回合计数归零；**真人专属**——误建流程的补救口）。幂等：没有流程 ⇒ `changed:false`。

## 测试

```bash
pnpm test   # 全仓 113 条；本包 16 条：装配面 / 域声明与内核校验 / 归属缺省 / 真人判定 /
            #   回合边界（开工·auto 收口·活动轮次不动手）/ 续跑投递（自署来源·去重·上限刹车）/
            #   服务面 ctx.workprocess（view / pauseActive / resumePaused / discard 幂等）
```
