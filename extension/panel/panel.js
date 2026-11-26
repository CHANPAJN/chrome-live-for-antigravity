const I18N = {
  zh: {
    langBtn: 'EN',
    connOnline: '本地桥接已就绪 · 空闲零开销',
    connOffline: '守护服务未响应 · 请运行 chrome-live start',
    navConsole: '操控台',
    navPlaybooks: '直达路书',
    navSettings: '配对与护栏',
    noActiveTab: '未检测到可操控网页',
    shareCta: '接管当前标签页',
    sharedCta: '✓ 当前页已接管 · 点击释放',
    pausedCta: '❚❚ 人工接管中 · 点击释放',
    blockedInternalReason: '浏览器内部页面受沙箱隔离保护，不可接管',
    blockedFinanceReason: '当前属于受保护的收银台/网银域名，已自动阻断',
    lockNote: '操控执行中网页自动防误触锁定；在页面任意处按住鼠标左键满 3 秒可原地解锁。',
    pausedNote: '当前页面已解锁交还手动操作；点下方列表「继续」可恢复锁定操控。',
    managedTitle: '受控与已共享标签页',
    releaseAll: '全部释放',
    emptyManaged: '暂无受控页面 · 按 Alt+Shift+L 即可共享当前已登录页',
    btnFocus: '定位',
    btnRelayOut: '副屏接力',
    btnRelayBack: '归队',
    btnPause: '暂停',
    btnResume: '继续',
    btnDetach: '释放',
    auditTitle: '实时动作流水',
    clearBtn: '清空',
    emptyAudit: '本次会话尚无操作记录',
    pbToggleTitle: '本地路书自动记忆',
    pbToggleDesc: '自动剥离敏感 Token 与追踪参数，沉淀深层后台直达 URL 与稳定选择器，二次访问 1 步跳转。',
    pbQuickAddTitle: '添加站点路书',
    pbTypeRoute: '捷径',
    pbTypeTip: '提示',
    pbTypeSelector: '定位',
    pbRouteKeyPh: '捷径名称（如：待发货订单）',
    pbRouteValPh: '直达网址或子路径（如 /admin/orders）',
    pbTipPlaceholder: '例如：日期框只读，需点击弹窗日历单元格',
    pbSelKeyPh: '控件名称（如：搜索框）',
    pbSelValPh: 'CSS 选择器（如 #search-input）',
    pbSaveTipBtn: '保存到本地路书',
    pbSavedTitle: '已记录的具体路书（可点击编辑）',
    pbClearAll: '清空全部',
    pbConfirmClear: '确认清空？',
    pbEmptySites: '暂无沉淀站点 · 浏览深层子页面自动记忆，或在上方手动保存捷径与提示',
    pbDeleteSite: '清空此站',
    pbKindRoute: '捷径',
    pbKindSelector: '定位',
    pbKindTip: '提示',
    pbEditBtn: '编辑',
    pbDelItemBtn: '×',
    pbSaveInline: '保存',
    pbCancelInline: '取消',
    pairTitle: '本地守护进程配对',
    resetPort: '恢复 28196',
    portLabel: '监听端口 (127.0.0.1)',
    tokenLabel: '本地配对口令 (Token)',
    savePairing: '保存配对并重连',
    guardTitle: '金融与收银台硬护栏',
    guardAlways: '常驻开启',
    guardDesc: '触碰支付网关、收银台路径或网银域名时，后台毫秒级强制断开调试器交还本人操作。',
    customGuardLabel: '自定义额外保护域名（每行一个）',
    saveGuard: '更新自定义拦截名单',
    toastSaved: '设置已保存并生效',
    toastCopied: '口令已复制到剪贴板',
    toastTipSaved: '路书条目已保存生效',
    toastCleared: '记录已清空',
    toastError: '本地守护服务未连接，操作未生效',
    blockedSuffix: ' [拦截]',
    actionLabels: {
      share_tab: '共享标签页',
      unshare_tab: '取消共享',
      open: '后台打开网页',
      snapshot: '读取元素快照',
      click: '点击交互',
      type: '填入文本',
      upload: '上传本地文件',
      scroll: '滚动视口',
      navigate: '页面跳转',
      extract: '多页并发提取',
      batch: '批量连招执行',
      wait: '等待页面就绪',
      screenshot: '抓取实时画面',
      done: '任务收尾释放',
      focus_tab: '定位标签页',
      relay_popout: '拆出副屏接力',
      relay_merge: '归队合回主窗',
      remote_interact: '聊天框原地遥操',
      inspect_region: '画面框选识别',
      release_tab: '释放标签页',
      reload_extension: '热重载扩展'
    }
  },
  en: {
    langBtn: '中文',
    connOnline: 'Local bridge connected · Zero idle CPU',
    connOffline: 'Daemon offline · Run "chrome-live start"',
    navConsole: 'Console',
    navPlaybooks: 'Playbooks',
    navSettings: 'Settings',
    noActiveTab: 'No scriptable web page active',
    shareCta: 'Attach Current Tab',
    sharedCta: '✓ Tab Attached · Click to Release',
    pausedCta: '❚❚ Manual Mode · Click to Release',
    blockedInternalReason: 'Browser internal pages are isolated from automation',
    blockedFinanceReason: 'Protected checkout/banking domain — automation blocked',
    lockNote: 'Pages lock against accidental clicks while active; hold left-click for 3s anywhere to unlock.',
    pausedNote: 'Unlocked for manual input; click "Resume" below to re-enable automation lock.',
    managedTitle: 'Controlled & Shared Tabs',
    releaseAll: 'Release All',
    emptyManaged: 'No tabs attached · Press Alt+Shift+L to share your signed-in tab',
    btnFocus: 'Focus',
    btnRelayOut: 'Popout',
    btnRelayBack: 'Merge',
    btnPause: 'Pause',
    btnResume: 'Resume',
    btnDetach: 'Detach',
    auditTitle: 'Activity Stream',
    clearBtn: 'Clear',
    emptyAudit: 'No actions recorded in this session',
    pbToggleTitle: 'Auto-Learn Site Playbooks',
    pbToggleDesc: 'Caches sanitized deep-link URLs and stable selectors locally (stripping auth/tracking params) for 1-step repeat navigation.',
    pbQuickAddTitle: 'Add to Playbook',
    pbTypeRoute: 'Route',
    pbTypeTip: 'Tip',
    pbTypeSelector: 'Selector',
    pbRouteKeyPh: 'Shortcut name (e.g. Orders List)',
    pbRouteValPh: 'Direct URL or path (e.g. /admin/orders)',
    pbTipPlaceholder: 'e.g. Date input is read-only; click calendar popup cells',
    pbSelKeyPh: 'Element alias (e.g. Search input)',
    pbSelValPh: 'CSS selector (e.g. #search-input)',
    pbSaveTipBtn: 'Save to Playbook',
    pbSavedTitle: 'Saved Domain Playbooks (Editable)',
    pbClearAll: 'Clear All',
    pbConfirmClear: 'Confirm?',
    pbEmptySites: 'No site playbooks saved yet',
    pbDeleteSite: 'Remove Site',
    pbKindRoute: 'Route',
    pbKindSelector: 'Selector',
    pbKindTip: 'Tip',
    pbEditBtn: 'Edit',
    pbDelItemBtn: '×',
    pbSaveInline: 'Save',
    pbCancelInline: 'Cancel',
    pairTitle: 'Local Bridge Pairing',
    resetPort: 'Reset 28196',
    portLabel: 'Daemon Port (127.0.0.1)',
    tokenLabel: 'Pairing Token',
    savePairing: 'Save & Reconnect',
    guardTitle: 'Financial & Security Guardrails',
    guardAlways: 'Always On',
    guardDesc: 'Checkout routes, Stripe, PayPal, Alipay, WeChat Pay, banking, and cloud billing auto-detach immediately.',
    customGuardLabel: 'Additional Protected Domains (one per line)',
    saveGuard: 'Update Protected Domains',
    toastSaved: 'Settings saved',
    toastCopied: 'Token copied to clipboard',
    toastTipSaved: 'Widget tip saved to playbook',
    toastCleared: 'Cleared',
    toastError: 'Daemon offline — action failed',
    blockedSuffix: ' [BLOCKED]',
    actionLabels: {
      share_tab: 'Shared Tab',
      unshare_tab: 'Unshared Tab',
      open: 'Opened Tab',
      snapshot: 'DOM Snapshot',
      click: 'Clicked Element',
      type: 'Typed Input',
      upload: 'Uploaded File',
      scroll: 'Scrolled Page',
      navigate: 'Navigated',
      extract: 'Parallel Extract',
      batch: 'Batch Pipeline',
      wait: 'Waited Ready',
      screenshot: 'Captured Frame',
      done: 'Task Done',
      focus_tab: 'Focused Tab',
      relay_popout: 'Relay Popout',
      relay_merge: 'Merged Relay',
      remote_interact: 'Inline Remote',
      inspect_region: 'Region Inspect',
      release_tab: 'Released Tab',
      reload_extension: 'Hot Reload'
    }
  }
};

const $ = (id) => document.getElementById(id);

const els = {
  connDot: $('connDot'),
  portChip: $('portChip'),
  connSubText: $('connSubText'),
  langBtn: $('langBtn'),
  reconnectBtn: $('reconnectBtn'),
  navConsole: $('navConsole'),
  navPlaybooks: $('navPlaybooks'),
  navPlaybooksLabel: $('navPlaybooksLabel'),
  navPlaybooksCount: $('navPlaybooksCount'),
  navSettings: $('navSettings'),
  paneConsole: $('paneConsole'),
  panePlaybooks: $('panePlaybooks'),
  paneSettings: $('paneSettings'),
  curTabTitle: $('curTabTitle'),
  curTabHost: $('curTabHost'),
  primaryShareBtn: $('primaryShareBtn'),
  primaryShareLabel: $('primaryShareLabel'),
  lockGestureNote: $('lockGestureNote'),
  managedSectionTitle: $('managedSectionTitle'),
  managedCountBadge: $('managedCountBadge'),
  releaseAllBtn: $('releaseAllBtn'),
  managedTabList: $('managedTabList'),
  auditSectionTitle: $('auditSectionTitle'),
  clearAuditBtn: $('clearAuditBtn'),
  auditList: $('auditList'),
  pbToggleTitle: $('pbToggleTitle'),
  pbToggleDesc: $('pbToggleDesc'),
  pbSwitchBtn: $('pbSwitchBtn'),
  pbQuickAddTitle: $('pbQuickAddTitle'),
  pbTypeRoute: $('pbTypeRoute'),
  pbTypeTip: $('pbTypeTip'),
  pbTypeSelector: $('pbTypeSelector'),
  pbDomainInput: $('pbDomainInput'),
  pbKeyInput: $('pbKeyInput'),
  pbTipInput: $('pbTipInput'),
  pbAddTipBtn: $('pbAddTipBtn'),
  pbSavedTitle: $('pbSavedTitle'),
  pbClearAllBtn: $('pbClearAllBtn'),
  pbSiteList: $('pbSiteList'),
  pairCardTitle: $('pairCardTitle'),
  resetPortBtn: $('resetPortBtn'),
  portFieldLabel: $('portFieldLabel'),
  portInput: $('portInput'),
  tokenFieldLabel: $('tokenFieldLabel'),
  tokenInput: $('tokenInput'),
  toggleTokenVisBtn: $('toggleTokenVisBtn'),
  copyTokenBtn: $('copyTokenBtn'),
  savePairingBtn: $('savePairingBtn'),
  guardCardTitle: $('guardCardTitle'),
  guardAlwaysBadge: $('guardAlwaysBadge'),
  guardCardDesc: $('guardCardDesc'),
  customGuardLabel: $('customGuardLabel'),
  customDomainsInput: $('customDomainsInput'),
  saveGuardBtn: $('saveGuardBtn'),
  toastBar: $('toastBar')
};

let currentLang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
let activeNav = 'console';
let stateCache = null;
let fullPlaybooksCache = {};
let confirmClearArmed = false;
let confirmClearTimer = null;
let toastTimer = null;
let pbDomainEditedByUser = false;
let pbFormKind = 'route'; // 'route' | 'tip' | 'selector'
let pbFormTouchedByUser = false;
let editingPlaybookKey = null; // e.g. "linux.do::route::LINUX DO"

function t() {
  return I18N[currentLang] || I18N.en;
}

function showToast(text) {
  if (toastTimer) clearTimeout(toastTimer);
  els.toastBar.textContent = text;
  els.toastBar.dataset.shown = 'true';
  toastTimer = setTimeout(() => {
    els.toastBar.dataset.shown = 'false';
  }, 1900);
}

function sendSw(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false });
    });
  });
}

function extractHost(rawUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return rawUrl.slice(0, 48);
  }
}

function switchTabPane(target) {
  activeNav = target;
  for (const [name, btn, pane] of [
    ['console', els.navConsole, els.paneConsole],
    ['playbooks', els.navPlaybooks, els.panePlaybooks],
    ['settings', els.navSettings, els.paneSettings]
  ]) {
    const selected = name === target;
    btn.setAttribute('aria-selected', String(selected));
    pane.dataset.active = String(selected);
  }
  if (target === 'playbooks') {
    refreshFullPlaybooks();
  }
}

function applyStaticLabels() {
  const d = t();
  els.langBtn.textContent = d.langBtn;
  els.navConsole.textContent = d.navConsole;
  els.navPlaybooksLabel.textContent = d.navPlaybooks;
  els.navSettings.textContent = d.navSettings;
  els.managedSectionTitle.textContent = d.managedTitle;
  els.releaseAllBtn.textContent = d.releaseAll;
  els.auditSectionTitle.textContent = d.auditTitle;
  els.clearAuditBtn.textContent = d.clearBtn;
  els.pbToggleTitle.textContent = d.pbToggleTitle;
  els.pbToggleDesc.textContent = d.pbToggleDesc;
  els.pbQuickAddTitle.textContent = d.pbQuickAddTitle;
  els.pbTypeRoute.textContent = d.pbTypeRoute;
  els.pbTypeTip.textContent = d.pbTypeTip;
  els.pbTypeSelector.textContent = d.pbTypeSelector;
  syncPlaybookFormModeUI();
  els.pbAddTipBtn.textContent = d.pbSaveTipBtn;
  els.pbSavedTitle.textContent = d.pbSavedTitle;
  els.pbClearAllBtn.textContent = confirmClearArmed ? d.pbConfirmClear : d.pbClearAll;
  els.pairCardTitle.textContent = d.pairTitle;
  els.resetPortBtn.textContent = d.resetPort;
  els.portFieldLabel.textContent = d.portLabel;
  els.tokenFieldLabel.textContent = d.tokenLabel;
  els.savePairingBtn.textContent = d.savePairing;
  els.guardCardTitle.textContent = d.guardTitle;
  els.guardAlwaysBadge.textContent = d.guardAlways;
  els.guardCardDesc.textContent = d.guardDesc;
  els.customGuardLabel.textContent = d.customGuardLabel;
  els.saveGuardBtn.textContent = d.saveGuard;
}

function renderCurrentPageHero(act) {
  const d = t();
  if (!act || !act.url) {
    els.curTabTitle.textContent = d.noActiveTab;
    els.curTabHost.textContent = '—';
    els.primaryShareBtn.disabled = true;
    els.primaryShareBtn.dataset.shared = 'false';
    els.primaryShareBtn.dataset.paused = 'false';
    els.primaryShareLabel.textContent = d.shareCta;
    els.lockGestureNote.textContent = d.lockNote;
    return;
  }

  const host = extractHost(act.url);
  els.curTabTitle.textContent = act.title || host || act.url;
  els.curTabTitle.title = act.title || act.url;
  els.curTabHost.textContent = act.url;
  els.curTabHost.title = act.url;

  if (!pbDomainEditedByUser && document.activeElement !== els.pbDomainInput && host && /^https?:/i.test(act.url)) {
    els.pbDomainInput.value = host;
  }
  if (
    pbFormKind === 'route' &&
    !pbFormTouchedByUser &&
    document.activeElement !== els.pbKeyInput &&
    document.activeElement !== els.pbTipInput &&
    /^https?:/i.test(act.url)
  ) {
    try {
      const parsed = new URL(act.url);
      if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname.length > 1) {
        const sensitiveRx =
          /(?:^utm_|^fbclid$|^gclid$|^spm$|^from$|^ref$|^_t$|^t$|^ts$|^timestamp$|^nonce$|token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))/i;
        for (const [key, val] of Array.from(parsed.searchParams.entries())) {
          if (sensitiveRx.test(key) || val.length >= 32 || /https?:\/\/|[?#=&%]/i.test(val)) {
            parsed.searchParams.delete(key);
          }
        }
        els.pbKeyInput.value = (act.title || parsed.pathname).split(/\s+[-|·—]\s+/)[0].trim().slice(0, 36);
        els.pbTipInput.value = `${parsed.pathname}${parsed.search}`;
      }
    } catch {}
  }

  if (!act.safetyAllowed) {
    els.primaryShareBtn.disabled = true;
    els.primaryShareBtn.dataset.shared = 'false';
    els.primaryShareBtn.dataset.paused = 'false';
    els.primaryShareLabel.textContent = d.shareCta;
    const isInternal = !/^https?:/i.test(act.url);
    els.lockGestureNote.textContent = isInternal ? d.blockedInternalReason : d.blockedFinanceReason;
    return;
  }

  els.primaryShareBtn.disabled = false;
  if (act.isManaged && act.isPaused) {
    els.primaryShareBtn.dataset.shared = 'false';
    els.primaryShareBtn.dataset.paused = 'true';
    els.primaryShareLabel.textContent = d.pausedCta;
    els.lockGestureNote.textContent = d.pausedNote;
  } else if (act.isManaged || act.isShared) {
    els.primaryShareBtn.dataset.shared = 'true';
    els.primaryShareBtn.dataset.paused = 'false';
    els.primaryShareLabel.textContent = d.sharedCta;
    els.lockGestureNote.textContent = d.lockNote;
  } else {
    els.primaryShareBtn.dataset.shared = 'false';
    els.primaryShareBtn.dataset.paused = 'false';
    els.primaryShareLabel.textContent = d.shareCta;
    els.lockGestureNote.textContent = d.lockNote;
  }
}

function renderManagedTabs(tabs = []) {
  const d = t();
  els.managedCountBadge.textContent = String(tabs.length);
  els.releaseAllBtn.classList.toggle('hidden', tabs.length === 0);
  els.managedTabList.replaceChildren();

  if (tabs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = d.emptyManaged;
    els.managedTabList.appendChild(empty);
    return;
  }

  for (const item of tabs) {
    const li = document.createElement('li');
    li.className = 'managed-row';

    const left = document.createElement('div');
    left.className = 'managed-left';

    const dot = document.createElement('span');
    dot.className = 'mode-dot';
    dot.dataset.mode = item.paused ? 'paused' : item.uiMode || 'shared';

    const texts = document.createElement('div');
    texts.className = 'managed-texts';

    const title = document.createElement('div');
    title.className = 'managed-title';
    title.textContent = item.title || extractHost(item.url) || `Tab #${item.tabId}`;
    title.title = `${item.title || ''}\n${item.url || ''}`;

    const sub = document.createElement('div');
    sub.className = 'managed-sub';
    const host = extractHost(item.url);
    sub.textContent = item.activity ? `${item.activity} · ${host}` : host;

    texts.append(title, sub);
    left.append(dot, texts);

    const tools = document.createElement('div');
    tools.className = 'row-tools';

    const focusBtn = document.createElement('button');
    focusBtn.type = 'button';
    focusBtn.className = 'mini-action';
    focusBtn.textContent = d.btnFocus;
    focusBtn.addEventListener('click', () => {
      sendSw('panel:focus_tab', { tabId: item.tabId });
    });

    const relayBtn = document.createElement('button');
    relayBtn.type = 'button';
    relayBtn.className = 'mini-action';
    relayBtn.textContent = item.inRelayPopout ? d.btnRelayBack : d.btnRelayOut;
    relayBtn.addEventListener('click', async () => {
      await sendSw('panel:toggle_relay_tab', { tabId: item.tabId });
      await refreshAll();
    });

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'mini-action';
    pauseBtn.textContent = item.paused ? d.btnResume : d.btnPause;
    pauseBtn.addEventListener('click', async () => {
      await sendSw('panel:toggle_pause_tab', { tabId: item.tabId });
      await refreshAll();
    });

    const detachBtn = document.createElement('button');
    detachBtn.type = 'button';
    detachBtn.className = 'mini-action danger';
    detachBtn.textContent = d.btnDetach;
    detachBtn.addEventListener('click', async () => {
      await sendSw('panel:detach_tab', { tabId: item.tabId });
      await refreshAll();
    });

    tools.append(focusBtn, relayBtn, pauseBtn, detachBtn);
    li.append(left, tools);
    els.managedTabList.appendChild(li);
  }
}

function renderAuditStream(audit = []) {
  const d = t();
  els.auditList.replaceChildren();
  if (!audit.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = d.emptyAudit;
    els.auditList.appendChild(empty);
    return;
  }

  for (const entry of audit.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = 'audit-row';

    const main = document.createElement('div');
    main.className = 'audit-main';

    const tag = document.createElement('span');
    tag.className = 'audit-tag';
    const isBlocked = entry.status === 'blocked';
    tag.dataset.blocked = String(isBlocked);
    const friendly = d.actionLabels[entry.action] || entry.action;
    tag.textContent = isBlocked ? `${friendly}${d.blockedSuffix}` : friendly;

    const detail = document.createElement('span');
    detail.className = 'audit-detail';
    const extra =
      entry.detail?.label ||
      extractHost(entry.detail?.url || '') ||
      (entry.detail?.tabId ? `#${entry.detail.tabId}` : '');
    detail.textContent = extra;
    main.title = entry.detail?.url || extra || friendly;

    main.append(tag, detail);

    const timeEl = document.createElement('span');
    timeEl.className = 'audit-time';
    timeEl.textContent = new Date(entry.ts || Date.now()).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    li.append(main, timeEl);
    els.auditList.appendChild(li);
  }
}

function syncPlaybookFormModeUI() {
  const d = t();
  for (const [kind, btn] of [
    ['route', els.pbTypeRoute],
    ['tip', els.pbTypeTip],
    ['selector', els.pbTypeSelector]
  ]) {
    btn.setAttribute('aria-selected', String(pbFormKind === kind));
  }
  if (pbFormKind === 'tip') {
    els.pbKeyInput.classList.add('hidden');
    els.pbTipInput.placeholder = d.pbTipPlaceholder;
  } else if (pbFormKind === 'selector') {
    els.pbKeyInput.classList.remove('hidden');
    els.pbKeyInput.placeholder = d.pbSelKeyPh;
    els.pbTipInput.placeholder = d.pbSelValPh;
  } else {
    els.pbKeyInput.classList.remove('hidden');
    els.pbKeyInput.placeholder = d.pbRouteKeyPh;
    els.pbTipInput.placeholder = d.pbRouteValPh;
  }
}

function formatReadableRoutePath(domain, fullUrl) {
  try {
    const u = new URL(fullUrl);
    const pathAndQuery = `${u.pathname}${u.search}${u.hash}`;
    if (u.hostname.toLowerCase() === domain.toLowerCase() && !u.port) {
      return pathAndQuery || '/';
    }
    return `${u.host}${pathAndQuery}`;
  } catch {
    return fullUrl;
  }
}

function renderPlaybookSites(sitesObj = {}) {
  const d = t();
  els.pbSiteList.replaceChildren();
  const domains = Object.keys(sitesObj);

  if (domains.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = d.pbEmptySites;
    els.pbSiteList.appendChild(empty);
    return;
  }

  for (const domain of domains) {
    const info = sitesObj[domain] || {};
    const routesEntries = Object.entries(info.routes || {});
    const selectorEntries = Object.entries(info.selectors || {});
    const tipEntries = Array.isArray(info.tips) ? info.tips : [];

    const card = document.createElement('div');
    card.className = 'pb-site-card';

    const head = document.createElement('div');
    head.className = 'pb-site-head';

    const domWrap = document.createElement('div');
    domWrap.className = 'pb-domain-wrap';

    const domTitle = document.createElement('span');
    domTitle.className = 'pb-domain';
    domTitle.textContent = domain;

    const metaCounts = [];
    if (routesEntries.length) metaCounts.push(`${routesEntries.length} ${d.pbKindRoute}`);
    if (selectorEntries.length) metaCounts.push(`${selectorEntries.length} ${d.pbKindSelector}`);
    if (tipEntries.length) metaCounts.push(`${tipEntries.length} ${d.pbKindTip}`);
    const countSpan = document.createElement('span');
    countSpan.className = 'pb-count-meta';
    countSpan.textContent = metaCounts.join(' · ');

    domWrap.append(domTitle, countSpan);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'text-danger-btn';
    delBtn.textContent = d.pbDeleteSite;
    delBtn.addEventListener('click', async () => {
      await sendSw('panel:playbook_action', { body: { action: 'clear', domain } });
      await refreshFullPlaybooks();
      await refreshAll();
    });

    head.append(domWrap, delBtn);
    card.appendChild(head);

    const listEl = document.createElement('div');
    listEl.className = 'pb-entry-list';

    const buildEditableRow = ({ kind, itemId, titleNode, codeText, initKey, initVal, onSave, onDelete }) => {
      const row = document.createElement('div');
      row.className = 'pb-entry-row';

      if (editingPlaybookKey === itemId) {
        const editor = document.createElement('div');
        editor.className = 'pb-inline-editor';

        let keyField = null;
        if (kind !== 'tip') {
          keyField = document.createElement('input');
          keyField.type = 'text';
          keyField.className = 'field-input';
          keyField.value = initKey || '';
          editor.appendChild(keyField);
        }

        const valField = document.createElement('input');
        valField.type = 'text';
        valField.className = 'field-input';
        valField.value = initVal || '';
        editor.appendChild(valField);

        const btnBar = document.createElement('div');
        btnBar.className = 'pb-inline-actions';

        const cancelB = document.createElement('button');
        cancelB.type = 'button';
        cancelB.className = 'mini-action';
        cancelB.textContent = d.pbCancelInline;
        cancelB.addEventListener('click', () => {
          editingPlaybookKey = null;
          renderPlaybookSites(fullPlaybooksCache);
        });

        const saveB = document.createElement('button');
        saveB.type = 'button';
        saveB.className = 'mini-action';
        saveB.textContent = d.pbSaveInline;
        saveB.addEventListener('click', async () => {
          const nextK = keyField ? keyField.value.trim() : '';
          const nextV = valField.value.trim();
          if ((kind !== 'tip' && !nextK) || !nextV) return;
          const r = await onSave(nextK, nextV);
          if (!r || !r.ok) {
            showToast(r?.error || t().toastError);
            return;
          }
          editingPlaybookKey = null;
          showToast(t().toastTipSaved);
          await refreshFullPlaybooks();
          await refreshAll();
        });

        btnBar.append(cancelB, saveB);
        editor.appendChild(btnBar);
        row.appendChild(editor);
        return row;
      }

      const top = document.createElement('div');
      top.className = 'pb-entry-top';

      const main = document.createElement('div');
      main.className = 'pb-entry-main';

      const pill = document.createElement('span');
      pill.className = 'pb-kind-pill';
      pill.dataset.kind = kind;
      pill.textContent =
        kind === 'route' ? d.pbKindRoute : kind === 'selector' ? d.pbKindSelector : d.pbKindTip;

      main.append(pill, titleNode);

      const tools = document.createElement('div');
      tools.className = 'pb-entry-tools';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'pb-mini-btn';
      editBtn.textContent = d.pbEditBtn;
      editBtn.addEventListener('click', () => {
        editingPlaybookKey = itemId;
        renderPlaybookSites(fullPlaybooksCache);
      });

      const xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.className = 'pb-mini-btn danger';
      xBtn.textContent = d.pbDelItemBtn;
      xBtn.addEventListener('click', async () => {
        await onDelete();
        await refreshFullPlaybooks();
        await refreshAll();
      });

      tools.append(editBtn, xBtn);
      top.append(main, tools);
      row.appendChild(top);

      if (codeText) {
        const codeLine = document.createElement('div');
        codeLine.className = 'pb-url-code';
        codeLine.textContent = codeText;
        codeLine.title = initVal || codeText;
        row.appendChild(codeLine);
      }

      return row;
    };

    // 1. Direct Routes (shows both human label AND actual shortcut path/URL!)
    for (const [rName, rUrl] of routesEntries) {
      const a = document.createElement('a');
      a.className = 'pb-route-link';
      a.textContent = `↗ ${rName}`;
      a.title = rUrl;
      a.addEventListener('click', () => {
        if (typeof rUrl === 'string' && /^https?:\/\//i.test(rUrl.trim())) {
          chrome.tabs.create({ url: rUrl.trim(), active: true });
        }
      });

      listEl.appendChild(
        buildEditableRow({
          kind: 'route',
          itemId: `${domain}::route::${rName}`,
          titleNode: a,
          codeText: formatReadableRoutePath(domain, rUrl),
          initKey: rName,
          initVal: rUrl,
          onSave: (nextName, nextUrl) =>
            sendSw('panel:playbook_action', {
              body: { action: 'save', domain, route: { name: nextName, url: nextUrl, oldName: rName } }
            }),
          onDelete: () =>
            sendSw('panel:playbook_action', {
              body: { action: 'delete_item', domain, kind: 'route', key: rName }
            })
        })
      );
    }

    // 2. Stable CSS Selectors (previously hidden, now visible & editable!)
    for (const [sName, sCss] of selectorEntries) {
      const titleSpan = document.createElement('span');
      titleSpan.className = 'pb-entry-title';
      titleSpan.textContent = sName;

      listEl.appendChild(
        buildEditableRow({
          kind: 'selector',
          itemId: `${domain}::sel::${sName}`,
          titleNode: titleSpan,
          codeText: sCss,
          initKey: sName,
          initVal: sCss,
          onSave: (nextName, nextCss) =>
            sendSw('panel:playbook_action', {
              body: { action: 'save', domain, selector: { name: nextName, css: nextCss, oldName: sName } }
            }),
          onDelete: () =>
            sendSw('panel:playbook_action', {
              body: { action: 'delete_item', domain, kind: 'selector', key: sName }
            })
        })
      );
    }

    // 3. UI Widget Workaround Tips
    tipEntries.forEach((tip, idx) => {
      const tipSpan = document.createElement('span');
      tipSpan.className = 'pb-tip-body';
      tipSpan.textContent = tip;

      listEl.appendChild(
        buildEditableRow({
          kind: 'tip',
          itemId: `${domain}::tip::${idx}`,
          titleNode: tipSpan,
          codeText: '',
          initKey: '',
          initVal: tip,
          onSave: (_k, nextTip) =>
            sendSw('panel:playbook_action', {
              body: { action: 'save', domain, tip: nextTip, tipIndex: idx }
            }),
          onDelete: () =>
            sendSw('panel:playbook_action', {
              body: { action: 'delete_item', domain, kind: 'tip', index: idx }
            })
        })
      );
    });

    card.appendChild(listEl);
    els.pbSiteList.appendChild(card);
  }
}

async function refreshFullPlaybooks() {
  const res = await sendSw('panel:get_playbooks_full');
  if (res && res.sites) {
    fullPlaybooksCache = res.sites;
    renderPlaybookSites(fullPlaybooksCache);
  }
}

function renderAll() {
  applyStaticLabels();
  if (!stateCache) return;
  const d = t();
  const s = stateCache;

  const port = s.port || 28196;
  els.connDot.dataset.connected = String(Boolean(s.wsConnected));
  els.portChip.textContent = `127.0.0.1:${port}`;
  els.connSubText.textContent = s.wsConnected ? d.connOnline : d.connOffline;

  const pb = s.playbook || { enabled: false, siteCount: 0 };
  els.navPlaybooksCount.textContent = String(pb.siteCount || 0);
  els.pbSwitchBtn.setAttribute('aria-checked', String(Boolean(pb.enabled)));

  if (document.activeElement !== els.portInput) {
    els.portInput.value = String(port);
  }
  if (document.activeElement !== els.tokenInput && s.token) {
    els.tokenInput.value = s.token;
  }
  if (document.activeElement !== els.customDomainsInput && Array.isArray(s.customBlockedDomains)) {
    els.customDomainsInput.value = s.customBlockedDomains.join('\n');
  }

  renderCurrentPageHero(s.currentActiveTab);
  renderManagedTabs(s.tabs || []);
  renderAuditStream(s.audit || []);
}

async function getCurrentWindowId() {
  try {
    if (chrome.windows && typeof chrome.windows.getCurrent === 'function') {
      const w = await chrome.windows.getCurrent();
      if (w && typeof w.id === 'number') return w.id;
    }
  } catch {}
  return undefined;
}

async function refreshAll() {
  const windowId = await getCurrentWindowId();
  const res = await sendSw('panel:get_state', { windowId });
  if (!res || !res.ok) return;
  if (res.lang === 'zh' || res.lang === 'en') {
    currentLang = res.lang;
  }
  stateCache = res;
  renderAll();
}

// Navigation events
els.navConsole.addEventListener('click', () => switchTabPane('console'));
els.navPlaybooks.addEventListener('click', () => switchTabPane('playbooks'));
els.navSettings.addEventListener('click', () => switchTabPane('settings'));

els.langBtn.addEventListener('click', async () => {
  const next = currentLang === 'zh' ? 'en' : 'zh';
  currentLang = next;
  renderAll();
  if (activeNav === 'playbooks') renderPlaybookSites(fullPlaybooksCache);
  await sendSw('panel:set_lang', { lang: next });
  await refreshAll();
});

els.reconnectBtn.addEventListener('click', async () => {
  await sendSw('panel:reconnect');
  setTimeout(refreshAll, 260);
});

els.primaryShareBtn.addEventListener('click', async () => {
  const windowId = await getCurrentWindowId();
  await sendSw('panel:share_active_tab', { windowId });
  await refreshAll();
});

els.releaseAllBtn.addEventListener('click', async () => {
  await sendSw('panel:release_all');
  await refreshAll();
});

els.clearAuditBtn.addEventListener('click', async () => {
  await sendSw('panel:clear_audit');
  showToast(t().toastCleared);
  await refreshAll();
});

els.pbDomainInput.addEventListener('input', () => {
  pbDomainEditedByUser = els.pbDomainInput.value.trim().length > 0;
});

els.pbKeyInput.addEventListener('input', () => {
  pbFormTouchedByUser = true;
});
els.pbTipInput.addEventListener('input', () => {
  pbFormTouchedByUser = true;
});

for (const [kind, btn] of [
  ['route', els.pbTypeRoute],
  ['tip', els.pbTypeTip],
  ['selector', els.pbTypeSelector]
]) {
  btn.addEventListener('click', () => {
    pbFormKind = kind;
    pbFormTouchedByUser = false;
    els.pbKeyInput.value = '';
    els.pbTipInput.value = '';
    syncPlaybookFormModeUI();
    renderAll();
  });
}

els.pbSwitchBtn.addEventListener('click', async () => {
  const cur = els.pbSwitchBtn.getAttribute('aria-checked') === 'true';
  const r = await sendSw('panel:playbook_action', {
    body: { action: 'set_enabled', enabled: !cur }
  });
  if (!r || !r.ok) showToast(t().toastError);
  await refreshAll();
});

els.pbAddTipBtn.addEventListener('click', async () => {
  const domain = els.pbDomainInput.value.trim();
  const keyVal = els.pbKeyInput.value.trim();
  const mainVal = els.pbTipInput.value.trim();
  if (!domain || !mainVal) return;

  let body;
  if (pbFormKind === 'route') {
    if (!keyVal) return;
    body = { action: 'save', domain, route: { name: keyVal, url: mainVal } };
  } else if (pbFormKind === 'selector') {
    if (!keyVal) return;
    body = { action: 'save', domain, selector: { name: keyVal, css: mainVal } };
  } else {
    body = { action: 'save', domain, tip: mainVal };
  }

  const r = await sendSw('panel:playbook_action', { body });
  if (r && r.ok) {
    els.pbKeyInput.value = '';
    els.pbTipInput.value = '';
    pbFormTouchedByUser = false;
    showToast(t().toastTipSaved);
    await refreshFullPlaybooks();
    await refreshAll();
  } else {
    showToast(r?.error || t().toastError);
  }
});

// Two-tap inline confirmation for destructive Clear All (OpenDesign rule 3: zero modal alert spam)
els.pbClearAllBtn.addEventListener('click', async () => {
  if (!confirmClearArmed) {
    confirmClearArmed = true;
    els.pbClearAllBtn.textContent = t().pbConfirmClear;
    if (confirmClearTimer) clearTimeout(confirmClearTimer);
    confirmClearTimer = setTimeout(() => {
      confirmClearArmed = false;
      els.pbClearAllBtn.textContent = t().pbClearAll;
    }, 3000);
    return;
  }
  confirmClearArmed = false;
  if (confirmClearTimer) clearTimeout(confirmClearTimer);
  const r = await sendSw('panel:playbook_action', { body: { action: 'clear' } });
  if (!r || !r.ok) {
    showToast(r?.error || t().toastError);
    return;
  }
  showToast(t().toastCleared);
  await refreshFullPlaybooks();
  await refreshAll();
});

els.resetPortBtn.addEventListener('click', () => {
  els.portInput.value = '28196';
});

els.toggleTokenVisBtn.addEventListener('click', () => {
  els.tokenInput.type = els.tokenInput.type === 'password' ? 'text' : 'password';
});

els.copyTokenBtn.addEventListener('click', async () => {
  const val = els.tokenInput.value.trim();
  if (!val) return;
  try {
    await navigator.clipboard.writeText(val);
    showToast(t().toastCopied);
  } catch {}
});

els.savePairingBtn.addEventListener('click', async () => {
  const cleanPort = Number.parseInt(els.portInput.value.replace(/\D+/g, ''), 10) || 28196;
  els.portInput.value = String(cleanPort);
  const token = els.tokenInput.value.trim();
  await sendSw('panel:save_config', { port: cleanPort, token });
  showToast(t().toastSaved);
  setTimeout(refreshAll, 300);
});

els.saveGuardBtn.addEventListener('click', async () => {
  const customBlockedDomains = els.customDomainsInput.value
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  await sendSw('panel:save_guardrails', { customBlockedDomains });
  showToast(t().toastSaved);
  await refreshAll();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sw:state_updated' && !document.hidden) {
    refreshAll();
  }
});

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!document.hidden && tab?.active && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) {
      refreshAll();
    }
  });
}
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => {
    if (!document.hidden) refreshAll();
  });
}

applyStaticLabels();
refreshAll();
