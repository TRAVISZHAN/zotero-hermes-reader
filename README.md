# Hermes Reading Assistant for Zotero 9

这是一套 Zotero 9 插件 + Mac(4090) 上的 Hermes Desktop Relay。目标是在 Zotero 的论文条目面板里调用 Hermes，并把当前论文、PDF 选区和会话绑定起来。

## 当前状态

- 插件版本：`0.5.1`
- 插件 ID：`hermes-reading-assistant-z9@altail.local`
- 最新 XPI：`dist/Hermes-Reading-Assistant-Zotero9-0.5.1.xpi`
- 最新 XPI SHA-256：`6afe48f858bae8c15df9b48213f4e14ad2b954638893923b298ef2949bbe2d80`
- Zotero：9.0.6
- Zotero profile：`~/Library/Application Support/Zotero/Profiles/<profile>.default`
- 修改 XPI 后必须重启 Zotero，才能让内存中的 bootstrap 代码更新。

## 已实现功能

### Zotero 侧栏

- 在 Item Pane 注册 Hermes 区块，使用 Hermes 图标作为 sidenav 图标。
- `header.l10nID` 和 `sidenav.l10nID` 都是 `ItemPaneManager` 的必填字段，必须保留。对应的 FTL 消息**只能有属性，不能有消息值**，见下面的排查点。
- 当前论文自动生成独立会话，按 `libraryID:itemKey` 保存会话绑定。

### PDF 选区

- PDF 文本选区弹窗增加“问 Hermes”。
- 高亮注释上下文菜单增加“问 Hermes（此高亮）”。
- 发送给 Hermes 的上下文包含原文、PDF 页码/页标签、论文元数据和 `zotero://select/library/items/<key>` 链接。

### 论文原文的来源

插件本身不传输任何文献内容,只发元数据、PDF 附件 key、PDF 本地路径,以及你在 PDF 里选中的原文。Hermes 读到的论文来自它自己那台机器:

- **Zotero MCP**:`~/.hermes/config.yaml` 的 `mcp_servers.zotero` 指向 `http://127.0.0.1:23120/mcp`(zotero-mcp-plugin 提供),用于读全文、检索、读高亮注释。需要那台机器的 Zotero 处于运行状态。
- **PDF 文件**:`paperContext()` 会带上 `attachment.getFilePath()` 得到的绝对路径,以及 `storage/<key>/<文件名>` 相对路径。同步后两台机器的附件 key 和文件名一致,但 data directory 未必相同,所以两种路径都发。

页码只能来自逐页读取。Zotero 的全文索引和 Hermes 的文档提取都是无页边界的扁平文本,因此 `evidenceRules()` 明确要求用 `pdftotext -f N -l N <path>` 取页,不允许按全文位置估算。

### 连接设置

Hermes 地址和令牌在 **Zotero → 设置 → Hermes 阅读助手** 里配置，通过 `Zotero.PreferencePanes.register` 注册。侧栏右上角只保留两个按钮：`↻` 重连、`⚙` 跳转到该设置页。

`prefs.xhtml` 是 XUL 片段，不是完整文档。`oncommand` 属性不会被 `parseXULToFragment` 接成监听器，所以按钮事件在 `main.js` 的 `initPrefPane` 里绑定；`onload` 是标准事件处理属性可以直接用，但它在 prefs 窗口的全局作用域求值，因此 `bootstrap.js` 必须把模块挂到 `Zotero.HermesReadingAssistantZ9` 上。

### 快捷动作

- 导读
- 解释此段
- 提取实验参数
- 核查结论
- 写入 Obsidian

“写入 Obsidian”是两阶段流程：Hermes 先返回拟追加 Markdown 和原文依据，用户在 Zotero 面板确认后才发送写入请求。插件本身不会直接写文件。

### Markdown

Hermes 回复使用安全的 DOM 渲染，不把模型输出作为 `innerHTML` 执行。当前支持：

- 标题、段落、换行
- 粗体、斜体、删除线、行内代码
- 有序/无序列表
- 引用、分隔线
- fenced code block（保留语言标记）
- Markdown 链接和表格

外部图片只显示为文字标签，不会自动从模型返回的 URL 拉取。

## 远程 Hermes 连接

Hermes Desktop 在 Mac(4090) 上的后端只监听 `127.0.0.1` 且端口会动态变化，因此增加了一个只绑定 Tailscale 的稳定 Relay：

- Relay 地址：`http://100.x.y.z:8644`
- Relay 绑定：`$HERMES_RELAY_HOST:8644`（填本机 Tailscale 地址），不暴露公网
- 健康检查：`GET /api/health`
- Relay 自动读取 `~/.hermes/spawn-ledger.json`，跟随当前 Hermes Desktop 的动态 serve 端口
- 当前已知 backend 端口可能是 `52836`，不要把它写死在插件里

Mac(4090) 上的部署文件：

- `~/.hermes-remote-relay/hermes-remote-relay.py`
- `~/Library/LaunchAgents/ai.hermes.remote-relay.plist`

仓库中的对应模板：

- `remote-relay/hermes-remote-relay.py`
- `remote-relay/ai.hermes.remote-relay.plist`

MacBook 上的 Zotero 设置：

1. Zotero → 设置 → **Hermes 阅读助手**（也可以点侧栏右上角的齿轮直接跳过去）。
2. 地址填写 `http://100.x.y.z:8644`。
3. 令牌留空，插件会先读取 Relay 根页面里的动态 session token。
4. 点击“保存并连接”。所有已打开的 Hermes 侧栏会一起重连。

两台机器都需要登录同一个 Tailscale 网络。若使用 `<your-host>.ts.net`，需要确保 Stash 对 `*.ts.net` 跳过代理；使用 `100.x.y.z` 时需要确保 `100.64.0.0/10` 为 DIRECT。

Relay 验证命令（在 Mac(4090) 或同一 Tailscale 网络机器上执行）：

```bash
curl --noproxy '*' http://100.x.y.z:8644/api/health
```

预期返回类似：

```json
{"ok": true, "backend_port": 52836}
```

## 正式安装插件

不要直接把 XPI 覆盖到 Zotero profile，也不要用 `open -a Zotero file.xpi`，后者可能被 Zotero 当作普通附件导入。使用 Zotero 自己的安装流程：

1. Zotero → 工具 → 插件。
2. 点击插件管理器右上角齿轮。
3. 选择 **Install Plugin From File...**。
4. 选择 `dist/Hermes-Reading-Assistant-Zotero9-0.5.1.xpi`。
5. 完成后完全退出并重新打开 Zotero。

可以在插件管理器确认名称为 **Hermes Reading Assistant (Zotero 9)**，并在 profile 的 `extensions.json` 中确认版本为 `0.5.1`。

不要手工把 `extensions/` 目录里的 XPI 改名或删除。这样做只会让 Zotero 在下次启动时把整条 `extensions.json` 记录清掉，插件直接消失，而不是"升级"。

## 开发与验收

在项目根目录执行：

```bash
python3 build.py
node --check content/scripts/main.js
node --check content/scripts/core.js
python3 -m unittest discover -s tests -v
```

当前测试为 8 项，覆盖 bootstrap 生命周期、XPI 打包、协议辅助函数、Zotero 9 Item Pane 合约、连接设置位于 Zotero 设置而非侧栏、侧栏不得撑宽 item pane、输入框不得把发送按钮挤出右边界，以及 FTL 消息不能带消息值的约束。

## 重要文件

- `bootstrap.js`：注册 chrome URL、加载 core/main、启动和关闭插件。
- `content/scripts/core.js`：地址规范化、论文上下文、会话/Obsidian 合约等纯逻辑。
- `content/scripts/main.js`：Zotero Item Pane、WebSocket 网关、PDF 选区、Markdown DOM 渲染和设置面板。
- `content/prefs.xhtml`：Zotero 设置里的“Hermes 连接”面板（XUL 片段）。
- `content/hermes-reader.css`：面板、消息、Markdown 样式。
- `locale/*/hermes-reading-assistant.ftl`：区块标题和 sidenav 无障碍标签。
- `remote-relay/hermes-remote-relay.py`：动态端口发现、HTTP token 转发和 WebSocket 双向转发。
- `tests/`：Node/Python 测试。

## 已知排查点

### 侧栏没有 Hermes 图标

首先确认已经重启 Zotero，并确认 profile 的 `extensions.json` 里有 `hermes-reading-assistant-z9@altail.local`。如果仍然没有图标，打开 Zotero → 工具 → 开发者 → Error Console，搜索 `Hermes Reading Assistant Z9` 或 `ItemPaneManager`。

不要删除 `main.js` 注册对象里的 `sidenav.l10nID`。Zotero 9 的插件 API 会因为缺少必填字段而拒绝整个区块注册。

### 区块只剩一行标题文字，内容全空；sidenav 图标上叠着文字

FTL 消息写了消息值（`msg-id = 文本`）。Fluent 在消息有值时会用该值覆盖宿主元素的 `textContent`：

- `header.l10nID` 挂在 `<collapsible-section>` 上，覆盖会同时删掉它的 `.head` 和 `<div data-type="body">`，`onRender` 拿到的 body 随之脱离文档，面板就变成一行纯文字。
- `sidenav.l10nID` 挂在 sidenav 的 `.btn` 上，覆盖会把标签文字直接画在图标上。

因此本插件的 FTL 只能写属性：

```
hermes-reading-assistant-section-header =
    .label = Hermes 阅读助手
hermes-reading-assistant-sidenav =
    .tooltiptext = Hermes 阅读助手
```

`collapsible-section` 用 `label` 属性渲染标题，sidenav 按钮是 XUL 元素、用 `tooltiptext` 做提示，这和 Zotero 自带的 `section-tags` / `sidenav-tags` 写法一致。`tests/test_package.py::test_ftl_messages_have_no_value` 会挡住这个回归。

### 侧栏内容右边被截断

`.zotero-view-item-main` 是行方向 flex 项且 `min-width: auto`，所以侧栏里任何很宽的元素都会把整个 item pane（连同 Zotero 自己的条目标题）顶出右边界。`.hermes-reader-z9` 因此设了 `contain: inline-size`，让本区块的宽度只由容器决定。新增宽元素时不要去掉这条。

### 发送按钮被右边界切掉

输入框不要用 `width: 100%`。它是 `.hermes-reader-z9-composer` 的 flex 项，宽度由 `flex: 1 1 120px` + `min-width: 0` 决定；固定宽度会连同 `resize` 拖拽留下的行内 `width` 一起把发送按钮顶出面板。composer 设了 `flex-wrap: wrap`，实在放不下时按钮换行显示，而不是被切掉。

### 填了远程地址后连不上,报"无法连接 Hermes(host)"

这条报错来自 `socket.onerror`,意味着 HTTP 取令牌那步**已经成功**,失败的是 WebSocket 握手 —— 不是令牌问题。

历史原因是 URL 拼接:`new URL("http://host:8644").pathname` 返回 `"/"` 而不是 `""`,再接上 `/api/ws` 就成了 `//api/ws`。Relay 的 `add_get("/api/ws", ...)` 匹配不到这个路径,会落到 catch-all 的 HTTP 代理上,返回 404,握手失败。本机自动发现不受影响,因为那条路径的 `wsURL` 是手工拼的字符串,没有尾斜杠。

所以 WebSocket 基址一律走 `HermesReaderCore.gatewayWebSocketURL()`,不要在 `main.js` 里重新拼。`tests/test_core.js` 里有对应断言。

验证 relay 端可以直接握手:

```bash
curl -s --noproxy '*' http://100.x.y.z:8644/api/health
```

### Relay 请求超时

先执行上面的 `curl --noproxy '*'` 检查。若直连成功而普通 curl 超时，通常是本机 Stash/TUN 代理拦截了 Tailscale 地址。检查 `100.64.0.0/10 DIRECT` 或 `*.ts.net` 跳过代理规则。

### Hermes 后端端口变化

这是预期行为。Relay 会从 `~/.hermes/spawn-ledger.json` 找到最新仍存活的 `purpose=serve` 进程；不要在插件、LaunchAgent 或文档里硬编码动态端口。

## 后续可扩展方向

- 增加会话列表和按论文搜索历史。
- 为图、表、公式定位增加结构化展示和点击跳转。
- 增加 Obsidian vault/目标笔记的显式选择器。
- 对 Relay 增加更清晰的断线重连状态和 Tailscale 主机名配置。
- 用 Zotero 集成测试验证真实侧栏按钮、Markdown 渲染和 PDF 选区事件。
