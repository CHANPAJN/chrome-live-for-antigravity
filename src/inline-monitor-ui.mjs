export const INLINE_MONITOR_URI = 'ui://chrome-live/live-monitor.html';

export function buildInlineMonitorHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chrome Live Relay Studio</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--color-text-primary, #18181b);
      font: 400 12px/1.4 var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
      user-select: none;
    }
    html.dark body {
      color: var(--color-text-primary, #f4f4f5);
    }
    .frame-card {
      border: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.1));
      background: var(--color-background-primary, #ffffff);
      border-radius: 10px;
      overflow: hidden;
    }
    html.dark .frame-card {
      border-color: var(--color-border-primary, rgba(255, 255, 255, 0.1));
      background: var(--color-background-secondary, #141417);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 38px;
      padding: 5px 10px;
      background: var(--color-background-secondary, #fafafa);
      border-bottom: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.08));
    }
    html.dark .topbar {
      background: var(--color-background-secondary, #18181b);
      border-bottom-color: var(--color-border-primary, rgba(255, 255, 255, 0.08));
    }
    .status-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 110px;
      flex: 1;
      overflow: hidden;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #a1a1aa;
      flex-shrink: 0;
    }
    .dot[data-live="true"] {
      background: #10b981;
      box-shadow: 0 0 0 2.5px rgba(16, 185, 129, 0.18);
    }
    .dot[data-paused="true"] {
      background: #f59e0b;
      box-shadow: 0 0 0 2.5px rgba(245, 158, 11, 0.2);
    }
    .meta-title {
      font-size: 12px;
      font-weight: 500;
      letter-spacing: -0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 210px;
    }
    .meta-sub {
      font-size: 11px;
      color: var(--color-text-secondary, #71717a);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-sub:not(:empty)::before {
      content: "·";
      margin-right: 6px;
      opacity: 0.6;
    }
    .btn-row {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .btn-sep {
      width: 1px;
      height: 14px;
      margin: 0 3px;
      background: var(--color-border-primary, rgba(0, 0, 0, 0.1));
      flex-shrink: 0;
    }
    html.dark .btn-sep {
      background: rgba(255, 255, 255, 0.12);
    }
    button {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--color-text-secondary, #52525b);
      border-radius: 6px;
      height: 25px;
      padding: 0 7px;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      line-height: 1;
      letter-spacing: -0.005em;
      white-space: nowrap;
      cursor: pointer;
      transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, transform 0.1s ease;
    }
    button svg {
      width: 12.5px;
      height: 12.5px;
      flex-shrink: 0;
      opacity: 0.82;
    }
    html.dark button {
      color: var(--color-text-secondary, #a1a1aa);
    }
    button:hover:not(:disabled) {
      background: rgba(0, 0, 0, 0.055);
      color: var(--color-text-primary, #18181b);
    }
    html.dark button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.08);
      color: var(--color-text-primary, #f4f4f5);
    }
    button:hover:not(:disabled) svg {
      opacity: 1;
    }
    button:active:not(:disabled) {
      transform: scale(0.97);
    }
    button:disabled {
      opacity: 0.35;
      cursor: default;
    }
    button[data-active="true"] {
      background: #18181b !important;
      border-color: #18181b !important;
      color: #ffffff !important;
    }
    html.dark button[data-active="true"] {
      background: #f4f4f5 !important;
      border-color: #f4f4f5 !important;
      color: #18181b !important;
    }
    button[data-active="true"] svg {
      opacity: 1;
    }
    button[data-attached="true"] {
      background: rgba(16, 185, 129, 0.1) !important;
      border-color: rgba(16, 185, 129, 0.28) !important;
      color: #047857 !important;
    }
    html.dark button[data-attached="true"] {
      background: rgba(16, 185, 129, 0.14) !important;
      border-color: rgba(16, 185, 129, 0.32) !important;
      color: #34d399 !important;
    }
    button[data-relay="merge"] {
      background: rgba(245, 158, 11, 0.12) !important;
      border-color: rgba(245, 158, 11, 0.34) !important;
      color: #b45309 !important;
    }
    html.dark button[data-relay="merge"] {
      color: #fbbf24 !important;
    }
    #releaseBtn:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.08);
      color: #dc2626;
    }
    html.dark #releaseBtn:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.14);
      color: #f87171;
    }
    .action-btn {
      border-color: var(--color-border-primary, rgba(0, 0, 0, 0.12));
      background: var(--color-background-primary, #ffffff);
      color: var(--color-text-primary, #18181b);
      padding: 0 9px;
    }
    html.dark .action-btn {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.06);
      color: #f4f4f5;
    }

    .tab-strip {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      overflow-x: auto;
      background: var(--color-background-secondary, #fafafa);
      border-bottom: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.07));
    }
    html.dark .tab-strip {
      background: var(--color-background-secondary, #18181b);
      border-bottom-color: rgba(255, 255, 255, 0.07);
    }
    .tab-pill {
      height: 22px;
      font-size: 11px;
      padding: 0 8px;
      border-radius: 5px;
      white-space: nowrap;
    }
    .tab-pill[data-active="true"] {
      background: var(--color-background-primary, #ffffff) !important;
      border-color: var(--color-border-primary, rgba(0, 0, 0, 0.14)) !important;
      color: var(--color-text-primary, #18181b) !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    html.dark .tab-pill[data-active="true"] {
      background: rgba(255, 255, 255, 0.1) !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
      color: #ffffff !important;
    }

    .viewport {
      position: relative;
      width: 100%;
      min-height: 185px;
      max-height: 410px;
      display: grid;
      place-items: center;
      background: #0c0e14;
      overflow: hidden;
    }
    .viewport[data-mode="remote"] {
      cursor: crosshair;
    }
    .viewport[data-mode="region"] {
      cursor: cell;
    }
    .viewport img {
      display: none;
      width: 100%;
      height: auto;
      max-height: 410px;
      object-fit: contain;
      pointer-events: none;
    }
    @media (min-height: 580px) {
      html, body {
        height: 100%;
      }
      .frame-card {
        display: flex;
        flex-direction: column;
        height: 100vh;
        border-radius: 0;
        border: 0;
      }
      .viewport {
        flex: 1;
        min-height: 0;
        max-height: none;
      }
      .viewport img {
        max-height: calc(100vh - 96px);
      }
    }
    .empty-box {
      padding: 32px 16px;
      text-align: center;
      font-size: 12px;
      color: #a1a1aa;
    }
    .hud-chip {
      position: absolute;
      left: 8px;
      bottom: 8px;
      padding: 2px 7px;
      border-radius: 5px;
      background: rgba(12, 14, 20, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(244, 244, 245, 0.85);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.02em;
      pointer-events: none;
      backdrop-filter: blur(8px);
    }
    .click-ripple {
      position: absolute;
      width: 22px;
      height: 22px;
      margin-left: -11px;
      margin-top: -11px;
      border-radius: 50%;
      border: 1.5px solid #e4e4e7;
      box-shadow: 0 0 8px rgba(255, 255, 255, 0.45);
      pointer-events: none;
      animation: rippleOut 0.42s ease-out forwards;
    }
    @keyframes rippleOut {
      0% { transform: scale(0.3); opacity: 1; }
      100% { transform: scale(1.8); opacity: 0; }
    }
    .select-box {
      position: absolute;
      border: 1.5px dashed #f4f4f5;
      background: rgba(255, 255, 255, 0.14);
      border-radius: 4px;
      pointer-events: none;
      display: none;
    }

    .bottom-drawer {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.08));
      background: var(--color-background-primary, #ffffff);
      font-size: 11.5px;
    }
    html.dark .bottom-drawer {
      background: rgba(255, 255, 255, 0.03);
      border-bottom-color: rgba(255, 255, 255, 0.08);
    }
    .bottom-drawer[data-open="true"] {
      display: flex;
    }
    .status-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 10px;
      border-bottom: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.08));
      font-size: 11px;
      background: rgba(0, 0, 0, 0.03);
      color: var(--color-text-secondary, #52525b);
    }
    html.dark .status-banner {
      background: rgba(255, 255, 255, 0.04);
      color: #a1a1aa;
    }
    .status-banner[data-open="true"] {
      display: flex;
    }
    .status-banner[data-kind="error"] {
      background: rgba(239, 68, 68, 0.08);
      color: #dc2626;
    }
    html.dark .status-banner[data-kind="error"] {
      color: #f87171;
    }
    .status-banner[data-kind="ok"] {
      background: rgba(16, 185, 129, 0.08);
      color: #047857;
    }
    html.dark .status-banner[data-kind="ok"] {
      color: #34d399;
    }
    .status-msg {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remote-input {
      flex: 1;
      min-width: 0;
      height: 26px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid var(--color-border-primary, rgba(0, 0, 0, 0.14));
      background: var(--color-background-primary, #ffffff);
      color: inherit;
      font: inherit;
      font-size: 11.5px;
      outline: none;
    }
    .remote-input:focus {
      border-color: var(--color-text-primary, #18181b);
    }
    html.dark .remote-input {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.05);
    }
    .region-summary {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--color-text-secondary, #71717a);
    }
  </style>
</head>
<body>
  <div id="rootBox" class="frame-card">
    <div class="topbar">
      <div class="status-left">
        <span id="led" class="dot"></span>
        <span id="titleEl" class="meta-title">Chrome Live</span>
        <span id="subEl" class="meta-sub"></span>
      </div>
      <div class="btn-row">
        <button id="remoteBtn" type="button" disabled title="Click, scroll, or type directly on the live stream">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5L12.5 7.5L8.4 8.8L6.8 12.8L3.5 2.5Z"/></svg>
          <span class="lbl">Control</span>
        </button>
        <button id="regionBtn" type="button" disabled title="Click or drag to pick page elements and extract selectors">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11"/></svg>
          <span class="lbl">Pick</span>
        </button>
        <button id="attachBtn" type="button" disabled style="display:none" title="Attach the current page title and URL to the next prompt">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 4.5l-4.6 4.6a1.5 1.5 0 1 0 2.1 2.1l5-5a2.8 2.8 0 0 0-4-4l-5.3 5.3a4 4 0 0 0 5.7 5.7l4.3-4.3"/></svg>
          <span class="lbl">Attach</span>
        </button>
        <span class="btn-sep"></span>
        <button id="relayBtn" type="button" data-relay="popout" disabled title="Pop out into a standalone window for manual login/2FA, then merge back">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/></svg>
          <span class="lbl">Popout</span>
        </button>
        <button id="snapBtn" type="button" title="Capture a fresh frame now">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.3-3.4M13 2.8v2.6h-2.6"/></svg>
          <span class="lbl">Refresh</span>
        </button>
        <button id="releaseBtn" type="button" disabled title="Release AI control while keeping this tab open">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6.5"/></svg>
          <span class="lbl">Release</span>
        </button>
      </div>
    </div>

    <div id="tabStrip" class="tab-strip"></div>

    <div id="statusBar" class="status-banner" data-open="false" data-kind="info">
      <span id="statusMsg" class="status-msg"></span>
      <button id="sendCtxNowBtn" class="action-btn" type="button" style="display:none">Send to AI</button>
    </div>

    <div id="remoteBar" class="bottom-drawer">
      <input id="remoteInput" type="text" class="remote-input" placeholder="Type text or verification code to send to the active field..." />
      <button id="sendTypeBtn" class="action-btn" type="button">Type</button>
      <button id="sendSubmitBtn" class="action-btn" type="button">Type &amp; Enter</button>
    </div>

    <div id="regionBar" class="bottom-drawer">
      <span id="regionText" class="region-summary">Click or drag anywhere on the stream to extract DOM selectors</span>
      <button id="askAiBtn" class="action-btn" type="button" style="display:none">Ask AI</button>
    </div>

    <div id="viewport" class="viewport">
      <img id="screenImg" alt="Chrome Live Stream" />
      <div id="emptyEl" class="empty-box">Connecting to local Chrome Live stream...</div>
      <div id="selectBox" class="select-box"></div>
      <span id="hudChip" class="hud-chip">LIVE · 0 Token</span>
    </div>
  </div>

  <script>
    (() => {
      const IS_ZH = /^zh\\b/i.test(navigator.language || '');
      document.documentElement.lang = IS_ZH ? 'zh-CN' : 'en';
      const L = IS_ZH
        ? {
            remote: '接管',
            region: '圈选',
            attach: '挂入',
            attached: '已挂入',
            relayOut: '副屏',
            relayBack: '归队',
            snap: '刷新',
            release: '释放',
            remoteTitle: '直接在画面上点击、滚轮或输入文字',
            regionTitle: '单击或拖拽框选网页元素提取选择器',
            attachTitle: '将当前网页标题与网址挂入下一条对话上下文',
            relayTitle: '弹出独立副屏窗口人工操作，完成后一键归队',
            snapTitle: '立即抓取当前最新画面',
            releaseTitle: '解除 AI 接管并保留该网页',
            remotePlaceholder: '输入验证码或文字发往网页当前输入框...',
            sendType: '填入',
            sendSubmit: '填入并回车',
            regionHint: '在下方画面单击或拖拽框选任意区域，自动提取内部元素',
            askAi: '发给 AI 处理',
            connecting: '正在连接本地 Chrome 实时画面...',
            offline: '本地桥接未响应',
            idle: '主 Chrome 在线 · 按 Alt+Shift+L 共享网页或直接派发任务即可在此实时同屏',
            active: '实时同屏中',
            chipIdle: 'LIVE · 0 Token',
            chipRemote: '接管模式 · 直接点击画面或滚动滚轮',
            chipRegion: '圈选模式 · 单击或拖拽框选提取元素',
            regionAttached: (n) => '已提取 ' + n + ' 个元素并挂入上下文',
            regionEmpty: '选框内未检测到可交互元素，请换个区域重试',
            askPrompt: '请查看我刚刚在实时画面中框选的网页区域元素并帮我处理'
          }
        : {
            remote: 'Control',
            region: 'Pick',
            attach: 'Attach',
            attached: 'Attached',
            relayOut: 'Popout',
            relayBack: 'Merge',
            snap: 'Refresh',
            release: 'Release',
            remoteTitle: 'Click, scroll, or type directly on the live stream',
            regionTitle: 'Click or drag to pick page elements and extract selectors',
            attachTitle: 'Attach the current page title and URL to the next prompt',
            relayTitle: 'Pop out into a standalone window for manual login/2FA, then merge back',
            snapTitle: 'Capture a fresh frame now',
            releaseTitle: 'Release AI control while keeping this tab open',
            remotePlaceholder: 'Type text or verification code to send to the active field...',
            sendType: 'Type',
            sendSubmit: 'Type & Enter',
            regionHint: 'Click or drag anywhere on the stream to extract DOM selectors',
            askAi: 'Ask AI',
            connecting: 'Connecting to local Chrome Live stream...',
            offline: 'Bridge offline',
            idle: 'Chrome connected · Share a tab (Alt+Shift+L) or run a browser task to stream live here',
            active: 'Streaming live',
            chipIdle: 'LIVE · 0 Token',
            chipRemote: 'Control · Click or scroll on stream',
            chipRegion: 'Pick · Click or drag to inspect elements',
            regionAttached: (n) => 'Attached ' + n + ' elements to next message',
            regionEmpty: 'No interactive elements found in selection',
            askPrompt: 'Please inspect the page region I just selected in Chrome Live.'
          };

      const rootBox = document.getElementById('rootBox');
      const led = document.getElementById('led');
      const titleEl = document.getElementById('titleEl');
      const subEl = document.getElementById('subEl');
      const remoteBtn = document.getElementById('remoteBtn');
      const regionBtn = document.getElementById('regionBtn');
      const attachBtn = document.getElementById('attachBtn');
      const relayBtn = document.getElementById('relayBtn');
      const snapBtn = document.getElementById('snapBtn');
      const releaseBtn = document.getElementById('releaseBtn');
      const tabStrip = document.getElementById('tabStrip');
      const statusBar = document.getElementById('statusBar');
      const statusMsg = document.getElementById('statusMsg');
      const sendCtxNowBtn = document.getElementById('sendCtxNowBtn');
      const viewport = document.getElementById('viewport');
      const screenImg = document.getElementById('screenImg');
      const emptyEl = document.getElementById('emptyEl');
      const selectBox = document.getElementById('selectBox');
      const hudChip = document.getElementById('hudChip');
      const remoteBar = document.getElementById('remoteBar');
      const remoteInput = document.getElementById('remoteInput');
      const sendTypeBtn = document.getElementById('sendTypeBtn');
      const sendSubmitBtn = document.getElementById('sendSubmitBtn');
      const regionBar = document.getElementById('regionBar');
      const regionText = document.getElementById('regionText');
      const askAiBtn = document.getElementById('askAiBtn');

      function setBtnLabel(btn, text) {
        const span = btn && btn.querySelector('.lbl');
        if (span) span.textContent = text;
        else if (btn) btn.textContent = text;
      }

      setBtnLabel(remoteBtn, L.remote);
      setBtnLabel(regionBtn, L.region);
      setBtnLabel(attachBtn, L.attach);
      setBtnLabel(relayBtn, L.relayOut);
      setBtnLabel(snapBtn, L.snap);
      setBtnLabel(releaseBtn, L.release);
      remoteBtn.title = L.remoteTitle;
      regionBtn.title = L.regionTitle;
      attachBtn.title = L.attachTitle;
      relayBtn.title = L.relayTitle;
      snapBtn.title = L.snapTitle;
      releaseBtn.title = L.releaseTitle;
      remoteInput.placeholder = L.remotePlaceholder;
      sendTypeBtn.textContent = L.sendType;
      sendSubmitBtn.textContent = L.sendSubmit;
      regionText.textContent = L.regionHint;
      askAiBtn.textContent = L.askAi;
      emptyEl.textContent = L.connecting;
      sendCtxNowBtn.textContent = IS_ZH ? '发给 AI' : 'Send to AI';

      let rpcSeq = 1;
      const pending = new Map();
      let hostCaps = {};
      let contextAttached = false;
      let lastAttachedContext = '';
      let selectedTabId = null;
      let currentTab = null;
      let hasActiveTabs = false;
      let lastFrameTs = 0;
      let lastFrameTabId = null;
      let pollTimer = null;
      let pollInFlight = false;
      let interactionMode = 'watch'; // 'watch' | 'remote' | 'region'
      let lastRegionSummary = '';

      function formatRpcErr(err) {
        if (!err) return 'Unknown error';
        if (typeof err === 'string') return err;
        if (err.message) return (err.code ? '[' + err.code + '] ' : '') + err.message;
        try { return JSON.stringify(err); } catch { return String(err); }
      }

      function showStatus(msg, kind = 'info', showSendNow = false) {
        if (!msg) {
          statusBar.dataset.open = 'false';
          sendCtxNowBtn.style.display = 'none';
          reportSize();
          return;
        }
        statusBar.dataset.kind = kind;
        statusBar.dataset.open = 'true';
        statusMsg.textContent = msg;
        sendCtxNowBtn.style.display = showSendNow && hostCaps && hostCaps.message ? 'inline-block' : 'none';
        reportSize();
      }

      function syncCapabilityButtons() {
        const canAttach = Boolean(hostCaps && (hostCaps.updateModelContext || hostCaps.message));
        attachBtn.style.display = canAttach ? 'inline-block' : 'none';
      }

      function postJson(payload) {
        window.parent.postMessage(payload, '*');
      }

      function sendRequest(method, params) {
        return new Promise((resolve, reject) => {
          const id = rpcSeq++;
          pending.set(id, { resolve, reject });
          postJson({ jsonrpc: '2.0', id, method, params });
        });
      }

      function applyHostContext(ctx) {
        if (!ctx || typeof ctx !== 'object') return;
        if (ctx.theme === 'dark') document.documentElement.classList.add('dark');
        else if (ctx.theme === 'light') document.documentElement.classList.remove('dark');
        const vars = ctx.styles && ctx.styles.variables;
        if (vars && typeof vars === 'object') {
          for (const [k, v] of Object.entries(vars)) {
            if (typeof v === 'string') document.documentElement.style.setProperty(k, v);
          }
        }
      }

      function reportSize() {
        const rect = rootBox.getBoundingClientRect();
        const height = Math.max(140, Math.min(660, Math.ceil(rect.height)));
        const width = Math.max(260, Math.ceil(rect.width));
        postJson({
          jsonrpc: '2.0',
          method: 'ui/notifications/size-changed',
          params: { width, height }
        });
      }

      function setMode(nextMode) {
        interactionMode = interactionMode === nextMode ? 'watch' : nextMode;
        remoteBtn.dataset.active = String(interactionMode === 'remote');
        regionBtn.dataset.active = String(interactionMode === 'region');
        viewport.dataset.mode = interactionMode;
        remoteBar.dataset.open = String(interactionMode === 'remote');
        regionBar.dataset.open = String(interactionMode === 'region');
        hudChip.textContent =
          interactionMode === 'remote'
            ? L.chipRemote
            : interactionMode === 'region'
              ? L.chipRegion
              : L.chipIdle;
        reportSize();
      }

      // Compute exact rendered image content box inside object-fit:contain
      function clientPointToNormalized(clientX, clientY, clamp = false) {
        if (!screenImg.naturalWidth || !screenImg.naturalHeight || screenImg.style.display === 'none') {
          return null;
        }
        const r = screenImg.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const imgAspect = screenImg.naturalWidth / screenImg.naturalHeight;
        const boxAspect = r.width / r.height;
        let drawW = r.width;
        let drawH = r.height;
        let offsetX = 0;
        let offsetY = 0;
        if (imgAspect > boxAspect) {
          drawH = r.width / imgAspect;
          offsetY = (r.height - drawH) / 2;
        } else {
          drawW = r.height * imgAspect;
          offsetX = (r.width - drawW) / 2;
        }
        let localX = clientX - (r.left + offsetX);
        let localY = clientY - (r.top + offsetY);
        if (!clamp && (localX < 0 || localY < 0 || localX > drawW || localY > drawH)) return null;
        localX = Math.min(drawW, Math.max(0, localX));
        localY = Math.min(drawH, Math.max(0, localY));
        const vr = viewport.getBoundingClientRect();
        return {
          rx: Math.min(0.998, Math.max(0.002, localX / drawW)),
          ry: Math.min(0.998, Math.max(0.002, localY / drawH)),
          stageX: Math.min(vr.width, Math.max(0, clientX - vr.left)),
          stageY: Math.min(vr.height, Math.max(0, clientY - vr.top))
        };
      }

      function spawnClickRipple(x, y) {
        const dot = document.createElement('div');
        dot.className = 'click-ripple';
        dot.style.left = Math.round(x) + 'px';
        dot.style.top = Math.round(y) + 'px';
        viewport.appendChild(dot);
        setTimeout(() => dot.remove(), 440);
      }

      function renderTabStrip(tabs) {
        if (tabs.length < 2) {
          tabStrip.style.display = 'none';
          tabStrip.replaceChildren();
          return;
        }
        tabStrip.style.display = 'flex';
        tabStrip.replaceChildren();
        for (const t of tabs) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tab-pill';
          b.dataset.active = String(t.tabId === (currentTab && currentTab.tabId));
          b.textContent = (t.title || t.url || ('#' + t.tabId)).slice(0, 22);
          b.addEventListener('click', async () => {
            selectedTabId = t.tabId;
            lastFrameTs = 0;
            await callAppAction(
              { action: 'screenshot', tabId: t.tabId },
              IS_ZH ? '正在切换标签页画面...' : 'Switching tab stream...'
            );
          });
          tabStrip.appendChild(b);
        }
      }

      function renderSnapshot(data) {
        if (!data || data.ok === false) {
          led.dataset.live = 'false';
          led.dataset.paused = 'false';
          titleEl.textContent = L.offline;
          subEl.textContent = '';
          hasActiveTabs = false;
          remoteBtn.disabled = true;
          regionBtn.disabled = true;
          attachBtn.disabled = true;
          relayBtn.disabled = true;
          releaseBtn.disabled = true;
          return;
        }

        const tabs = Array.isArray(data.tabs) ? data.tabs : [];
        hasActiveTabs = tabs.length > 0;
        const prevInRelay = Boolean(currentTab && currentTab.inRelayPopout);
        const primary =
          (selectedTabId !== null && tabs.find((t) => t.tabId === selectedTabId)) ||
          tabs.find((t) => t.substate === 'shared') ||
          tabs[0] ||
          null;
        currentTab = primary;
        selectedTabId = primary ? primary.tabId : null;

        renderTabStrip(tabs);

        const isPaused = Boolean(primary && primary.paused);
        led.dataset.live = String(Boolean(data.extensionConnected && primary && !isPaused));
        led.dataset.paused = String(isPaused);

        if (primary) {
          titleEl.textContent = primary.title || 'Chrome Live';
          subEl.textContent = primary.activity || primary.url || L.active;
          remoteBtn.disabled = isPaused;
          if (isPaused && interactionMode === 'remote') setMode('watch');
          regionBtn.disabled = false;
          attachBtn.disabled = false;
          relayBtn.disabled = false;
          releaseBtn.disabled = false;
          if (primary.inRelayPopout) {
            relayBtn.dataset.relay = 'merge';
            setBtnLabel(relayBtn, L.relayBack);
          } else {
            relayBtn.dataset.relay = 'popout';
            setBtnLabel(relayBtn, L.relayOut);
            if (prevInRelay) {
              showStatus(IS_ZH ? '副屏已归队，AI 恢复接管' : 'Relay merged back; AI resumed', 'ok', false);
            }
          }
        } else {
          titleEl.textContent = 'Chrome Live';
          subEl.textContent = data.extensionConnected
            ? (IS_ZH ? '空闲 · 无受控标签页' : 'Idle · No active tab')
            : L.offline;
          emptyEl.textContent = L.idle;
          remoteBtn.disabled = true;
          regionBtn.disabled = true;
          attachBtn.disabled = true;
          relayBtn.disabled = true;
          relayBtn.dataset.relay = 'popout';
          setBtnLabel(relayBtn, L.relayOut);
          releaseBtn.disabled = true;
          if (interactionMode !== 'watch') setMode('watch');
          if (prevInRelay) showStatus('');
        }

        const frameTabId = data.frameTabId ?? (data.latestFrameMeta && data.latestFrameMeta.tabId) ?? null;
        const ts =
          data.latestFrameMeta && data.latestFrameMeta.capturedAt
            ? data.latestFrameMeta.capturedAt
            : 0;
        if (data.frameDataUrl && (ts !== lastFrameTs || frameTabId !== lastFrameTabId)) {
          lastFrameTs = ts || Date.now();
          lastFrameTabId = frameTabId;
          screenImg.onload = () => reportSize();
          screenImg.src = data.frameDataUrl;
          screenImg.style.display = 'block';
          emptyEl.style.display = 'none';
        } else if (!lastFrameTs) {
          screenImg.style.display = 'none';
          emptyEl.style.display = 'block';
        }
        reportSize();
      }

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

        if (msg.id !== undefined && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) entry.reject(msg.error);
          else entry.resolve(msg.result);
          return;
        }

        if (msg.method === 'ping' && msg.id !== undefined) {
          postJson({ jsonrpc: '2.0', id: msg.id, result: {} });
          return;
        }

        if (msg.method === 'ui/resource-teardown') {
          if (pollTimer) clearTimeout(pollTimer);
          if (msg.id !== undefined) postJson({ jsonrpc: '2.0', id: msg.id, result: {} });
          return;
        }

        if (msg.method === 'ui/notifications/host-context-changed') {
          applyHostContext(msg.params);
          return;
        }

        if (msg.method === 'ui/notifications/tool-result') {
          const sc = msg.params && (msg.params.structuredContent || msg.params);
          if (sc) renderSnapshot(sc);
        }
      });

      async function pollLoop() {
        if (document.hidden || pollInFlight) {
          scheduleNextPoll();
          return;
        }
        pollInFlight = true;
        try {
          const pollArgs = { action: 'poll', lastFrameTs };
          if (selectedTabId !== null) pollArgs.tabId = selectedTabId;
          const res = await sendRequest('tools/call', {
            name: 'chrome_live_monitor',
            arguments: pollArgs
          });
          if (res && res.structuredContent) {
            renderSnapshot(res.structuredContent);
          }
        } catch {}
        pollInFlight = false;
        scheduleNextPoll();
      }

      function scheduleNextPoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(pollLoop, hasActiveTabs ? 720 : 2400);
      }

      remoteBtn.addEventListener('click', () => setMode('remote'));
      regionBtn.addEventListener('click', () => setMode('region'));

      async function callAppAction(actionArgs, labelText) {
        if (labelText) showStatus(labelText, 'info', false);
        try {
          const res = await sendRequest('tools/call', {
            name: 'chrome_live_monitor',
            arguments: actionArgs
          });
          if (res && res.isError) {
            const errTxt = (res.content && res.content[0] && res.content[0].text) || 'Action failed';
            showStatus((IS_ZH ? '操作失败：' : 'Action failed: ') + errTxt, 'error', false);
            return null;
          }
          if (res && res.structuredContent) renderSnapshot(res.structuredContent);
          return res;
        } catch (err) {
          showStatus((IS_ZH ? '调用受阻：' : 'RPC error: ') + formatRpcErr(err), 'error', false);
          return null;
        }
      }

      attachBtn.addEventListener('click', async () => {
        if (!currentTab) return;
        if (contextAttached) {
          try {
            if (hostCaps && hostCaps.updateModelContext) {
              await sendRequest('ui/update-model-context', { content: [] });
            }
            contextAttached = false;
            lastAttachedContext = '';
            attachBtn.dataset.attached = 'false';
            setBtnLabel(attachBtn, L.attach);
            showStatus(IS_ZH ? '已取消挂入的网页上下文' : 'Cleared attached page context', 'info', false);
          } catch (err) {
            showStatus((IS_ZH ? '取消失败：' : 'Clear failed: ') + formatRpcErr(err), 'error', false);
          }
          return;
        }
        const ctxText =
          '[Chrome Live Current Tab Context]\\n' +
          '- TabId: ' + currentTab.tabId + '\\n' +
          '- Title: ' + (currentTab.title || '') + '\\n' +
          '- URL: ' + (currentTab.url || '') + '\\n' +
          '- State: ' + (currentTab.substate || 'worker') + (currentTab.paused ? ' (paused)' : '');
        lastAttachedContext = ctxText;
        if (hostCaps && hostCaps.updateModelContext) {
          try {
            await sendRequest('ui/update-model-context', {
              content: [{ type: 'text', text: ctxText }]
            });
            contextAttached = true;
            attachBtn.dataset.attached = 'true';
            setBtnLabel(attachBtn, L.attached);
            showStatus(
              IS_ZH
                ? '已挂入下一条对话上下文：' + (currentTab.title || currentTab.url)
                : 'Attached to next message: ' + (currentTab.title || currentTab.url),
              'ok',
              true
            );
          } catch (err) {
            showStatus(
              (IS_ZH ? '宿主拒绝挂入上下文：' : 'Host rejected context attach: ') + formatRpcErr(err),
              'error',
              true
            );
          }
        } else if (hostCaps && hostCaps.message) {
          showStatus(
            IS_ZH ? '当前视图不支持静默挂入，请点右侧按钮直接发给 AI' : 'Use Send to AI button to pass context',
            'info',
            true
          );
        }
      });

      sendCtxNowBtn.addEventListener('click', async () => {
        if (!lastAttachedContext) return;
        try {
          await sendRequest('ui/message', {
            role: 'user',
            content: [{ type: 'text', text: (IS_ZH ? '请结合这个网页上下文继续处理：\\n' : 'Continue using this page context:\\n') + lastAttachedContext }]
          });
          showStatus(IS_ZH ? '已发送到对话流' : 'Sent to conversation', 'ok', false);
        } catch (err) {
          showStatus((IS_ZH ? '发送失败：' : 'Send failed: ') + formatRpcErr(err), 'error', false);
        }
      });

      relayBtn.addEventListener('click', async () => {
        if (!currentTab) return;
        const act = currentTab.inRelayPopout ? 'relay_merge' : 'relay_popout';
        const res = await callAppAction(
          { action: act, tabId: currentTab.tabId },
          act === 'relay_popout' ? (IS_ZH ? '正在弹出副屏接力窗口...' : 'Opening relay popout...') : (IS_ZH ? '正在归队合回原窗口...' : 'Merging tab back...')
        );
        if (res) showStatus(act === 'relay_popout' ? (IS_ZH ? '已弹出独立副屏窗口，完成后可点「交还归队」' : 'Relay window opened') : (IS_ZH ? '已交还归队' : 'Merged back'), 'ok', false);
      });

      snapBtn.addEventListener('click', async () => {
        const res = await callAppAction(
          { action: 'screenshot', tabId: currentTab ? currentTab.tabId : undefined },
          IS_ZH ? '正在抓取最新画面...' : 'Refreshing live frame...'
        );
        if (res) showStatus(IS_ZH ? '画面已刷新' : 'Frame updated', 'ok', false);
      });

      releaseBtn.addEventListener('click', async () => {
        if (!currentTab) return;
        const res = await callAppAction(
          { action: 'release_tab', tabId: currentTab.tabId },
          IS_ZH ? '正在释放标签页接管...' : 'Releasing tab...'
        );
        if (res) showStatus(IS_ZH ? '已释放控制权' : 'Tab released', 'ok', false);
      });

      // Remote click & Region drag selection on live viewport
      let dragStart = null;
      viewport.addEventListener('pointerdown', async (ev) => {
        if (ev.button !== 0 || !currentTab) return;
        const pt = clientPointToNormalized(ev.clientX, ev.clientY, interactionMode === 'region');
        if (!pt) return;

        if (interactionMode === 'remote') {
          spawnClickRipple(pt.stageX, pt.stageY);
          const res = await callAppAction(
            { action: 'remote_click', tabId: currentTab.tabId, rx: pt.rx, ry: pt.ry },
            IS_ZH ? '正在派发远程点击...' : 'Dispatching remote click...'
          );
          if (res) showStatus(IS_ZH ? '远程点击已执行' : 'Remote click sent', 'ok', false);
          return;
        }

        if (interactionMode === 'region') {
          dragStart = pt;
          selectBox.style.left = pt.stageX + 'px';
          selectBox.style.top = pt.stageY + 'px';
          selectBox.style.width = '0px';
          selectBox.style.height = '0px';
          selectBox.style.display = 'block';
          viewport.setPointerCapture(ev.pointerId);
        }
      });

      viewport.addEventListener('pointermove', (ev) => {
        if (!dragStart || interactionMode !== 'region') return;
        const vr = viewport.getBoundingClientRect();
        const curX = Math.max(0, Math.min(vr.width, ev.clientX - vr.left));
        const curY = Math.max(0, Math.min(vr.height, ev.clientY - vr.top));
        selectBox.style.left = Math.min(dragStart.stageX, curX) + 'px';
        selectBox.style.top = Math.min(dragStart.stageY, curY) + 'px';
        selectBox.style.width = Math.abs(curX - dragStart.stageX) + 'px';
        selectBox.style.height = Math.abs(curY - dragStart.stageY) + 'px';
      });

      viewport.addEventListener('pointerup', async (ev) => {
        if (!dragStart || interactionMode !== 'region') return;
        const startPt = dragStart;
        dragStart = null;
        try { viewport.releasePointerCapture(ev.pointerId); } catch {}
        setTimeout(() => { selectBox.style.display = 'none'; }, 500);

        const endPt = clientPointToNormalized(ev.clientX, ev.clientY, true);
        if (!endPt || !currentTab) return;
        let rx1 = startPt.rx;
        let ry1 = startPt.ry;
        let rx2 = endPt.rx;
        let ry2 = endPt.ry;
        if (Math.hypot(endPt.stageX - startPt.stageX, endPt.stageY - startPt.stageY) < 8) {
          // Single-click fallback: inspect a small box around the clicked point
          rx1 = Math.max(0.002, startPt.rx - 0.045);
          ry1 = Math.max(0.002, startPt.ry - 0.045);
          rx2 = Math.min(0.998, startPt.rx + 0.045);
          ry2 = Math.min(0.998, startPt.ry + 0.045);
        }

        const res = await callAppAction(
          {
            action: 'inspect_region',
            tabId: currentTab.tabId,
            rx1,
            ry1,
            rx2,
            ry2
          },
          IS_ZH ? '正在识别圈选区域内的网页元素...' : 'Inspecting selected region...'
        );
        if (!res) return;

        const regionData = res && res.structuredContent && res.structuredContent.regionResult;
        const els = (regionData && regionData.elements) || [];
        if (els.length === 0) {
          regionText.textContent = L.regionEmpty;
          askAiBtn.style.display = 'none';
          showStatus(L.regionEmpty, 'info', false);
          return;
        }
        const lines = els.map((e) => '- <' + e.tag + '> "' + e.label + '" (selector: ' + e.selector + ')');
        lastRegionSummary =
          '[Chrome Live Selected Page Region on ' + (regionData.url || '') + ']\\n' + lines.join('\\n');
        lastAttachedContext = lastRegionSummary;
        const brief = els.map((e) => e.label).slice(0, 3).join(' / ');
        regionText.textContent = L.regionAttached(els.length) + '：' + brief;

        if (hostCaps && hostCaps.updateModelContext) {
          try {
            await sendRequest('ui/update-model-context', {
              content: [{ type: 'text', text: lastRegionSummary }]
            });
            showStatus(L.regionAttached(els.length) + '：' + brief, 'ok', true);
          } catch (err) {
            showStatus((IS_ZH ? '已识别元素，但挂入失败：' : 'Picked elements, attach failed: ') + formatRpcErr(err), 'error', true);
          }
        } else {
          showStatus((IS_ZH ? '已识别 ' + els.length + ' 个元素：' : 'Picked ' + els.length + ' elements: ') + brief, 'ok', true);
        }

        if (hostCaps && hostCaps.message) {
          askAiBtn.style.display = 'inline-block';
        }
      });

      let wheelBusy = false;
      viewport.addEventListener(
        'wheel',
        async (ev) => {
          if (interactionMode !== 'remote' || !currentTab) return;
          ev.preventDefault();
          if (wheelBusy) return;
          wheelBusy = true;
          const dy = ev.deltaY > 0 ? 380 : -380;
          await callAppAction({ action: 'remote_wheel', tabId: currentTab.tabId, deltaY: dy });
          setTimeout(() => { wheelBusy = false; }, 220);
        },
        { passive: false }
      );

      async function submitRemoteText(submitEnter) {
        if (!currentTab) return;
        const txt = remoteInput.value;
        if (!txt && !submitEnter) return;
        remoteInput.value = '';
        const res = await callAppAction(
          { action: 'remote_type', tabId: currentTab.tabId, text: txt, submit: submitEnter },
          IS_ZH ? '正在向网页输入文本...' : 'Sending text to page...'
        );
        if (res) showStatus(IS_ZH ? '文本已发送' : 'Text sent', 'ok', false);
      }

      sendTypeBtn.addEventListener('click', () => submitRemoteText(false));
      sendSubmitBtn.addEventListener('click', () => submitRemoteText(true));
      remoteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitRemoteText(true);
      });

      askAiBtn.addEventListener('click', () => {
        if (!lastRegionSummary) return;
        sendRequest('ui/message', {
          role: 'user',
          content: [{ type: 'text', text: L.askPrompt + '\\n\\n' + lastRegionSummary }]
        }).catch(() => {});
      });

      new ResizeObserver(() => reportSize()).observe(rootBox);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollLoop();
      });

      (async () => {
        try {
          const initRes = await sendRequest('ui/initialize', {
            protocolVersion: '2026-01-26',
            appInfo: { name: 'chrome-live-relay-studio', version: '1.1.0' },
            appCapabilities: {}
          });
          if (initRes && initRes.hostCapabilities) hostCaps = initRes.hostCapabilities;
          syncCapabilityButtons();
          if (initRes && initRes.hostContext) applyHostContext(initRes.hostContext);
          postJson({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
          reportSize();
          scheduleNextPoll();
        } catch {}
      })();
    })();
  </script>
</body>
</html>`;
}
