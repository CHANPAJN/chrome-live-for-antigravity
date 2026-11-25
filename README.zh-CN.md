# Chrome Live (for Antigravity)

[![Cross-Platform CI](https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml/badge.svg)](https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml) · [English Documentation](./README.md) · **开源协议：GPL-3.0-only** · **纯 Node.js 标准库零外部依赖**

> **独立社区项目声明：** 本项目为面向 Google Antigravity 开发者社区的独立开源工具，与 Google LLC 或 Meta Platforms, Inc. 无任何隶属、官方背书或赞助关系。

**Chrome Live (for Antigravity)** 通过纯本地、零第三方依赖的 Node.js 桥接服务（`127.0.0.1:28196`），让 Antigravity（以及 Claude Code、Codex、OpenCode 等任意支持 CLI 或 MCP 的智能体）直接复用**你日常已登录的主力 Chrome / Edge 浏览器**。

无需再忍受空白无 Cookie 的沙箱浏览器反复弹验证码或每次弹远程调试 `Allow` 授权框：你可以随时按 `Alt+Shift+L`（macOS 为 `Option+Shift+L`）**将当前已登录标签页一键接管给 Agent 操作**，也可以让它在**当前窗口折叠的后台彩色标签组**里静默查资料，同时直接在内置 **Antigravity MCP App（SEP-1865）** 的聊天流内联画框、右侧分屏或左侧全局栏里同屏观看与接力操控。

<p align="center">
  <img src="./docs/real-dual-demo.gif" alt="100% 双真机同步实录：官方正式版 Antigravity（内联 SEP-1865 MCP App 实时画框）与真实 Chrome 同屏联动、青色后台折叠标签组与本地支付护栏拦截" width="880" />
</p>
<p align="center"><sub>100% 真实桌面双窗同步实录（零合成零模拟）：左侧官方正式版 Antigravity（原生内联 <code>chrome_live_monitor</code> 实时画框、<code>LIVE · 0 Token</code> 与 6 键顶栏），右侧真实 Chrome（毛玻璃灵动岛、零抢焦点青色折叠后台标签组 <code>Live · Active</code>、本地拦截 <code>checkout.stripe.com</code>）。</sub></p>

<details>
<summary><strong>展开查看纯 CLI 终端 + 真实 Chrome 实录演示（适用于 Claude Code / Codex / OpenCode）</strong></summary>
<p align="center">
  <img src="./docs/real-demo.gif" alt="真实 Chrome 1:1 实录演示：实时 CLI 驱动原版 Chrome、协作飞镖光标与毛玻璃灵动岛、青色后台折叠标签组、本地支付护栏拦截" width="880" />
</p>
</details>

---

## 实测性能与 Token 对比（Benchmark）

基于真实浏览器多步检索全链路（打开 `pypi.org` → 检索填词 → 提交 → 等待加载 → 提取结果快照 → `done` 收尾）的底层会话账单实测：

| 执行模式 | 工具调用轮次 | 端到端总耗时 | 总 Token 吞吐量 | 非缓存净消耗 Token |
| :--- | :---: | :---: | :---: | :---: |
| **传统单步循环**（`open` → `snapshot` → `type` → `click` → `wait` → `snapshot` → `done`） | 7 轮 | 71.0s | 419,162 | 20,360 |
| **`batch --compact` 单轮连招** | **1 轮（-85.7%）** | **13.0s（提速 5.5 倍）** | **67,365（省 83.9%）** | **2,445（省 88.0%）** |
| **开启本地路书（`playbook on`）二次直达** | **1 轮（-85.7%）** | **10.0s（比 batch 再快 23%）** | 跳过首页摸索，一步直达深层路由 | — |

- **常驻后台资源开销：** 空闲 CPU **`< 0.01%`**（实测 `0.0096%`），私有内存约 **`34 MB`**，守护进程重启后 **`~3.1 秒`** 扩展自动无感重连，收银台/网银护栏本地拦截耗时 **`< 100ms`**。

---

## 核心特性

- **安全复用已登录会话（按标签页显式授权 + 防误触锁定）：** 按 `Alt+Shift+L`（或在扩展侧边栏点击「接管当前标签页」）即可授权并开启防误触锁定；需要手动介入时在网页任意处**按住鼠标左键满 3 秒**即可原地丝滑解锁。执行 `done` 收尾时自动卸载调试器，**绝不会误关你正在使用的日常标签页**。
- **零抢焦点后台标签组：** Agent 新开网页自动归入当前窗口折叠的 `Live · 操控中` 青色标签组，不弹独立窗口、不抢前台打字或阅读焦点。
- **静默多页并发提取（`extract`）：** 直接复用当前窗口未激活后台标签页并发抓取多篇帖子的纯净正文与高清大图链接，抓完毫秒级自动关闭临时页，任务栏零弹窗闪烁。
- **原生内置 Antigravity MCP App（SEP-1865 三入口：对话内联 + 右侧分屏 + 左侧全局栏）：** 零依赖实现官方 MCP Apps 协议（`ui://chrome-live/live-monitor.html`），同时支持聊天框内联画框（`chrome_live_monitor`）、右侧分屏 `+` 菜单（`aux_pane`）和左侧边栏 Plugins 全屏控制台（`global`，由 `chrome_live_workspace` 提供），按 `tabId` 独立隔离实时帧流：
  - **一键挂入对话上下文（`挂入` / `Attach`）：** 点一下即可通过 `ui/update-model-context` 将当前网页标题、URL 与 `TabId` 挂进下一条提问输入框（自动按宿主能力在全局全屏视图隐藏无对话按钮）。
  - **一键副屏接力与归队（`副屏` ↔ `归队`）：** 遇到扫码、滑块或复杂表单时，一键把受控页弹出为独立副屏窗口并自动解锁交给人手操作；处理完点一下归队（或点网页胶囊「继续」），标签页自动飞回原窗口原序号并恢复 AI 接管。
  - **画面流直连控制（`接管` / `Control`）：** 不用切出聊天框，直接在实时画面上点击、滚轮翻页或输入发字，后台自动换算精确视口坐标派发 CDP 事件。
  - **框选 DOM 直通对话（`圈选` / `Pick`）：** 在画面上单击或鼠标拖拽框选任意区域，自动穿透 Shadow DOM 提取该区域内真实选择器与文本并挂入聊天上下文。
- **Shadow DOM 穿透 + 现代 ARIA 表单状态与红字校验识别：** `snapshot` 不仅穿透开放式 Shadow DOM，还能直接识别 `[role="switch"]`/`[role="radio"]`/`[role="checkbox"]`/`[role="option"]`，标注 `{DISABLED}`、`{checked=true/false}`、`{selected}`、`{expanded}` 状态并自动提取页面校验报错提示（`Alerts:`）；`click` 遇到禁用按钮直接报明原因，彻底告别盲点盲截图。
- **原生 CDP 本地文件上传（`upload`）与灵动岛胶囊 HUD：** 基于 CDP `DOM.setFileInputFiles` 直接注入本地图片/附件（支持纯富文本编辑器粘贴回退与凭据文件护栏），受控页面悬浮纯 CSS 物理弹簧圆角胶囊与平滑协作光标。
- **CLI 技能 + 标准 MCP 双通道：** 既可通过 `SKILL.md` 零上下文损耗按需调用 CLI（支持 `batch - --compact` 标准输入连招），也可通过 `chrome-live mcp` 作为标准 `stdio` MCP Server 挂载。
- **可选开启的本地站点直达路书（`playbook on`，默认关闭）：** 代码默认关闭（`false`）。显式开启后，自动剥离 Token 与追踪参数，在本机 `~/.chrome-live-antigravity/site-playbooks.json` 沉淀深层后台直达路由与控件避坑提示，二次访问同域名直接 1 步跳转。
- **零二进制、零第三方依赖：** 100% 基于 Node.js `>= 20` 内置标准库与原生 Manifest V3 明文编写，无任何外部 npm 包与黑盒二进制文件。

---

## 快速开始

### 懒人一句话安装（推荐 · 直接复制发给你的 AI）

把下面这句话直接发给 **Antigravity、Claude Code、Codex、OpenCode 或 Cursor**，AI 会自动帮你跑完克隆、生成配对口令、启动守护进程并给出扩展目录路径：

```text
请阅读 https://github.com/CHANPAJN/chrome-live-for-antigravity/blob/main/AI_INSTALL.md ，按步骤帮我克隆并配置好 chrome-live-for-antigravity，生成本地配对口令并启动桥接服务，最后把需要拖入 chrome://extensions 的本地目录路径发给我。
```

---

### 手动三步安装

#### 1. 克隆仓库并生成本机随机配对口令

```bash
git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
cd chrome-live-for-antigravity
node ./bin/chrome-live.mjs setup
```

`setup` 会在本机 `~/.chrome-live-antigravity/auth.token` 生成 256 位随机密钥（`0600` 权限），并在 `extension/.local-runtime.json`（已被 `.gitignore` 忽略）写入本地配对配置，加载扩展后开箱即连，无需每次手动粘贴口令。

### 2. 加载浏览器扩展（兼容 Chrome / Edge / Brave）

> 提示：新版正式版 Chrome（`137+` / `157+`）已禁用命令行 `--load-extension` 参数，请统一在扩展管理页开启开发者模式加载：

1. 在 Chrome 地址栏打开 `chrome://extensions`（Edge 用户打开 `edge://extensions`）；
2. 打开右上角（或左侧栏）的 **开发者模式（Developer mode）**；
3. 点击 **加载已解压的扩展程序（Load unpacked）**（或直接拖入文件夹），选择本仓库下的 `extension/` 目录；
4. 检查本地桥接服务连接状态：

```bash
node ./bin/chrome-live.mjs health
```

### 3. 接入 Antigravity 或其他智能体（默认全关，按需开启）

本项目默认绝不静默写入你的全局 `~/.gemini/config/` 目录，按需选择以下任一方式接入：

**方式 A —— 一键安装 Antigravity 插件（含 `SKILL.md` + 右侧实时画面面板）：**

```bash
node ./bin/chrome-live.mjs install --with-plugin
```

**方式 B —— 作为标准 `stdio` MCP Server 挂载：**

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

---

## 常用 CLI 指令速查

```bash
node ./bin/chrome-live.mjs health                         # 查看桥接与扩展在线状态
node ./bin/chrome-live.mjs open "https://example.com"     # 在后台折叠标签组静默打开网页
node ./bin/chrome-live.mjs snapshot                       # 提取带编号 [0],[1] 的可交互元素与正文
node ./bin/chrome-live.mjs click 0                        # 按序号、CSS 选择器或按钮文字点击
node ./bin/chrome-live.mjs type "搜索" "关键词" --submit   # 按序号、CSS 选择器或 placeholder 填词回车
node ./bin/chrome-live.mjs upload "./demo.png"            # 通过原生 CDP 往网页发帖框/上传框传本地图片或附件
node ./bin/chrome-live.mjs batch - --compact              # 单轮从 stdin 执行多步连招并返回精简快照
node ./bin/chrome-live.mjs extract "https://a.com"        # 当前窗口后台静默并发提取正文与高清图
node ./bin/chrome-live.mjs relay popout                   # 一键弹出独立副屏窗口并解锁供人工接力操作
node ./bin/chrome-live.mjs relay merge                    # 将副屏接力页归队回原窗口原位置并恢复 AI 接管
node ./bin/chrome-live.mjs done "任务完成"                 # 释放调试器并清理临时工作页（保留人工共享页）
```

---

## 工作原理与透明说明

1. **按需挂载调试器与空闲零开销回收：**
   仅在抓取实时画面或执行指令期间按需挂载 `chrome.debugger` (`1.3`)，空闲满 `18 秒` 自动断开释放，平时保持零额外 CPU 占用。
2. **本机防跨站与防 DNS 重绑定保护：**
   守护进程严格绑定 `127.0.0.1:28196`（支持环境变量 `CHROME_LIVE_PORT` 修改），强制校验 `Host` 请求头，对一切来自普通网页（`Origin: http://...` 或 `https://...`）的请求直接返回 `403 Forbidden`，并使用常量时间算法 `crypto.timingSafeEqual` 核验本地 Token。
3. **金融收银台与网银本地硬拦截：**
   守护进程与扩展后台双重内置金融风控列表，自动拦截支付宝、微信支付、银联、各大网银、Stripe、PayPal、云厂商账单中心、`chrome://` / `edge://` 内部页以及 `/checkout`、`/#/checkout`、`/payment` 等收银路径；一旦网页跳转触碰保护域名，毫秒级自动断开调试控制权交还用户本人。
4. **能力边界与干净卸载：**
   不修改、不注入 Antigravity 客户端任何本地程序文件；闭合第三方 Shadow Root、跨源支付 `<iframe>` 与系统级原生文件弹窗受浏览器安全沙箱隔离不可访问。如需停用卸载，执行 `node ./bin/chrome-live.mjs stop`，在扩展管理页移除扩展并删除 `~/.chrome-live-antigravity` 即可。

---

## 自动化测试

```bash
npm test
```

## 致谢

感谢 [LINUX DO](https://linux.do) 社区开发者在多智能体复用本地浏览器工作流讨论中提供的真实场景反馈与灵感。

## 开源协议

本项目基于 [GNU General Public License v3.0](./LICENSE)（`GPL-3.0-only`）开源发布。
