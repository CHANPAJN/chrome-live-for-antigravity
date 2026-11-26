(function initChromeLiveHud() {
  'use strict';

  if (window.top !== window) return;

  const REGISTRY_SYMBOL = '__chromeLiveHudController__';
  const CURRENT_HUD_REV = 11;
  const HOST_Z_MARKER = '2147483647';

  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isOurNeutralHostDiv(node) {
    if (!node || node.tagName !== 'DIV' || node.childElementCount > 0) return false;
    if (node.hasAttribute('data-chrome-live-hud')) return true;
    const st = node.getAttribute('style') || '';
    return node.id === '' && node.className === '' && st.includes(HOST_Z_MARKER) && st.includes('pointer-events:none');
  }

  let inheritedDock = '';
  let inheritedTopPct = null;
  if (window[REGISTRY_SYMBOL]) {
    if (
      window[REGISTRY_SYMBOL]._hudRev === CURRENT_HUD_REV &&
      typeof window[REGISTRY_SYMBOL].ping === 'function' &&
      window[REGISTRY_SYMBOL].ping()
    ) {
      return;
    }
    if (typeof window[REGISTRY_SYMBOL].destroy === 'function') {
      try {
        inheritedDock = window[REGISTRY_SYMBOL]._state?.dock || '';
        inheritedTopPct = window[REGISTRY_SYMBOL]._state?.topPct ?? null;
        window[REGISTRY_SYMBOL].destroy();
      } catch {}
    }
  }

  // Sweep any orphan HUD host nodes left behind by prior extension reloads without exposing brand attributes
  try {
    const rootChildren = Array.from((document.documentElement || document.body)?.children || []);
    for (const oldNode of rootChildren) {
      if (isOurNeutralHostDiv(oldNode)) {
        oldNode.remove();
      }
    }
  } catch {}

  const DBL_TAP_WINDOW_MS = 420;
  const DBL_TAP_MAX_DIST_PX = 36;
  // Original rounded collaboration dart silhouette (zero overlap with classic OS arrow paths)
  const COLLAB_DART_PATH =
    'M2.4 2.4 L19.2 8.512 C20.9 9.1 21.0 11.573 19.3 12.2 L12.7 15.057 L9.9 21.647 C9.2 23.2 6.8 23.1 6.2 21.4 Z';

  const DICT = {
    zh: {
      dragTip: '上下拖动调整侧栏高度，或拖至左/右边缘贴壁停靠',
      ready: '待命就绪',
      pausedByUser: '手动接管中',
      resumed: '已恢复自动执行',
      badgeLive: 'LIVE',
      badgeHold: 'HOLD',
      badgeShared: 'LIVE',
      pauseTip: '点击立即切为手动模式（也可双击页面或按 Esc）',
      resumeTip: '点击恢复 AI 自动操控',
      disconnectLabel: '断开',
      closeTip: '释放此标签页控制权（不关闭网页）',
      confirmAsk: '断开此页受控？',
      cancelBtn: '取消',
      disconnectBtn: '确认断开',
      lockedTapHint: '双击页面或按 Esc 立即切手动',
      cursorClick: '点击',
      cursorType: '输入',
      cursorUpload: '上传',
      cursorScroll: '滚动',
      cursorMove: '定位'
    },
    en: {
      dragTip: 'Drag vertically to reposition, or drag across to snap left/right edge',
      ready: 'Ready',
      pausedByUser: 'Manual mode',
      resumed: 'Automation resumed',
      badgeLive: 'LIVE',
      badgeHold: 'HOLD',
      badgeShared: 'LIVE',
      pauseTip: 'Switch to manual control (or double-click page / press Esc)',
      resumeTip: 'Resume AI control',
      disconnectLabel: 'Detach',
      closeTip: 'Detach this tab without closing it',
      confirmAsk: 'Detach this tab?',
      cancelBtn: 'Cancel',
      disconnectBtn: 'Confirm',
      lockedTapHint: 'Double-click page or press Esc for manual mode',
      cursorClick: 'Click',
      cursorType: 'Type',
      cursorUpload: 'Upload',
      cursorScroll: 'Scroll',
      cursorMove: 'Move'
    }
  };

  const STYLESHEET = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: "Microsoft YaHei UI", "PingFang SC", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --spring-width: 440ms linear(0, 0.4479, 0.8864, 1.055, 1.018, 0.998, 1);
      --spring-pop: 240ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .lock-shield {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: transparent;
      cursor: default;
      display: none;
    }
    .lock-shield[data-locked="true"] {
      display: block;
      pointer-events: auto;
    }

    /* Top 2.5px Solid Director Line (Zero 4-side blur glow) */
    .director-topline {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 2.5px;
      pointer-events: none;
      overflow: hidden;
      opacity: 0;
      background: rgba(37, 99, 235, 0.20);
      transition: opacity 180ms ease, background-color 200ms ease;
    }
    .director-topline-runner {
      width: 36%;
      height: 100%;
      background: #2563eb;
      transform: translateX(-100%);
    }
    .director-topline[data-state="working"] {
      opacity: 1;
      background: rgba(37, 99, 235, 0.22);
    }
    .director-topline[data-state="working"] .director-topline-runner {
      background: #2563eb;
      animation: cliveDirectorSlide 1.95s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .director-topline[data-state="shared"] {
      opacity: 1;
      height: 2px;
      background: #059669;
    }
    .director-topline[data-state="shared"] .director-topline-runner {
      display: none;
    }
    .director-topline[data-state="paused"] {
      opacity: 1;
      background: #d97706;
    }
    .director-topline[data-state="paused"] .director-topline-runner {
      display: none;
    }
    @keyframes cliveDirectorSlide {
      0% { transform: translateX(-105%); }
      100% { transform: translateX(285%); }
    }

    /* B+C Fusion: Edge-Pinned Magnetic Two-Cell Tally Bookmark Strip */
    .edge-tally-dock {
      position: fixed;
      right: 0;
      top: 78%;
      height: 32px;
      display: inline-flex;
      align-items: stretch;
      background: #ffffff;
      color: #18181b;
      border: 1px solid #cbd5e1;
      border-right: none;
      border-radius: 6px 0 0 6px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12), 0 1px 3px rgba(15, 23, 42, 0.06);
      font-size: 12px;
      line-height: 1;
      pointer-events: auto;
      user-select: none;
      overflow: hidden;
      will-change: transform, opacity;
      transform: translate3d(var(--collapsed-shift, 0px), -50%, 0);
      transition:
        transform var(--spring-width),
        opacity 160ms ease,
        box-shadow 180ms ease;
    }
    .edge-tally-dock[data-side="left"] {
      right: auto;
      left: 0;
      border-right: 1px solid #cbd5e1;
      border-left: none;
      border-radius: 0 6px 6px 0;
      flex-direction: row-reverse;
      transform: translate3d(calc(-1 * var(--collapsed-shift, 0px)), -50%, 0);
    }
    .edge-tally-dock[data-expanded="true"],
    .edge-tally-dock:hover {
      transform: translate3d(0, -50%, 0);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08);
    }
    .edge-tally-dock[data-hidden="true"] {
      opacity: 0;
      pointer-events: none;
      transform: translate3d(100%, -50%, 0);
    }
    .edge-tally-dock[data-side="left"][data-hidden="true"] {
      transform: translate3d(-100%, -50%, 0);
    }
    .edge-tally-dock[data-pressing="true"] {
      box-shadow: 0 12px 28px rgba(37, 99, 235, 0.22);
    }

    /* Cell 1 (Always Exposed Tab Ear): Solid LIVE / HOLD Tally Switch */
    .tally-head-cell {
      display: inline-flex;
      align-items: stretch;
      height: 100%;
      flex-shrink: 0;
    }
    .tally-mode-btn {
      appearance: none;
      border: none;
      margin: 0;
      height: 100%;
      min-width: 50px;
      padding: 0 9px;
      background: #2563eb;
      color: #ffffff;
      font: 700 11px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 150ms ease, filter 150ms ease;
    }
    .tally-mode-btn:hover {
      filter: brightness(1.08);
    }
    .tally-mode-btn:active {
      filter: brightness(0.95);
    }
    .tally-mode-btn[data-mode="shared"] {
      background: #059669;
    }
    .tally-mode-btn[data-mode="paused"] {
      background: #d97706;
    }
    .tally-mode-btn[data-mode="confirm"] {
      background: #dc2626;
    }

    .grip-handle {
      width: 12px;
      height: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      border-left: 1px solid #e2e8f0;
      border-right: 1px solid #e2e8f0;
      cursor: grab;
      flex-shrink: 0;
    }
    .grip-handle:active {
      cursor: grabbing;
      background: #eff6ff;
    }
    .grip-dots {
      width: 2px;
      height: 12px;
      border-radius: 1px;
      background: #94a3b8;
    }

    /* Cell 2 (Slide-out Drawer Body): Crisp White Porcelain Status & Actions */
    .drawer-body {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 100%;
      padding: 0 8px 0 9px;
      white-space: nowrap;
      background: #ffffff;
    }
    .status-label {
      color: #27272a;
      font-size: 12px;
      font-weight: 500;
      max-width: 210px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-label[data-alert="true"] {
      color: #1d4ed8;
      font-weight: 600;
    }

    .action-cluster {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .flat-btn {
      appearance: none;
      border: 1px solid #e4e4e7;
      border-radius: 4px;
      height: 22px;
      padding: 0 8px;
      background: #f8fafc;
      color: #3f3f46;
      font: 500 11px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .flat-btn:hover {
      background: #fef2f2;
      color: #dc2626;
      border-color: #fecaca;
    }
    .flat-btn[data-kind="ghost"] {
      background: transparent;
      color: #52525b;
    }
    .flat-btn[data-kind="ghost"]:hover {
      background: #f4f4f5;
      color: #18181b;
      border-color: #d4d4d8;
    }
    .flat-btn[data-kind="danger"] {
      background: #dc2626;
      color: #ffffff;
      border-color: #dc2626;
      font-weight: 600;
    }
    .flat-btn[data-kind="danger"]:hover {
      background: #b91c1c;
      border-color: #b91c1c;
      color: #ffffff;
    }

    .hidden-el {
      display: none !important;
    }

    .ripple-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }
    .coord-ring {
      position: absolute;
      width: 24px;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      border-radius: 4px;
      border: 2px solid #2563eb;
      background: rgba(37, 99, 235, 0.08);
      animation: expandSquare 0.38s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes expandSquare {
      0% { transform: scale(0.4); opacity: 0.95; }
      100% { transform: scale(1.65); opacity: 0; }
    }

    .collab-cursor {
      position: fixed;
      left: 0;
      top: 0;
      pointer-events: none;
      z-index: 2;
      opacity: 0;
      transform: translate3d(50vw, 50vh, 0);
      transition:
        transform 240ms cubic-bezier(0.22, 1, 0.36, 1),
        opacity 180ms ease;
      will-change: transform, opacity;
    }
    .collab-cursor[data-visible="true"] {
      opacity: 1;
    }
    .collab-cursor[data-instant="true"] {
      transition: opacity 180ms ease;
    }
    .collab-cursor-inner {
      position: relative;
      transform-origin: 3px 3px;
      transition: transform 120ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .collab-cursor[data-pressed="true"] .collab-cursor-inner {
      transform: scale(0.84);
    }
    .collab-dart-svg {
      width: 22px;
      height: 22px;
      display: block;
      filter: drop-shadow(0 2px 5px rgba(15, 23, 42, 0.28));
      transform: translate(-2px, -2px);
    }
    .collab-dart-svg path {
      fill: #2563eb;
      stroke: #ffffff;
      stroke-width: 1.75;
      stroke-linejoin: round;
    }
    .collab-cursor-pill {
      position: absolute;
      left: 15px;
      top: 14px;
      padding: 2px 7px;
      border-radius: 4px;
      background: #ffffff;
      border: 1px solid #2563eb;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16);
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        --spring-width: 140ms ease;
        --spring-pop: 120ms ease;
      }
      .director-topline[data-state="working"] .director-topline-runner {
        animation: none;
        width: 100%;
        transform: none;
      }
    }

    @media print {
      :host {
        display: none !important;
      }
    }
  `;

  class ChromeLiveHud {
    constructor() {
      this._hudRev = CURRENT_HUD_REV;
      this._cleanups = [];
      this._flashTimer = null;
      this._confirmTimer = null;
      this._hoverCollapseTimer = null;
      this._cursorIdleTimer = null;
      this._cursorPressTimer = null;
      this._cursorPlaced = false;
      this._wasVisible = false;
      this._pointerInsideDock = false;
      const defaultLang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
      const initSide = inheritedDock === 'left' ? 'left' : 'right';
      const initTopPct =
        typeof inheritedTopPct === 'number' && Number.isFinite(inheritedTopPct)
          ? Math.min(90, Math.max(12, inheritedTopPct))
          : 78;
      this._state = {
        lang: defaultLang,
        visible: false,
        mode: 'working', // 'working' | 'shared' | 'paused' | 'done'
        activity: DICT[defaultLang].ready,
        flashText: '',
        confirmingDisconnect: false,
        dock: initSide,
        topPct: initTopPct,
        userActionQueue: []
      };
      this._mount();
    }

    _t() {
      return DICT[this._state.lang] || DICT.en;
    }

    _mount() {
      const svgNs = 'http://www.w3.org/2000/svg';
      this.hostEl = document.createElement('div');
      this.hostEl.setAttribute(
        'style',
        'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
      );
      this.shadow = this.hostEl.attachShadow({ mode: 'closed' });

      const styleEl = document.createElement('style');
      styleEl.textContent = STYLESHEET;

      this.shieldEl = document.createElement('div');
      this.shieldEl.className = 'lock-shield';

      // Top 2.5px Solid Director Line
      this.borderEl = document.createElement('div');
      this.borderEl.className = 'director-topline';
      const runnerEl = document.createElement('div');
      runnerEl.className = 'director-topline-runner';
      this.borderEl.appendChild(runnerEl);

      this.rippleLayer = document.createElement('div');
      this.rippleLayer.className = 'ripple-layer';

      // Smooth collaboration cursor + white porcelain tag
      this.cursorEl = document.createElement('div');
      this.cursorEl.className = 'collab-cursor';
      this.cursorEl.dataset.visible = 'false';
      const cursorInner = document.createElement('div');
      cursorInner.className = 'collab-cursor-inner';
      const dartSvg = document.createElementNS(svgNs, 'svg');
      dartSvg.setAttribute('viewBox', '0 0 24 24');
      dartSvg.setAttribute('class', 'collab-dart-svg');
      const dartPath = document.createElementNS(svgNs, 'path');
      dartPath.setAttribute('d', COLLAB_DART_PATH);
      dartSvg.appendChild(dartPath);
      this.cursorPillEl = document.createElement('span');
      this.cursorPillEl.className = 'collab-cursor-pill';
      this.cursorPillEl.textContent = this._t().cursorMove;
      cursorInner.append(dartSvg, this.cursorPillEl);
      this.cursorEl.appendChild(cursorInner);

      // B+C Edge-Pinned Magnetic Tally Strip
      this.capsuleEl = document.createElement('div');
      this.capsuleEl.className = 'edge-tally-dock';
      this.capsuleEl.dataset.hidden = 'true';
      this.capsuleEl.dataset.side = this._state.dock;
      this.capsuleEl.dataset.expanded = 'false';

      this.headCellEl = document.createElement('div');
      this.headCellEl.className = 'tally-head-cell';

      // Exposed Tally Mode Button (`LIVE` / `HOLD`) acts directly as `pauseBtn` for 1-click toggle!
      this.pauseBtn = document.createElement('button');
      this.pauseBtn.type = 'button';
      this.pauseBtn.className = 'tally-mode-btn';
      this.pauseBtn.textContent = this._t().badgeLive;

      this.gripEl = document.createElement('div');
      this.gripEl.className = 'grip-handle';
      this.gripEl.title = this._t().dragTip;
      const gripDots = document.createElement('span');
      gripDots.className = 'grip-dots';
      this.gripEl.appendChild(gripDots);

      this.headCellEl.append(this.pauseBtn, this.gripEl);

      // Slide-out White Porcelain Drawer Body
      this.drawerEl = document.createElement('div');
      this.drawerEl.className = 'drawer-body';

      this.labelEl = document.createElement('span');
      this.labelEl.className = 'status-label';
      this.labelEl.textContent = this._t().ready;

      this.normalActionsEl = document.createElement('div');
      this.normalActionsEl.className = 'action-cluster';

      this.closeBtn = document.createElement('button');
      this.closeBtn.type = 'button';
      this.closeBtn.className = 'flat-btn';
      this.closeBtn.textContent = this._t().disconnectLabel;
      this.normalActionsEl.appendChild(this.closeBtn);

      this.confirmActionsEl = document.createElement('div');
      this.confirmActionsEl.className = 'action-cluster hidden-el';

      this.cancelConfirmBtn = document.createElement('button');
      this.cancelConfirmBtn.type = 'button';
      this.cancelConfirmBtn.className = 'flat-btn';
      this.cancelConfirmBtn.dataset.kind = 'ghost';
      this.cancelConfirmBtn.textContent = this._t().cancelBtn;

      this.confirmDisconnectBtn = document.createElement('button');
      this.confirmDisconnectBtn.type = 'button';
      this.confirmDisconnectBtn.className = 'flat-btn';
      this.confirmDisconnectBtn.dataset.kind = 'danger';
      this.confirmDisconnectBtn.textContent = this._t().disconnectBtn;

      this.confirmActionsEl.append(this.cancelConfirmBtn, this.confirmDisconnectBtn);
      this.drawerEl.append(this.labelEl, this.normalActionsEl, this.confirmActionsEl);
      this.capsuleEl.append(this.headCellEl, this.drawerEl);

      this.shadow.append(
        styleEl,
        this.shieldEl,
        this.borderEl,
        this.rippleLayer,
        this.cursorEl,
        this.capsuleEl
      );

      this._bindInteractions();
      (document.documentElement || document.body).appendChild(this.hostEl);
    }

    _clearConfirmState() {
      if (this._confirmTimer) {
        clearTimeout(this._confirmTimer);
        this._confirmTimer = null;
      }
      this._state.confirmingDisconnect = false;
    }

    _flashMessage(msg, durationMs = 2200) {
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._state.flashText = msg;
      this._render();
      this._flashTimer = setTimeout(() => {
        this._flashTimer = null;
        this._state.flashText = '';
        this._render();
      }, durationMs);
    }

    _notifyBackground(eventName) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          chrome.runtime.sendMessage({ type: 'hud:user_event', event: eventName }).catch(() => {
            this._state.userActionQueue.push(eventName);
          });
          return;
        }
      } catch {}
      this._state.userActionQueue.push(eventName);
    }

    _switchToManualNow() {
      this._clearConfirmState();
      this._state.userPausedLock = true;
      this._state.mode = 'paused';
      this._state.activity = this._t().pausedByUser;
      this._state.flashText = '';
      this._notifyBackground('pause');
      this._render();
    }

    _bindInteractions() {
      const selfDestructIfOrphan = () => {
        if (!isExtensionContextValid()) {
          this.destroy();
          return true;
        }
        return false;
      };

      const onPauseClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        const nextPaused = this._state.mode !== 'paused';
        this._state.userPausedLock = nextPaused;
        this._state.mode = nextPaused ? 'paused' : 'working';
        this._state.activity = nextPaused ? this._t().pausedByUser : this._t().resumed;
        this._state.flashText = '';
        this._notifyBackground(nextPaused ? 'pause' : 'resume');
        this._render();
      };

      const onCloseAskClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        this._state.confirmingDisconnect = true;
        this._render();
        this._confirmTimer = setTimeout(() => {
          this._confirmTimer = null;
          if (this._state.confirmingDisconnect) {
            this._state.confirmingDisconnect = false;
            this._render();
          }
        }, 4500);
      };

      const onCancelConfirmClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        this._render();
      };

      const onConfirmReleaseClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        this._state.userPausedLock = true;
        this._state.mode = 'paused';
        this._state.visible = false;
        this._notifyBackground('release');
        this._render();
      };

      // Double-click anywhere on locked page OR press `Esc` -> instant manual takeover!
      let lastTapAt = 0;
      let lastTapX = 0;
      let lastTapY = 0;

      const onShieldPointerDown = (ev) => {
        if (!ev.isTrusted) return;
        if (ev._cliveShieldDone) return;
        ev._cliveShieldDone = true;
        if (selfDestructIfOrphan()) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.button !== 0 || this._state.mode !== 'working') return;

        const now = performance.now();
        const dist = Math.hypot(ev.clientX - lastTapX, ev.clientY - lastTapY);
        if (lastTapAt > 0 && now - lastTapAt <= DBL_TAP_WINDOW_MS && dist <= DBL_TAP_MAX_DIST_PX) {
          lastTapAt = 0;
          this._switchToManualNow();
          return;
        }
        lastTapAt = now;
        lastTapX = ev.clientX;
        lastTapY = ev.clientY;
        this._flashMessage(this._t().lockedTapHint, 2200);
      };

      const swallowLockedEvent = (ev) => {
        if (selfDestructIfOrphan()) return;
        if (this._state.visible && this._state.mode === 'working') {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      const onEscKeyDown = (ev) => {
        if (!ev || !ev.isTrusted) return;
        if (selfDestructIfOrphan()) return;
        if (this._state.visible && this._state.mode === 'working' && ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          this._switchToManualNow();
        }
      };

      // Hover slide-out & auto-collapse on edge dock
      const onDockEnter = (ev) => {
        if (ev && !ev.isTrusted) return;
        if (this._hoverCollapseTimer) {
          clearTimeout(this._hoverCollapseTimer);
          this._hoverCollapseTimer = null;
        }
        this._pointerInsideDock = true;
        this._render();
      };

      const onDockLeave = (ev) => {
        if (ev && !ev.isTrusted) return;
        this._pointerInsideDock = false;
        if (this._hoverCollapseTimer) clearTimeout(this._hoverCollapseTimer);
        this._hoverCollapseTimer = setTimeout(() => {
          this._hoverCollapseTimer = null;
          this._render();
        }, 280);
      };

      // Vertical reposition & left/right edge snap via grip handle
      let dragging = false;
      let dragPointerId = null;
      let dragStartX = 0;
      let dragStartY = 0;

      const onGripDown = (ev) => {
        if (!ev.isTrusted || ev._cliveGripDone || ev.button !== 0) return;
        ev._cliveGripDone = true;
        dragging = true;
        dragPointerId = ev.pointerId;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        this.capsuleEl.dataset.pressing = 'true';
        try {
          this.gripEl.setPointerCapture(ev.pointerId);
        } catch {}
      };

      const onGripMove = (ev) => {
        if (!dragging || (dragPointerId !== null && ev.pointerId !== dragPointerId)) return;
        const vh = Math.max(200, window.innerHeight || 800);
        const pct = Math.min(90, Math.max(12, (ev.clientY / vh) * 100));
        this._state.topPct = Math.round(pct * 10) / 10;
        this.capsuleEl.style.top = `${this._state.topPct}%`;
      };

      const onGripUp = (ev) => {
        if (!dragging || (dragPointerId !== null && ev.pointerId !== dragPointerId)) return;
        dragging = false;
        dragPointerId = null;
        this.capsuleEl.dataset.pressing = 'false';
        try {
          this.gripEl.releasePointerCapture(ev.pointerId);
        } catch {}
        if (Math.hypot(ev.clientX - dragStartX, ev.clientY - dragStartY) < 6) {
          return;
        }
        const vw = Math.max(320, window.innerWidth || 1280);
        const vh = Math.max(200, window.innerHeight || 800);
        this._state.dock = ev.clientX < vw * 0.45 ? 'left' : 'right';
        this._state.topPct = Math.round(Math.min(90, Math.max(12, (ev.clientY / vh) * 100)) * 10) / 10;
        this._render();
      };

      const onGripCancel = (ev) => {
        if (!dragging || (dragPointerId !== null && ev.pointerId !== dragPointerId)) return;
        dragging = false;
        dragPointerId = null;
        this.capsuleEl.dataset.pressing = 'false';
        try {
          this.gripEl.releasePointerCapture(ev.pointerId);
        } catch {}
      };

      const hitHudBox = (elBox, visible) => {
        if (!visible || !elBox || typeof elBox.getBoundingClientRect !== 'function') return false;
        if (typeof evClientX !== 'number' || typeof evClientY !== 'number') return false;
        const r = elBox.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          evClientX >= r.left &&
          evClientX <= r.right &&
          evClientY >= r.top &&
          evClientY <= r.bottom
        );
      };
      const hitHudButton = hitHudBox;
      let evClientX = null;
      let evClientY = null;

      // Guard HUD host interactions in window capture phase (via `document_start` slot 0 when available)
      // so hostile page `window.addEventListener(..., e => e.stopImmediatePropagation(), true)` can never lock out
      // LIVE/HOLD mode switch, Detach confirmation, dock drag, or double-click unlock!
      const captureHostGuard = (ev) => {
        if (!ev || !ev.isTrusted || ev._cliveHandled) return;
        const evtType = ev.type;
        if (evtType === 'pointermove') {
          if (dragging && dragPointerId !== null && ev.pointerId === dragPointerId) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onGripMove(ev);
          }
          return;
        }
        if (evtType === 'pointerup' || evtType === 'pointercancel') {
          if (dragging && dragPointerId !== null && ev.pointerId === dragPointerId) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            if (evtType === 'pointerup') onGripUp(ev);
            else onGripCancel(ev);
            return;
          }
        }

        if (typeof ev.composedPath !== 'function') return;
        const pathNodes = ev.composedPath();
        if (!pathNodes || !pathNodes.includes(this.hostEl)) return;
        const topTarget = pathNodes[0];
        evClientX = typeof ev.clientX === 'number' ? ev.clientX : null;
        evClientY = typeof ev.clientY === 'number' ? ev.clientY : null;
        const isConfirming = Boolean(this._state.confirmingDisconnect);
        const onPauseToggle =
          topTarget === this.pauseBtn || this.pauseBtn.contains(topTarget) || hitHudButton(this.pauseBtn, true);
        const onActiveBtn = isConfirming
          ? onPauseToggle ||
            topTarget === this.cancelConfirmBtn ||
            this.cancelConfirmBtn.contains(topTarget) ||
            hitHudButton(this.cancelConfirmBtn, true) ||
            topTarget === this.confirmDisconnectBtn ||
            this.confirmDisconnectBtn.contains(topTarget) ||
            hitHudButton(this.confirmDisconnectBtn, true)
          : onPauseToggle ||
            topTarget === this.closeBtn ||
            this.closeBtn.contains(topTarget) ||
            hitHudButton(this.closeBtn, true);
        const onGrip =
          topTarget === this.gripEl || this.gripEl.contains(topTarget) || hitHudBox(this.gripEl, this._state.visible);
        const onDockCard =
          topTarget === this.capsuleEl ||
          this.capsuleEl.contains(topTarget) ||
          hitHudBox(this.capsuleEl, this._state.visible);
        const onLockedShield = Boolean(this._state.visible && this._state.mode === 'working');

        if (evtType === 'pointerdown') {
          if (onActiveBtn) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            return;
          }
          if (onGrip) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onGripDown(ev);
            return;
          }
          if (onDockCard) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            return;
          }
          if (onLockedShield) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onShieldPointerDown(ev);
          }
          return;
        }

        if (evtType === 'pointerup' || evtType === 'pointercancel' || evtType === 'mousedown' || evtType === 'mouseup') {
          if (onActiveBtn || onGrip || onDockCard || onLockedShield) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
          }
          return;
        }

        if (evtType === 'contextmenu') {
          if (onActiveBtn || onGrip || onDockCard || onLockedShield) {
            ev._cliveHandled = true;
            ev.preventDefault?.();
            ev.stopImmediatePropagation?.();
          }
          return;
        }

        if (evtType === 'click') {
          if (onPauseToggle) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onPauseClick(ev);
          } else if (
            !isConfirming &&
            (topTarget === this.closeBtn || this.closeBtn.contains(topTarget) || hitHudButton(this.closeBtn, true))
          ) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onCloseAskClick(ev);
          } else if (
            isConfirming &&
            (topTarget === this.cancelConfirmBtn ||
              this.cancelConfirmBtn.contains(topTarget) ||
              hitHudButton(this.cancelConfirmBtn, true))
          ) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onCancelConfirmClick(ev);
          } else if (
            isConfirming &&
            (topTarget === this.confirmDisconnectBtn ||
              this.confirmDisconnectBtn.contains(topTarget) ||
              hitHudButton(this.confirmDisconnectBtn, true))
          ) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onConfirmReleaseClick(ev);
          } else if (onGrip || onDockCard || onLockedShield) {
            ev._cliveHandled = true;
            ev.preventDefault?.();
            ev.stopImmediatePropagation?.();
          }
        }
      };

      const CAPTURE_GUARD_EVENTS = [
        'click',
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'mousedown',
        'mouseup',
        'contextmenu'
      ];
      const usedEarlyGuard = typeof window.__CLIVE_SET_CAPTURE_GUARD__ === 'function';
      if (usedEarlyGuard) {
        window.__CLIVE_SET_CAPTURE_GUARD__(captureHostGuard);
      } else {
        for (const tName of CAPTURE_GUARD_EVENTS) {
          window.addEventListener(tName, captureHostGuard, true);
        }
      }

      window.addEventListener('keydown', onEscKeyDown, true);
      this.capsuleEl.addEventListener('pointerenter', onDockEnter);
      this.capsuleEl.addEventListener('pointerleave', onDockLeave);
      this.pauseBtn.addEventListener('click', onPauseClick);
      this.closeBtn.addEventListener('click', onCloseAskClick);
      this.cancelConfirmBtn.addEventListener('click', onCancelConfirmClick);
      this.confirmDisconnectBtn.addEventListener('click', onConfirmReleaseClick);
      this.shieldEl.addEventListener('pointerdown', onShieldPointerDown, true);
      this.shieldEl.addEventListener('contextmenu', swallowLockedEvent, true);
      this.shieldEl.addEventListener('wheel', swallowLockedEvent, { passive: false, capture: true });
      this.gripEl.addEventListener('pointerdown', onGripDown, true);
      this.gripEl.addEventListener('pointermove', onGripMove, true);
      this.gripEl.addEventListener('pointerup', onGripUp, true);
      this.gripEl.addEventListener('pointercancel', onGripCancel, true);

      this._cleanups.push(() => {
        this._clearConfirmState();
        if (this._flashTimer) clearTimeout(this._flashTimer);
        if (this._hoverCollapseTimer) clearTimeout(this._hoverCollapseTimer);
        if (this._cursorIdleTimer) clearTimeout(this._cursorIdleTimer);
        if (this._cursorPressTimer) clearTimeout(this._cursorPressTimer);
        if (usedEarlyGuard && typeof window.__CLIVE_SET_CAPTURE_GUARD__ === 'function') {
          window.__CLIVE_SET_CAPTURE_GUARD__(null);
        } else {
          for (const tName of CAPTURE_GUARD_EVENTS) {
            window.removeEventListener(tName, captureHostGuard, true);
          }
        }
        window.removeEventListener('keydown', onEscKeyDown, true);
        this.capsuleEl.removeEventListener('pointerenter', onDockEnter);
        this.capsuleEl.removeEventListener('pointerleave', onDockLeave);
        this.pauseBtn.removeEventListener('click', onPauseClick);
        this.closeBtn.removeEventListener('click', onCloseAskClick);
        this.cancelConfirmBtn.removeEventListener('click', onCancelConfirmClick);
        this.confirmDisconnectBtn.removeEventListener('click', onConfirmReleaseClick);
        this.shieldEl.removeEventListener('pointerdown', onShieldPointerDown, true);
        this.shieldEl.removeEventListener('contextmenu', swallowLockedEvent, true);
        this.shieldEl.removeEventListener('wheel', swallowLockedEvent, true);
        this.gripEl.removeEventListener('pointerdown', onGripDown, true);
        this.gripEl.removeEventListener('pointermove', onGripMove, true);
        this.gripEl.removeEventListener('pointerup', onGripUp, true);
        this.gripEl.removeEventListener('pointercancel', onGripCancel, true);
      });
    }

    _syncCollapsedShift() {
      const drawerW = Math.ceil(this.drawerEl.offsetWidth || 0);
      if (drawerW > 0) {
        this.capsuleEl.style.setProperty('--collapsed-shift', `${drawerW}px`);
      }
    }

    _render() {
      if (!this.hostEl.isConnected && document.documentElement) {
        document.documentElement.appendChild(this.hostEl);
      }
      const t = this._t();
      this.gripEl.title = t.dragTip;
      this.closeBtn.textContent = t.disconnectLabel;
      this.closeBtn.title = t.closeTip;
      this.cancelConfirmBtn.textContent = t.cancelBtn;
      this.confirmDisconnectBtn.textContent = t.disconnectBtn;

      if (!this._state.visible) {
        this._wasVisible = false;
        this._clearConfirmState();
        this.capsuleEl.dataset.hidden = 'true';
        this.cursorEl.dataset.visible = 'false';
        this.shieldEl.dataset.locked = 'false';
        this.borderEl.removeAttribute('data-state');
        return;
      }

      const isLockedWorking = this._state.mode === 'working';
      const isPaused = this._state.mode === 'paused';
      this.shieldEl.dataset.locked = String(isLockedWorking);

      const side = this._state.dock === 'left' ? 'left' : 'right';
      this.capsuleEl.dataset.side = side;
      this.capsuleEl.style.top = `${this._state.topPct}%`;
      this.borderEl.dataset.state = this._state.mode;

      this.pauseBtn.textContent = isPaused ? t.badgeHold : this._state.mode === 'shared' ? t.badgeShared : t.badgeLive;
      this.pauseBtn.title = isPaused ? t.resumeTip : t.pauseTip;
      this.pauseBtn.dataset.mode = this._state.confirmingDisconnect ? 'confirm' : this._state.mode;

      if (this._state.confirmingDisconnect) {
        this.labelEl.textContent = t.confirmAsk;
        this.labelEl.dataset.alert = 'false';
        this.normalActionsEl.classList.add('hidden-el');
        this.confirmActionsEl.classList.remove('hidden-el');
      } else {
        this.labelEl.textContent = this._state.flashText || this._state.activity || t.ready;
        this.labelEl.dataset.alert = String(Boolean(this._state.flashText));
        this.normalActionsEl.classList.remove('hidden-el');
        this.confirmActionsEl.classList.add('hidden-el');
      }

      const shouldExpand = Boolean(
        this._pointerInsideDock || this._state.confirmingDisconnect || this._state.flashText
      );
      this.capsuleEl.dataset.expanded = String(shouldExpand);

      this._wasVisible = true;
      this._syncCollapsedShift();
      this.capsuleEl.dataset.hidden = 'false';
    }

    update(payload = {}) {
      if (payload.lang === 'zh' || payload.lang === 'en') {
        this._state.lang = payload.lang;
      }
      if (payload.clearUserPauseLock === true) {
        this._state.userPausedLock = false;
      }
      if (typeof payload.visible === 'boolean') this._state.visible = payload.visible;
      if (typeof payload.mode === 'string') {
        if (payload.mode === 'paused') {
          this._state.mode = 'paused';
        } else if (!this._state.userPausedLock) {
          this._state.mode = payload.mode;
        }
        this._clearConfirmState();
        // Never wipe userActionQueue inside update(); only drainUserEvents() may consume queued user gestures!
      }
      if (typeof payload.activity === 'string' && (!this._state.userPausedLock || payload.mode === 'paused')) {
        this._state.activity = payload.activity;
        this._state.flashText = '';
      }
      if (payload.dock === 'left' || payload.dock === 'right') {
        this._state.dock = payload.dock;
      }
      this._render();
      return { ok: true, mode: this._state.mode, lang: this._state.lang };
    }

    moveCursor(opts = {}) {
      const x = Number(opts.x);
      const y = Number(opts.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };

      const t = this._t();
      const kind = String(opts.kind || 'click');
      this.cursorPillEl.textContent =
        kind === 'type'
          ? t.cursorType
          : kind === 'upload'
            ? t.cursorUpload
            : kind === 'scroll'
              ? t.cursorScroll
              : kind === 'click'
                ? t.cursorClick
                : t.cursorMove;

      if (!this._cursorPlaced) {
        const startX = Math.round((window.innerWidth || 1200) * 0.5);
        const startY = Math.round((window.innerHeight || 800) * 0.58);
        this.cursorEl.dataset.instant = 'true';
        this.cursorEl.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
        void this.cursorEl.offsetWidth;
        this.cursorEl.dataset.instant = 'false';
        this._cursorPlaced = true;
      }

      this.cursorEl.dataset.visible = 'true';
      this.cursorEl.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;

      if (this._cursorPressTimer) clearTimeout(this._cursorPressTimer);
      if (opts.press !== false) {
        this._cursorPressTimer = setTimeout(() => {
          this.cursorEl.dataset.pressed = 'true';
          this.pulseAt({ x, y });
          setTimeout(() => {
            this.cursorEl.dataset.pressed = 'false';
          }, 140);
        }, 220);
      }

      if (this._cursorIdleTimer) clearTimeout(this._cursorIdleTimer);
      this._cursorIdleTimer = setTimeout(() => {
        this._cursorIdleTimer = null;
        this.cursorEl.dataset.visible = 'false';
      }, 2200);

      return { ok: true };
    }

    pulseAt(coords = {}) {
      const x = Number(coords.x);
      const y = Number(coords.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const ring = document.createElement('div');
      ring.className = 'coord-ring';
      ring.style.left = `${Math.round(x)}px`;
      ring.style.top = `${Math.round(y)}px`;
      this.rippleLayer.appendChild(ring);
      setTimeout(() => {
        ring.remove();
      }, 420);
    }

    drainUserEvents() {
      const copy = this._state.userActionQueue.splice(0, this._state.userActionQueue.length);
      return { events: copy, mode: this._state.mode, visible: this._state.visible };
    }

    ping() {
      return isExtensionContextValid() && Boolean(this.hostEl && this.hostEl.isConnected);
    }

    destroy() {
      for (const fn of this._cleanups.splice(0)) {
        try {
          fn();
        } catch {}
      }
      this.hostEl.remove();
      delete window[REGISTRY_SYMBOL];
    }
  }

  window[REGISTRY_SYMBOL] = new ChromeLiveHud();
})();
