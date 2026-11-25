# AI Automated Setup Guide (`AI_INSTALL.md`)

> **For Coding Agents (Antigravity / Claude Code / Codex / OpenCode / Cursor):**
> Follow the deterministic steps below to set up `chrome-live-for-antigravity` on the user's machine. Do **not** modify global agent config directories (`~/.gemini`, `~/.claude`, etc.) without asking the user first.

---

## Step 1 — Check Prerequisites & Clone Repository

1. Verify Node.js `>= 20` is installed:
   ```bash
   node -v
   ```
2. If you are not already inside a local `chrome-live-for-antigravity` checkout, clone it into the user's preferred workspace or tools directory:
   ```bash
   git clone https://github.com/CHANPAJN/chrome-live-for-antigravity.git
   cd chrome-live-for-antigravity
   ```
   *No `git` installed? Download and unpack the ZIP directly (works out of the box on clean Windows/macOS/Linux machines):*
   ```powershell
   # Windows PowerShell
   Invoke-WebRequest -Uri "https://github.com/CHANPAJN/chrome-live-for-antigravity/archive/refs/heads/main.zip" -OutFile "chrome-live.zip"
   Expand-Archive -Path "chrome-live.zip" -DestinationPath "." -Force
   cd chrome-live-for-antigravity-main
   ```
   *(Zero `npm install` is needed — the project uses 100% Node.js standard library modules with zero external dependencies.)*

---

## Step 2 — Generate Local Pairing Token & Run Self-Test

Run `setup` to generate a local 256-bit random token (`~/.chrome-live-antigravity/auth.token`, `0600` permissions) and write the git-ignored extension bootstrap file (`extension/.local-runtime.json`), then run the test suite:

```bash
node ./bin/chrome-live.mjs setup
npm test
```

---

## Step 3 — Start the Local Bridge Daemon

Start the localhost bridge service (`127.0.0.1:28196`):

```bash
node ./bin/chrome-live.mjs start
```

---

## Step 4 — Guide the User to Load the Unpacked Extension (One-Time Step)

Modern stable Chrome (`137+` / `157+`) disables `--load-extension` CLI flags for security. Print the **exact absolute path** of the `extension/` folder on the user's machine and give them these 3 short steps:

1. Open `chrome://extensions` in Google Chrome (or `edge://extensions` in Microsoft Edge).
2. Turn on **Developer mode** (toggle in the top-right or left sidebar).
3. Click **Load unpacked** (加载已解压的扩展程序) — or drag and drop the folder — and select:
   `<ABSOLUTE_PATH_TO_REPO>/extension`

*(Because `setup` already wrote `extension/.local-runtime.json`, the extension pairs with `127.0.0.1:28196` automatically as soon as it is loaded — no manual token copy-paste required.)*

---

## Step 5 — Connect Your Agent Client (Ask User Before Installing)

Ask the user how they want to wire `chrome-live` into their agent environment:

- **Option A — Antigravity Plugin (`SKILL.md` + Live Sidecar Preview Pane):**
  ```bash
  node ./bin/chrome-live.mjs install --with-plugin
  ```
- **Option B — Standard `stdio` MCP Server (Claude Code / Codex / Cursor / OpenCode / Antigravity):**
  Register the following entry in the client's MCP configuration (replacing `<ABSOLUTE_PATH_TO_REPO>`):
  ```json
  {
    "mcpServers": {
      "chrome-live": {
        "command": "node",
        "args": ["<ABSOLUTE_PATH_TO_REPO>/bin/chrome-live.mjs", "mcp"]
      }
    }
  }
  ```

---

## Step 6 — Verify Live Connection

Once the user confirms they loaded the `extension/` folder, verify the end-to-end handshake:

```bash
node ./bin/chrome-live.mjs health
```

Confirm `"ok": true` and `"extensionConnected": true` in the JSON output. Setup is complete!
