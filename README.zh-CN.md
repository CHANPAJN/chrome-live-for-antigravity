<div align="center">

# chrome-live-for-antigravity

专为 **Google Antigravity** 打造的零依赖 Chrome MV3 桥接与原生 **MCP App（`SEP-1865`）**，支持 Windows、macOS 与 Linux。  
直接复用你日常已登录的 Chrome / Edge 浏览器——聊天内 0 Token 实时画框、防误触禁止点击锁、青 / 黄彩色标签组状态、独立副屏扫码接力与单轮 `batch` 连招，无任何第三方 npm 包或黑盒二进制。

<p>
  <a href="./README.md">English</a> ·
  <b>简体中文</b>
</p>

<p>
  <a href="https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml"><img src="https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml/badge.svg" alt="Cross-Platform CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="GPL-3.0 License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Dependencies-Zero%20(Node%20%3E%3D%2020)-2F855A?style=flat-square" alt="Zero Dependencies" /></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/Community-LINUX%20DO-1C1C1E?style=flat-square&logo=linux&logoColor=34D399" alt="LINUX DO" /></a>
</p>

<img src="./docs/real-dual-demo-zh.gif" width="840" alt="chrome-live-for-antigravity 实时演示" />

<sub>独立社区开源项目，与 Google LLC 无关联。</sub>

</div>

<details>
<summary>查看真实 Chrome 窗口 + CLI 原始录屏</summary>
<p align="center">
  <img src="./docs/real-demo.gif" width="840" alt="真实 Chrome 窗口与 CLI 实录" />
</p>
</details>

## 核心能力

- **一键直连复用标签页 + 右侧折叠工牌**：直接单击浏览器右上角扩展图标（不抢占右侧边栏，右键可打开独立控制台小窗）或按 `Alt+Shift+L`（macOS 为 `Option+Shift+L`），即可把当前已登录标签页交给 Antigravity（图标实时显示 `LIVE` / `HOLD` 角标）。受控页平时仅在右边缘贴壁收折一枚紧凑 `LIVE` / `HOLD` 导播工牌（移入滑出白底控制条，上下视野零遮挡）；随时点一下工牌、双击网页空白处或按键盘 `Esc` 即可毫秒级切回手动模式；执行 `done` 只卸载调试器，绝不关闭你的原页面。
- **青 / 黄标签组状态 + 顶边 `2.5px` 导播细线**：AI 操作时页面归入顶部青色 **`Live · 操控中`** 标签组并显示 `2.5px` 顶边导播细线（无四周发光雾遮挡），后台新开查询页自动折叠成小胶囊，不弹新窗不抢前台焦点；一旦点击 `LIVE` 工牌、双击页面、按 `Esc` 或弹出独立副屏人工接手，标签组与顶边细线立刻切换为琥珀色 **`Live · 已暂停`**（`HOLD`），当前归谁操控一目了然。
- **聊天内 0 Token 实时画框 + 多标签同屏切换（`SEP-1865`）**：支持聊天内联（`chrome_live_monitor`）、右侧分屏与左侧全屏工作台（`chrome_live_workspace`），实时画面不消耗模型 Token。支持同时托管多个受控标签页，按 `tabId` 独立隔离帧流并在画框顶栏随时切屏，内置 6 个快捷动作：
  - **接管**：直接在画框里远程点击、滚轮翻页和输入文字；
  - **圈选**：在画框上拉框选区域，穿透开放 Shadow DOM 提取真实选择器和文本发回对话；
  - **挂入**：把当前页面标题、URL 和 `tabId` 附到下一条提示词上下文；
  - **副屏 / 归队**：遇到扫码或人机验证时一键弹出独立小窗手动处理；在浏览器悬浮条点「继续」即可合回并恢复 AI 接管，若从外部点「归队」或直接点右上角 `×` 关掉副屏窗口，页面会带 Cookie 归队回主窗口并保持「已暂停」保护态（关窗重开会重新加载该页 URL，在浏览器内点「继续」后恢复操控）；
  - **刷新 / 释放**：手动拉取最新一帧，或立即解除受控并卸载调试器。
- **拟人化交互、单轮 `batch` 连招与并发正文提取**：鼠标移动带贝塞尔曲线轨迹与接近减速，打字带错落间隔；支持通过 stdin 把 `open → type → click → wait → snapshot → done` 合并为 1 轮调用；`extract` 在后台标签页并发抓正文和原图直链、抓完即关；`snapshot` 穿透开放 Shadow DOM，准确标出 `{DISABLED}`、`{checked}`、`{selected}`、`{expanded}` 与页面校验报错。
- **按需开启的本地站点路书（`playbook on`，默认关闭）**：代码默认 `false`。在扩展侧边栏或命令行开启后，自动剔除敏感与追踪查询参数，在本地 `~/.chrome-live-antigravity/site-playbooks.json`（POSIX `0700`/`0600` 权限，Windows 自动配置当前登录用户专属 `icacls` ACL）记录直达路由、稳定 CSS 选择器与避坑提示，二次访问同域名直接跳过摸索。

## 实测对比

测试场景：打开 `pypi.org` → 输入搜索词 → 提交 → 等待加载 → 提取结果 → 清理收尾（基于底层会话账单实测）：

| 模式 | 对话轮次 | 总耗时 | 总 Token 吞吐 | 非缓存净消耗 |
| :--- | :---: | :---: | :---: | :---: |
| 传统逐步调用（`open → snapshot → type → click → wait → snapshot → done`） | 7 轮 | 71.0s | 419,162 | 20,360 |
| `batch --compact` 单轮连招 | **1 轮（-85.7%）** | **13.0s（提速 5.5 倍）** | **67,365（-83.9%）** | **2,445（-88.0%）** |
| 开启本地路书（`playbook on`）二次访问 | **1 轮（-85.7%）** | **10.0s** | 跳过首页直接定位 | — |

常驻后台占用实测：空闲 CPU `< 0.01%`（实测 `0.0096%`），私有内存约 `30–34 MB`，守护进程重启后扩展约 `3 秒` 自动重连，本地安全拦截耗时 `< 100ms`。

## 安装

需本机已安装 `Node.js >= 20`，无需 `npm install` 任何第三方依赖。

**AI 对话一键配置**（直接粘贴给 Antigravity，详见 [AI_INSTALL.md](./AI_INSTALL.md)）

```text
请阅读 https://github.com/CHANPAJN/chrome-live-for-antigravity/blob/main/AI_INSTALL.md ，按步骤帮我克隆并配置好 chrome-live-for-antigravity，生成本地配对口令并启动桥接服务，最后把需要拖入 chrome://extensions 的本地目录路径发给我。
```

**手动安装（3 步）**

**第一步：克隆并生成本地配对口令**（写入 `~/.chrome-live-antigravity/auth.token`，POSIX `0600` / Windows 当前用户专属 `icacls` ACL，并自动生成被 `.gitignore` 忽略的 `extension/.local-runtime.json`）

```bash
git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
cd chrome-live-for-antigravity
node ./bin/chrome-live.mjs setup
```

**第二步：加载浏览器扩展（Chrome / Edge / Brave）**  
Chrome `137+` 已移除 `--load-extension`，请在地址栏打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」，点击「加载已解压的扩展程序」选中仓库下的 `extension/` 目录，再运行检查确认连通：

```bash
node ./bin/chrome-live.mjs health
```

**第三步：接入 Antigravity**（默认不会改动 `~/.gemini/config/`，按需二选一）

```bash
# 方式 A：一键安装 Antigravity 插件（含 SKILL.md 与实时画框面板）
node ./bin/chrome-live.mjs install --with-plugin
```

> **后续拉取新版本热更新**：执行 `git pull && node ./bin/chrome-live.mjs reload`（若装了插件则跑 `git pull && node ./bin/chrome-live.mjs install --with-plugin`），会自动重启本地守护进程并后台热重载 Chrome 扩展，无需去 `chrome://extensions` 手动点刷新。

或手动挂载为标准 `stdio` MCP Server：

```json
{
  "mcpServers": {
    "chrome-live": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-live-for-antigravity/bin/chrome-live.mjs", "mcp"]
    }
  }
}
```

## 使用与命令

```bash
node ./bin/chrome-live.mjs health                           # 查看守护进程与扩展连接状态
node ./bin/chrome-live.mjs reload                           # 后台热重载本地扩展（本地文件更新后也会自动无感热更，免开扩展页点刷新）
node ./bin/chrome-live.mjs open "https://example.com"       # 在后台青色折叠标签组静默打开网页
node ./bin/chrome-live.mjs snapshot                         # 提取带编号元素 [0],[1] 与正文
node ./bin/chrome-live.mjs click 0                          # 按序号、CSS 选择器或按钮文字点击
node ./bin/chrome-live.mjs type "搜索" "关键词" --submit    # 填词并提交
node ./bin/chrome-live.mjs upload "~/.chrome-live-antigravity/uploads/demo.png" # 通过原生 CDP 上传暂存目录附件
node ./bin/chrome-live.mjs batch - --compact                # 从 stdin 单轮执行多步连招
node ./bin/chrome-live.mjs extract "https://a.com"          # 后台并发提取正文与原图直链
node ./bin/chrome-live.mjs relay popout                     # 弹出独立副屏供人工处理扫码/验证
node ./bin/chrome-live.mjs relay merge                      # 合回原主窗口（保持已暂停保护态，在浏览器内点继续恢复 AI）
node ./bin/chrome-live.mjs release                          # 释放当前页控制权（不关闭页面）
node ./bin/chrome-live.mjs done "任务完成"                  # 断开调试器并清理临时工作页
```

**隐藏顶部「已开始调试此浏览器」提示条幅**

只要扩展挂载 Chrome 原生 `chrome.debugger` API，Chrome 默认会在顶部弹出 `“Chrome Live (for Antigravity)”已开始调试此浏览器 [取消]`（点「取消」会立即断开当前 AI 控制）：

- **默认自动消失**：平时不用手动点取消，任务执行 `done` 或空闲满 18 秒后扩展会自动卸载调试器，条幅随之消失。
- **彻底隐藏条幅（可选）**：完全退出 Chrome 后，给启动命令加上 Chromium 官方参数 `--silent-debugger-extension-api` 即可不再显示：
  - **Windows**：右键桌面或任务栏上的 Chrome 快捷方式 → **属性** → 在「目标」末尾引号**外面**加空格和 `--silent-debugger-extension-api`，确定后重启 Chrome：
    ```text
    "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
    ```
  - **macOS**：彻底退出 Chrome（`Cmd + Q`）后在终端运行：
    ```bash
    open -b com.google.Chrome --args --silent-debugger-extension-api
    ```
  - **Linux**：命令行运行 `google-chrome --silent-debugger-extension-api`，或在 `~/.local/share/applications/` 对应 `.desktop` 文件的 `Exec=` 末尾追加该参数。

**多标签并发边界与模型提效建议**

- **多开边界**：画框顶栏同时托管并自由切换多个标签页、以及 `extract` 后台并发抓正文均按 `tabId` 严格隔离运行；但涉及多站点富文本发帖、粘贴传图（共用系统剪贴板）或依赖前台焦点的复杂表单时，建议按站点串行执行，避免焦点与剪贴板互相抢占。
- **推荐模型搭配**：
  - **日常查资料、批量抓取、常规单轮 `batch`**：优先用 **Flash / 快速轻量档模型**，工具调用极快、成本低，配合 `batch --compact` 与本地站点路书（`playbook on`）约 10 秒即可完成一次检索闭环；
  - **复杂后台表单、动态 Shadow DOM 控件与排错**：切到 **高推理主力档模型**，对 ARIA 状态提示与复杂交互链路的判断更稳。

## 架构与透明边界

- **按需挂载调试器 & 硬暂停/硬取消**：仅在执行命令或拉流期间挂载 `chrome.debugger`（`1.3`），空闲 18 秒自动卸载释放（空闲 CPU `< 0.01%`）。一旦点右侧 `LIVE` 工牌、双击页面、按 `Esc` 键或弹出副屏，扩展会立即停止画面流、卸载调试器、清空缓存画面并中止在途点击/输入/等待步骤（拒绝晚到状态更新重新锁屏）。画框 UI 交互动作受仅经 `CallToolResult._meta` 投递至隔离沙箱 `ui://` iframe 的 256 位随机能力令牌保护（不出现在 `resources/read` 静态 HTML、`content` 或 `structuredContent` 中），且仅浏览器内真人手势可解除暂停。（注：若同时安装可选的 CLI `SKILL.md`，本机具备终端权限的编码智能体可直接调用本地命令行；若需严格限制在 MCP 工具集内，仅挂载 `stdio` MCP Server 即可。）点击 Chrome 顶部原生横幅的「取消」会彻底撤销该页授权，绝不偷偷重挂；共享已有登录标签页必须由你在浏览器内手动确认。
- **本地回环隔离与全链路双向 HMAC 零明文鉴权**：守护进程严格监听 `127.0.0.1:28196`（可用 `CHROME_LIVE_PORT` 修改），校验 `Host` 头、拒绝所有网页 `Origin`（`403`）、在缓冲任何 POST 包体字节前先对独立请求头签名 `X-Chrome-Live-Hdr-Sig`（绑定 `Content-Length`、时间戳与十六进制 Nonce）完成密码学 HMAC 验签、按 RFC 6455 强制校验客户端帧掩码，并在 `auth.token` 轮换时立即主动断开存量 WebSocket 会话；扩展（WS + HTTP）、CLI、MCP 服务与独立侧栏**全链路采用无分隔符歧义的 JSON 元组 HMAC-SHA256 双向请求/响应签名 + Nonce 防重放**（全程 0 字节明文口令走本地回环）。状态目录启用 POSIX `0700`/`0600` 权限与 Windows 当前用户专属 `icacls` ACL；一次性配对文件 `extension/.local-runtime.json` 排除在 `npm pack` 之外并在首次握手成功后自动覆写擦除。是否向登录/验证码表单输入或点击验证控件完全由用户及所选模型自身的安全策略决定，而**读取侧保持严格单向脱敏**：快照、容器标签与点击回执绝不读取页面已有的密码框值、`-webkit-text-security` 掩码文本、代码/富文本编辑器草稿及用户输入值，拦截 CSS 属性前/后缀探测选择器，并对传出 URL 与正文摘要中的常见高熵/敏感查询串及 `#hash` 参数执行多层启发式脱敏。
- **双层金融与暂存箱上传护栏（及如实边界说明）**：守护进程与扩展在 `open`、`navigate`、`batch` 与 `extract` 全链路双层拦截主流支付网关（支付宝、微信支付、Stripe、PayPal、网银）、`chrome://` / `edge://` 及常见 `/checkout`、`/pay`、`/payment`、`/cashier`、`/billing` 路由（经多层百分号解码、`;matrix` 参数与尾随点号规范化、`.html`/`.php`/`.htm` 后缀匹配、SPA Hash 解析及 `webNavigation` 子 frame 真实落地 URL 核验）。CDP 文件上传**默认严格限定在专用暂存目录 `~/.chrome-live-antigravity/uploads` 内**（也可通过 `CHROME_LIVE_UPLOAD_DIR` 自定义白名单目录），在校验 `lstat`/`realpath` 与 `nlink === 1`（POSIX 启用 `O_NOFOLLOW`，Windows 追加打开后 `realpathSync.native` 复核）后直接从文件描述符生成一次性私有只读快照（阻断跨步长 TOCTOU 替换），拒绝符号链接、目录联接（Junction）、硬链接与 `.ssh`、`.env`、`.aws`、`Local State`、`key4.db`、`.pem`、`.tfstate` 等敏感凭据。同时受控多个标签页时，操作指令必须显式指定 `tabId`。需注意：启发式路由与令牌脱敏护栏无法覆盖任意非标准自研编码路由，也不会识别普通商家后台里的改价、发货、退款等业务按钮；DOM 脚本不进入跨源 `<iframe>`，但在未命中拦截规则的普通页面上，浏览器级截图与坐标点击仍覆盖当前可见视口；高敏感账号建议放在独立 Chrome 用户配置中使用。
- **零客户端修改、零第三方依赖 & 干净卸载**：全部代码基于 Node.js `>= 20` 内置标准库与明文 MV3 JavaScript 编写，不修改 Antigravity 客户端任何文件；关闭式 Shadow DOM 与系统级文件对话框均受浏览器沙箱隔离不可访问。运行测试或彻底卸载：

```bash
npm test                                                    # 运行安全护栏、协议与端到端集成测试
node ./bin/chrome-live.mjs stop                             # 停止服务后，在扩展页移除扩展并删除 ~/.chrome-live-antigravity
```

## 许可协议

基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开源发布。感谢 [LINUX DO](https://linux.do) 社区的交流与反馈支持。
