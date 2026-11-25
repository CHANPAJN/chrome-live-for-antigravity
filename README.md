<div align="center">

# chrome-live-for-antigravity

Zero-dependency Chrome MV3 bridge and native **Antigravity MCP App (`SEP-1865`)** for Windows, macOS, and Linux.  
Connect **Google Antigravity** directly to your everyday signed-in Chrome or Edge browser — 0-token live preview in chat, anti-misclick lock, color-coded tab groups, standalone human-relay popout, and single-roundtrip `batch` automation with zero third-party npm packages.

<p>
  <b>English</b> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p>
  <a href="https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml"><img src="https://github.com/CHANPAJN/chrome-live-for-antigravity/actions/workflows/ci.yml/badge.svg" alt="Cross-Platform CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="GPL-3.0 License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Dependencies-Zero%20(Node%20%3E%3D%2020)-2F855A?style=flat-square" alt="Zero Dependencies" /></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/Community-LINUX%20DO-1C1C1E?style=flat-square&logo=linux&logoColor=34D399" alt="LINUX DO Community" /></a>
</p>

<img src="./docs/real-dual-demo.gif" width="840" alt="chrome-live-for-antigravity Live Demo" />

<sub>Independent community project. Not affiliated with or endorsed by Google LLC.</sub>

</div>

<details>
<summary>View raw 1:1 Chrome window + live CLI capture</summary>
<p align="center">
  <img src="./docs/real-demo.gif" width="840" alt="Real Chrome window driven by CLI" />
</p>
</details>

## Features

- **Signed-In Tab Reuse & Anti-Misclick Lock**: Press `Alt+Shift+L` (`Option+Shift+L` on macOS) to share the active tab with Antigravity without blank headless profiles or repeated login loops. A transparent lock shield (`not-allowed` circle-slash cursor) prevents accidental clicks while the agent works; click **Pause** on the bottom floating HUD or hold left-click for 3 seconds to take over anytime. Running `done` detaches the debugger without closing your shared tab.
- **Color-Coded Tab Groups & Auto-Collapse**: Active AI tabs sit inside a cyan **`Live · Active`** tab group, and background research tabs auto-collapse into a compact pill without stealing window focus. Pausing, holding left-click for 3 seconds, or popping out a relay window immediately switches the tab group and page border to yellow **`Live · Paused`** so control state is unmistakable.
- **0-Token Live Preview & Multi-Tab Switching (`SEP-1865`)**: Streams live frames inline in chat (`chrome_live_monitor`), docked in the side pane, or full-page in the sidebar (`chrome_live_workspace`) without burning model tokens. Supports managing multiple controlled tabs simultaneously with per-`tabId` isolated frame caches and a top tab switcher inside the live monitor, plus 6 direct controls:
  - **Control**: Click, scroll, and type directly on the live frame;
  - **Pick**: Drag a box on the stream to extract real DOM selectors (traversing open Shadow DOM) straight into chat;
  - **Attach**: Push the current tab's title, URL, and `tabId` into the next prompt via `ui/update-model-context`;
  - **Popout / Merge**: Pop a controlled tab out into a standalone window for manual QR login, 2FA, or verification; click **Resume** inside Chrome to merge and continue automation, or click **Merge** / close the popout window to return the tab to your main window in **Paused** state (preserving cookies; closing the window reloads the tab URL);
  - **Refresh / Release**: Pull a fresh frame immediately or detach control on demand.
- **Human-Like Motion, Single-Roundtrip `batch` & Clean Extraction**: Pointer movements follow quadratic Bezier curves with approach deceleration and staggered typing cadence. Pipe `open -> type -> click -> wait -> snapshot -> done` through stdin in a single turn, extract clean text and full-res image URLs across multiple background tabs via `extract`, and inspect `{DISABLED}`, `{checked}`, `{selected}`, `{expanded}`, and validation alerts through open Shadow DOM.
- **Opt-In Local Site Playbooks (`playbook on`, Off by Default)**: Disabled (`false`) out of the box. When enabled in the extension side panel or via CLI, stores sanitized deep-link routes, stable CSS selectors, and widget tips locally in `~/.chrome-live-antigravity/site-playbooks.json` (protected via `0700`/`0600` on POSIX and current-user `icacls` ACLs on Windows) so repeat visits skip landing-page discovery.

## Benchmarks

Measured on a real multi-step `pypi.org` search workflow (`open -> type -> submit -> wait -> extract -> cleanup`) from underlying session token logs:

| Mode | Agent Turns | Wall Time | Total Token Throughput | Non-Cached Tokens |
| :--- | :---: | :---: | :---: | :---: |
| Classic step-by-step loop (`open → snapshot → type → click → wait → snapshot → done`) | 7 | 71.0s | 419,162 | 20,360 |
| Single-roundtrip `batch --compact` | **1 (-85.7%)** | **13.0s (5.5× faster)** | **67,365 (-83.9%)** | **2,445 (-88.0%)** |
| Repeat visit with `playbook on` | **1 (-85.7%)** | **10.0s** | Skips landing page discovery | — |

Background footprint: `< 0.01%` idle CPU (`0.0096%` measured), `~30–34 MB` private memory, `~3s` automatic extension reconnect after daemon restart, `< 100ms` local guardrail checks.

## Install

Requires `Node.js >= 20` and zero third-party npm packages.

**AI Agent Setup** (paste into Antigravity; see [AI_INSTALL.md](./AI_INSTALL.md))

```text
Read https://github.com/CHANPAJN/chrome-live-for-antigravity/blob/main/AI_INSTALL.md and follow it step by step to clone and configure chrome-live-for-antigravity, generate the local pairing token, start the bridge daemon, and return the local extension/ folder path for me to load in chrome://extensions.
```

**Manual Setup (3 Steps)**

**Step 1 — Clone & generate local pairing token** (`~/.chrome-live-antigravity/auth.token`, POSIX `0600` / Windows user-only `icacls` + gitignored `extension/.local-runtime.json`)

```bash
git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
cd chrome-live-for-antigravity
node ./bin/chrome-live.mjs setup
```

**Step 2 — Load the unpacked extension (Chrome / Edge / Brave)**  
Chrome `137+` removed `--load-extension`, so load it once from `chrome://extensions` (or `edge://extensions`): enable **Developer mode**, click **Load unpacked**, select this repository's `extension/` directory, then verify the handshake:

```bash
node ./bin/chrome-live.mjs health
```

**Step 3 — Connect to Antigravity** (nothing is written to `~/.gemini/config/` until you opt in)

```bash
# Option A: Install Antigravity plugin (SKILL.md + Live Monitor Sidecar)
node ./bin/chrome-live.mjs install --with-plugin
```

Or mount manually as a standard `stdio` MCP server:

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

## Usage & CLI

```bash
node ./bin/chrome-live.mjs health                           # Inspect daemon & extension connection status
node ./bin/chrome-live.mjs open "https://example.com"       # Open URL inside collapsed background tab group
node ./bin/chrome-live.mjs snapshot                         # Capture indexed elements [0],[1] & page text
node ./bin/chrome-live.mjs click 0                          # Click by index, CSS selector, or visible label
node ./bin/chrome-live.mjs type "Search" "query" --submit   # Type into input field and submit
node ./bin/chrome-live.mjs upload "./demo.png"              # Attach local file via native CDP
node ./bin/chrome-live.mjs batch - --compact                # Run multi-step stdin pipeline in 1 turn
node ./bin/chrome-live.mjs extract "https://a.com"          # Extract clean text & image URLs in parallel
node ./bin/chrome-live.mjs relay popout                     # Pop tab into standalone window for manual login/2FA
node ./bin/chrome-live.mjs relay merge                      # Merge popout back to main window (stays Paused until Resume in Chrome)
node ./bin/chrome-live.mjs release                          # Detach control without closing the tab
node ./bin/chrome-live.mjs done "Task complete"             # Detach debugger & close temporary worker tabs
```

**Hiding the Chrome `"started debugging this browser"` Banner**

Chrome displays a top infobar whenever an extension attaches `chrome.debugger` (clicking **Cancel** detaches AI control immediately):

- **Auto-dismiss by default**: You do not need to click Cancel — the extension detaches automatically on `done` or after 18 seconds of idle time, and the bar disappears on its own.
- **Suppress permanently (optional)**: Fully quit Chrome and launch it with Chromium's built-in `--silent-debugger-extension-api` flag:
  - **Windows**: Right-click your Chrome shortcut (Desktop / Taskbar) → **Properties** → append a space and `--silent-debugger-extension-api` **outside** the closing quote in **Target**, then restart Chrome:
    ```text
    "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
    ```
  - **macOS**: Quit Chrome completely (`Cmd + Q`) and launch via Terminal:
    ```bash
    open -b com.google.Chrome --args --silent-debugger-extension-api
    ```
  - **Linux**: Run `google-chrome --silent-debugger-extension-api`, or append the flag to the `Exec=` line in your `.desktop` launcher under `~/.local/share/applications/`.

**Multi-Tab Concurrency & Model Recommendations**

- **Multi-tab scope**: Monitoring multiple controlled tabs simultaneously in the live preview tab bar and running parallel read-only `extract` jobs work cleanly with strict `tabId` isolation. For multi-site rich-text posting or complex forms that share system clipboard / window focus, run one site serially at a time rather than firing parallel writes.
- **Recommended models for efficiency**:
  - **Everyday lookup, extraction & single-roundtrip `batch`**: Fast / Flash-tier models respond quickly and pair best with `batch --compact` and opt-in local Site Playbooks (`playbook on`).
  - **Complex admin forms, Shadow DOM widgets & debugging**: Switch to a higher-reasoning Pro-tier model for reliable ARIA alert handling and multi-step planning.

## How It Works & Operational Transparency

- **On-Demand Debugger Attachment & Hard Pause/Cancel**: `chrome.debugger` (`1.3`) attaches only during active commands or live streaming and auto-detaches after 18 seconds of idle time (`< 0.01%` idle CPU). Pausing via HUD, holding left-click for 3s, or popping out a relay window immediately stops screencasting, detaches the debugger, purges cached frames, and aborts in-flight click/typing/wait steps without allowing late updates to re-lock the page. Interactive UI callbacks require a per-process 256-bit capability token delivered exclusively via `CallToolResult._meta` to the isolated `ui://` iframe (omitted from `resources/read` HTML, `content`, and `structuredContent`), and only a user gesture inside Chrome can lift a pause. (Note: mounting the optional local CLI `SKILL.md` grants shell-capable coding agents direct local CLI access; for strict MCP-only tool isolation, register only the stdio MCP server.) Clicking **Cancel** on Chrome's native debugging banner fully revokes tab control instead of silently reattaching, and sharing an existing signed-in tab requires explicit user action in Chrome (`Alt+Shift+L` or extension UI).
- **Loopback Isolation & Full-Stack Mutual HMAC Auth**: The daemon binds strictly to `127.0.0.1:28196` (override with `CHROME_LIVE_PORT`), validates the `Host` header, rejects web `Origin` headers with `403`, cryptographically verifies a dedicated `X-Chrome-Live-Hdr-Sig` HMAC (with `Content-Length`, timestamp, and hex nonce) **before** buffering a single byte of POST body, enforces RFC 6455 client frame masking, evicts active WebSocket sessions immediately if `auth.token` rotates, and authenticates **every** local client (MV3 extension WebSocket + HTTP, CLI, MCP server, and sidecar) via collision-free JSON-tuple **HMAC-SHA256 request/response signatures**—zero plaintext tokens ever traverse loopback sockets. State directories use POSIX `0700`/`0600` modes and Windows current-user `icacls` ACLs; the one-time `extension/.local-runtime.json` bootstrap is excluded from `npm pack` and shredded on first handshake; password/OTP inputs block automated typing, user-entered input/editor draft values are never read back in snapshots or click receipts, CSS attribute-substring selector probing is blocked, and outgoing URLs/excerpts redact sensitive query and `#hash` tokens.
- **Dual-Layer Financial & Staged Upload Guardrails (and Honest Scope)**: Both the daemon and the extension block payment gateways (Stripe, PayPal, Alipay, WeChat Pay, banking portals, cloud billing consoles), `chrome://` / `edge://`, and `/checkout`, `/pay`, `/payment`, `/cashier`, `/billing` routes (after multi-pass percent-decoding, matrix-param stripping, `.html`/`.php`/`.htm` suffix matching, SPA hash parsing, and `webNavigation` sub-frame URL inspection) across `open`, `navigate`, `batch`, and `extract`. By default, CDP file uploads are confined to `~/.chrome-live-antigravity/uploads` (override via `CHROME_LIVE_UPLOAD_DIR`), verify `lstat`/`realpath` + `nlink === 1` (`O_NOFOLLOW` on POSIX plus post-open `realpathSync.native` verification on Windows) before freezing an immutable private snapshot directly from the open file descriptor to defeat cross-step TOCTOU swaps, and reject symlinks, hardlinks, and credential stores (`.ssh`, `.env`, `.aws`, `Local State`, `key4.db`, `.pem`, `.tfstate`). When multiple tabs are controlled simultaneously, mutating commands require an explicit `tabId`. Note that domain/route guardrails do not interpret business actions inside normal admin portals (such as editing prices, shipping, or refunds), and while DOM scripts do not traverse cross-origin iframes, browser-level screenshots and coordinate clicks cover the visible viewport on allowed pages—for high-risk accounts, use a dedicated Chrome profile.
- **Zero Host Patching & Clean Uninstall**: Built purely on Node.js `>= 20` standard modules and plain MV3 JavaScript — zero npm packages, zero prebuilt binaries, and zero edits to Antigravity binaries. Closed Shadow DOM and native OS file dialogs remain isolated by the browser sandbox. To verify or uninstall:

```bash
npm test                                                    # Run security, guardrail & protocol test suite
node ./bin/chrome-live.mjs stop                             # Stop daemon, then remove extension & ~/.chrome-live-antigravity
```

## License

Released under the [GNU General Public License v3.0 (GPL-3.0)](./LICENSE). Community discussion & feedback: [LINUX DO](https://linux.do).
