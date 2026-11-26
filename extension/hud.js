(function initChromeLiveHud() {
  'use strict';

  if (window.top !== window) return;

  const REGISTRY_SYMBOL = '__chromeLiveHudController__';
  const CURRENT_HUD_REV = 15;
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

  let inheritedSide = '';
  let inheritedBottomPx = null;
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
        inheritedSide = window[REGISTRY_SYMBOL]._state?.dock || '';
        inheritedBottomPx = window[REGISTRY_SYMBOL]._state?.bottomPx ?? null;
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

  const HOLD_UNLOCK_MS = 3000;
  const FOREGROUND_AUTO_COLLAPSE_MS = 10000; // Wait 10s while tab is in foreground before gently tucking left
  const DEFAULT_BOTTOM_OFFSET_PX = 84; // Sits cleanly above inline monitor's bottom-left `LIVE · 0 Token` chip
  const RING_CIRCUMFERENCE = 2 * Math.PI * 20; // r = 20 -> ~125.66
  // Original rounded collaboration dart silhouette (zero overlap with classic OS arrow paths)
  const COLLAB_DART_PATH =
    'M2.4 2.4 L19.2 8.512 C20.9 9.1 21.0 11.573 19.3 12.2 L12.7 15.057 L9.9 21.647 C9.2 23.2 6.8 23.1 6.2 21.4 Z';

  const DICT = {
    zh: {
      dragTip: '上下拖动调整高度，或拖至左/右边缘贴壁停靠',
      ready: '按住左键 3 秒解锁',
      doneText: '任务已完成',
      pausedByUser: '已解锁 · 手动操控中',
      resumed: '已恢复防误触锁定',
      badgeLive: 'LIVE',
      badgeHold: 'HOLD',
      badgeShared: 'LIVE',
      pauseTip: '点击立即解锁切为手动（或在页面按住左键满 3 秒解锁）',
      resumeTip: '点击恢复 AI 防误触锁定操控',
      peekTip: '移入或点击向右展开控制栏',
      disconnectLabel: '断开',
      closeTip: '释放此标签页控制权（不关闭网页）',
      confirmAsk: '断开此页受控？',
      cancelBtn: '取消',
      disconnectBtn: '确认断开',
      lockedTapHint: '已防误触锁定 · 按住左键 3 秒解锁',
      holdingHint: '继续按住解锁',
      cursorClick: '点击',
      cursorType: '输入',
      cursorUpload: '上传',
      cursorScroll: '滚动',
      cursorMove: '定位'
    },
    en: {
      dragTip: 'Drag vertically to adjust height, or drag across to snap left/right edge',
      ready: 'Hold left-click 3s to unlock',
      doneText: 'Completed',
      pausedByUser: 'Unlocked · Manual mode',
      resumed: 'Resumed locked control',
      badgeLive: 'LIVE',
      badgeHold: 'HOLD',
      badgeShared: 'LIVE',
      pauseTip: 'Click to unlock manual mode (or hold left-click 3s on page)',
      resumeTip: 'Click to resume AI locked control',
      peekTip: 'Hover or click to expand controls',
      disconnectLabel: 'Detach',
      closeTip: 'Detach this tab without closing it',
      confirmAsk: 'Detach this tab?',
      cancelBtn: 'Cancel',
      disconnectBtn: 'Confirm',
      lockedTapHint: 'Page locked · Hold left-click 3s to unlock',
      holdingHint: 'Hold to unlock',
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
      --collapse-slow: 900ms cubic-bezier(0.22, 1, 0.36, 1);
      --spring-pop: 260ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Original Circle-Slash Anti-Misclick Lock Shield */
    .lock-shield {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: transparent;
      cursor: not-allowed;
      display: none;
    }
    .lock-shield[data-locked="true"] {
      display: block;
      pointer-events: auto;
    }

    /* Large 52px 3-Second Hold-to-Unlock Circular Ring Progress Indicator */
    .hold-badge {
      position: fixed;
      left: 0;
      top: 0;
      translate: -50% -124%;
      scale: 0.9;
      display: inline-flex;
      align-items: center;
      gap: 13px;
      padding: 10px 22px 10px 12px;
      border-radius: 13px;
      background: #ffffff;
      border: 1.5px solid #cbd5e1;
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22), 0 3px 8px rgba(15, 23, 42, 0.08);
      color: #18181b;
      font-size: 16px;
      font-weight: 600;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.14s ease, scale var(--spring-pop);
      white-space: nowrap;
    }
    .hold-badge[data-active="true"] {
      opacity: 1;
      scale: 1;
    }
    .hold-ring-wrap {
      position: relative;
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .hold-ring-svg {
      width: 52px;
      height: 52px;
      transform: rotate(-90deg);
    }
    .hold-ring-track {
      fill: rgba(37, 99, 235, 0.07);
      stroke: #dbeafe;
      stroke-width: 3.9;
    }
    .hold-ring-bar {
      fill: none;
      stroke: #2563eb;
      stroke-width: 3.9;
      stroke-linecap: round;
      stroke-dasharray: 125.66;
      stroke-dashoffset: 125.66;
    }
    .hold-sec-num {
      position: absolute;
      font-size: 18px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #1d4ed8;
    }

    /* Top 3px Solid Director Line (Zero 4-side blur glow) */
    .director-topline {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
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
      height: 2.5px;
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

    /* High-Visibility 60px Left-Edge Dock Positioned Above Bottom-Left Screencast Chip (bottom: 84px) */
    .edge-tally-dock {
      position: fixed;
      left: 0;
      bottom: 84px;
      height: 60px;
      max-width: calc(100vw - 16px);
      display: inline-flex;
      align-items: stretch;
      background: #ffffff;
      color: #18181b;
      border: 1.5px solid #cbd5e1;
      border-left: none;
      border-radius: 0 14px 14px 0;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08);
      font-size: 16.5px;
      line-height: 1;
      pointer-events: auto;
      user-select: none;
      overflow: hidden;
      scale: 1;
      transition:
        scale var(--spring-pop),
        opacity 180ms ease,
        box-shadow 220ms ease;
    }
    .edge-tally-dock[data-side="right"] {
      left: auto;
      right: 0;
      border-left: 1.5px solid #cbd5e1;
      border-right: none;
      border-radius: 14px 0 0 14px;
      flex-direction: row-reverse;
    }
    .edge-tally-dock[data-hidden="true"] {
      opacity: 0;
      scale: 0.92;
      pointer-events: none;
    }
    .edge-tally-dock[data-pressing="true"] {
      scale: 0.98;
      box-shadow: 0 16px 34px rgba(37, 99, 235, 0.25);
    }

    /* Always-Visible Large Head Badge: 32px Circle-Lock Icon + Bold 17.5px LIVE / HOLD */
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
      padding: 0 22px 0 18px;
      background: #2563eb;
      color: #ffffff;
      font: 700 17.5px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: background-color 160ms ease, filter 160ms ease;
    }
    .tally-mode-btn:hover {
      filter: brightness(1.07);
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
    .tally-lock-svg {
      width: 32px;
      height: 32px;
      display: block;
      flex-shrink: 0;
    }

    /* Smooth Collapsible Drawer Shell (Tucks gently toward left edge after 10s in foreground) */
    .drawer-shell {
      display: inline-flex;
      align-items: stretch;
      height: 100%;
      overflow: hidden;
      width: var(--drawer-w, auto);
      opacity: 1;
      transition:
        width var(--collapse-slow),
        opacity 560ms ease;
    }
    .edge-tally-dock[data-collapsed="true"] .drawer-shell {
      width: 0px !important;
      opacity: 0;
      pointer-events: none;
    }

    /* Obvious White Peek Ear When Tucked Left: Shows Clear Expand Chevron */
    .peek-ear {
      display: none;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 100%;
      background: #ffffff;
      color: #2563eb;
      cursor: pointer;
      flex-shrink: 0;
      transition: background-color 150ms ease, color 150ms ease;
    }
    .peek-ear:hover {
      background: #eff6ff;
    }
    .edge-tally-dock[data-collapsed="true"] .peek-ear {
      display: inline-flex;
    }
    .peek-ear svg {
      width: 20px;
      height: 20px;
      display: block;
      transition: transform 200ms ease;
    }
    .edge-tally-dock[data-side="right"] .peek-ear svg {
      transform: rotate(180deg);
    }

    .drawer-body {
      display: inline-flex;
      align-items: center;
      gap: 16px;
      height: 100%;
      padding: 0 16px 0 20px;
      white-space: nowrap;
      background: #ffffff;
    }
    .drag-grip {
      display: inline-flex;
      align-items: center;
      height: 100%;
      cursor: grab;
      min-width: 0;
    }
    .drag-grip:active {
      cursor: grabbing;
    }
    .status-label {
      color: #18181b;
      font-size: 16.5px;
      font-weight: 500;
      max-width: 310px;
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
      gap: 8px;
      flex-shrink: 0;
    }
    .flat-btn {
      appearance: none;
      border: 1px solid #d4d4d8;
      border-radius: 8px;
      height: 38px;
      padding: 0 16px;
      background: #f8fafc;
      color: #3f3f46;
      font: 500 14.5px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
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
      border-color: #a1a1aa;
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
      width: 30px;
      height: 30px;
      margin-left: -15px;
      margin-top: -15px;
      border-radius: 50%;
      border: 2px solid #2563eb;
      background: rgba(37, 99, 235, 0.08);
      animation: expandRing 0.38s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes expandRing {
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
      width: 28px;
      height: 28px;
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
      left: 18px;
      top: 17px;
      padding: 3.5px 10px;
      border-radius: 6px;
      background: #ffffff;
      border: 1px solid #2563eb;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16);
      color: #1d4ed8;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        --spring-width: 160ms ease;
        --collapse-slow: 240ms ease;
        --spring-pop: 140ms ease;
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

  // Crisp 24x24 Enlarged Circle-Lock SVG Paths (Rendered at 32x32px: Bold Circle + Clear Padlock)
  const LOCK_CLOSED_SVG_PATH =
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM9.2 10.6V8.7a2.8 2.8 0 0 1 5.6 0v1.9M8 10.6h8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-4.8a1 1 0 0 1 1-1Z';
  const LOCK_OPEN_SVG_PATH =
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM9.2 10.6V8.4a2.8 2.8 0 0 1 5.2-1.4M8 10.6h8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-4.8a1 1 0 0 1 1-1Z';

  class ChromeLiveHud {
    constructor() {
      this._hudRev = CURRENT_HUD_REV;
      this._cleanups = [];
      this._holdRaf = null;
      this._flashTimer = null;
      this._confirmTimer = null;
      this._fgCollapseTimer = null;
      this._cursorIdleTimer = null;
      this._cursorPressTimer = null;
      this._cursorPlaced = false;
      this._wasVisible = false;
      this._pointerInsideDock = false;
      this._collapsed = false;
      const defaultLang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
      const initSide = inheritedSide === 'right' || inheritedSide === 'bottom-right' || inheritedSide === 'top-right' ? 'right' : 'left';
      const initBottomPx =
        typeof inheritedBottomPx === 'number' && Number.isFinite(inheritedBottomPx)
          ? Math.max(16, inheritedBottomPx)
          : DEFAULT_BOTTOM_OFFSET_PX;
      this._state = {
        lang: defaultLang,
        visible: false,
        mode: 'working', // 'working' | 'shared' | 'paused' | 'done'
        activity: DICT[defaultLang].ready,
        flashText: '',
        confirmingDisconnect: false,
        dock: initSide,
        bottomPx: initBottomPx,
        userActionQueue: []
      };
      this._mount();
    }

    _t() {
      return DICT[this._state.lang] || DICT.en;
    }

    _normalizeActivityText(raw) {
      const t = this._t();
      const s = String(raw || '').trim();
      if (!s) return t.ready;
      if (s.toLowerCase() === 'done') return t.doneText;
      return s;
    }

    _isTabInForeground() {
      try {
        return document.visibilityState === 'visible' && !document.hidden;
      } catch {
        return true;
      }
    }

    _clearFgCollapseTimer() {
      if (this._fgCollapseTimer) {
        clearTimeout(this._fgCollapseTimer);
        this._fgCollapseTimer = null;
      }
    }

    // Expand badge & start 10-second foreground countdown (stays open while tab is in background!)
    _expandAndArmForegroundCollapse() {
      this._collapsed = false;
      this._clearFgCollapseTimer();
      if (
        !this._state.visible ||
        this._pointerInsideDock ||
        this._state.confirmingDisconnect ||
        !this._isTabInForeground()
      ) {
        return;
      }
      this._fgCollapseTimer = setTimeout(() => {
        this._fgCollapseTimer = null;
        if (
          this._state.visible &&
          !this._pointerInsideDock &&
          !this._state.confirmingDisconnect &&
          !this._state.flashText &&
          this._isTabInForeground()
        ) {
          this._collapsed = true;
          this._render();
        }
      }, FOREGROUND_AUTO_COLLAPSE_MS);
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

      // Top 3px Solid Director Line
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

      // Enlarged 52px 3-second left-click hold unlock circular ring indicator
      this.holdBadgeEl = document.createElement('div');
      this.holdBadgeEl.className = 'hold-badge';
      const ringWrap = document.createElement('div');
      ringWrap.className = 'hold-ring-wrap';
      const ringSvg = document.createElementNS(svgNs, 'svg');
      ringSvg.setAttribute('viewBox', '0 0 48 48');
      ringSvg.setAttribute('class', 'hold-ring-svg');
      const trackCircle = document.createElementNS(svgNs, 'circle');
      trackCircle.setAttribute('cx', '24');
      trackCircle.setAttribute('cy', '24');
      trackCircle.setAttribute('r', '20');
      trackCircle.setAttribute('class', 'hold-ring-track');
      this.holdBarCircle = document.createElementNS(svgNs, 'circle');
      this.holdBarCircle.setAttribute('cx', '24');
      this.holdBarCircle.setAttribute('cy', '24');
      this.holdBarCircle.setAttribute('r', '20');
      this.holdBarCircle.setAttribute('class', 'hold-ring-bar');
      ringSvg.append(trackCircle, this.holdBarCircle);

      this.holdSecEl = document.createElement('span');
      this.holdSecEl.className = 'hold-sec-num';
      this.holdSecEl.textContent = '3';
      ringWrap.append(ringSvg, this.holdSecEl);

      this.holdTextEl = document.createElement('span');
      this.holdTextEl.textContent = this._t().holdingHint;
      this.holdBadgeEl.append(ringWrap, this.holdTextEl);

      // High-Visibility 60px Left-Edge Tally Badge (`bottom: 84px`, clear of inline `LIVE · 0 Token` chip)
      this.capsuleEl = document.createElement('div');
      this.capsuleEl.className = 'edge-tally-dock';
      this.capsuleEl.dataset.hidden = 'true';
      this.capsuleEl.dataset.side = this._state.dock;
      this.capsuleEl.dataset.collapsed = 'false';

      this.headCellEl = document.createElement('div');
      this.headCellEl.className = 'tally-head-cell';

      this.pauseBtn = document.createElement('button');
      this.pauseBtn.type = 'button';
      this.pauseBtn.className = 'tally-mode-btn';

      const lockSvg = document.createElementNS(svgNs, 'svg');
      lockSvg.setAttribute('viewBox', '0 0 24 24');
      lockSvg.setAttribute('fill', 'none');
      lockSvg.setAttribute('stroke', 'currentColor');
      lockSvg.setAttribute('stroke-width', '2.15');
      lockSvg.setAttribute('stroke-linecap', 'round');
      lockSvg.setAttribute('stroke-linejoin', 'round');
      lockSvg.setAttribute('class', 'tally-lock-svg');
      this.lockIconPath = document.createElementNS(svgNs, 'path');
      this.lockIconPath.setAttribute('d', LOCK_CLOSED_SVG_PATH);
      lockSvg.appendChild(this.lockIconPath);

      this.tallyTextSpan = document.createElement('span');
      this.tallyTextSpan.textContent = this._t().badgeLive;
      this.pauseBtn.append(lockSvg, this.tallyTextSpan);
      this.headCellEl.appendChild(this.pauseBtn);

      // Collapsible Right Drawer Shell
      this.drawerShellEl = document.createElement('div');
      this.drawerShellEl.className = 'drawer-shell';

      this.drawerEl = document.createElement('div');
      this.drawerEl.className = 'drawer-body';

      this.gripEl = document.createElement('div');
      this.gripEl.className = 'drag-grip';
      this.gripEl.title = this._t().dragTip;

      this.labelEl = document.createElement('span');
      this.labelEl.className = 'status-label';
      this.labelEl.textContent = this._t().ready;
      this.gripEl.appendChild(this.labelEl);

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
      this.drawerEl.append(this.gripEl, this.normalActionsEl, this.confirmActionsEl);
      this.drawerShellEl.appendChild(this.drawerEl);

      // Obvious White Peek Ear with Chevron When Collapsed Left
      this.peekEarEl = document.createElement('div');
      this.peekEarEl.className = 'peek-ear';
      this.peekEarEl.title = this._t().peekTip;
      const chevSvg = document.createElementNS(svgNs, 'svg');
      chevSvg.setAttribute('viewBox', '0 0 16 16');
      chevSvg.setAttribute('fill', 'none');
      chevSvg.setAttribute('stroke', 'currentColor');
      chevSvg.setAttribute('stroke-width', '2.2');
      chevSvg.setAttribute('stroke-linecap', 'round');
      chevSvg.setAttribute('stroke-linejoin', 'round');
      const chevPath = document.createElementNS(svgNs, 'path');
      chevPath.setAttribute('d', 'M6 3.5L10.5 8 6 12.5');
      chevSvg.appendChild(chevPath);
      this.peekEarEl.appendChild(chevSvg);

      this.capsuleEl.append(this.headCellEl, this.drawerShellEl, this.peekEarEl);

      this.shadow.append(
        styleEl,
        this.shieldEl,
        this.borderEl,
        this.rippleLayer,
        this.cursorEl,
        this.holdBadgeEl,
        this.capsuleEl
      );

      this._bindInteractions();
      (document.documentElement || document.body).appendChild(this.hostEl);
    }

    _cancelHoldUnlock() {
      if (this._holdRaf !== null) {
        cancelAnimationFrame(this._holdRaf);
        this._holdRaf = null;
      }
      this.holdBadgeEl.dataset.active = 'false';
      this.holdBarCircle.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    }

    _clearConfirmState() {
      if (this._confirmTimer) {
        clearTimeout(this._confirmTimer);
        this._confirmTimer = null;
      }
      this._state.confirmingDisconnect = false;
    }

    _flashMessage(msg, durationMs = 2800) {
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._state.flashText = msg;
      this._expandAndArmForegroundCollapse();
      this._render();
      this._flashTimer = setTimeout(() => {
        this._flashTimer = null;
        this._state.flashText = '';
        this._expandAndArmForegroundCollapse();
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
      this._cancelHoldUnlock();
      this._clearConfirmState();
      this._state.userPausedLock = true;
      this._state.mode = 'paused';
      this._state.activity = this._t().pausedByUser;
      this._state.flashText = '';
      this._expandAndArmForegroundCollapse();
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
        this._cancelHoldUnlock();
        this._clearConfirmState();
        const nextPaused = this._state.mode !== 'paused';
        this._state.userPausedLock = nextPaused;
        this._state.mode = nextPaused ? 'paused' : 'working';
        this._state.activity = nextPaused ? this._t().pausedByUser : this._t().resumed;
        this._state.flashText = '';
        this._expandAndArmForegroundCollapse();
        this._notifyBackground(nextPaused ? 'pause' : 'resume');
        this._render();
      };

      const onPeekClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._expandAndArmForegroundCollapse();
        this._render();
      };

      const onCloseAskClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this._state.confirmingDisconnect = true;
        this._collapsed = false;
        this._clearFgCollapseTimer();
        this._render();
        this._confirmTimer = setTimeout(() => {
          this._confirmTimer = null;
          if (this._state.confirmingDisconnect) {
            this._state.confirmingDisconnect = false;
            this._expandAndArmForegroundCollapse();
            this._render();
          }
        }, 5000);
      };

      const onCancelConfirmClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        this._expandAndArmForegroundCollapse();
        this._render();
      };

      const onConfirmReleaseClick = (ev) => {
        if (!ev.isTrusted || ev._cliveBtnDone) return;
        ev._cliveBtnDone = true;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this._clearFgCollapseTimer();
        this._state.userPausedLock = true;
        this._state.mode = 'paused';
        this._state.visible = false;
        this._notifyBackground('release');
        this._render();
      };

      // Hover or touch immediately expands; leaving re-arms 10s foreground countdown
      const onDockEnter = (ev) => {
        if (ev && !ev.isTrusted) return;
        this._pointerInsideDock = true;
        this._collapsed = false;
        this._clearFgCollapseTimer();
        this._render();
      };

      const onDockLeave = (ev) => {
        if (ev && !ev.isTrusted) return;
        this._pointerInsideDock = false;
        this._expandAndArmForegroundCollapse();
      };

      // Pause 10s collapse countdown while tab is in background; start fresh 10s countdown when user brings tab to foreground!
      const onVisibilityChange = () => {
        if (selfDestructIfOrphan()) return;
        if (!this._state.visible) return;
        if (!this._isTabInForeground()) {
          this._clearFgCollapseTimer();
        } else if (!this._collapsed) {
          this._expandAndArmForegroundCollapse();
        }
      };

      // Original Left-Click Hold 3s on Locked Page Shield to Unlock Manual Control
      let holdStartAt = 0;
      let holdingPointerId = null;

      const placeHoldBadge = (cx, cy) => {
        const vw = window.innerWidth || 1280;
        const halfBound = Math.min(130, Math.floor(vw * 0.4));
        const clampedX = Math.min(Math.max(halfBound, cx), Math.max(halfBound, vw - halfBound));
        const clampedY = Math.max(88, cy);
        this.holdBadgeEl.style.left = `${Math.round(clampedX)}px`;
        this.holdBadgeEl.style.top = `${Math.round(clampedY)}px`;
      };

      const onShieldPointerDown = (ev) => {
        if (!ev.isTrusted) return;
        if (ev._cliveShieldDone) return;
        ev._cliveShieldDone = true;
        if (selfDestructIfOrphan()) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.button !== 0 || this._state.mode !== 'working') return;

        holdingPointerId = ev.pointerId;
        holdStartAt = performance.now();
        try {
          this.shieldEl.setPointerCapture(ev.pointerId);
        } catch {}

        placeHoldBadge(ev.clientX, ev.clientY);
        this.holdTextEl.textContent = this._t().holdingHint;

        const step = (now) => {
          if (holdingPointerId === null) return;
          const elapsed = now - holdStartAt;
          if (elapsed >= 110) {
            this.holdBadgeEl.dataset.active = 'true';
          }
          const ratio = Math.min(1, elapsed / HOLD_UNLOCK_MS);
          const offset = RING_CIRCUMFERENCE * (1 - ratio);
          this.holdBarCircle.style.strokeDashoffset = offset.toFixed(2);
          const remainSec = Math.max(1, Math.ceil((HOLD_UNLOCK_MS - elapsed) / 1000));
          this.holdSecEl.textContent = String(remainSec);

          if (ratio >= 1) {
            holdingPointerId = null;
            this._switchToManualNow();
            return;
          }
          this._holdRaf = requestAnimationFrame(step);
        };

        this._cancelHoldUnlock();
        this._holdRaf = requestAnimationFrame(step);
      };

      const onShieldPointerMove = (ev) => {
        if (holdingPointerId !== ev.pointerId) return;
        placeHoldBadge(ev.clientX, ev.clientY);
      };

      const endShieldHold = (ev) => {
        if (holdingPointerId === null) return;
        const elapsed = performance.now() - holdStartAt;
        try {
          if (ev && typeof ev.pointerId === 'number') {
            this.shieldEl.releasePointerCapture(ev.pointerId);
          }
        } catch {}
        holdingPointerId = null;
        this._cancelHoldUnlock();
        if (elapsed < HOLD_UNLOCK_MS && this._state.mode === 'working') {
          this._flashMessage(this._t().lockedTapHint, 2800);
        }
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

      // Vertical drag to fine-tune height + snap left/right edge (default: left edge, bottom: 84px)
      let dragging = false;
      let dragPointerId = null;
      let dragStartX = 0;
      let dragStartY = 0;
      let startBottomPx = DEFAULT_BOTTOM_OFFSET_PX;

      const onGripDown = (ev) => {
        if (!ev.isTrusted || ev._cliveGripDone || ev.button !== 0) return;
        ev._cliveGripDone = true;
        dragging = true;
        dragPointerId = ev.pointerId;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        startBottomPx = this._state.bottomPx;
        this.capsuleEl.dataset.pressing = 'true';
        try {
          this.gripEl.setPointerCapture(ev.pointerId);
        } catch {}
      };

      const onGripMove = (ev) => {
        if (!dragging || (dragPointerId !== null && ev.pointerId !== dragPointerId)) return;
        const vh = Math.max(240, window.innerHeight || 800);
        const nextBottom = Math.min(vh - 76, Math.max(16, Math.round(startBottomPx + (dragStartY - ev.clientY))));
        this._state.bottomPx = nextBottom;
        this.capsuleEl.style.bottom = `${nextBottom}px`;
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
        const vh = Math.max(240, window.innerHeight || 800);
        this._state.dock = ev.clientX > vw * 0.55 ? 'right' : 'left';
        this._state.bottomPx = Math.min(vh - 76, Math.max(16, Math.round(startBottomPx + (dragStartY - ev.clientY))));
        this._expandAndArmForegroundCollapse();
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

      const captureHostGuard = (ev) => {
        if (!ev || !ev.isTrusted || ev._cliveHandled) return;
        const evtType = ev.type;
        if (evtType === 'pointermove') {
          if (holdingPointerId !== null && ev.pointerId === holdingPointerId) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onShieldPointerMove(ev);
            return;
          }
          if (dragging && dragPointerId !== null && ev.pointerId === dragPointerId) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onGripMove(ev);
          }
          return;
        }
        if (evtType === 'pointerup' || evtType === 'pointercancel') {
          if (holdingPointerId !== null && ev.pointerId === holdingPointerId) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            endShieldHold(ev);
            return;
          }
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
        const onPeekEar =
          this._collapsed &&
          (topTarget === this.peekEarEl || this.peekEarEl.contains(topTarget) || hitHudButton(this.peekEarEl, true));
        const onActiveBtn = isConfirming
          ? onPauseToggle ||
            onPeekEar ||
            topTarget === this.cancelConfirmBtn ||
            this.cancelConfirmBtn.contains(topTarget) ||
            hitHudButton(this.cancelConfirmBtn, true) ||
            topTarget === this.confirmDisconnectBtn ||
            this.confirmDisconnectBtn.contains(topTarget) ||
            hitHudButton(this.confirmDisconnectBtn, true)
          : onPauseToggle ||
            onPeekEar ||
            (!this._collapsed &&
              (topTarget === this.closeBtn || this.closeBtn.contains(topTarget) || hitHudButton(this.closeBtn, true)));
        const onGrip =
          !this._collapsed &&
          (topTarget === this.gripEl || this.gripEl.contains(topTarget) || hitHudBox(this.gripEl, this._state.visible));
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
          if (onPeekEar) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onPeekClick(ev);
          } else if (onPauseToggle) {
            ev._cliveHandled = true;
            ev.stopImmediatePropagation?.();
            onPauseClick(ev);
          } else if (
            !isConfirming &&
            !this._collapsed &&
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
      window.addEventListener('blur', endShieldHold);
      document.addEventListener('visibilitychange', onVisibilityChange);
      this.capsuleEl.addEventListener('pointerenter', onDockEnter);
      this.capsuleEl.addEventListener('pointerleave', onDockLeave);
      this.peekEarEl.addEventListener('click', onPeekClick);
      this.pauseBtn.addEventListener('click', onPauseClick);
      this.closeBtn.addEventListener('click', onCloseAskClick);
      this.cancelConfirmBtn.addEventListener('click', onCancelConfirmClick);
      this.confirmDisconnectBtn.addEventListener('click', onConfirmReleaseClick);
      this.shieldEl.addEventListener('pointerdown', onShieldPointerDown, true);
      this.shieldEl.addEventListener('pointermove', onShieldPointerMove, true);
      this.shieldEl.addEventListener('pointerup', endShieldHold, true);
      this.shieldEl.addEventListener('pointercancel', endShieldHold, true);
      this.shieldEl.addEventListener('contextmenu', swallowLockedEvent, true);
      this.shieldEl.addEventListener('wheel', swallowLockedEvent, { passive: false, capture: true });
      this.gripEl.addEventListener('pointerdown', onGripDown, true);
      this.gripEl.addEventListener('pointermove', onGripMove, true);
      this.gripEl.addEventListener('pointerup', onGripUp, true);
      this.gripEl.addEventListener('pointercancel', onGripCancel, true);

      this._cleanups.push(() => {
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this._clearFgCollapseTimer();
        if (this._flashTimer) clearTimeout(this._flashTimer);
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
        window.removeEventListener('blur', endShieldHold);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        this.capsuleEl.removeEventListener('pointerenter', onDockEnter);
        this.capsuleEl.removeEventListener('pointerleave', onDockLeave);
        this.peekEarEl.removeEventListener('click', onPeekClick);
        this.pauseBtn.removeEventListener('click', onPauseClick);
        this.closeBtn.removeEventListener('click', onCloseAskClick);
        this.cancelConfirmBtn.removeEventListener('click', onCancelConfirmClick);
        this.confirmDisconnectBtn.removeEventListener('click', onConfirmReleaseClick);
        this.shieldEl.removeEventListener('pointerdown', onShieldPointerDown, true);
        this.shieldEl.removeEventListener('pointermove', onShieldPointerMove, true);
        this.shieldEl.removeEventListener('pointerup', endShieldHold, true);
        this.shieldEl.removeEventListener('pointercancel', endShieldHold, true);
        this.shieldEl.removeEventListener('contextmenu', swallowLockedEvent, true);
        this.shieldEl.removeEventListener('wheel', swallowLockedEvent, true);
        this.gripEl.removeEventListener('pointerdown', onGripDown, true);
        this.gripEl.removeEventListener('pointermove', onGripMove, true);
        this.gripEl.removeEventListener('pointerup', onGripUp, true);
        this.gripEl.removeEventListener('pointercancel', onGripCancel, true);
      });
    }

    _syncDrawerNaturalWidth() {
      const w = Math.ceil(this.drawerEl.offsetWidth || 0);
      if (w > 0) {
        this.capsuleEl.style.setProperty('--drawer-w', `${w}px`);
      }
    }

    _render() {
      if (!this.hostEl.isConnected && document.documentElement) {
        document.documentElement.appendChild(this.hostEl);
      }
      const t = this._t();
      this.gripEl.title = t.dragTip;
      this.peekEarEl.title = t.peekTip;
      this.closeBtn.textContent = t.disconnectLabel;
      this.closeBtn.title = t.closeTip;
      this.holdTextEl.textContent = t.holdingHint;
      this.cancelConfirmBtn.textContent = t.cancelBtn;
      this.confirmDisconnectBtn.textContent = t.disconnectBtn;

      if (!this._state.visible) {
        this._wasVisible = false;
        this._collapsed = false;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this._clearFgCollapseTimer();
        this.capsuleEl.dataset.hidden = 'true';
        this.cursorEl.dataset.visible = 'false';
        this.shieldEl.dataset.locked = 'false';
        this.borderEl.removeAttribute('data-state');
        return;
      }

      const isLockedWorking = this._state.mode === 'working';
      const isPaused = this._state.mode === 'paused';
      this.shieldEl.dataset.locked = String(isLockedWorking);
      if (!isLockedWorking) {
        this._cancelHoldUnlock();
      }

      const side = this._state.dock === 'right' ? 'right' : 'left';
      this.capsuleEl.dataset.side = side;
      this.capsuleEl.style.bottom = `${this._state.bottomPx}px`;
      this.borderEl.dataset.state = this._state.mode;

      this.tallyTextSpan.textContent = isPaused
        ? t.badgeHold
        : this._state.mode === 'shared'
          ? t.badgeShared
          : t.badgeLive;
      this.lockIconPath.setAttribute('d', isPaused ? LOCK_OPEN_SVG_PATH : LOCK_CLOSED_SVG_PATH);
      this.pauseBtn.title = isPaused ? t.resumeTip : t.pauseTip;
      this.pauseBtn.dataset.mode = this._state.confirmingDisconnect ? 'confirm' : this._state.mode;

      if (this._state.confirmingDisconnect) {
        this.labelEl.textContent = t.confirmAsk;
        this.labelEl.dataset.alert = 'false';
        this.normalActionsEl.classList.add('hidden-el');
        this.confirmActionsEl.classList.remove('hidden-el');
      } else {
        const displayStr = this._state.flashText || this._normalizeActivityText(this._state.activity);
        this.labelEl.textContent = displayStr;
        this.labelEl.dataset.alert = String(Boolean(this._state.flashText));
        this.normalActionsEl.classList.remove('hidden-el');
        this.confirmActionsEl.classList.add('hidden-el');
      }

      const firstAppear = !this._wasVisible;
      this._wasVisible = true;
      if (firstAppear) {
        this._expandAndArmForegroundCollapse();
      }

      if (!this._collapsed) {
        this._syncDrawerNaturalWidth();
      }
      const effectiveCollapsed = Boolean(
        this._collapsed &&
          !this._pointerInsideDock &&
          !this._state.confirmingDisconnect &&
          !this._state.flashText
      );
      this.capsuleEl.dataset.collapsed = String(effectiveCollapsed);
      this.capsuleEl.dataset.hidden = 'false';
    }

    update(payload = {}) {
      if (payload.lang === 'zh' || payload.lang === 'en') {
        this._state.lang = payload.lang;
      }
      if (payload.clearUserPauseLock === true) {
        this._state.userPausedLock = false;
      }
      const prevMode = this._state.mode;
      const prevVisible = this._state.visible;
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
      if (this._state.visible && (!prevVisible || this._state.mode !== prevMode)) {
        this._expandAndArmForegroundCollapse();
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
