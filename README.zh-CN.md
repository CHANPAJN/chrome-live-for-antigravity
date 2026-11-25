# Chrome Live (for Antigravity)

[![Cross-Platform CI](https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml/badge.svg)](https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml) · [English](./README.md) · **GPL-3.0** · **Node.js 零外部依赖**

> 独立社区开源项目，与 Google LLC 或 Meta Platforms, Inc. 无关联。

把 Antigravity 直接连到你平时已登录的 Chrome / Edge 上，不用再每次开空白的无头浏览器重新登录、过验证码。

<p align="center">
  <img src="./docs/real-dual-demo-zh.gif" alt="Chrome Live for Antigravity demo" width="880" />
</p>

<details>
<summary>查看真实 Chrome 窗口 + CLI 原始录屏</summary>
<p align="center">
  <img src="./docs/real-demo.gif" alt="Real Chrome window driven by CLI" width="880" />
</p>
</details>

---

## 为什么要做这个

用编程 Agent 操作网页时，常见方案有几个很烦的问题：

1. 无头浏览器每次打开都是空白环境，需要反复登录和过验证码，还要下载几百 MB 的浏览器内核。
2. 一步一次工具调用外加反复截大图，一个普通检索任务动辄跑六七轮，Token 和时间都花在来回通信上。
3. 后台任务经常把窗口顶到最前面，打断正在写的代码或文档；遇到扫码或验证又没法中途接手。

Chrome Live 通过本地守护进程（`127.0.0.1:28196`）加一个原生 MV3 扩展，换了一种方式：

- **按标签页复用已登录浏览器 + 防误触锁**：按 `Alt+Shift+L`（macOS 为 `Option+Shift+L`）把当前已登录标签页交给 Antigravity，页面自动开启全屏防误触护盾（鼠标显示禁止点击圆圈图标，防手滑打断）；需要手动接手时按住左键满 3 秒或点底部「暂停」即可解锁。执行 `done` 只断开调试器，绝不关闭你的原页面。
- **彩色标签组状态一目了然，后台自动折叠不抢焦点**：AI 执行时页面归入顶部青色 **`Live · 操控中`** 标签组，后台新开查询页会自动折叠成一个小胶囊，不弹新窗不抢焦点；当你点击「暂停」、长按 3 秒解锁或弹出独立副屏人工接手时，标签组与边框会立即切为明黄色 **`Live · 已暂停`**，清清楚楚区分当前归谁操作。
- **拟人轨迹与随时暂停**：点击和输入带贝塞尔曲线轨迹、接近减速和错落打字节奏；受控页面底部有悬浮状态条，随时点「暂停」或按住左键 3 秒即可拿回控制权。
- **聊天内实时画框（Antigravity MCP App / SEP-1865）**：支持聊天内联（`chrome_live_monitor`）、右侧分屏和左侧独立视图（`chrome_live_workspace`），实时流不消耗模型 Token。顶栏自带 6 个常用动作：
  - **接管**：直接在画框里远程点击、滚轮和输入；
  - **圈选**：在画框上拉框选区域，穿透开放 Shadow DOM 提取真实选择器和文本发回对话；
  - **挂入**：把当前页面标题、URL 和 `tabId` 附到下一条消息上下文；
  - **副屏 / 归队**：遇到扫码或人机验证时一键弹出独立小窗手动处理，完成后再归队交还给 Agent。
- **单轮 `batch` 连招 + 本地站点路书**：支持通过标准输入把 `open → type → click → wait → snapshot → done` 合并为 1 轮调用；可选开启 `playbook on`（默认关闭），在本地 `~/.chrome-live-antigravity/site-playbooks.json` 记录常用路由和选择器（自动剥离敏感查询参数），二次访问同站直接跳过摸索。
- **并发正文提取与完整表单状态**：`extract` 在后台标签页并发抓取正文和原图直链，自动过滤 `<style>/<script>`，抓完即关；`snapshot` 穿透开放 Shadow DOM，标出 `{DISABLED}`、`{checked}`、`{selected}`、`{expanded}` 和页面报错提示。
- **本地安全拦截与零依赖**：纯 Node.js（>= 20）内置模块编写，无任何第三方 npm 包或预编译二进制。支付宝、微信支付、Stripe、PayPal、网银、`chrome://`、`/checkout`（含 SPA Hash 路由）在触碰浏览器前就会在本地被拦截；CDP 文件上传会拦截 `.ssh`、`.env`、`.aws` 等凭据路径。

---

## 实测对比（PyPI 检索全流程）

测试任务：打开 `pypi.org` → 输入搜索词 → 提交 → 等待加载 → 提取结果 → 清理收尾（基于底层会话账单统计）：

| 模式 | 对话轮次 | 总耗时 | 总 Token 吞吐 | 非缓存净消耗 |
| :--- | :---: | :---: | :---: | :---: |
| 传统逐步调用（`open → snapshot → type → click → wait → snapshot → done`） | 7 轮 | 71.0s | 419,162 | 20,360 |
| `batch --compact` 单轮连招 | **1 轮（-85.7%）** | **13.0s（提速 5.5 倍）** | **67,365（-83.9%）** | **2,445（-88.0%）** |
| 开启本地路书（`playbook on`）二次访问 | **1 轮（-85.7%）** | **10.0s** | 跳过首页直接定位 | — |

实测常驻资源占用：空闲 CPU `< 0.01%`（实测 `0.0096%`），私有内存约 `30~34 MB`，守护进程重启后扩展约 `3 秒` 自动重连，本地安全拦截耗时 `< 100ms`。

---

## 安装与使用

### 方式 1：让 Antigravity 直接帮你装

把下面这段话直接发给 Antigravity：

```text
请阅读 https://github.com/CHANPAJN/chrome-live-for-antigravity/blob/main/AI_INSTALL.md ，按步骤帮我克隆并配置好 chrome-live-for-antigravity，生成本地配对口令并启动桥接服务，最后把需要拖入 chrome://extensions 的本地目录路径发给我。
```

### 方式 2：手动三步安装

**1. 克隆仓库并初始化本地口令**

```bash
git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
cd chrome-live-for-antigravity
node ./bin/chrome-live.mjs setup
```

`setup` 会在 `~/.chrome-live-antigravity/auth.token` 生成随机口令（权限 `0600`），并自动写入被 `.gitignore` 忽略的 `extension/.local-runtime.json`，扩展加载后自动配对，不用手动复制 Token。

**2. 在 Chrome / Edge / Brave 中加载扩展**

> 新版正式版 Chrome（137+）已移除命令行 `--load-extension`，请在扩展管理页手动加载：

1. 地址栏打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 开启右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选中仓库里的 `extension/` 目录；
4. 运行检查确认连接成功：

```bash
node ./bin/chrome-live.mjs health
```

**3. 接入 Antigravity**

默认不会自动改动你的 `~/.gemini/config/`，按需二选一：

- **安装 Antigravity 插件（含 Skill + 实时画框面板）**：

```bash
node ./bin/chrome-live.mjs install --with-plugin
```

- **或手动以标准 `stdio` MCP Server 方式挂载**：

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

## 常用 CLI 命令

```bash
node ./bin/chrome-live.mjs health                          # 查看守护进程与扩展连接状态
node ./bin/chrome-live.mjs open "https://example.com"      # 在后台青色折叠标签组打开网页
node ./bin/chrome-live.mjs snapshot                        # 提取编号元素 [0],[1] 与正文
node ./bin/chrome-live.mjs click 0                         # 按序号、CSS 选择器或文本点击
node ./bin/chrome-live.mjs type "搜索" "关键词" --submit    # 填词并提交
node ./bin/chrome-live.mjs upload "./demo.png"             # 通过 CDP 上传本地图片或附件
node ./bin/chrome-live.mjs batch - --compact               # 从 stdin 单轮执行多步连招
node ./bin/chrome-live.mjs extract "https://a.com"         # 后台并发提取正文与原图链接
node ./bin/chrome-live.mjs relay popout                    # 弹出独立副屏供人工处理验证
node ./bin/chrome-live.mjs relay merge                     # 归队回原窗口并交还控制权
node ./bin/chrome-live.mjs release                         # 释放当前页控制权（不关闭页面）
node ./bin/chrome-live.mjs done "任务完成"                  # 断开调试器并清理临时工作页
```

---

## 安全与隐私说明

- **按需挂载调试器**：仅在执行动作或拉流时挂载 `chrome.debugger`（1.3），空闲 18 秒后自动卸载释放。
- **防跨站与 DNS 重绑定**：守护进程只监听 `127.0.0.1:28196`（可用 `CHROME_LIVE_PORT` 修改），校验 `Host` 头，拒绝所有网页来源的 `Origin` 请求（`403`），并用 `crypto.timingSafeEqual` 核验本地 Token。
- **支付与敏感路径拦截**：内置国内外主流支付、网银、云账单、`chrome://`、`edge://` 及 `/checkout`、`/payment`、`/pay`、`/cashier`、`/billing` 路由拦截；受控页面若跳转到受保护域名会自动断开调试并交还用户。
- **无客户端修改 & 干净卸载**：不修改 Antigravity 客户端任何文件；关闭式 Shadow DOM、跨源支付 `<iframe>` 与系统文件对话框均受浏览器沙箱隔离不可访问。卸载只需运行 `node ./bin/chrome-live.mjs stop`，在扩展页移除扩展并删除 `~/.chrome-live-antigravity`。

## 测试

```bash
npm test
```

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区开发者在多 Agent 复用本地浏览器工作流讨论中提供的真实场景反馈。

## 开源协议

基于 [GNU General Public License v3.0](./LICENSE)（GPL-3.0-only）发布。
