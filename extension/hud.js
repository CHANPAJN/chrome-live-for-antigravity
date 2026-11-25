(function initChromeLiveHud() {
  'use strict';

  if (window.top !== window) return;

  const REGISTRY_SYMBOL = '__chromeLiveHudController__';
  const CURRENT_HUD_REV = 10;
  const HOST_Z_MARKER = '2147483646';

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
  const RING_CIRCUMFERENCE = 2 * Math.PI * 20; // r = 20 -> ~125.66
  // Original rounded collaboration dart silhouette (zero overlap with classic OS arrow paths)
  const COLLAB_DART_PATH =
    'M2.4 2.4 L19.2 8.5 C20.9 9.1 21.0 11.5 19.3 12.2 L12.7 15.0 L9.9 21.6 C9.2 23.2 6.8 23.1 6.2 21.4 Z';

  const DICT = {
    zh: {
      dragTip: '按住拖动可吸附至页面顶部、底部或四角',
      ready: '已就绪',
      pausedByUser: '人工接管中',
      resumed: '已恢复锁定操控',
      pause: '暂停',
      resume: '继续',
      closeTip: '释放此标签页',
      confirmAsk: '将 Chrome Live 与此标签页断开连接？',
      cancelBtn: '取消',
      disconnectBtn: '断开连接',
      lockedTapHint: '已防误触锁定 · 按住左键 3 秒解锁',
      holdingHint: '继续按住解锁',
      cursorClick: 'Live · 点击',
      cursorType: 'Live · 输入',
      cursorUpload: 'Live · 上传',
      cursorScroll: 'Live · 滚动',
      cursorMove: 'Live'
    },
    en: {
      dragTip: 'Drag to snap HUD to top, bottom, or corners',
      ready: 'Ready',
      pausedByUser: 'Manual control',
      resumed: 'Resumed automation',
      pause: 'Pause',
      resume: 'Resume',
      closeTip: 'Detach this tab',
      confirmAsk: 'Disconnect Chrome Live from this tab?',
      cancelBtn: 'Cancel',
      disconnectBtn: 'Disconnect',
      lockedTapHint: 'Page locked · Hold left-click 3s to unlock',
      holdingHint: 'Hold to unlock',
      cursorClick: 'Live · Click',
      cursorType: 'Live · Type',
      cursorUpload: 'Live · Upload',
      cursorScroll: 'Live · Scroll',
      cursorMove: 'Live'
    }
  };

  const STYLESHEET = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      --spring-width: 440ms linear(0, 0.44, 0.88, 1.055, 1.018, 0.998, 1);
      --spring-pop: 360ms cubic-bezier(0.34, 1.46, 0.64, 1);
    }

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

    .aura-border {
      position: fixed;
      inset: 0;
      pointer-events: none;
      box-shadow: inset 0 0 0 2px rgba(14, 165, 233, 0.72), inset 0 0 18px rgba(14, 165, 233, 0.18);
      transition: opacity 0.25s ease, box-shadow 0.28s ease;
      opacity: 0;
    }
    .aura-border[data-state="working"] {
      opacity: 1;
      animation: breatheBorder 2.4s ease-in-out infinite;
    }
    .aura-border[data-state="shared"] {
      opacity: 1;
      box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.56);
    }
    .aura-border[data-state="paused"] {
      opacity: 1;
      box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.68);
    }
    @keyframes breatheBorder {
      0%, 100% {
        box-shadow: inset 0 0 0 2px rgba(14, 165, 233, 0.52), inset 0 0 12px rgba(14, 165, 233, 0.13);
      }
      50% {
        box-shadow: inset 0 0 0 2.5px rgba(56, 189, 248, 0.88), inset 0 0 22px rgba(14, 165, 233, 0.26);
      }
    }

    .hold-badge {
      position: fixed;
      left: 0;
      top: 0;
      translate: -50% -118%;
      scale: 0.88;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 7px 14px 7px 9px;
      border-radius: 999px;
      background: rgba(17, 17, 19, 0.94);
      backdrop-filter: blur(16px) saturate(150%);
      -webkit-backdrop-filter: blur(16px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
      color: #f4f4f5;
      font-size: 12px;
      font-weight: 500;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease, scale var(--spring-pop);
      white-space: nowrap;
    }
    .hold-badge[data-active="true"] {
      opacity: 1;
      scale: 1;
    }
    .hold-ring-wrap {
      position: relative;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .hold-ring-svg {
      width: 28px;
      height: 28px;
      transform: rotate(-90deg);
    }
    .hold-ring-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.14);
      stroke-width: 3.2;
    }
    .hold-ring-bar {
      fill: none;
      stroke: #38bdf8;
      stroke-width: 3.2;
      stroke-linecap: round;
      stroke-dasharray: 125.66;
      stroke-dashoffset: 125.66;
    }
    .hold-sec-num {
      position: absolute;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
    }

    /* Dynamic Island Full-Pill Shell with Zero-Overhead Spring Width Morph */
    .island-shell {
      position: fixed;
      left: 50%;
      bottom: 18px;
      translate: -50% 0;
      scale: 1;
      height: 42px;
      max-width: calc(100vw - 28px);
      border-radius: 999px;
      background: rgba(15, 15, 18, 0.93);
      backdrop-filter: blur(18px) saturate(160%);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.13),
        0 10px 28px rgba(0, 0, 0, 0.38),
        0 2px 6px rgba(0, 0, 0, 0.24);
      color: #ffffff;
      font-size: 13px;
      line-height: 1;
      pointer-events: auto;
      user-select: none;
      overflow: hidden;
      will-change: width, scale, opacity;
      transition:
        width var(--spring-width),
        scale var(--spring-pop),
        opacity 190ms ease;
    }
    .island-shell[data-hidden="true"] {
      opacity: 0;
      scale: 0.84;
      pointer-events: none;
    }
    .island-shell[data-pressing="true"] {
      scale: 0.97;
    }
    .island-shell[data-dock="top-center"] {
      bottom: auto;
      top: 14px;
      left: 50%;
      translate: -50% 0;
    }
    .island-shell[data-dock="top-right"] {
      left: auto;
      bottom: auto;
      top: 14px;
      right: 16px;
      translate: 0 0;
    }
    .island-shell[data-dock="bottom-right"] {
      left: auto;
      top: auto;
      bottom: 18px;
      right: 16px;
      translate: 0 0;
    }
    .island-shell[data-dock="bottom-left"] {
      right: auto;
      top: auto;
      bottom: 18px;
      left: 16px;
      translate: 0 0;
    }
    .island-shell[data-dock="top-left"] {
      right: auto;
      bottom: auto;
      top: 14px;
      left: 16px;
      translate: 0 0;
    }

    .island-track {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      height: 42px;
      padding: 0 7px 0 9px;
      width: max-content;
      max-width: calc(100vw - 28px);
      box-sizing: border-box;
    }

    .drag-grip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: grab;
      height: 100%;
      flex-shrink: 0;
    }
    .drag-grip:active {
      cursor: grabbing;
    }

    .orb-badge {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      box-shadow: 0 0 10px rgba(14, 165, 233, 0.48);
      display: grid;
      place-items: center;
      flex-shrink: 0;
      transition: background 0.25s ease, box-shadow 0.25s ease, scale var(--spring-pop);
    }
    .orb-badge::after {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ffffff;
    }
    .orb-badge[data-state="shared"],
    .orb-badge[data-state="done"] {
      background: linear-gradient(135deg, #10b981, #059669);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.42);
    }
    .orb-badge[data-state="paused"] {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.45);
    }
    .orb-badge[data-state="confirm"] {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.45);
    }

    .copy-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .title-tag {
      font-weight: 600;
      color: #ffffff;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }

    .dot-sep {
      color: rgba(255, 255, 255, 0.34);
      font-size: 12px;
      flex-shrink: 0;
    }

    .status-label {
      color: rgba(244, 244, 245, 0.86);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
    }
    .status-label[data-shimmer="true"] {
      background: linear-gradient(
        100deg,
        rgba(244, 244, 245, 0.78) 0%,
        rgba(244, 244, 245, 0.78) 36%,
        #7dd3fc 50%,
        rgba(244, 244, 245, 0.78) 64%,
        rgba(244, 244, 245, 0.78) 100%
      ) 0 0 / 240% 100%;
      color: transparent;
      -webkit-background-clip: text;
      background-clip: text;
      animation: textSheen 2.4s linear infinite;
    }
    @keyframes textSheen {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }

    .action-cluster {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 2px;
      flex-shrink: 0;
    }

    .pill-btn {
      appearance: none;
      border: none;
      border-radius: 999px;
      height: 28px;
      padding: 0 12px;
      font: 600 12px/1 inherit;
      cursor: pointer;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.13);
      color: #f4f4f5;
      transition: background 0.15s ease, color 0.15s ease, scale var(--spring-pop);
    }
    .pill-btn:hover {
      background: rgba(255, 255, 255, 0.22);
      color: #ffffff;
    }
    .pill-btn:active {
      scale: 0.93;
    }
    .pill-btn[data-primary="resume"] {
      background: #0ea5e9;
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(14, 165, 233, 0.38);
    }
    .pill-btn[data-primary="resume"]:hover {
      background: #38bdf8;
    }
    .pill-btn[data-primary="solid-white"] {
      background: #ffffff;
      color: #09090b;
      padding: 0 14px;
    }
    .pill-btn[data-primary="solid-white"]:hover {
      background: #e4e4e7;
    }
    .pill-btn[data-ghost="true"] {
      background: transparent;
      color: rgba(255, 255, 255, 0.75);
      font-weight: 500;
      padding: 0 9px;
    }
    .pill-btn[data-ghost="true"]:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .close-circle-btn {
      appearance: none;
      border: none;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: transparent;
      color: rgba(255, 255, 255, 0.62);
      display: grid;
      place-items: center;
      padding: 0;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, scale var(--spring-pop);
    }
    .close-circle-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }
    .close-circle-btn:active {
      scale: 0.88;
    }
    .close-circle-btn svg {
      width: 14px;
      height: 14px;
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
      border: 2px solid #38bdf8;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.55);
      animation: expandRing 0.42s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes expandRing {
      0% { transform: scale(0.35); opacity: 0.95; }
      100% { transform: scale(1.75); opacity: 0; }
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
      transition: transform 120ms cubic-bezier(0.34, 1.46, 0.64, 1);
    }
    .collab-cursor[data-pressed="true"] .collab-cursor-inner {
      transform: scale(0.82);
    }
    .collab-dart-svg {
      width: 24px;
      height: 24px;
      display: block;
      filter: drop-shadow(0 3px 7px rgba(0, 0, 0, 0.42));
      transform: translate(-2px, -2px);
    }
    .collab-dart-svg path {
      fill: #0ea5e9;
      stroke: #ffffff;
      stroke-width: 1.75;
      stroke-linejoin: round;
    }
    .collab-cursor-pill {
      position: absolute;
      left: 16px;
      top: 15px;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(15, 15, 18, 0.93);
      border: 1px solid rgba(56, 189, 248, 0.45);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.34);
      color: #f4f4f5;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        --spring-width: 160ms ease;
        --spring-pop: 140ms ease;
      }
      .status-label[data-shimmer="true"] {
        animation: none;
        background: none;
        color: rgba(244, 244, 245, 0.88);
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
      this._holdRaf = null;
      this._flashTimer = null;
      this._confirmTimer = null;
      this._cursorIdleTimer = null;
      this._cursorPressTimer = null;
      this._cursorPlaced = false;
      this._wasVisible = false;
      const defaultLang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
      this._state = {
        lang: defaultLang,
        visible: false,
        mode: 'working', // 'working' | 'shared' | 'paused' | 'done'
        activity: DICT[defaultLang].ready,
        flashText: '',
        confirmingDisconnect: false,
        dock: inheritedDock || 'bottom-center',
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
        'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;'
      );
      this.shadow = this.hostEl.attachShadow({ mode: 'closed' });

      const styleEl = document.createElement('style');
      styleEl.textContent = STYLESHEET;

      this.shieldEl = document.createElement('div');
      this.shieldEl.className = 'lock-shield';

      this.borderEl = document.createElement('div');
      this.borderEl.className = 'aura-border';

      this.rippleLayer = document.createElement('div');
      this.rippleLayer.className = 'ripple-layer';

      // Smooth collaboration cursor + action pill
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

      // 3-second left-click hold unlock progress indicator
      this.holdBadgeEl = document.createElement('div');
      this.holdBadgeEl.className = 'hold-badge';
      const ringWrap = document.createElement('div');
      ringWrap.className = 'hold-ring-wrap';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 48 48');
      svg.setAttribute('class', 'hold-ring-svg');
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
      svg.append(trackCircle, this.holdBarCircle);

      this.holdSecEl = document.createElement('span');
      this.holdSecEl.className = 'hold-sec-num';
      this.holdSecEl.textContent = '3';
      ringWrap.append(svg, this.holdSecEl);

      this.holdTextEl = document.createElement('span');
      this.holdTextEl.textContent = this._t().holdingHint;
      this.holdBadgeEl.append(ringWrap, this.holdTextEl);

      // Dynamic Island Full-Pill Capsule
      this.capsuleEl = document.createElement('div');
      this.capsuleEl.className = 'island-shell';
      this.capsuleEl.dataset.hidden = 'true';
      this.capsuleEl.dataset.dock = this._state.dock;

      this.trackEl = document.createElement('div');
      this.trackEl.className = 'island-track';

      this.gripEl = document.createElement('div');
      this.gripEl.className = 'drag-grip';
      this.gripEl.title = this._t().dragTip;

      this.orbEl = document.createElement('span');
      this.orbEl.className = 'orb-badge';

      const copyGroup = document.createElement('div');
      copyGroup.className = 'copy-group';

      this.brandEl = document.createElement('span');
      this.brandEl.className = 'title-tag';
      this.brandEl.textContent = 'Chrome Live';

      this.sepEl = document.createElement('span');
      this.sepEl.className = 'dot-sep';
      this.sepEl.textContent = '·';

      this.labelEl = document.createElement('span');
      this.labelEl.className = 'status-label';
      this.labelEl.textContent = this._t().ready;

      copyGroup.append(this.brandEl, this.sepEl, this.labelEl);
      this.gripEl.append(this.orbEl, copyGroup);

      // Normal action cluster: [Pause/Resume pill] + [× circle]
      this.normalActionsEl = document.createElement('div');
      this.normalActionsEl.className = 'action-cluster';

      this.pauseBtn = document.createElement('button');
      this.pauseBtn.type = 'button';
      this.pauseBtn.className = 'pill-btn';
      this.pauseBtn.textContent = this._t().pause;

      this.closeBtn = document.createElement('button');
      this.closeBtn.type = 'button';
      this.closeBtn.className = 'close-circle-btn';
      const closeSvg = document.createElementNS(svgNs, 'svg');
      closeSvg.setAttribute('viewBox', '0 0 24 24');
      closeSvg.setAttribute('fill', 'none');
      closeSvg.setAttribute('stroke', 'currentColor');
      closeSvg.setAttribute('stroke-width', '2.2');
      closeSvg.setAttribute('stroke-linecap', 'round');
      const l1 = document.createElementNS(svgNs, 'line');
      l1.setAttribute('x1', '18');
      l1.setAttribute('y1', '6');
      l1.setAttribute('x2', '6');
      l1.setAttribute('y2', '18');
      const l2 = document.createElementNS(svgNs, 'line');
      l2.setAttribute('x1', '6');
      l2.setAttribute('y1', '6');
      l2.setAttribute('x2', '18');
      l2.setAttribute('y2', '18');
      closeSvg.append(l1, l2);
      this.closeBtn.appendChild(closeSvg);

      this.normalActionsEl.append(this.pauseBtn, this.closeBtn);

      // Inline spring-expanded disconnect confirmation cluster: [Cancel] + [Disconnect solid white pill]
      this.confirmActionsEl = document.createElement('div');
      this.confirmActionsEl.className = 'action-cluster hidden-el';

      this.cancelConfirmBtn = document.createElement('button');
      this.cancelConfirmBtn.type = 'button';
      this.cancelConfirmBtn.className = 'pill-btn';
      this.cancelConfirmBtn.dataset.ghost = 'true';
      this.cancelConfirmBtn.textContent = this._t().cancelBtn;

      this.confirmDisconnectBtn = document.createElement('button');
      this.confirmDisconnectBtn.type = 'button';
      this.confirmDisconnectBtn.className = 'pill-btn';
      this.confirmDisconnectBtn.dataset.primary = 'solid-white';
      this.confirmDisconnectBtn.textContent = this._t().disconnectBtn;

      this.confirmActionsEl.append(this.cancelConfirmBtn, this.confirmDisconnectBtn);

      this.trackEl.append(this.gripEl, this.normalActionsEl, this.confirmActionsEl);
      this.capsuleEl.appendChild(this.trackEl);

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

    _flashMessage(msg, durationMs = 2000) {
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

    _bindInteractions() {
      const selfDestructIfOrphan = () => {
        if (!isExtensionContextValid()) {
          this.destroy();
          return true;
        }
        return false;
      };

      const onPauseClick = (ev) => {
        if (!ev.isTrusted) return;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        const nextPaused = this._state.mode !== 'paused';
        this._state.mode = nextPaused ? 'paused' : 'working';
        this._state.activity = nextPaused ? this._t().pausedByUser : this._t().resumed;
        this._state.flashText = '';
        this._notifyBackground(nextPaused ? 'pause' : 'resume');
        this._render();
      };

      const onCloseAskClick = (ev) => {
        if (!ev.isTrusted) return;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._cancelHoldUnlock();
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
        if (!ev.isTrusted) return;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._clearConfirmState();
        this._render();
      };

      const onConfirmReleaseClick = (ev) => {
        if (!ev.isTrusted) return;
        ev.stopPropagation();
        if (selfDestructIfOrphan()) return;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this._state.mode = 'paused';
        this._state.visible = false;
        this._notifyBackground('release');
        this._render();
      };

      // Left-click hold 3s on locked page shield to unlock manual control
      let holdStartAt = 0;
      let holdingPointerId = null;

      const onShieldPointerDown = (ev) => {
        if (!ev.isTrusted) return;
        if (selfDestructIfOrphan()) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.button !== 0 || this._state.mode !== 'working') return;

        holdingPointerId = ev.pointerId;
        holdStartAt = performance.now();
        try {
          this.shieldEl.setPointerCapture(ev.pointerId);
        } catch {}

        const placeBadge = (cx, cy) => {
          const vw = window.innerWidth || 1280;
          const halfBound = Math.min(90, Math.floor(vw * 0.4));
          const clampedX = Math.min(Math.max(halfBound, cx), Math.max(halfBound, vw - halfBound));
          const clampedY = Math.max(64, cy);
          this.holdBadgeEl.style.left = `${Math.round(clampedX)}px`;
          this.holdBadgeEl.style.top = `${Math.round(clampedY)}px`;
        };
        placeBadge(ev.clientX, ev.clientY);
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
            this._cancelHoldUnlock();
            this._clearConfirmState();
            this._state.mode = 'paused';
            this._state.activity = this._t().pausedByUser;
            this._state.flashText = '';
            this._notifyBackground('pause');
            this._render();
            return;
          }
          this._holdRaf = requestAnimationFrame(step);
        };

        this._cancelHoldUnlock();
        this._holdRaf = requestAnimationFrame(step);
      };

      const onShieldPointerMove = (ev) => {
        if (holdingPointerId !== ev.pointerId) return;
        const clampedX = Math.min(Math.max(90, ev.clientX), (window.innerWidth || 1280) - 90);
        const clampedY = Math.max(64, ev.clientY);
        this.holdBadgeEl.style.left = `${Math.round(clampedX)}px`;
        this.holdBadgeEl.style.top = `${Math.round(clampedY)}px`;
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
          this._flashMessage(this._t().lockedTapHint, 2100);
        }
      };

      const swallowLockedEvent = (ev) => {
        if (selfDestructIfOrphan()) return;
        if (this._state.visible && this._state.mode === 'working') {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      // Drag capsule to snap to 6 positions (top/bottom left/center/right; require >= 8px movement)
      let dragging = false;
      let dragStartX = 0;
      let dragStartY = 0;
      const onGripDown = (ev) => {
        if (ev.button !== 0) return;
        dragging = true;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        this.capsuleEl.dataset.pressing = 'true';
        try {
          this.gripEl.setPointerCapture(ev.pointerId);
        } catch {}
      };

      const onGripUp = (ev) => {
        if (!dragging) return;
        dragging = false;
        this.capsuleEl.dataset.pressing = 'false';
        try {
          this.gripEl.releasePointerCapture(ev.pointerId);
        } catch {}
        if (Math.hypot(ev.clientX - dragStartX, ev.clientY - dragStartY) < 8) {
          return;
        }
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const isTop = ev.clientY < vh * 0.45;
        const zone = ev.clientX < vw * 0.32 ? 'left' : ev.clientX > vw * 0.68 ? 'right' : 'center';
        this._state.dock = `${isTop ? 'top' : 'bottom'}-${zone}`;
        this._render();
      };

      const onGripCancel = (ev) => {
        if (!dragging) return;
        dragging = false;
        this.capsuleEl.dataset.pressing = 'false';
        try {
          this.gripEl.releasePointerCapture(ev.pointerId);
        } catch {}
      };

      this.pauseBtn.addEventListener('click', onPauseClick);
      this.closeBtn.addEventListener('click', onCloseAskClick);
      this.cancelConfirmBtn.addEventListener('click', onCancelConfirmClick);
      this.confirmDisconnectBtn.addEventListener('click', onConfirmReleaseClick);
      this.shieldEl.addEventListener('pointerdown', onShieldPointerDown);
      this.shieldEl.addEventListener('pointermove', onShieldPointerMove);
      this.shieldEl.addEventListener('pointerup', endShieldHold);
      this.shieldEl.addEventListener('pointercancel', endShieldHold);
      this.shieldEl.addEventListener('contextmenu', swallowLockedEvent);
      this.shieldEl.addEventListener('wheel', swallowLockedEvent, { passive: false });
      window.addEventListener('blur', endShieldHold);
      this.gripEl.addEventListener('pointerdown', onGripDown);
      this.gripEl.addEventListener('pointerup', onGripUp);
      this.gripEl.addEventListener('pointercancel', onGripCancel);

      this._cleanups.push(() => {
        this._cancelHoldUnlock();
        this._clearConfirmState();
        if (this._flashTimer) clearTimeout(this._flashTimer);
        if (this._cursorIdleTimer) clearTimeout(this._cursorIdleTimer);
        if (this._cursorPressTimer) clearTimeout(this._cursorPressTimer);
        this.pauseBtn.removeEventListener('click', onPauseClick);
        this.closeBtn.removeEventListener('click', onCloseAskClick);
        this.cancelConfirmBtn.removeEventListener('click', onCancelConfirmClick);
        this.confirmDisconnectBtn.removeEventListener('click', onConfirmReleaseClick);
        this.shieldEl.removeEventListener('pointerdown', onShieldPointerDown);
        this.shieldEl.removeEventListener('pointermove', onShieldPointerMove);
        this.shieldEl.removeEventListener('pointerup', endShieldHold);
        this.shieldEl.removeEventListener('pointercancel', endShieldHold);
        this.shieldEl.removeEventListener('contextmenu', swallowLockedEvent);
        this.shieldEl.removeEventListener('wheel', swallowLockedEvent);
        window.removeEventListener('blur', endShieldHold);
        this.gripEl.removeEventListener('pointerdown', onGripDown);
        this.gripEl.removeEventListener('pointerup', onGripUp);
        this.gripEl.removeEventListener('pointercancel', onGripCancel);
      });
    }

    _syncCapsuleWidth(instant = false) {
      const maxW = Math.max(220, (window.innerWidth || 1280) - 28);
      const naturalW = Math.min(maxW, Math.ceil(this.trackEl.offsetWidth));
      if (naturalW <= 0) return;
      if (instant) {
        const prev = this.capsuleEl.style.transition;
        this.capsuleEl.style.transition = 'none';
        this.capsuleEl.style.width = `${naturalW}px`;
        void this.capsuleEl.offsetWidth;
        this.capsuleEl.style.transition = prev;
      } else {
        this.capsuleEl.style.width = `${naturalW}px`;
      }
    }

    _render() {
      if (!this.hostEl.isConnected && document.documentElement) {
        document.documentElement.appendChild(this.hostEl);
      }
      const t = this._t();
      this.gripEl.title = t.dragTip;
      this.closeBtn.title = t.closeTip;
      this.holdTextEl.textContent = t.holdingHint;
      this.cancelConfirmBtn.textContent = t.cancelBtn;
      this.confirmDisconnectBtn.textContent = t.disconnectBtn;

      if (!this._state.visible) {
        this._wasVisible = false;
        this._cancelHoldUnlock();
        this._clearConfirmState();
        this.capsuleEl.dataset.hidden = 'true';
        this.cursorEl.dataset.visible = 'false';
        this.shieldEl.dataset.locked = 'false';
        this.borderEl.removeAttribute('data-state');
        return;
      }

      const isLockedWorking = this._state.mode === 'working';
      this.shieldEl.dataset.locked = String(isLockedWorking);
      if (!isLockedWorking) {
        this._cancelHoldUnlock();
      }

      this.capsuleEl.dataset.dock = this._state.dock;
      this.borderEl.dataset.state = this._state.mode;

      if (this._state.confirmingDisconnect) {
        this.orbEl.dataset.state = 'confirm';
        this.brandEl.textContent = t.confirmAsk;
        this.sepEl.classList.add('hidden-el');
        this.labelEl.classList.add('hidden-el');
        this.normalActionsEl.classList.add('hidden-el');
        this.confirmActionsEl.classList.remove('hidden-el');
      } else {
        this.orbEl.dataset.state = this._state.mode;
        this.brandEl.textContent = 'Chrome Live';
        this.sepEl.classList.remove('hidden-el');
        this.labelEl.classList.remove('hidden-el');
        this.labelEl.textContent = this._state.flashText || this._state.activity || t.ready;
        this.labelEl.dataset.shimmer = String(isLockedWorking && !this._state.flashText);

        const isPaused = this._state.mode === 'paused';
        this.pauseBtn.textContent = isPaused ? t.resume : t.pause;
        this.pauseBtn.dataset.primary = isPaused ? 'resume' : '';
        this.normalActionsEl.classList.remove('hidden-el');
        this.confirmActionsEl.classList.add('hidden-el');
      }

      const firstAppear = !this._wasVisible;
      this._wasVisible = true;
      this._syncCapsuleWidth(firstAppear);
      this.capsuleEl.dataset.hidden = 'false';
    }

    update(payload = {}) {
      if (payload.lang === 'zh' || payload.lang === 'en') {
        this._state.lang = payload.lang;
      }
      if (typeof payload.visible === 'boolean') this._state.visible = payload.visible;
      if (typeof payload.mode === 'string') {
        this._state.mode = payload.mode;
        this._clearConfirmState();
        this._state.userActionQueue.length = 0;
      }
      if (typeof payload.activity === 'string') {
        this._state.activity = payload.activity;
        this._state.flashText = '';
      }
      if (typeof payload.dock === 'string') this._state.dock = payload.dock;
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
      }, 440);
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
