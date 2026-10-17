# 桌面端升级后必查清单（workprocess 全栈"加载异常"）

**适用场景**：DSH 桌面端升级过版本之后，workprocess 的工具 / 阶段卡片 / `/work` 命令"突然全没了"，
重启也不回来，但代码没动、测试全绿。

**一句话结论**：不是代码 bug。本仓四个包把 DSH 宿主包钉成了**精确版本**，宿主一升级就
`incompatible-version`，整栈被宿主拒装；同一次升级还会把 profile 的两份配置重写，把 bundle 行从
`dsh.profile.bundles` 里摘掉。两个原因叠加，现象就是"全栈消失且重启无效"。

**最近一次实例**：2026-10-17，桌面端 `0.2.0-rc.2 → 0.2.1-rc.2`（app 目录 mtime 17:39）。详见文末时间线。

---

## 一、先确认现象（四条独立读数，缺一条都不要下结论）

| 查什么 | 怎么查 | 没装载长什么样 | 装载了长什么样 |
| --- | --- | --- | --- |
| Loader 行 | `plugin_manager` `list_plugins`（194 行，分页翻完） | 找不到 `include:workprocess` 等四行 | 四行都在，`fiberPhase: active` |
| 工具面 | `cordis_inspect_query` host `Tool.listTools` | 61 个工具里没有一个 `*_workstage` / `*_worktask` | 六个工具都在 |
| 客户端 | client `Slots.listSubTree` `root: "conversation.input.dock"` | `occupants` 只有 `todo(0)` / `goal(10)` / `queue(20)` | 多一条 `registrant: workprocess/client`、`id: workprocess` |
| 业务面 | 直接调 `get_workstage`（空参） | 工具不存在 | 返回"该归属下还没有流程"（**这是健康信号，不是错误**） |

**两个不要用错的判据**（本次排查踩过）：

- `Config.listConfigs {name: "workprocess"}` 的 `status`：`schema` / `absent` 只表示**这个插件行有没有
  Config schema**。`include:agent`、`include:session` 这些**已装载**的核心行同样是 `absent`。只有
  `entries: []`（**查不到这一行**）才算没装载。
- host `Service.listService {service: "workprocess"}` 报 `no catalogued Service named "workprocess"`
  **不能证明服务没注册**——该目录只收编登记过类型契约的服务。服务键确实是 `workprocess`
  （`workprocess/src/events.ts:43`），健康时工具能跑通就是证据。

## 二、定位根因（两条命令）

```bash
# ① 宿主是否直接拒装：看 error.code
plugin_manager action=list_bundles      # 找 error.code = "incompatible-version"
#    回执里会写明 runtimeVersion 与 requirements，例如
#    {"runtimeVersion":"0.2.1-rc.2","requirements":{"@deepseek-ai/dsh-agent":"0.2.0-rc.2"}}

# ② profile 是否被摘掉：看 bundles 列表
node -p "JSON.stringify(require('$DSH_PROFILE_DIR/package.json').dsh.profile.bundles,null,1)"
```

两条中任一条成立，都足以让全栈消失；本次**两条同时成立**。

## 三、升级后必查清单（照做即可）

1. **抬钉子**。四个 `package.json` 里所有 `@deepseek-ai/dsh-*` 的精确版本号，改成新宿主的版本：
   - `workprocess/package.json` → `@deepseek-ai/dsh-storage-domain`
   - `tool-workprocess/package.json` → `dsh-tools` / `dsh-llm` / `dsh-agent` / `dsh-session-projection` / `dsh-system-prompt`
   - `workprocess-round-driver/package.json` → `dsh-llm` / `dsh-agent` / `dsh-session-projection` / `dsh-session`
   - `command-workprocess/package.json` → `dsh-llm` / `dsh-commands`

   查法：`npm view @deepseek-ai/dsh-agent versions --json | tail`，确认目标版本已发布（预发布版本
   `0.2.1-rc.2` 都在 registry 上）。

   > **不要用 `^0.2.0-rc.2` 这种 range 偷懒**：node-semver 对预发布版本很挑——带 prerelease 的版本
   > 只有**同 major.minor.patch** 的比较器才放行，`^0.2.0-rc.2` 收不到 `0.2.1-rc.2`。精确值最稳。

2. **重装，让嵌套副本跟上**。`pnpm install`。四个子包的 `node_modules/@deepseek-ai/*` 各有一份
   宿主包副本（`autoInstallPeers` 装的），不重装会残留旧版本，变成"两份框架实例"。

3. **压掉 zod 双份**。`0.2.1-rc.2` 那批包对 `zod` 全写 `^4.4.3`，pnpm 会解出 **4.4.3 和 4.6.6 两份**，
   `tsc` 随即在 `$ZodCheck` / `ParsePayload` 上报一屏"类型不兼容"。宿主自己钉的是 4.4.3，所以根
   `package.json` 里加：

   ```json
   "pnpm": { "overrides": { "zod": "4.4.3" } }
   ```

4. **重新启用四个 bundle**。用 `plugin_manager` `set_bundle`（`enabled: true`），**不要手改**
   `$DSH_PROFILE_DIR/package.json`。四次都应回 `"application": "applied"`——apply 是热应用的，
   **不需要重启桌面端**；界面上没出现就刷新页面。

5. **验收**：回到第一节四条读数，外加 `pnpm typecheck`（应 0）与 `pnpm test`（应全绿）。

## 四、还没修的风险：profile 配置会被重写

同一次升级里，`$DSH_PROFILE_DIR` 的两份配置被改写了：

- `cordis.patch.yml`：**82 行 → 23 行**，`ui-chat` / `llm-pi-ai` / `agent-default-model` / `permission`
  四段丢失，且 `ui-settings-account` 的 `purpose/process/completion` 被改成向导初值
  （`development/detailed/completed`）——像是设置向导在持久化自己的进度。
- `package.json`：`dsh.profile.bundles` **11 项 → 3 项**，只剩 `base` / `web-app` / `dsh-dataforge`。

现场留了两个备份，排查时可对照：

```
$DSH_PROFILE_DIR/cordis.patch.yml.bak-1792235055842              # 18:50 的完整版（82 行）
$DSH_PROFILE_DIR/cordis.patch.yml.bak-before-restore-1792235201  # 19:04 被砍后的版本（23 行）
```

`cordis.patch.yml` 事后已人工恢复（文件里留着说明注释），`package.json` 的 bundles 由本次修复补回。
**改写者未定位**——下次再遇到"设置突然变回向导初值"或"插件又全没了"，先看这两个文件有没有变短。

## 五、教训：精确钉子的代价

精确钉版本换来的是"宿主 API 变了就立刻拒装"，这比"装上了再在运行期炸"要好——代价是**每次升级桌面端
都得抬一次钉子**。这条清单就是那个"抬钉子"的动作。

## 六、本次时间线

| 时刻 | 事件 |
| --- | --- |
| 10-15 09:51 | 崩溃日志记录当时桌面端为 `@deepseek-ai/dsh-desktop 0.2.0-rc.2` |
| 10-17 13:18 | profile 安装 `dsh-our-free-model`，此时 `dsh.profile.bundles` 有 11 项 |
| 10-17 17:39 | 桌面端升级到 `0.2.1-rc.2`（`/Applications/DeepSeek Harness.app` mtime） |
| 10-17 19:04:30 | `cordis.patch.yml` 被重写：82 → 23 行 |
| 10-17 19:13:59 | `package.json` 被重写：bundles 11 → 3 项，四个 workprocess 包被摘掉 |
| 10-17 19:20 | 宿主重启，Loader 树 194 行里已无任何 workprocess 行（三处全空） |
| 10-17 19:26 | 抬钉子到 `0.2.1-rc.2` + `zod` override，`pnpm install` |
| 10-17 19:27 | `set_bundle` 四次全部 `applied`；六工具、客户端 dock、四条 Loader 行同时回位；`typecheck` 0、`test` 347 passed |

## 七、复核命令速查

```bash
# 还有没有旧钉子残留
grep -rn '0\.2\.0-rc\.2' --include=package.json .

# 嵌套副本版本（四个包逐个看）
for p in workprocess workprocess-round-driver tool-workprocess command-workprocess; do
  echo "### $p"
  for d in "$p"/node_modules/@deepseek-ai/*/; do
    node -p "const j=require('./$d/package.json'); '  '+j.name+'@'+j.version"
  done
done

# zod 是否只剩一份
grep -n 'zod: 4\.' pnpm-lock.yaml | sort -u
```
