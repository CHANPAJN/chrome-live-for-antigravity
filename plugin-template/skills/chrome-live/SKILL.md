---
name: chrome-live
description: Reuse the user's signed-in Chrome browser via the local Chrome Live bridge (shared tabs, background tab groups, concurrent DOM extraction, and live sidecar preview).
---

# Chrome Live Bridge Skill

Operate the user's local Google Chrome through `chrome-live` (`127.0.0.1:__CHROME_LIVE_PORT__`):

- **Shared Signed-In Tabs (`substate == "shared"`):** When the user shares an authenticated tab (`Alt+Shift+L`), run `health` first to inspect `tabs`, pass `--tab <tabId>` on subsequent actions, and **never close the user's shared tab**.
- **Background Tab Groups (`open`):** Open external pages quietly inside the collapsed `Live · Active` tab group without stealing foreground window focus, and always run `done "<summary>"` at the end of the task so temporary worker tabs and CDP debuggers are cleaned up.
- **Concurrent Extraction (`extract`):** Fetch clean article text and high-resolution image URLs from multiple pages at once in a self-cleaning minimized worker window.

## Live Preview (MANDATORY First Step on Visual Workflows)

- **Always mount the inline preview card on Turn 1:** Whenever starting a multi-step browser interaction, **always call the `chrome_live_monitor` MCP tool (`ServerName: "chrome-live-for-antigravity_chrome-live"`) in parallel with your first browser command** so the live screencast card appears right inside the user's current chat viewport (CLI commands alone do not auto-insert a chat UI card). Never pass `--fg` or `focus_tab` unless the user explicitly asks to bring Chrome to the foreground.
- **Optional right-hand side pane:** Include `[Chrome Live View](sidecar://chrome-live-for-antigravity/live_view/)` if the user prefers watching in a docked side panel.

## Core CLI Commands

```bash
# 1. Verify bridge & extension connection
node "__CHROME_LIVE_CLI_PATH__" health

# 2. Open a page in a background tab group
node "__CHROME_LIVE_CLI_PATH__" open "https://example.com" --label "Reading documentation"

# 3. Capture indexed interactive DOM elements [0], [1], [2]...
node "__CHROME_LIVE_CLI_PATH__" snapshot

# 4. Single-roundtrip multi-step pipeline (type -> submit/click -> wait -> snapshot in one call!)
node "__CHROME_LIVE_CLI_PATH__" batch '[{"action":"open","url":"https://example.com"},{"action":"wait","ms":500},{"action":"snapshot","maxItems":20}]' --compact

# 5. Interact step-by-step by element index, selector, or visible label
node "__CHROME_LIVE_CLI_PATH__" click 0
node "__CHROME_LIVE_CLI_PATH__" type 1 "search term" --submit
node "__CHROME_LIVE_CLI_PATH__" upload "./screenshot.png"
node "__CHROME_LIVE_CLI_PATH__" scroll down 600

# 6. Concurrent multi-URL text & image extraction
node "__CHROME_LIVE_CLI_PATH__" extract "https://example.com/a" "https://example.com/b"

# 7. Opt-in local Site Playbooks (1-step jump to deep admin routes & UI widget workarounds)
node "__CHROME_LIVE_CLI_PATH__" playbook on
node "__CHROME_LIVE_CLI_PATH__" playbook save example.com --route "Orders=https://example.com/admin/orders" --tip "Date input is read-only; click calendar cell"

# 8. Finish task & release debugger (closes temporary worker tabs; keeps shared tabs open)
node "__CHROME_LIVE_CLI_PATH__" done "Completed lookup"

# 9. Release control of a specific tab (or all controlled tabs) without closing it
node "__CHROME_LIVE_CLI_PATH__" release --tab <tabId>
node "__CHROME_LIVE_CLI_PATH__" release --all
```

## Concurrency & Anti-Loop Rules (Important)

- **Complex interactive publishing/forms -> run serially, not multi-agent concurrent:** Use `extract` for concurrent read-only scraping across many URLs. For multi-site rich-text posting (login flows, tag dropdowns, category switches, publish modals), run one site at a time rather than spawning parallel subagents against the same Chrome instance.
- **Read `snapshot` state & alerts first:** `snapshot` reports `[DISABLED]`, `checked=true/false`, `selected`, `expanded`, and page `Alerts:` (form validation errors). Inspect those before retrying clicks or taking screenshots.
- **Hard circuit-breaker for subagents:** Never read bridge source files (`chrome-live.mjs`, `service-worker.js`) or write ad-hoc `.mjs` workaround scripts during normal browsing tasks. Cap screenshots at 2 per page; if a page flow fails twice or exceeds 8 turns without reaching the target state, stop immediately and report the exact blocker.

## Safety Boundaries

- Payment gateways, retail banking, cloud billing consoles, and `/checkout` routes are blocked locally by default; never attempt to bypass financial guardrails.
