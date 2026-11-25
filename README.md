# Chrome Live (for Antigravity)

[中文文档](./README.zh-CN.md) · **License: GPL-3.0-only** · **Zero External Dependencies**

> **Disclaimer:** Independent community project built for the Google Antigravity developer ecosystem. Not affiliated with, endorsed by, or sponsored by Google LLC or Meta Platforms, Inc.

**Chrome Live (for Antigravity)** connects Antigravity (and any CLI / MCP-capable coding agent) directly to **your own everyday Chrome or Edge profile** over a strictly local zero-dependency Node.js bridge (`127.0.0.1:28196`).

Instead of launching a blank, logged-out sandboxed browser that triggers anti-bot captchas or forces repeated logins, you can either **share a single signed-in tab on demand** (`Alt+Shift+L`) or let your agent work quietly inside **collapsed background tab groups** while watching a live preview stream in Antigravity's right-hand side pane.

---

## Measured Benchmarks (End-to-End Agent Session)

Evaluated on real multi-step search & extraction workflows (`pypi.org` query -> input -> submit -> wait -> DOM snapshot -> cleanup) across an isolated Chromium MV3 session:

| Mode | Agent Tool Turns | End-to-End Latency | Total Token Throughput | Net Uncached Tokens |
| :--- | :---: | :---: | :---: | :---: |
| **Step-by-step baseline** (`open` -> `snapshot` -> `type` -> `click` -> `wait` -> `snapshot` -> `done`) | 7 turns | 71.0s | 419,162 | 20,360 |
| **Single-roundtrip `batch --compact`** | **1 turn (-85.7%)** | **13.0s (5.5x faster)** | **67,365 (-83.9%)** | **2,445 (-88.0%)** |
| **Repeat visit with `Site Playbook` (`playbook on`)** | **1 turn (-85.7%)** | **10.0s (23% faster than batch)** | Skips homepage discovery & jumps straight to deep route | — |

- **Daemon Idle Footprint:** `< 0.01%` idle CPU (`0.0096%` measured), `~34 MB` private memory, `~3.1s` automatic WebSocket reconnect after daemon restart, `< 100ms` local financial guardrail interception.

---

## Key Capabilities

- **Reuse Signed-In Sessions Safely (Tab-Scoped Opt-In):** Press `Alt+Shift+L` (or click *Attach Current Tab* in the side panel) to grant access to an already authenticated tab. While active, an accidental-click shield protects the page (hold left-click for `3s` anywhere to unlock manual control). When `chrome-live done` runs, the debugger detaches immediately while **never closing your shared tab**.
- **Zero-Focus Background Tab Groups:** Newly opened research tabs are placed into a collapsed `Live · Active` tab group so your foreground workspace never loses keyboard or window focus.
- **Silent Concurrent Extraction (`extract`):** Extract clean article text and high-resolution image URLs from multiple pages concurrently in inactive background tabs that auto-close upon completion without taskbar window flicker.
- **Built-in Antigravity MCP App (SEP-1865) — Inline, Side Pane (`aux_pane`) & Sidebar (`global`):** Ships with a zero-dependency **MCP App** (`ui://chrome-live/live-monitor.html`) supporting all three Antigravity surfaces: inline in chat (`chrome_live_monitor`), docked right-hand side pane (`aux_pane`), and full-page left sidebar console (`global`, via `chrome_live_workspace`), with per-tab isolated frame streams:
  - **One-Click Attach to Prompt (`Attach`):** Attach the active tab's title, URL, and `tabId` directly to your next chat message via `ui/update-model-context` (automatically adapts to surface capabilities).
  - **Secondary Window Relay (`Popout` ↔ `Merge`):** Detach any controlled tab into a standalone secondary window unlocked for manual login/2FA, then merge it right back to its original window & tab index when done.
  - **Direct Stream Control (`Control`):** Click, scroll, or send text directly on the live preview image via CDP coordinate mapping without switching windows.
  - **Visual Region Picker (`Pick`):** Click or drag a box over any part of the live stream to extract exact DOM selectors & text and attach them straight into the chat model context.
- **Open Shadow DOM, Modern ARIA States & Form Alert Detection:** `snapshot` traverses open Shadow roots, surfaces modern `[role="switch"]`/`[role="radio"]`/`[role="checkbox"]`/`[role="option"]` widgets with `{DISABLED}`, `{checked=true/false}`, `{selected}`, `{expanded}` badges, and extracts visible form validation alerts (`Alerts:`). `click` blocks disabled controls explicitly and avoids plain-text HTML tag false positives.
- **Native CDP File Upload (`upload`) & Dynamic-Island HUD:** Attach local images or files directly into hidden `<input type="file">` fields via CDP `DOM.setFileInputFiles` (with automatic `DataTransfer` paste/drop fallback for rich-text editors and credential-file guardrails), paired with a zero-CPU CSS spring HUD capsule and smooth collaboration cursor.
- **Dual Integration (CLI Skill + Standard `stdio` MCP):** Use ultra-lean CLI commands via `SKILL.md` (including `batch - --compact` stdin pipelines) or mount `chrome-live mcp` as a standard JSON-RPC MCP server.
- **Opt-In Local Site Playbooks (`playbook on`):** Disabled by default (`false`). When explicitly enabled, locally caches sanitized deep-link URLs, stable selectors, and widget workaround tips in `~/.chrome-live-antigravity/site-playbooks.json` (stripping auth/tracking query params).
- **Zero-Binary, Zero-NPM-Dependency Codebase:** Built exclusively on Node.js `>= 20` built-in modules (`node:http`, `node:crypto`, `node:fs`) and vanilla Manifest V3 JavaScript—every line is plain text and auditable in minutes.

---

## Quick Start

### One-Prompt AI Setup (Recommended)

Paste this single prompt into **Antigravity, Claude Code, Codex, OpenCode, or Cursor** and let your agent set everything up automatically:

```text
Please read https://github.com/CHANPAJN/chrome-live-for-antigravity/blob/main/AI_INSTALL.md (or local AI_INSTALL.md if already cloned), clone and set up chrome-live-for-antigravity, generate the local pairing token, start the bridge daemon, and show me the exact extension folder path to load in chrome://extensions.
```

---

### Manual 3-Step Setup

#### 1. Clone & Generate Local Pairing Token

```bash
git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
cd chrome-live-for-antigravity
node ./bin/chrome-live.mjs setup
```

`setup` generates a 256-bit random token in `~/.chrome-live-antigravity/auth.token` (`0600` permissions) and writes a git-ignored `.local-runtime.json` inside `extension/` so your unpacked extension pairs automatically on load.

### 2. Load the Unpacked Extension (Chrome / Edge / Brave)

> Note: Modern stable Chrome releases (`137+` / `157+`) ignore `--load-extension` command-line flags. Always load unpacked extensions via the extensions management page below:

1. Open `chrome://extensions` in Google Chrome (or `edge://extensions` in Microsoft Edge).
2. Enable **Developer mode** (top-right or left-sidebar toggle).
3. Click **Load unpacked** (or drag-and-drop) and select the `extension/` folder inside this repository.
4. Start (or verify) the local bridge daemon:

```bash
node ./bin/chrome-live.mjs health
```

### 3. Connect to Antigravity (Opt-In)

Nothing is written to your global `~/.gemini/config/` directory unless you explicitly opt in.

**Option A — Install the Antigravity Plugin (Skill + Live Sidecar Pane):**

```bash
node ./bin/chrome-live.mjs install --with-plugin
```

**Option B — Register as a Standard `stdio` MCP Server:**

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

## CLI Reference

```bash
node ./bin/chrome-live.mjs health                        # Check bridge & extension status
node ./bin/chrome-live.mjs tabs                          # List shared & worker tabs
node ./bin/chrome-live.mjs open "https://example.com" --label "Docs lookup"
node ./bin/chrome-live.mjs snapshot                      # Index interactive DOM + open Shadow DOM elements
node ./bin/chrome-live.mjs click 0                       # Click by index, CSS selector, or visible text
node ./bin/chrome-live.mjs type "Search" "query" --submit # Type by index, CSS selector, or placeholder
node ./bin/chrome-live.mjs upload "./cover.png"          # Upload local image/file into page file input or composer
node ./bin/chrome-live.mjs batch - --compact             # Run multi-step JSON pipeline from stdin in 1 turn
node ./bin/chrome-live.mjs extract "https://example.com/a" "https://example.com/b"
node ./bin/chrome-live.mjs relay popout                  # Detach tab to standalone window for manual 2FA/login
node ./bin/chrome-live.mjs relay merge                   # Merge relay window tab back & resume AI control
node ./bin/chrome-live.mjs screenshot --out preview.jpg
node ./bin/chrome-live.mjs done "Finished lookup"        # Detach debugger & clean up worker tab
node ./bin/chrome-live.mjs stop                          # Gracefully stop the local daemon
```

---

## How It Works & Operational Transparency

1. **On-Demand CDP Attachment & Idle Release:**
   `chrome.debugger` (`1.3`) is attached only while capturing live preview frames or completing active commands, and automatically detaches after `18s` of inactivity so idle tabs incur zero background CPU overhead.
2. **Localhost Isolation (Anti-CSRF & Anti-DNS-Rebinding):**
   The daemon binds strictly to `127.0.0.1:28196` (configurable via `CHROME_LIVE_PORT`), validates the HTTP `Host` header against localhost, rejects all `http://` and `https://` web `Origin` headers with `403 Forbidden`, and verifies `X-Chrome-Live-Token` using `crypto.timingSafeEqual`.
3. **Hardcoded Financial & Checkout Guardrails:**
   Both the Node.js daemon and the extension service worker enforce a local blocklist covering payment processors (`stripe.com`, `paypal.com`, `alipay.com`, `pay.weixin.qq.com`), major retail banks, cloud billing consoles, internal browser protocols (`chrome://`, `edge://`, `file://`), and `/checkout` or `/#/checkout` routes. Navigating or redirecting onto a protected route immediately detaches debugger control.
4. **Known DOM Boundaries:**
   Element indexing (`snapshot`) traverses standard DOM trees and open Shadow roots; closed third-party Shadow roots, cross-origin sandboxed `<iframe>` payment widgets, and OS-level file dialogs remain intentionally inaccessible.
5. **Clean Removal:**
   Run `node ./bin/chrome-live.mjs stop`, remove the unpacked extension from `chrome://extensions`, and delete `~/.chrome-live-antigravity` (plus `~/.gemini/config/plugins/chrome-live-for-antigravity` if you ran `install --with-plugin`). Does not modify or patch any Antigravity client files.

---

## Testing

```bash
npm test
```

## Acknowledgments

Thanks to the developer discussions and feedback from the [LINUX DO](https://linux.do) community on practical multi-agent browser workflows.

## License

Released under the [GNU General Public License v3.0](./LICENSE) (`GPL-3.0-only`).
