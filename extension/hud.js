(function initChromeLiveHud() {
  'use strict';

  if (window.top !== window) return;

  const REGISTRY_SYMBOL = '__chromeLiveHudController__';
  const CURRENT_HUD_REV = 19;
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
  const FOREGROUND_AUTO_COLLAPSE_MS = 10000; // Wait full 10s in foreground before gently tucking left
  const DEFAULT_BOTTOM_OFFSET_PX = 84; // Clear of inline screencast bottom-left `LIVE · 0 Token` chip
  const ORBIT_DURATION_CSS = '3.6s'; // Medium balanced 360-degree orbit speed
  const RING_CIRCUMFERENCE = 2 * Math.PI * 20; // r = 20 -> ~125.66
  // Concentric optical reticle geometry (zero overlap with dart/arrow cursors)
  const OPTICAL_RETICLE_SPEC = {
    outerR: 12.112,
    dashArc: 22.173,
    dashGap: 15.857,
    coreR: 3.647
  };

  const DICT = {
    zh: {
      dragTip: '上下拖动调整高度，或拖至左/右边缘贴壁停靠',
      ready: '按住左键3秒解锁',
      doneText: '任务已完成',
      pausedByUser: '已解锁 · 手动操控中',
      resumed: '已恢复防误触锁定',
      badgeLive: 'LIVE',
      badgeHold: 'HOLD',
      badgeShared: 'LIVE',
      pauseTip: '点击切换手动模式（或在页面按住左键满3秒解锁）',
      resumeTip: '点击恢复 AI 防误触锁定操控',
      peekTip: '移入或点击向右展开控制栏',
      disconnectLabel: '断开',
      closeTip: '释放此标签页控制权（不关闭网页）',
      confirmAsk: '断开此页受控？',
      cancelBtn: '取消',
      disconnectBtn: '确认断开',
      lockedTapHint: '已防误触锁定 · 按住左键3秒解锁',
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
      --collapse-slow: 880ms cubic-bezier(0.22, 1, 0.36, 1);
      --spring-pop: 240ms cubic-bezier(0.22, 1, 0.36, 1);
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

    /* 3-Second Hold-to-Unlock Circular Ring Progress Indicator */
    .hold-badge {
      position: fixed;
      left: 0;
      top: 0;
      translate: -50% -124%;
      scale: 0.92;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 9px 20px 9px 11px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
      color: #18181b;
      font-size: 15px;
      font-weight: 500;
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
      width: 46px;
      height: 46px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .hold-ring-svg {
      width: 46px;
      height: 46px;
      transform: rotate(-90deg);
    }
    .hold-ring-track {
      fill: rgba(37, 99, 235, 0.06);
      stroke: #e2e8f0;
      stroke-width: 3.8;
    }
    .hold-ring-bar {
      fill: none;
      stroke: #2563eb;
      stroke-width: 3.8;
      stroke-linecap: round;
      stroke-dasharray: 125.66;
      stroke-dashoffset: 125.66;
    }
    .hold-sec-num {
      position: absolute;
      font-size: 16.5px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #1d4ed8;
    }

    /* Scheme B: 3.5px Dual-Beam Symmetric 360-Degree Full-Perimeter Orbit */
    .perimeter-orbit {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .perimeter-orbit[data-state="working"],
    .perimeter-orbit[data-state="shared"],
    .perimeter-orbit[data-state="paused"] {
      opacity: 1;
    }
    .orbit-working-group,
    .orbit-shared-rect,
    .orbit-paused-rect {
      display: none;
    }
    .perimeter-orbit[data-state="working"] .orbit-working-group {
      display: inline;
    }
    .perimeter-orbit[data-state="shared"] .orbit-shared-rect {
      display: inline;
    }
    .perimeter-orbit[data-state="paused"] .orbit-paused-rect {
      display: inline;
    }
    .orbit-beam-anim {
      animation: clivePerimeterOrbit ${ORBIT_DURATION_CSS} linear infinite;
    }
    @keyframes clivePerimeterOrbit {
      from { stroke-dashoffset: 1000; }
      to { stroke-dashoffset: 0; }
    }
    @keyframes cliveLockRingSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .lock-ring-spin {
      transform-origin: 12px 12px;
      animation: cliveLockRingSpin ${ORBIT_DURATION_CSS} linear infinite;
    }

    /* 54px Left-Edge Tally Dock Above Screencast Chip (bottom: 84px) */
    .edge-tally-dock {
      position: fixed;
      left: 0;
      bottom: 84px;
      height: 54px;
      max-width: calc(100vw - 20px);
      display: inline-flex;
      align-items: stretch;
      background: #ffffff;
      color: #18181b;
      border: 1px solid #cbd5e1;
      border-left: none;
      border-radius: 0 12px 12px 0;
      box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06);
      font-size: 15px;
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
      border-left: 1px solid #cbd5e1;
      border-right: none;
      border-radius: 12px 0 0 12px;
      flex-direction: row-reverse;
    }
    .edge-tally-dock[data-hidden="true"] {
      opacity: 0;
      scale: 0.92;
      pointer-events: none;
    }
    .edge-tally-dock[data-pressing="true"] {
      scale: 0.985;
      box-shadow: 0 14px 32px rgba(15, 23, 42, 0.22);
    }

    /* Always-Visible Solid Tally Head: Precision 28px Circle-Padlock + Bold LIVE / HOLD */
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
      padding: 0 20px 0 16px;
      background: #2563eb;
      color: #ffffff;
      font: 700 16px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      letter-spacing: 0.05em;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: background-color 160ms ease, filter 160ms ease;
    }
    .tally-mode-btn:hover {
      filter: brightness(1.06);
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
      width: 28px;
      height: 28px;
      display: block;
      flex-shrink: 0;
    }

    /* Zero-Truncation CSS Grid 1fr <-> 0fr Collapsible Drawer (Never clips buttons when text grows!) */
    .drawer-grid {
      display: grid;
      grid-template-columns: 1fr;
      height: 100%;
      opacity: 1;
      transition:
        grid-template-columns var(--collapse-slow),
        opacity 480ms ease;
    }
    .edge-tally-dock[data-collapsed="true"] .drawer-grid {
      grid-template-columns: 0fr;
      opacity: 0;
      pointer-events: none;
    }
    .drawer-inner {
      min-width: 0;
      overflow: hidden;
      display: flex;
      align-items: center;
      height: 100%;
    }

    .drawer-body {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      height: 100%;
      padding: 0 14px 0 18px;
      white-space: nowrap;
      background: #ffffff;
      flex-shrink: 0;
    }
    .drag-grip {
      display: inline-flex;
      align-items: center;
      height: 100%;
      cursor: grab;
    }
    .drag-grip:active {
      cursor: grabbing;
    }
    /* Strict OpenDesign Rule: Clean Neutral Charcoal Text (#18181b), Regular/500 Weight, Never Gaudy Blue Bold! */
    .status-label {
      color: #18181b;
      font-size: 15px;
      font-weight: 400;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }

    .v-divider {
      width: 1px;
      height: 20px;
      background: #e4e4e7;
      flex-shrink: 0;
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
      border-radius: 7px;
      height: 34px;
      padding: 0 14px;
      background: #f8fafc;
      color: #27272a;
      font: 400 14px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
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

    /* Smoothly Revealed White Peek Ear When Tucked Left (Zero display:none jump!) */
    .peek-ear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0px;
      height: 100%;
      overflow: hidden;
      opacity: 0;
      background: #ffffff;
      color: #52525b;
      cursor: pointer;
      flex-shrink: 0;
      pointer-events: none;
      transition:
        width var(--collapse-slow),
        opacity 480ms ease,
        background-color 150ms ease,
        color 150ms ease;
    }
    .edge-tally-dock[data-collapsed="true"] .peek-ear {
      width: 30px;
      opacity: 1;
      pointer-events: auto;
    }
    .peek-ear:hover {
      background: #f4f4f5;
      color: #18181b;
    }
    .peek-ear svg {
      width: 18px;
      height: 18px;
      display: block;
      flex-shrink: 0;
    }
    .edge-tally-dock[data-side="right"] .peek-ear svg {
      transform: rotate(180deg);
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
      width: 28px;
      height: 28px;
      margin-left: -14px;
      margin-top: -14px;
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
      width: 0;
      height: 0;
      transform-origin: 0 0;
      transition: transform 130ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .collab-cursor[data-pressed="true"] .collab-cursor-inner {
      transform: scale(0.80);
    }
    .reticle-svg {
      position: absolute;
      left: -16px;
      top: -16px;
      width: 32px;
      height: 32px;
      display: block;
      filter: drop-shadow(0 2px 5px rgba(15, 23, 42, 0.22));
    }
    .reticle-spin {
      transform-origin: 16px 16px;
      animation: lockRingSpin 2.2s linear infinite;
    }
    .collab-cursor-pill {
      position: absolute;
      left: 19px;
      top: -12px;
      height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      background: #ffffff;
      border: 1.5px solid #2563eb;
      box-shadow: 0 3px 10px rgba(37, 99, 235, 0.16);
      color: #1e3a8a;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .collab-cursor[data-flip="left"] .collab-cursor-pill {
      left: auto;
      right: 19px;
    }
    .collab-cursor-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #2563eb;
      flex-shrink: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        --spring-width: 160ms ease;
        --collapse-slow: 220ms ease;
        --spring-pop: 140ms ease;
      }
      .orbit-beam-anim,
      .lock-ring-spin,
      .reticle-spin {
        animation: none;
      }
    }

    @media print {
      :host {
        display: none !important;
      }
    }
  `;

  function buildLockIconNodes(svgNs, isOpen, isSpinning) {
    // Precision 24x24 Circle-Padlock with synced 360-degree rotating outer arc when actively working
    const frag = document.createDocumentFragment();

    const baseRing = document.createElementNS(svgNs, 'circle');
    baseRing.setAttribute('cx', '12');
    baseRing.setAttribute('cy', '12');
    baseRing.setAttribute('r', '10.2');
    baseRing.setAttribute('fill', 'rgba(255, 255, 255, 0.14)');
    baseRing.setAttribute('stroke', isSpinning ? 'rgba(255, 255, 255, 0.34)' : 'currentColor');
    baseRing.setAttribute('stroke-width', '1.9');
    baseRing.setAttribute('data-base-ring', 'true');

    const spinArc = document.createElementNS(svgNs, 'circle');
    spinArc.setAttribute('cx', '12');
    spinArc.setAttribute('cy', '12');
    spinArc.setAttribute('r', '10.2');
    spinArc.setAttribute('fill', 'none');
    spinArc.setAttribute('stroke', 'currentColor');
    spinArc.setAttribute('stroke-width', '2.15');
    spinArc.setAttribute('stroke-linecap', 'round');
    spinArc.setAttribute('stroke-dasharray', isSpinning ? '28 36' : '0 66');
    if (isSpinning) {
      spinArc.setAttribute('class', 'lock-ring-spin');
    }
    spinArc.setAttribute('data-spin-arc', 'true');

    const shackle = document.createElementNS(svgNs, 'path');
    shackle.setAttribute(
      'd',
      isOpen
        ? 'M9.3 10.8V8.3a2.7 2.7 0 0 1 5.0-1.4'
        : 'M9.3 10.8V8.5a2.7 2.7 0 0 1 5.4 0v2.3'
    );
    shackle.setAttribute('fill', 'none');
    shackle.setAttribute('stroke', 'currentColor');
    shackle.setAttribute('stroke-width', '2.0');
    shackle.setAttribute('stroke-linecap', 'round');

    const bodyRect = document.createElementNS(svgNs, 'rect');
    bodyRect.setAttribute('x', '7.5');
    bodyRect.setAttribute('y', '10.6');
    bodyRect.setAttribute('width', '9');
    bodyRect.setAttribute('height', '6.8');
    bodyRect.setAttribute('rx', '1.6');
    bodyRect.setAttribute('fill', 'currentColor');

    const keyhole = document.createElementNS(svgNs, 'circle');
    keyhole.setAttribute('cx', '12');
    keyhole.setAttribute('cy', '14');
    keyhole.setAttribute('r', '1.15');
    keyhole.setAttribute('fill', isOpen ? '#d97706' : '#2563eb');
    keyhole.setAttribute('data-keyhole', 'true');

    frag.append(baseRing, spinArc, shackle, bodyRect, keyhole);
    return frag;
  }

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
      this._lastRenderedLockOpen = null;
      this._lastRenderedLockBg = '';
      const detectUiLang = () => {
        try {
          if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
            if (/^zh(?:[-_]|$)/i.test(chrome.i18n.getUILanguage() || '')) return 'zh';
          }
        } catch {}
        try {
          const langs =
            Array.isArray(navigator.languages) && navigator.languages.length > 0
              ? navigator.languages
              : [navigator.language || ''];
          if (langs.some((l) => /^zh(?:[-_]|$)/i.test(String(l || '')))) return 'zh';
        } catch {}
        return 'en';
      };
      const defaultLang = detectUiLang();
      const initSide =
        inheritedSide === 'right' || inheritedSide === 'bottom-right' || inheritedSide === 'top-right'
          ? 'right'
          : 'left';
      const initBottomPx =
        typeof inheritedBottomPx === 'number' && Number.isFinite(inheritedBottomPx)
          ? Math.max(16, inheritedBottomPx)
          : DEFAULT_BOTTOM_OFFSET_PX;
      this._state = {
        lang: defaultLang,
        hydrated: false,
        visible: false,
        mode: 'working', // 'working' | 'shared' | 'paused' | 'done'
        activity: DICT[defaultLang].ready,
        flashText: '',
        confirmingDisconnect: false,
        dock: initSide,
        bottomPx: initBottomPx,
        userActionQueue: []
      };
      this._releaseFreezeLock = null;
      this._mount();
    }

    // Hold a lightweight Web Lock while actively controlled so Chromium's `TabGroupsCollapseFreezing`
    // (`CannotFreezeReason::kHoldingWebLock`) never freezes background worker tabs after 5s in a collapsed group!
    _syncFreezeExemptionLock() {
      const shouldHold = Boolean(this._state.visible && this._state.mode !== 'paused');
      if (shouldHold) {
        if (!this._releaseFreezeLock && typeof navigator !== 'undefined' && navigator.locks?.request) {
          let releaseFn = null;
          const p = new Promise((resolve) => {
            releaseFn = resolve;
          });
          this._releaseFreezeLock = () => {
            if (releaseFn) {
              const fn = releaseFn;
              releaseFn = null;
              fn();
            }
          };
          try {
            const lockHex = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
              b.toString(16).padStart(2, '0')
            ).join('');
            navigator.locks
              .request(`clive_active_${lockHex}`, () => p)
              .catch(() => {});
          } catch {
            this._releaseFreezeLock = null;
          }
        }
      } else if (this._releaseFreezeLock) {
        const drop = this._releaseFreezeLock;
        this._releaseFreezeLock = null;
        try {
          drop();
        } catch {}
      }
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

    // Expand badge & start 10-second foreground-only countdown (never collapses while tab is in background!)
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
      this._svgNs = svgNs;
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

      // Full-Perimeter 3.5px Dual-Beam 360-Degree Orbit SVG Overlay (stroke-width 7 on edge = exact 3.5px inside viewport)
      this.borderEl = document.createElementNS(svgNs, 'svg');
      this.borderEl.setAttribute('class', 'perimeter-orbit');
      this.borderEl.setAttribute('preserveAspectRatio', 'none');

      const workingGroup = document.createElementNS(svgNs, 'g');
      workingGroup.setAttribute('class', 'orbit-working-group');

      const baseTrack = document.createElementNS(svgNs, 'rect');
      baseTrack.setAttribute('x', '0');
      baseTrack.setAttribute('y', '0');
      baseTrack.setAttribute('width', '100%');
      baseTrack.setAttribute('height', '100%');
      baseTrack.setAttribute('fill', 'none');
      baseTrack.setAttribute('stroke', 'rgba(37, 99, 235, 0.22)');
      baseTrack.setAttribute('stroke-width', '7');

      const softHalo = document.createElementNS(svgNs, 'rect');
      softHalo.setAttribute('x', '0');
      softHalo.setAttribute('y', '0');
      softHalo.setAttribute('width', '100%');
      softHalo.setAttribute('height', '100%');
      softHalo.setAttribute('pathLength', '1000');
      softHalo.setAttribute('fill', 'none');
      softHalo.setAttribute('stroke', 'rgba(59, 130, 246, 0.36)');
      softHalo.setAttribute('stroke-width', '9.5');
      softHalo.setAttribute('stroke-dasharray', '230 270 230 270');
      softHalo.setAttribute('class', 'orbit-beam-anim');

      const primaryBeam = document.createElementNS(svgNs, 'rect');
      primaryBeam.setAttribute('x', '0');
      primaryBeam.setAttribute('y', '0');
      primaryBeam.setAttribute('width', '100%');
      primaryBeam.setAttribute('height', '100%');
      primaryBeam.setAttribute('pathLength', '1000');
      primaryBeam.setAttribute('fill', 'none');
      primaryBeam.setAttribute('stroke', '#2563eb');
      primaryBeam.setAttribute('stroke-width', '7');
      primaryBeam.setAttribute('stroke-linecap', 'round');
      primaryBeam.setAttribute('stroke-dasharray', '150 350 150 350');
      primaryBeam.setAttribute('class', 'orbit-beam-anim');

      const brightCore = document.createElementNS(svgNs, 'rect');
      brightCore.setAttribute('x', '0');
      brightCore.setAttribute('y', '0');
      brightCore.setAttribute('width', '100%');
      brightCore.setAttribute('height', '100%');
      brightCore.setAttribute('pathLength', '1000');
      brightCore.setAttribute('fill', 'none');
      brightCore.setAttribute('stroke', '#60a5fa');
      brightCore.setAttribute('stroke-width', '5');
      brightCore.setAttribute('stroke-linecap', 'round');
      brightCore.setAttribute('stroke-dasharray', '45 455 45 455');
      brightCore.setAttribute('class', 'orbit-beam-anim');

      workingGroup.append(baseTrack, softHalo, primaryBeam, brightCore);

      const sharedRect = document.createElementNS(svgNs, 'rect');
      sharedRect.setAttribute('x', '0');
      sharedRect.setAttribute('y', '0');
      sharedRect.setAttribute('width', '100%');
      sharedRect.setAttribute('height', '100%');
      sharedRect.setAttribute('fill', 'none');
      sharedRect.setAttribute('stroke', 'rgba(5, 150, 105, 0.62)');
      sharedRect.setAttribute('stroke-width', '6');
      sharedRect.setAttribute('class', 'orbit-shared-rect');

      const pausedRect = document.createElementNS(svgNs, 'rect');
      pausedRect.setAttribute('x', '0');
      pausedRect.setAttribute('y', '0');
      pausedRect.setAttribute('width', '100%');
      pausedRect.setAttribute('height', '100%');
      pausedRect.setAttribute('fill', 'none');
      pausedRect.setAttribute('stroke', '#d97706');
      pausedRect.setAttribute('stroke-width', '7');
      pausedRect.setAttribute('class', 'orbit-paused-rect');

      this.borderEl.append(workingGroup, sharedRect, pausedRect);

      this.rippleLayer = document.createElement('div');
      this.rippleLayer.className = 'ripple-layer';

      // Concentric optical reticle cursor + horizontal status capsule
      this.cursorEl = document.createElement('div');
      this.cursorEl.className = 'collab-cursor';
      this.cursorEl.dataset.visible = 'false';
      this.cursorEl.dataset.flip = 'right';
      const cursorInner = document.createElement('div');
      cursorInner.className = 'collab-cursor-inner';
      const reticleSvg = document.createElementNS(svgNs, 'svg');
      reticleSvg.setAttribute('viewBox', '0 0 32 32');
      reticleSvg.setAttribute('class', 'reticle-svg');
      const rOuterStr = String(OPTICAL_RETICLE_SPEC.outerR);
      const reticleHalo = document.createElementNS(svgNs, 'circle');
      reticleHalo.setAttribute('cx', '16');
      reticleHalo.setAttribute('cy', '16');
      reticleHalo.setAttribute('r', rOuterStr);
      reticleHalo.setAttribute('fill', 'rgba(37, 99, 235, 0.08)');
      reticleHalo.setAttribute('stroke', '#ffffff');
      reticleHalo.setAttribute('stroke-width', '3.2');
      const reticleArc = document.createElementNS(svgNs, 'circle');
      reticleArc.setAttribute('cx', '16');
      reticleArc.setAttribute('cy', '16');
      reticleArc.setAttribute('r', rOuterStr);
      reticleArc.setAttribute('fill', 'none');
      reticleArc.setAttribute('stroke', '#2563eb');
      reticleArc.setAttribute('stroke-width', '2.2');
      reticleArc.setAttribute('stroke-linecap', 'round');
      reticleArc.setAttribute(
        'stroke-dasharray',
        `${OPTICAL_RETICLE_SPEC.dashArc} ${OPTICAL_RETICLE_SPEC.dashGap}`
      );
      reticleArc.setAttribute('class', 'reticle-spin');
      const reticleCore = document.createElementNS(svgNs, 'circle');
      reticleCore.setAttribute('cx', '16');
      reticleCore.setAttribute('cy', '16');
      reticleCore.setAttribute('r', String(OPTICAL_RETICLE_SPEC.coreR));
      reticleCore.setAttribute('fill', '#2563eb');
      reticleCore.setAttribute('stroke', '#ffffff');
      reticleCore.setAttribute('stroke-width', '1.6');
      reticleSvg.append(reticleHalo, reticleArc, reticleCore);
      this.cursorPillEl = document.createElement('span');
      this.cursorPillEl.className = 'collab-cursor-pill';
      const pillDot = document.createElement('span');
      pillDot.className = 'collab-cursor-dot';
      this.cursorPillTextEl = document.createElement('span');
      this.cursorPillTextEl.textContent = this._t().cursorMove;
      this.cursorPillEl.append(pillDot, this.cursorPillTextEl);
      cursorInner.append(reticleSvg, this.cursorPillEl);
      this.cursorEl.appendChild(cursorInner);

      // 3-second left-click hold unlock circular ring indicator
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

      // 54px Left-Edge Tally Badge with CSS Grid 1fr <-> 0fr Zero-Truncation Drawer
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

      this.lockSvgEl = document.createElementNS(svgNs, 'svg');
      this.lockSvgEl.setAttribute('viewBox', '0 0 24 24');
      this.lockSvgEl.setAttribute('class', 'tally-lock-svg');
      this.lockSvgEl.appendChild(buildLockIconNodes(svgNs, false, true));
      this._lastRenderedLockKey = 'false:true';
      this._lastRenderedLockBg = '#2563eb';

      this.tallyTextSpan = document.createElement('span');
      this.tallyTextSpan.textContent = this._t().badgeLive;
      this.pauseBtn.append(this.lockSvgEl, this.tallyTextSpan);
      this.headCellEl.appendChild(this.pauseBtn);

      // CSS Grid 1fr <-> 0fr Collapsible Drawer
      this.drawerGridEl = document.createElement('div');
      this.drawerGridEl.className = 'drawer-grid';
      this.drawerInnerEl = document.createElement('div');
      this.drawerInnerEl.className = 'drawer-inner';

      this.drawerEl = document.createElement('div');
      this.drawerEl.className = 'drawer-body';

      this.gripEl = document.createElement('div');
      this.gripEl.className = 'drag-grip';
      this.gripEl.title = this._t().dragTip;

      this.labelEl = document.createElement('span');
      this.labelEl.className = 'status-label';
      this.labelEl.textContent = this._t().ready;
      this.gripEl.appendChild(this.labelEl);

      const dividerEl = document.createElement('span');
      dividerEl.className = 'v-divider';

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
      this.drawerEl.append(this.gripEl, dividerEl, this.normalActionsEl, this.confirmActionsEl);
      this.drawerInnerEl.appendChild(this.drawerEl);
      this.drawerGridEl.appendChild(this.drawerInnerEl);

      // Smoothly Animated White Peek Ear When Tucked Left
      this.peekEarEl = document.createElement('div');
      this.peekEarEl.className = 'peek-ear';
      this.peekEarEl.title = this._t().peekTip;
      const chevSvg = document.createElementNS(svgNs, 'svg');
      chevSvg.setAttribute('viewBox', '0 0 16 16');
      chevSvg.setAttribute('fill', 'none');
      chevSvg.setAttribute('stroke', 'currentColor');
      chevSvg.setAttribute('stroke-width', '2.1');
      chevSvg.setAttribute('stroke-linecap', 'round');
      chevSvg.setAttribute('stroke-linejoin', 'round');
      const chevPath = document.createElementNS(svgNs, 'path');
      chevPath.setAttribute('d', 'M6 3.5L10.5 8 6 12.5');
      chevSvg.appendChild(chevPath);
      this.peekEarEl.appendChild(chevSvg);

      this.capsuleEl.append(this.headCellEl, this.drawerGridEl, this.peekEarEl);

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

    _flashMessage(msg, durationMs = 3500) {
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
      if (eventName === 'release') {
        this._state.hydrated = true;
      }
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
      this._syncFreezeExemptionLock();
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
          this._flashMessage(this._t().lockedTapHint, 3500);
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
        const isCurrentlyCollapsed = this.capsuleEl.dataset.collapsed === 'true';
        const onPauseToggle =
          topTarget === this.pauseBtn || this.pauseBtn.contains(topTarget) || hitHudButton(this.pauseBtn, true);
        const onPeekEar =
          isCurrentlyCollapsed &&
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
            (!isCurrentlyCollapsed &&
              (topTarget === this.closeBtn || this.closeBtn.contains(topTarget) || hitHudButton(this.closeBtn, true)));
        const onGrip =
          !isCurrentlyCollapsed &&
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
            !isCurrentlyCollapsed &&
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

    _syncLockIconGraphic(isOpen, isSpinning, effectiveMode) {
      const keyholeColor =
        effectiveMode === 'confirm'
          ? '#dc2626'
          : effectiveMode === 'paused'
            ? '#d97706'
            : effectiveMode === 'shared'
              ? '#059669'
              : '#2563eb';
      const stateKey = `${isOpen}:${isSpinning}`;
      if (this._lastRenderedLockKey !== stateKey) {
        this.lockSvgEl.replaceChildren(buildLockIconNodes(this._svgNs, isOpen, isSpinning));
        this._lastRenderedLockKey = stateKey;
        this._lastRenderedLockBg = '';
      }
      if (this._lastRenderedLockBg !== keyholeColor) {
        const kh = this.lockSvgEl.querySelector('[data-keyhole]');
        if (kh) kh.setAttribute('fill', keyholeColor);
        this._lastRenderedLockBg = keyholeColor;
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
      this.borderEl.setAttribute('data-state', this._state.mode);

      const effectiveMode = this._state.confirmingDisconnect ? 'confirm' : this._state.mode;
      this.tallyTextSpan.textContent = isPaused
        ? t.badgeHold
        : this._state.mode === 'shared'
          ? t.badgeShared
          : t.badgeLive;
      this._syncLockIconGraphic(isPaused, isLockedWorking, effectiveMode);
      this.pauseBtn.title = isPaused ? t.resumeTip : t.pauseTip;
      this.pauseBtn.dataset.mode = effectiveMode;

      if (this._state.confirmingDisconnect) {
        this.labelEl.textContent = t.confirmAsk;
        this.normalActionsEl.classList.add('hidden-el');
        this.confirmActionsEl.classList.remove('hidden-el');
      } else {
        const displayStr = this._state.flashText || this._normalizeActivityText(this._state.activity);
        this.labelEl.textContent = displayStr;
        this.normalActionsEl.classList.remove('hidden-el');
        this.confirmActionsEl.classList.add('hidden-el');
      }

      const firstAppear = !this._wasVisible;
      this._wasVisible = true;
      if (firstAppear) {
        this._expandAndArmForegroundCollapse();
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
      this._state.hydrated = true;
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
      this._syncFreezeExemptionLock();
      this._render();
      return { ok: true, mode: this._state.mode, lang: this._state.lang };
    }

    moveCursor(opts = {}) {
      const x = Number(opts.x);
      const y = Number(opts.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };

      const t = this._t();
      const kind = String(opts.kind || 'click');
      const actionLabel =
        kind === 'type'
          ? t.cursorType
          : kind === 'upload'
            ? t.cursorUpload
            : kind === 'scroll'
              ? t.cursorScroll
              : kind === 'click'
                ? t.cursorClick
                : t.cursorMove;
      if (this.cursorPillTextEl) {
        this.cursorPillTextEl.textContent = actionLabel;
      } else {
        this.cursorPillEl.textContent = actionLabel;
      }
      this.cursorEl.dataset.flip = x > (window.innerWidth || 1200) - 96 ? 'left' : 'right';

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
      return { events: copy, mode: this._state.mode, visible: this._state.visible, hydrated: this._state.hydrated };
    }

    ping() {
      return isExtensionContextValid() && Boolean(this.hostEl && this.hostEl.isConnected);
    }

    destroy() {
      this._state.visible = false;
      this._syncFreezeExemptionLock();
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
