# 丢弃式探针：仓外插件客户端半能不能被宿主扫到（wt:design:3）

> **已退役（implement:2，2026-10-12）**：探针完成使命后被真产物替换——`workprocess/lib/client.probe.js` 已删除，
> `package.json` 的 `exports["./client"]` 现指向 `./lib/client.js`（真浏览器半）。本文件保留作历史记录。

**探针件（已删除）**
- ~~`workprocess/lib/client.probe.js`（占位一行字，不做任何取数）~~
- `workprocess/package.json` 的两处声明：`exports["./client"] → ./lib/client.js`、`dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-conversation"] }`（后者保留，声明本身是对的）

## 已验证（可复跑，无需重启）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 声明通过宿主自己的校验器 | `node --import tsx/esm /tmp/wp_probe_check.mts`（脚本调 `packages/client/modules/src/client/manifest.ts` 的 `parseDshClient`） | `{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-conversation"]}` |
| `./client` 解析到真实文件 | 同一脚本用 profile 目录做 `createRequire`：`require.resolve('workprocess/client')` | `…/workprocess/lib/client.probe.js`（exist=true） |
| 插件行仍指向本包 | 同上：`require.resolve('workprocess')` | `…/workprocess/dist/index.js` |
| 产物能被 loader 执行并注册条目 | `node --check … && node /tmp/wp_probe_run.mjs`（stub 掉 `window.__ModuleLoader__` 与 `require('react')`） | id=`workprocess`；`apply` 后注册 `{"name":"conversation.input.dock","id":"workprocess-probe","order":99}`；占位文案渲染成功 |

## 待人工确认（我做不到的那一步）

**宿主必须重启**：扫描结果按包**缓存**，否定结论"stable until restart"
（`packages/client/modules/src/index.ts:601-603` 的 `pkgMeta` 注释；构造函数在 boot 时一次性扫 Loader 行）。
我无法重启正在承载本会话的桌面宿主。

重启后请确认两件事：
1. composer 上方（todo / goal 那一条带里）**多出一行**「🧪 workprocess 探针：客户端半已加载」。
2. 浏览器半加载报告无 `workprocess` 报错（`cordis_inspect what:"temporary"`）。

> 顺带记录：宿主 web 服务在 `127.0.0.1:19387`，产物路由形如
> `/plugins/<包名>/client.js?rev=<rev>`（`packages/client/modules/src/index.ts:249-251`）——**带 rev 才命中**，
> 不带 rev 一律 404（本机已实测：`/plugins/workprocess/client.js → 404`），所以别用裸 URL 下结论。

## 人工确认结果（2026-10-12）

**✅ 通过。** 宿主重启后，用户亲测：
- 探针行**出现在输入框上方那条带里**（与 todo / goal 同槽，槽位选型正确）。
- 用户反馈"展示了但是没有 todo 那样在输入框上面"——注意：条目**确实在输入框上方**，只是**样式**不像 todo（探针是裸 `div` 一行字，todo 是 section 卡片）。真实现的视觉外壳要求已作为 **决策 D-5** 追加进 `docs/workprocess-ui-design.md` ⑥。
- 用户未报告加载报错（条目渲染成功即说明浏览器半加载无异常）；`cordis_inspect what:"temporary"` 未单独检查，以界面观测为准。
- **截图证据**：`docs/workprocess-ui-probe-observation.webp`（用户提供，1754×308）。可见探针行在输入框上方、**全宽无卡片皮**；与 todo 的差异正是视觉外壳，已由决策 D-5 承接，**不是**槽位或注册问题。

**结论：最大的未知数已排除——仓外 `link:` 插件声明 `dsh.client` 后能被宿主扫描到并成功注册进 `conversation.input.dock`。**

## 回滚

```bash
cd /Users/mac/Documents/ai/dsh/dsh-workprocess/workprocess
git checkout -- package.json        # 去掉 exports["./client"] 与 dsh.client
rm lib/client.probe.js
```
（实施阶段本就该把 `./client` 改指向真产物并删掉本探针。）
