const EXT_VERSION = '1.0.0';
const STORAGE_CONFIG_KEY = 'chromeLive.config';
const STORAGE_GUARDRAILS_KEY = 'chromeLive.customBlockedDomains';
const STORAGE_LANG_KEY = 'chromeLive.lang';
const SESSION_STATE_KEY = 'chromeLive.sessionState';
const CDP_IDLE_DETACH_MS = 18000;
const KEEPALIVE_ALARM = 'chrome-live-keepalive';

const SW_I18N = {
  zh: {
    sharedReady: '已接管 · 等待指令',
    unshared: '已取消接管',
    released: '已释放控制权',
    workingPrefix: (label) => (label ? `执行中 · ${label}` : '已打开页面'),
    readingDom: '正在读取页面元素',
    clicking: (tgt) => `正在点击 ${tgt}`,
    typing: '正在输入文本',
    uploading: (n) => `正在上传文件 (${n})`,
    scrolling: (dir) => `正在滚动 (${dir})`,
    navigating: '正在跳转页面',
    loaded: (title) => `已加载 ${title}`,
    donePrefix: (sum) => `已完成 · ${sum}`,
    waiting: '正在等待页面响应',
    batchStep: (i, n) => `连招执行 (${i}/${n})`,
    groupTitle: 'Live · 操控中',
    groupShared: 'Live · 已共享',
    groupPaused: 'Live · 已暂停',
    groupDone: 'Live · 已完成'
  },
  en: {
    sharedReady: 'Attached · Ready for commands',
    unshared: 'Detached',
    released: 'Released',
    workingPrefix: (label) => (label ? `Working · ${label}` : 'Opened page'),
    readingDom: 'Reading page elements',
    clicking: (tgt) => `Clicking ${tgt}`,
    typing: 'Typing into field',
    uploading: (n) => `Uploading file (${n})`,
    scrolling: (dir) => `Scrolling ${dir}`,
    navigating: 'Navigating',
    loaded: (title) => `Loaded ${title}`,
    donePrefix: (sum) => `Done · ${sum}`,
    waiting: 'Waiting for page',
    batchStep: (i, n) => `Batch (${i}/${n})`,
    groupTitle: 'Live · Active',
    groupShared: 'Live · Shared',
    groupPaused: 'Live · Paused',
    groupDone: 'Live · Done'
  }
};

let currentLang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
function tr() {
  return SW_I18N[currentLang] || SW_I18N.en;
}

const BUILTIN_PROTECTED_DOMAINS = [
  'checkout.stripe.com',
  'billing.stripe.com',
  'paypal.com',
  'venmo.com',
  'wise.com',
  'revolut.com',
  'adyen.com',
  'braintreegateway.com',
  'alipay.com',
  'pay.weixin.qq.com',
  'tenpay.com',
  '95516.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citibank.com',
  'hsbc.com',
  'barclays.co.uk',
  'icbc.com.cn',
  'ccb.com',
  'abchina.com',
  'boc.cn',
  'cmbchina.com',
  'psbc.com',
  'bankcomm.com',
  'console.aws.amazon.com',
  'console.cloud.google.com',
  'portal.azure.com',
  'dash.cloudflare.com'
];

const CHECKOUT_PATH_RX = /\/(?:checkout|payment|payments|cashier|billing\/pay|wallet\/transfer)(?:\/|\?|$|#)/i;

let bridgeConfig = {
  host: '127.0.0.1',
  port: 28196,
  token: ''
};
let customBlockedDomains = [];

let ws = null;
let wsReconnectTimer = null;
let localAudit = [];

// tabId -> { tabId, substate: 'shared'|'worker', uiMode: string, attachedCdp: boolean, screencastActive: boolean, paused: boolean, title: string, url: string, activity: string, idleTimer: any }
const managedTabs = new Map();
const hudSyncLocks = new Map();
let liveTabGroupId = null;
let extractWindowId = null;
let extractWindowPromise = null;
let groupSerializeChain = Promise.resolve();
let activeExtractJobs = 0;

function pushLocalAudit(action, detail = {}, status = 'ok') {
  localAudit.unshift({ ts: Date.now(), action, detail, status });
  if (localAudit.length > 40) localAudit.length = 40;
}

function checkTabUrlAllowed(rawUrl) {
  if (!rawUrl || rawUrl === 'about:blank') return { allowed: true, reason: '' };
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'Malformed URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Restricted protocol ${parsed.protocol}` };
  }
  const reservedPorts = new Set(['9222', '9229', '28196', String(bridgeConfig.port || 28196)]);
  if (parsed.port && reservedPorts.has(parsed.port)) {
    return { allowed: false, reason: `Reserved local port ${parsed.port}` };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const rules = [...BUILTIN_PROTECTED_DOMAINS, ...customBlockedDomains];
  for (const r of rules) {
    const clean = String(r || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (clean && (host === clean || host.endsWith(`.${clean}`))) {
      return { allowed: false, reason: `Protected financial/security domain (${clean})` };
    }
  }
  const fullRoute = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (CHECKOUT_PATH_RX.test(fullRoute)) {
    return { allowed: false, reason: `Protected checkout/payment route (${parsed.pathname})` };
  }
  return { allowed: true, reason: '' };
}

async function persistSessionState() {
  try {
    await chrome.storage.local.set({
      [SESSION_STATE_KEY]: {
        liveTabGroupId,
        tabs: serializeTabs()
      }
    });
  } catch {}
}

async function restoreSessionState() {
  try {
    const saved = await chrome.storage.local.get(SESSION_STATE_KEY);
    const snap = saved?.[SESSION_STATE_KEY];
    if (!snap || typeof snap !== 'object') return;
    if (typeof snap.liveTabGroupId === 'number') {
      const grp = await chrome.tabGroups.get(snap.liveTabGroupId).catch(() => null);
      if (grp) liveTabGroupId = snap.liveTabGroupId;
    }
    if (Array.isArray(snap.tabs)) {
      for (const item of snap.tabs) {
        if (!item || typeof item.tabId !== 'number' || managedTabs.has(item.tabId)) continue;
        const liveTab = await chrome.tabs.get(item.tabId).catch(() => null);
        if (!liveTab || !liveTab.url || !checkTabUrlAllowed(liveTab.url).allowed) continue;
        managedTabs.set(item.tabId, {
          tabId: item.tabId,
          substate: item.substate === 'shared' ? 'shared' : 'worker',
          uiMode: item.uiMode || 'working',
          attachedCdp: false,
          screencastActive: false,
          paused: Boolean(item.paused),
          originWindowId: typeof item.originWindowId === 'number' ? item.originWindowId : null,
          originIndex: typeof item.originIndex === 'number' ? item.originIndex : null,
          relayPopoutWinId: typeof item.relayPopoutWinId === 'number' ? item.relayPopoutWinId : null,
          title: liveTab.title || item.title || '',
          url: liveTab.url || item.url || '',
          activity: item.activity || tr().sharedReady,
          idleTimer: null
        });
      }
    }
  } catch {}
}

async function loadBootstrapAndStorage() {
  // Always ensure keepalive alarm exists across browser/SW restarts
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.45 });
  await restoreSessionState();

  const stored = await chrome.storage.local.get([
    STORAGE_CONFIG_KEY,
    STORAGE_GUARDRAILS_KEY,
    STORAGE_LANG_KEY
  ]);
  if (stored[STORAGE_LANG_KEY] === 'zh' || stored[STORAGE_LANG_KEY] === 'en') {
    currentLang = stored[STORAGE_LANG_KEY];
  }
  if (Array.isArray(stored[STORAGE_GUARDRAILS_KEY])) {
    customBlockedDomains = stored[STORAGE_GUARDRAILS_KEY];
  }
  if (stored[STORAGE_CONFIG_KEY] && stored[STORAGE_CONFIG_KEY].token) {
    bridgeConfig = {
      host: '127.0.0.1',
      port: Number(stored[STORAGE_CONFIG_KEY].port) || 28196,
      token: String(stored[STORAGE_CONFIG_KEY].token)
    };
    return;
  }

  // Fallback: check optional local runtime file created by `chrome-live setup`
  try {
    const resp = await fetch(chrome.runtime.getURL('.local-runtime.json'));
    if (resp.ok) {
      const json = await resp.json();
      if (json && typeof json.token === 'string' && json.token.length >= 16) {
        bridgeConfig = {
          host: '127.0.0.1',
          port: Number(json.port) || 28196,
          token: json.token.trim()
        };
        await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: bridgeConfig });
      }
    }
  } catch {
    // .local-runtime.json not present yet; user can paste token in side panel or run `chrome-live setup`.
  }
}

function serializeTabs() {
  const list = [];
  for (const entry of managedTabs.values()) {
    list.push({
      tabId: entry.tabId,
      substate: entry.substate,
      uiMode: entry.uiMode || (entry.paused ? 'paused' : entry.substate === 'shared' ? 'shared' : 'working'),
      paused: entry.paused,
      inRelayPopout: Boolean(entry.relayPopoutWinId),
      originWindowId: entry.originWindowId ?? null,
      originIndex: entry.originIndex ?? null,
      relayPopoutWinId: entry.relayPopoutWinId ?? null,
      attachedCdp: entry.attachedCdp,
      title: entry.title,
      url: entry.url,
      activity: entry.activity
    });
  }
  return list;
}

function syncActionBadge() {
  const count = managedTabs.size;
  if (count === 0) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  let anyWorking = false;
  let allPaused = true;
  for (const e of managedTabs.values()) {
    if (!e.paused) allPaused = false;
    if (!e.paused && e.uiMode === 'working') anyWorking = true;
  }
  const bgColor = allPaused ? '#d97706' : anyWorking ? '#0284c7' : '#10b981';
  chrome.action.setBadgeBackgroundColor({ color: bgColor }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' }).catch(() => {});
  chrome.action.setBadgeText({ text: String(count) }).catch(() => {});
}

function notifyPanelAndDaemon() {
  syncActionBadge();
  persistSessionState();
  const tabs = serializeTabs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'status_sync',
        version: EXT_VERSION,
        tabs,
        customBlockedDomains
      })
    );
  }
  chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
}

function scheduleReconnect(delayMs = 3000) {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

async function connectWebSocket() {
  if (!bridgeConfig.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Probe HTTP liveness silently first so Chrome never logs WebSocket ERR_CONNECTION_REFUSED when daemon is stopped.
  try {
    const pingResp = await fetch(`http://${bridgeConfig.host}:${bridgeConfig.port}/api/ping`, {
      method: 'GET',
      cache: 'no-store'
    });
    if (!pingResp.ok) {
      scheduleReconnect(4000);
      return;
    }
  } catch {
    scheduleReconnect(4000);
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = `ws://${bridgeConfig.host}:${bridgeConfig.port}/ws/extension?token=${encodeURIComponent(bridgeConfig.token)}`;
  try {
    const sock = new WebSocket(wsUrl);
    ws = sock;

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      sock.send(
        JSON.stringify({
          type: 'hello',
          version: EXT_VERSION,
          tabs: serializeTabs(),
          customBlockedDomains
        })
      );
      chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
    });

    sock.addEventListener('message', async (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'rpc_request' && msg.id) {
        try {
          const result = await executeBridgeRpc(msg.method, msg.params || {});
          sock.send(JSON.stringify({ type: 'rpc_response', id: msg.id, ok: true, result }));
        } catch (err) {
          sock.send(
            JSON.stringify({
              type: 'rpc_response',
              id: msg.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            })
          );
        }
      }
    });

    sock.addEventListener('close', () => {
      if (ws === sock) {
        ws = null;
        chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
        scheduleReconnect(3500);
      }
    });

    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {}
    });
  } catch {
    scheduleReconnect(4000);
  }
}

async function runHudScriptSafe(tabId, opts, timeoutMs = 1200) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || t.discarded || t.status === 'unloaded') return null;
  let timer = null;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, ...opts }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function syncHudNow(tabId, payload) {
  const entry = managedTabs.get(tabId);
  if (entry && typeof payload.mode === 'string') {
    entry.uiMode = payload.mode;
  }
  const fullPayload = { lang: currentLang, ...payload };

  try {
    const fastRes = await runHudScriptSafe(tabId, {
      func: (data) => {
        const sweepOrphans = (keepEl) => {
          const kids = Array.from((document.documentElement || document.body)?.children || []);
          for (const el of kids) {
            if (el === keepEl) continue;
            if (
              el.hasAttribute?.('data-chrome-live-hud') ||
              (el.tagName === 'DIV' &&
                el.id === '' &&
                el.className === '' &&
                el.childElementCount === 0 &&
                (el.getAttribute('style') || '').includes('2147483646'))
            ) {
              el.remove();
            }
          }
        };
        const ctrl = window.__chromeLiveHudController__;
        if (ctrl && ctrl._hudRev === 10 && typeof ctrl.ping === 'function' && ctrl.ping()) {
          if (data.visible === false) sweepOrphans(ctrl.hostEl);
          ctrl.update(data);
          return { updated: true };
        }
        if (data.visible === false) {
          sweepOrphans(null);
          return { updated: true };
        }
        return { updated: false };
      },
      args: [fullPayload]
    });
    if (fastRes?.[0]?.result?.updated) return;
  } catch {
    return;
  }

  try {
    const injected = await runHudScriptSafe(tabId, { files: ['hud.js'] }, 1500);
    if (!injected) return;
    await runHudScriptSafe(tabId, {
      func: (data) => {
        const ctrl = window.__chromeLiveHudController__;
        if (ctrl && typeof ctrl.update === 'function') ctrl.update(data);
      },
      args: [fullPayload]
    });
  } catch {}
}

function syncHud(tabId, payload) {
  const prev = hudSyncLocks.get(tabId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => syncHudNow(tabId, payload))
    .finally(() => {
      if (hudSyncLocks.get(tabId) === next) {
        hudSyncLocks.delete(tabId);
      }
    });
  hudSyncLocks.set(tabId, next);
  return next;
}

async function reconcileHudAfterStartup() {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (!tab || typeof tab.id !== 'number' || tab.discarded || !/^https?:/i.test(tab.url || '')) continue;
      if (!checkTabUrlAllowed(tab.url || '').allowed) continue;
      const entry = managedTabs.get(tab.id);
      if (entry) {
        await syncHud(tab.id, {
          visible: true,
          mode: entry.paused ? 'paused' : entry.uiMode || 'working',
          activity: entry.activity
        });
      } else {
        await runHudScriptSafe(tab.id, {
          func: () => {
            const kids = Array.from((document.documentElement || document.body)?.children || []);
            for (const el of kids) {
              if (
                el.hasAttribute?.('data-chrome-live-hud') ||
                (el.tagName === 'DIV' &&
                  el.id === '' &&
                  el.className === '' &&
                  el.childElementCount === 0 &&
                  (el.getAttribute('style') || '').includes('2147483646'))
              ) {
                el.remove();
              }
            }
          }
        });
      }
    }
  } catch {}
}

async function pulseHudCoord(tabId, x, y) {
  await runHudScriptSafe(tabId, {
    func: (cx, cy) => {
      const ctrl = window.__chromeLiveHudController__;
      if (ctrl && typeof ctrl.pulseAt === 'function') ctrl.pulseAt({ x: cx, y: cy });
    },
    args: [x, y]
  });
}

async function pollHudUserEvents(tabId, entry) {
  try {
    const res = await runHudScriptSafe(tabId, {
      func: () => {
        const ctrl = window.__chromeLiveHudController__;
        return ctrl && typeof ctrl.drainUserEvents === 'function' ? ctrl.drainUserEvents() : null;
      }
    });
    const state = res?.[0]?.result;
    if (!state || !Array.isArray(state.events)) return;
    for (const ev of state.events) {
      if (ev === 'pause') {
        entry.paused = true;
        await syncLiveTabGroups();
      } else if (ev === 'resume') {
        entry.paused = false;
        await syncLiveTabGroups();
      } else if (ev === 'release') {
        await detachManagedTab(tabId, tr().released);
      }
    }
  } catch {}
}

function resetCdpIdleTimer(entry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    stopCdpForTab(entry.tabId).catch(() => {});
  }, CDP_IDLE_DETACH_MS);
}

async function ensureCdpForTab(tabId, entry) {
  resetCdpIdleTimer(entry);
  if (entry.attachedCdp) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  entry.attachedCdp = true;
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
  await chrome.debugger
    .sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 68,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 2
    })
    .then(() => {
      entry.screencastActive = true;
    })
    .catch(() => {});
}

async function stopCdpForTab(tabId) {
  const entry = managedTabs.get(tabId);
  if (!entry) return;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry.screencastActive) {
    entry.screencastActive = false;
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
  }
  if (entry.attachedCdp) {
    entry.attachedCdp = false;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function captureQuickFrame(tabId, entry, timeoutMs = 1200) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  try {
    await Promise.race([
      ensureCdpForTab(tabId, entry),
      new Promise((resolve) => setTimeout(resolve, 900))
    ]);
    if (!entry.attachedCdp) return null;
    const shot = await Promise.race([
      chrome.debugger
        .sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 72
        })
        .catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
    if (shot && shot.data) {
      ws.send(
        JSON.stringify({
          type: 'screencast_frame',
          tabId,
          mimeType: 'image/jpeg',
          data: shot.data,
          title: entry.title,
          url: entry.url,
          activity: entry.activity
        })
      );
      return shot.data;
    }
  } catch {}
  return null;
}

function isOurGroupTitle(title) {
  return /^(?:[▶●❚]+\s*)?Live\s*·\s*/i.test(String(title || '').trim());
}

async function syncLiveTabGroups() {
  syncActionBadge();
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      if (g.id !== liveTabGroupId && !isOurGroupTitle(g.title)) continue;
      const tabsInGroup = await chrome.tabs.query({ groupId: g.id });
      const orphanTabIds = [];
      const activeManagedInGroup = [];

      for (const t of tabsInGroup) {
        if (typeof t.id !== 'number') continue;
        const entry = managedTabs.get(t.id);
        if (!entry) {
          orphanTabIds.push(t.id);
        } else {
          activeManagedInGroup.push(entry);
        }
      }

      if (orphanTabIds.length > 0) {
        await chrome.tabs.ungroup(orphanTabIds).catch(() => {});
      }

      if (activeManagedInGroup.length === 0) {
        if (liveTabGroupId === g.id) liveTabGroupId = null;
        continue;
      }

      const allPaused = activeManagedInGroup.every((e) => e.paused);
      const anyWorking = activeManagedInGroup.some((e) => !e.paused && e.uiMode === 'working');
      let nextTitle = tr().groupShared;
      let nextColor = 'green';
      if (allPaused) {
        nextTitle = tr().groupPaused;
        nextColor = 'yellow';
      } else if (anyWorking) {
        nextTitle = tr().groupTitle;
        nextColor = 'cyan';
      }

      await chrome.tabGroups
        .update(g.id, {
          title: nextTitle,
          color: nextColor
        })
        .catch(() => {});
    }
  } catch {}
}

const recentDetachedTabs = new Map();

function rememberDetachedTab(tabId, reason = '', isGuardrail = false) {
  recentDetachedTabs.set(tabId, {
    reason: String(reason || 'Released'),
    isGuardrail: Boolean(isGuardrail),
    at: Date.now()
  });
  if (recentDetachedTabs.size > 64) {
    const oldest = recentDetachedTabs.keys().next().value;
    if (oldest !== undefined) recentDetachedTabs.delete(oldest);
  }
}

async function detachManagedTab(tabId, reason = '', isGuardrail = false) {
  const entry = managedTabs.get(tabId);
  managedTabs.delete(tabId);
  rememberDetachedTab(tabId, reason, isGuardrail);
  if (entry) {
    await stopCdpForTab(tabId);
  }
  await syncHud(tabId, { visible: false, activity: reason || tr().released });
  // Ungroup tab from the Live group immediately upon release
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.groupId === 'number' && tab.groupId >= 0) {
      const grp = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (grp && (grp.id === liveTabGroupId || isOurGroupTitle(grp.title))) {
        await chrome.tabs.ungroup(tabId).catch(() => {});
      }
    }
  } catch {}
  await syncLiveTabGroups();
  notifyPanelAndDaemon();
}

async function shareTab(tab, toggleIfAlreadyShared = false) {
  if (!tab || typeof tab.id !== 'number') return;
  const existing = managedTabs.get(tab.id);
  if (existing && toggleIfAlreadyShared) {
    await detachManagedTab(tab.id, 'Unshared');
    pushLocalAudit('unshare_tab', { tabId: tab.id });
    return;
  }

  const safety = checkTabUrlAllowed(tab.url || '');
  if (!safety.allowed) {
    pushLocalAudit('share_tab', { tabId: tab.id, url: tab.url, reason: safety.reason }, 'blocked');
    notifyPanelAndDaemon();
    return;
  }

  const entry = {
    tabId: tab.id,
    substate: 'shared',
    uiMode: 'working',
    attachedCdp: false,
    screencastActive: false,
    paused: false,
    title: tab.title || '',
    url: tab.url || '',
    activity: tr().sharedReady,
    idleTimer: null
  };
  managedTabs.set(tab.id, entry);
  // Immediately attach cyan "Live · 操控中" badge (without collapsing foreground tab) and lock HUD!
  if (typeof tab.groupId !== 'number' || tab.groupId < 0) {
    await placeInBackgroundTabGroup(tab.id, tab.windowId, false, 'cyan', tr().groupTitle);
  } else {
    await syncLiveTabGroups();
  }
  await syncHud(tab.id, {
    visible: true,
    mode: 'working',
    activity: entry.activity
  });
  await captureQuickFrame(tab.id, entry);
  pushLocalAudit('share_tab', { tabId: tab.id, url: tab.url });
  notifyPanelAndDaemon();
}

async function placeInBackgroundTabGroup(
  tabId,
  windowId,
  collapse = true,
  color = 'cyan',
  customTitle = ''
) {
  const job = groupSerializeChain.then(async () => {
    try {
      let groupId = liveTabGroupId;
      if (groupId !== null) {
        const existing = await chrome.tabGroups.get(groupId).catch(() => null);
        if (!existing || existing.windowId !== windowId) groupId = null;
      }
      const nextGroupId = await chrome.tabs.group({
        tabIds: [tabId],
        ...(groupId !== null ? { groupId } : {})
      });
      liveTabGroupId = nextGroupId;
      const updateProps = {
        title: customTitle || tr().groupTitle,
        color
      };
      if (collapse) {
        updateProps.collapsed = true;
      }
      await chrome.tabGroups.update(nextGroupId, updateProps);
    } catch {}
  });
  groupSerializeChain = job.catch(() => {});
  return job;
}

async function popoutRelayTab(entry, focus = true) {
  const tab = await chrome.tabs.get(entry.tabId);
  if (entry.relayPopoutWinId) {
    const existingPop = await chrome.windows.get(entry.relayPopoutWinId).catch(() => null);
    if (existingPop && tab.windowId === existingPop.id) {
      if (focus) {
        await chrome.windows.update(existingPop.id, { focused: true }).catch(() => {});
      }
      return { tabId: entry.tabId, inRelayPopout: true, relayWindowId: existingPop.id };
    }
    entry.relayPopoutWinId = null;
  }

  entry.originWindowId = tab.windowId;
  entry.originIndex = tab.index;
  entry.originGroupId = typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : -1;
  entry.paused = true;
  entry.uiMode = 'paused';
  entry.activity = currentLang === 'zh' ? '副屏接力操控中 · 点继续归队' : 'Relay window · Resume to merge back';

  await chrome.tabs.ungroup(entry.tabId).catch(() => {});
  const origWin = await chrome.windows.get(tab.windowId).catch(() => null);
  const popWidth = Math.min(1040, Math.max(740, Math.round((origWin?.width || 1400) * 0.58)));
  const popHeight = Math.min(880, Math.max(600, origWin?.height || 820));

  const createdWin = await chrome.windows.create({
    tabId: entry.tabId,
    type: 'normal',
    width: popWidth,
    height: popHeight,
    focused: focus
  });
  entry.relayPopoutWinId = createdWin?.id ?? null;

  await syncHud(entry.tabId, {
    visible: true,
    mode: 'paused',
    activity: entry.activity
  });
  await syncLiveTabGroups();
  await captureQuickFrame(entry.tabId, entry);
  pushLocalAudit('relay_popout', { tabId: entry.tabId, url: entry.url });
  notifyPanelAndDaemon();
  return { tabId: entry.tabId, inRelayPopout: true, relayWindowId: entry.relayPopoutWinId };
}

async function mergeRelayTabBack(entry) {
  const prevOriginWinId = entry.originWindowId;
  const prevOriginIndex = entry.originIndex;
  const prevOriginGroupId = typeof entry.originGroupId === 'number' ? entry.originGroupId : -1;
  entry.relayPopoutWinId = null;
  entry.originWindowId = null;
  entry.originIndex = null;
  entry.originGroupId = -1;

  let targetWindowId = null;
  if (typeof prevOriginWinId === 'number') {
    const origExists = await chrome.windows.get(prevOriginWinId).catch(() => null);
    if (origExists && origExists.type === 'normal') {
      targetWindowId = origExists.id;
    }
  }
  if (targetWindowId === null) {
    const curTab = await chrome.tabs.get(entry.tabId).catch(() => null);
    const allNormal = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    const otherWin = allNormal.find((w) => w.id !== curTab?.windowId);
    if (otherWin) targetWindowId = otherWin.id;
  }

  if (targetWindowId !== null) {
    await chrome.tabs
      .move(entry.tabId, {
        windowId: targetWindowId,
        index: typeof prevOriginIndex === 'number' ? prevOriginIndex : -1
      })
      .catch(() => {});
    if (entry.substate === 'worker') {
      await placeInBackgroundTabGroup(
        entry.tabId,
        targetWindowId,
        true,
        'cyan',
        tr().groupTitle
      );
    } else if (prevOriginGroupId >= 0) {
      await chrome.tabs
        .group({ tabIds: [entry.tabId], groupId: prevOriginGroupId })
        .catch(() => {});
    }
  }

  entry.paused = false;
  entry.uiMode = 'working';
  entry.activity = currentLang === 'zh' ? '已交还归队 · AI 恢复接管' : 'Merged back · AI resumed';

  await syncHud(entry.tabId, {
    visible: true,
    mode: 'working',
    activity: entry.activity
  });
  await syncLiveTabGroups();
  await captureQuickFrame(entry.tabId, entry);
  pushLocalAudit('relay_merge', { tabId: entry.tabId, url: entry.url });
  notifyPanelAndDaemon();
  return { tabId: entry.tabId, inRelayPopout: false, mergedToWindowId: targetWindowId };
}

function resolveTargetEntry(requestedTabId) {
  if (requestedTabId !== undefined && requestedTabId !== null && requestedTabId !== '') {
    const numId = Number(requestedTabId);
    if (!Number.isFinite(numId)) {
      throw new Error(`Invalid tabId parameter: ${requestedTabId}`);
    }
    if (managedTabs.has(numId)) {
      return managedTabs.get(numId);
    }
    const detached = recentDetachedTabs.get(numId);
    if (detached?.isGuardrail) {
      throw new Error(`[GUARDRAIL] Detached tab #${numId} because it navigated to ${detached.reason}`);
    }
    throw new Error(
      `Tab #${numId} is no longer controlled (${detached?.reason || 'not attached'}).`
    );
  }
  // Prefer user-shared tab first, otherwise most recent worker tab
  for (const e of managedTabs.values()) {
    if (e.substate === 'shared') return e;
  }
  let last = null;
  for (const e of managedTabs.values()) {
    last = e;
  }
  if (!last) {
    throw new Error(
      'No shared or controlled tab available. Share a tab with Alt+Shift+L or run "chrome-live open <url>".'
    );
  }
  return last;
}

async function execScriptBounded(tabId, scriptOptions, timeoutMs = 6500) {
  const cur = await chrome.tabs.get(tabId).catch(() => null);
  if (cur?.discarded) {
    await chrome.tabs.reload(tabId).catch(() => {});
    await waitForTabComplete(tabId, 9000);
  }
  let timer = null;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, ...scriptOptions }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tab #${tabId} script execution timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertTabReadyForAction(entry) {
  await pollHudUserEvents(entry.tabId, entry);
  if (!managedTabs.has(entry.tabId)) {
    throw new Error('Tab was released by user');
  }
  if (entry.paused) {
    throw new Error('Tab automation is currently paused by user in the HUD');
  }
  const liveTab = await chrome.tabs.get(entry.tabId);
  if (liveTab.discarded) {
    await chrome.tabs.reload(entry.tabId).catch(() => {});
    await waitForTabComplete(entry.tabId, 9000);
  }
  entry.title = liveTab.title || '';
  entry.url = liveTab.url || '';
  const safety = checkTabUrlAllowed(entry.url);
  if (!safety.allowed) {
    await detachManagedTab(entry.tabId, safety.reason, true);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'guardrail_trip',
          tabId: entry.tabId,
          url: entry.url,
          reason: safety.reason
        })
      );
    }
    throw new Error(`[GUARDRAIL] Detached tab because it navigated to ${safety.reason}`);
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current || current.status === 'complete') return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function executeBridgeRpc(method, params) {
  pushLocalAudit(method, { tabId: params.tabId, url: params.url, label: params.label });

  if (method === 'reload_extension') {
    setTimeout(() => {
      chrome.runtime.reload();
    }, 80);
    return { reloading: true };
  }

  if (method === 'share_active') {
    let [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
      windowType: 'normal'
    });
    if (!activeTab) {
      [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    if (!activeTab) throw new Error('No active Chrome tab found');
    await shareTab(activeTab, false);
    return { tabId: activeTab.id, title: activeTab.title, shared: true };
  }

  if (method === 'focus_tab') {
    const entry = resolveTargetEntry(params.tabId);
    const tab = await chrome.tabs.update(entry.tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return { tabId: entry.tabId, focused: true };
  }

  if (method === 'relay_popout') {
    const entry = resolveTargetEntry(params.tabId);
    return await popoutRelayTab(entry, params.focus !== false);
  }

  if (method === 'relay_merge') {
    const entry = resolveTargetEntry(params.tabId);
    return await mergeRelayTabBack(entry);
  }

  if (method === 'remote_interact') {
    const entry = resolveTargetEntry(params.tabId);
    const liveTab = await chrome.tabs.get(entry.tabId);
    entry.title = liveTab.title || '';
    entry.url = liveTab.url || '';
    const safety = checkTabUrlAllowed(entry.url);
    if (!safety.allowed) {
      await detachManagedTab(entry.tabId, safety.reason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId: entry.tabId,
            url: entry.url,
            reason: safety.reason
          })
        );
      }
      throw new Error(`[GUARDRAIL] Detached tab because it navigated to ${safety.reason}`);
    }
    const kind = String(params.kind || 'click');

    if (kind === 'click') {
      const rx = Math.min(0.995, Math.max(0.005, Number(params.rx) || 0.5));
      const ry = Math.min(0.995, Math.max(0.005, Number(params.ry) || 0.5));
      const vpRes = await execScriptBounded(entry.tabId, {
        func: (normX, normY) => {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const px = Math.round(normX * vw);
          const py = Math.round(normY * vh);
          const ctrl = window.__chromeLiveHudController__;
          if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = 'none';
          if (ctrl && typeof ctrl.moveCursor === 'function') {
            ctrl.moveCursor({ x: px, y: py, kind: 'click', press: true });
          }
          return { px, py, hidden: document.hidden };
        },
        args: [rx, ry]
      });
      const vp = vpRes?.[0]?.result || { px: 640, py: 400, hidden: false };
      let hitViaCdp = false;
      if (!vp.hidden) {
        try {
          await ensureCdpForTab(entry.tabId, entry);
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: vp.px,
            y: vp.py
          });
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: vp.px,
            y: vp.py,
            button: 'left',
            buttons: 1,
            clickCount: 1
          });
          await new Promise((r) => setTimeout(r, 52));
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: vp.px,
            y: vp.py,
            button: 'left',
            buttons: 0,
            clickCount: 1
          });
          hitViaCdp = true;
        } catch {}
      }
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: (px, py, usedCdp) => {
            if (!usedCdp) {
              const targetEl = document.elementFromPoint(px, py);
              if (targetEl) {
                targetEl.focus?.();
                targetEl.click?.();
              }
            }
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
          },
          args: [vp.px, vp.py, hitViaCdp]
        })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 200));
      await captureQuickFrame(entry.tabId, entry);
      notifyPanelAndDaemon();
      return { tabId: entry.tabId, clickedAt: { x: vp.px, y: vp.py } };
    }

    if (kind === 'wheel') {
      const deltaY = Math.max(-1600, Math.min(1600, Number(params.deltaY) || 360));
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
        func: (dy) => {
          window.scrollBy({ top: dy, behavior: document.hidden ? 'instant' : 'smooth' });
        },
        args: [deltaY]
      });
      await new Promise((r) => setTimeout(r, 180));
      await captureQuickFrame(entry.tabId, entry);
      return { tabId: entry.tabId, scrolledBy: deltaY };
    }

    if (kind === 'key_text') {
      const val = String(params.text ?? '');
      const shouldSubmit = Boolean(params.submit);
      const ceIndex = typeof params.ceIndex === 'number' ? params.ceIndex : -1;
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
        func: (str, sub, ceIdx) => {
          let el = ceIdx >= 0 ? document.querySelectorAll('[contenteditable="true"]')[ceIdx] : document.activeElement;
          if (
            !el ||
            el === document.body ||
            (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !el.isContentEditable)
          ) {
            el = document.querySelector(
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, [contenteditable="true"]'
            );
          }
          if (!el) return;
          el.focus?.();
          if (el.isContentEditable) {
            const sel = window.getSelection?.();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, str);
            if (!inserted) {
              el.textContent = str;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str }));
            }
          } else {
            const proto =
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, str);
            else el.value = str;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (sub) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            el.form?.requestSubmit?.();
          }
        },
        args: [val, shouldSubmit, ceIndex]
      });
      await new Promise((r) => setTimeout(r, 220));
      await captureQuickFrame(entry.tabId, entry);
      notifyPanelAndDaemon();
      return { tabId: entry.tabId, typed: val.length };
    }

    throw new Error(`Unsupported remote_interact kind: ${kind}`);
  }

  if (method === 'inspect_region') {
    const entry = resolveTargetEntry(params.tabId);
    const liveTab = await chrome.tabs.get(entry.tabId);
    entry.title = liveTab.title || '';
    entry.url = liveTab.url || '';
    const safety = checkTabUrlAllowed(entry.url);
    if (!safety.allowed) {
      await detachManagedTab(entry.tabId, safety.reason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId: entry.tabId,
            url: entry.url,
            reason: safety.reason
          })
        );
      }
      throw new Error(`[GUARDRAIL] Detached tab because it navigated to ${safety.reason}`);
    }
    const rx1 = Math.min(1, Math.max(0, Number(params.rx1) || 0));
    const ry1 = Math.min(1, Math.max(0, Number(params.ry1) || 0));
    const rx2 = Math.min(1, Math.max(0, Number(params.rx2) || 1));
    const ry2 = Math.min(1, Math.max(0, Number(params.ry2) || 1));

    const regionRes = await execScriptBounded(entry.tabId, {
      func: (nx1, ny1, nx2, ny2) => {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const xMin = Math.min(nx1, nx2) * vw;
        const xMax = Math.max(nx1, nx2) * vw;
        const yMin = Math.min(ny1, ny2) * vh;
        const yMax = Math.max(ny1, ny2) * vh;

        function collectDeep(root, sel, depth = 0, acc = []) {
          if (!root || depth > 6) return acc;
          try {
            for (const n of root.querySelectorAll(sel)) acc.push(n);
          } catch {}
          for (const h of root.querySelectorAll('*')) {
            if (h === window.__chromeLiveHudController__?.hostEl) continue;
            if (h.shadowRoot) collectDeep(h.shadowRoot, sel, depth + 1, acc);
          }
          return acc;
        }

        const cands = collectDeep(
          document,
          'a[href], button, input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="button"], [role="link"], [role="tab"], h1, h2, h3, td, li'
        );
        const scored = [];
        for (const el of cands) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const overlapW = Math.min(r.right, xMax) - Math.max(r.left, xMin);
          const overlapH = Math.min(r.bottom, yMax) - Math.max(r.top, yMin);
          if (overlapW < 3 || overlapH < 3) continue;
          const rawLabel = (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.textContent ||
            el.value ||
            el.getAttribute('name') ||
            el.id ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 72);
          const tagLower = el.tagName.toLowerCase();
          const isFormField =
            tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select' || el.isContentEditable;
          const label =
            rawLabel || (isFormField ? `<${tagLower}${el.type ? `[type=${el.type}]` : ''}>` : '');
          if (!label) continue;
          const tid = el.getAttribute('data-testid');
          const selector = tid
            ? `[data-testid="${CSS.escape(tid)}"]`
            : el.id
              ? `#${CSS.escape(el.id)}`
              : el.getAttribute('name')
                ? `${tagLower}[name="${CSS.escape(el.getAttribute('name'))}"]`
                : tagLower;
          const area = Math.max(16, r.width * r.height);
          scored.push({
            area,
            item: {
              tag: tagLower,
              label,
              selector,
              href: el.tagName === 'A' ? el.href : undefined
            }
          });
        }
        scored.sort((a, b) => a.area - b.area);
        const matched = scored.slice(0, 10).map((s) => s.item);
        return {
          url: location.href,
          title: document.title,
          boxPx: { x1: Math.round(xMin), y1: Math.round(yMin), x2: Math.round(xMax), y2: Math.round(yMax) },
          elements: matched
        };
      },
      args: [rx1, ry1, rx2, ry2]
    });

    return { tabId: entry.tabId, ...(regionRes?.[0]?.result || { elements: [] }) };
  }

  if (method === 'release_tab') {
    if (params.all) {
      for (const id of Array.from(managedTabs.keys())) {
        await detachManagedTab(id, 'Released');
      }
      return { releasedAll: true };
    }
    const entry = resolveTargetEntry(params.tabId);
    await detachManagedTab(entry.tabId, 'Released');
    return { tabId: entry.tabId, released: true };
  }

  if (method === 'batch') {
    const steps = Array.isArray(params.steps) ? params.steps.slice(0, 12) : [];
    if (steps.length === 0) throw new Error('batch requires a non-empty steps array');

    let currentTabId = typeof params.tabId === 'number' ? params.tabId : undefined;
    const stepResults = [];
    let finalSnapshot = null;

    for (let i = 0; i < steps.length; i++) {
      const rawStep = steps[i];
      if (!rawStep || typeof rawStep !== 'object') continue;
      const action = String(rawStep.action || rawStep.method || rawStep.cmd || '').trim();
      if (!action || action === 'batch') {
        throw new Error(`Invalid batch step action at index ${i}: "${action}"`);
      }

      const stepParams = { ...rawStep };
      delete stepParams.action;
      delete stepParams.method;
      delete stepParams.cmd;
      if (stepParams.tabId === undefined && currentTabId !== undefined) {
        stepParams.tabId = currentTabId;
      }

      if (currentTabId !== undefined && managedTabs.has(currentTabId)) {
        const curEntry = managedTabs.get(currentTabId);
        curEntry.activity = `${tr().batchStep(i + 1, steps.length)} · ${action}`;
        await syncHud(currentTabId, {
          visible: true,
          mode: 'working',
          activity: curEntry.activity
        });
      }

      const out = await executeBridgeRpc(action, stepParams);
      if (out && typeof out.tabId === 'number') {
        currentTabId = out.tabId;
      }
      if (action === 'snapshot') {
        finalSnapshot = out;
      }
      stepResults.push({ step: i, action, ok: true, result: out });
    }

    return {
      completedSteps: stepResults.length,
      totalSteps: steps.length,
      tabId: currentTabId ?? null,
      stepResults,
      finalSnapshot
    };
  }

  if (method === 'open') {
    const url = String(params.url || '').trim();
    const safety = checkTabUrlAllowed(url);
    if (!safety.allowed) throw new Error(`[GUARDRAIL] ${safety.reason}`);

    const background = params.background !== false;
    const created = await chrome.tabs.create({ url, active: !background });
    if (!created || typeof created.id !== 'number') {
      throw new Error('Failed to create browser tab');
    }
    if (background) {
      await placeInBackgroundTabGroup(created.id, created.windowId);
    }
    await waitForTabComplete(created.id, 14000);
    const updatedTab = await chrome.tabs.get(created.id);
    const postCheck = checkTabUrlAllowed(updatedTab.url || '');
    if (!postCheck.allowed) {
      await chrome.tabs.remove(created.id).catch(() => {});
      throw new Error(`[GUARDRAIL] Redirected to protected URL: ${postCheck.reason}`);
    }

    const activity = tr().workingPrefix(params.label);
    const entry = {
      tabId: created.id,
      substate: 'worker',
      attachedCdp: false,
      screencastActive: false,
      paused: false,
      title: updatedTab.title || '',
      url: updatedTab.url || url,
      activity,
      idleTimer: null
    };
    managedTabs.set(created.id, entry);
    await syncHud(created.id, { visible: true, mode: 'working', activity });
    await captureQuickFrame(created.id, entry);
    notifyPanelAndDaemon();
    return { tabId: created.id, title: entry.title, url: entry.url };
  }

  if (method === 'extract') {
    const urls = Array.isArray(params.urls) ? params.urls.slice(0, 8) : [];
    const scrollSteps = Math.min(5, Math.max(0, Number(params.scrollSteps ?? 1)));
    if (urls.length === 0) throw new Error('extract requires at least one URL');
    for (const u of urls) {
      const check = checkTabUrlAllowed(u);
      if (!check.allowed) throw new Error(`[GUARDRAIL] ${check.reason} (${u})`);
    }

    // Prefer opening inactive background tabs inside an existing normal window (zero taskbar popup/flicker)
    let hostWindowId = null;
    try {
      const normalWins = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const focusedWin = normalWins.find((w) => w.focused) || normalWins[0];
      if (focusedWin && typeof focusedWin.id === 'number') {
        hostWindowId = focusedWin.id;
      }
    } catch {}

    if (hostWindowId === null) {
      if (extractWindowId !== null) {
        const existingWin = await chrome.windows.get(extractWindowId).catch(() => null);
        if (!existingWin) extractWindowId = null;
      }
      if (extractWindowId === null) {
        if (!extractWindowPromise) {
          extractWindowPromise = chrome.windows
            .create({
              url: 'about:blank',
              state: 'minimized',
              focused: false
            })
            .then((win) => {
              extractWindowId = win?.id ?? null;
              return extractWindowId;
            })
            .finally(() => {
              extractWindowPromise = null;
            });
        }
        await extractWindowPromise;
      }
      hostWindowId = extractWindowId;
    }

    activeExtractJobs += urls.length;
    try {
      const results = await Promise.all(
        urls.map(async (targetUrl) => {
          let workerTab = null;
          try {
            workerTab = await chrome.tabs.create({
              windowId: hostWindowId ?? undefined,
              url: targetUrl,
              active: false
            });
            await waitForTabComplete(workerTab.id, 15000);
            const finalTab = await chrome.tabs.get(workerTab.id);
            const postSafety = checkTabUrlAllowed(finalTab.url || '');
            if (!postSafety.allowed) {
              return { url: targetUrl, error: postSafety.reason };
            }

            const injected = await chrome.scripting.executeScript({ target: { tabId: workerTab.id  }, injectImmediately: true,
              func: async (steps) => {
                for (let i = 0; i < steps; i++) {
                  window.scrollBy(0, Math.round(window.innerHeight * 0.85));
                  await new Promise((r) => setTimeout(r, 320));
                }
                const root =
                  document.querySelector('article, main, [role="main"]') || document.body;
                const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
                let text = '';
                if (root) {
                  const parts = [];
                  let accLen = 0;
                  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                  let node;
                  while ((node = walker.nextNode())) {
                    const p = node.parentElement;
                    if (!p) continue;
                    if (SKIP_TAGS.has(p.tagName) || p.closest('style, script, noscript, template, [data-chrome-live-hud]')) {
                      continue;
                    }
                    const chunk = node.nodeValue || '';
                    if (!chunk.trim()) continue;
                    parts.push(chunk);
                    accLen += chunk.length + 1;
                    if (accLen >= 22000) break;
                  }
                  text = parts
                    .join(' ')
                    .replace(/\s+\n/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .replace(/[ \t]{2,}/g, ' ')
                    .trim()
                    .slice(0, 18000);
                }

                const imgSet = new Set();
                for (const img of document.querySelectorAll('img')) {
                  const src = img.currentSrc || img.src || '';
                  if (/^https?:\/\//i.test(src) && (img.naturalWidth >= 280 || img.width >= 280)) {
                    imgSet.add(src);
                  }
                }
                return {
                  title: document.title,
                  finalUrl: location.href,
                  text,
                  images: Array.from(imgSet).slice(0, 24)
                };
              },
              args: [scrollSteps]
            });
            return injected?.[0]?.result || { url: targetUrl, text: '', images: [] };
          } finally {
            if (workerTab && typeof workerTab.id === 'number') {
              await chrome.tabs.remove(workerTab.id).catch(() => {});
            }
          }
        })
      );
      return { items: results };
    } finally {
      activeExtractJobs = Math.max(0, activeExtractJobs - urls.length);
      if (activeExtractJobs === 0 && extractWindowId !== null) {
        const winToClose = extractWindowId;
        extractWindowId = null;
        await chrome.windows.remove(winToClose).catch(() => {});
      }
    }
  }

  const entry = resolveTargetEntry(params.tabId);
  await assertTabReadyForAction(entry);

  if (method === 'snapshot') {
    const maxItems = Math.min(200, Math.max(10, Number(params.maxItems) || 90));
    entry.activity = tr().readingDom;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: (limit) => {
        const SELECTORS =
          'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="switch"], [role="radio"], [role="checkbox"], [role="option"], [role="menuitem"], [contenteditable="true"], label:has(input[type="radio"]), label:has(input[type="checkbox"])';

        function collectDeep(root, sel, depth = 0, acc = []) {
          if (!root || depth > 6) return acc;
          try {
            for (const n of root.querySelectorAll(sel)) acc.push(n);
          } catch {}
          let allNodes;
          try {
            allNodes = root.querySelectorAll('*');
          } catch {
            allNodes = [];
          }
          for (const host of allNodes) {
            if (host.hasAttribute && host.hasAttribute('data-chrome-live-hud')) continue;
            if (host.shadowRoot) {
              collectDeep(host.shadowRoot, sel, depth + 1, acc);
            }
          }
          return acc;
        }

        const candidates = collectDeep(document, SELECTORS);
        const elements = [];
        let idx = 0;

        for (const node of candidates) {
          if (idx >= limit) break;
          if (node.closest && node.closest('[data-chrome-live-hud]')) continue;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;

          const tagLower = node.tagName.toLowerCase();
          let linkedInput = null;
          if (tagLower === 'label') {
            linkedInput = node.querySelector('input[type="radio"], input[type="checkbox"]');
            if (linkedInput) {
              const inpStyle = window.getComputedStyle(linkedInput);
              const inpRect = linkedInput.getBoundingClientRect();
              const inpVisible =
                inpStyle.display !== 'none' &&
                inpStyle.visibility !== 'hidden' &&
                inpStyle.opacity !== '0' &&
                inpRect.width >= 4 &&
                inpRect.height >= 4;
              if (inpVisible) continue;
            }
          }

          node.setAttribute('data-clive-idx', String(idx));
          const rawLabel =
            node.getAttribute('aria-label') ||
            node.getAttribute('placeholder') ||
            node.textContent ||
            node.value ||
            node.getAttribute('title') ||
            '';
          const label = String(rawLabel).replace(/\s+/g, ' ').trim().slice(0, 90);
          const roleAttr = (node.getAttribute('role') || '').trim().toLowerCase();
          let stableSelector;
          const isControl =
            tagLower === 'input' ||
            tagLower === 'textarea' ||
            tagLower === 'select' ||
            tagLower === 'button' ||
            /^(?:textbox|searchbox|combobox|switch|radio|checkbox|option|menuitem)$/.test(roleAttr);
          const testId = node.getAttribute('data-testid');
          if (isControl && testId && /^[\w.:-]{1,64}$/.test(testId)) {
            stableSelector = `[data-testid="${CSS.escape(testId)}"]`;
          } else if (
            isControl &&
            node.id &&
            /^[a-zA-Z][\w-]{1,48}$/.test(node.id) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(node.id) &&
            !/\d{4,}/.test(node.id)
          ) {
            stableSelector = `#${node.id}`;
          } else if (isControl) {
            const nameAttr = node.getAttribute('name');
            if (nameAttr && /^[\w.-]{1,48}$/.test(nameAttr)) {
              stableSelector = `${tagLower}[name="${CSS.escape(nameAttr)}"]`;
            }
          }

          const isDisabled =
            Boolean(node.disabled) ||
            Boolean(linkedInput?.disabled) ||
            node.getAttribute('aria-disabled') === 'true';
          let checkedState;
          const ariaChecked = node.getAttribute('aria-checked');
          if (ariaChecked === 'true' || ariaChecked === 'false') {
            checkedState = ariaChecked === 'true';
          } else if (
            (tagLower === 'input' && /^(?:checkbox|radio)$/i.test(node.getAttribute('type') || '')) ||
            linkedInput
          ) {
            checkedState = Boolean((linkedInput || node).checked);
          } else if (node.getAttribute('aria-pressed') === 'true') {
            checkedState = true;
          }
          const isSelected = node.getAttribute('aria-selected') === 'true' || Boolean(node.selected);
          const ariaExpanded = node.getAttribute('aria-expanded');
          const expandedState =
            ariaExpanded === 'true' || ariaExpanded === 'false' ? ariaExpanded === 'true' : undefined;

          const entryObj = {
            index: idx,
            tag: tagLower,
            type: node.getAttribute('type') || (linkedInput ? linkedInput.getAttribute('type') : undefined) || undefined,
            role: roleAttr || undefined,
            label: label || `(${tagLower})`,
            href: node.tagName === 'A' ? node.href : undefined,
            stableSelector
          };
          if (isDisabled) entryObj.disabled = true;
          if (checkedState !== undefined) entryObj.checked = checkedState;
          if (isSelected) entryObj.selected = true;
          if (expandedState !== undefined) entryObj.expanded = expandedState;
          elements.push(entryObj);
          idx++;
        }

        const alertNodes = collectDeep(
          document,
          '[role="alert"], [aria-live="assertive"], .el-form-item__error, .error-message, .field-error, .form-error, [data-error]'
        );
        const alertSet = new Set();
        for (const aNode of alertNodes) {
          if (alertSet.size >= 5) break;
          if (aNode.closest && aNode.closest('[data-chrome-live-hud]')) continue;
          const aStyle = window.getComputedStyle(aNode);
          if (aStyle.display === 'none' || aStyle.visibility === 'hidden' || aStyle.opacity === '0') continue;
          const aRect = aNode.getBoundingClientRect();
          if (aRect.width < 4 || aRect.height < 4) continue;
          const txt = String(aNode.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          if (txt && txt.length >= 2) alertSet.add(txt);
        }
        const alerts = Array.from(alertSet);

        const mainRoot = document.querySelector('main, article, [role="main"]') || document.body;
        const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
        let excerpt = '';
        if (mainRoot) {
          const parts = [];
          let accLen = 0;
          const walker = document.createTreeWalker(mainRoot, NodeFilter.SHOW_TEXT);
          let tNode;
          while ((tNode = walker.nextNode())) {
            const p = tNode.parentElement;
            if (!p) continue;
            if (SKIP_TAGS.has(p.tagName) || p.closest('style, script, noscript, template, [data-chrome-live-hud]')) {
              continue;
            }
            const v = tNode.nodeValue || '';
            if (!v.trim()) continue;
            parts.push(v);
            accLen += v.length + 1;
            if (accLen >= 6000) break;
          }
          excerpt = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4500);
        }

        return {
          title: document.title,
          url: location.href,
          elements,
          alerts: alerts.length > 0 ? alerts : undefined,
          excerpt
        };
      },
      args: [maxItems]
    });

    await captureQuickFrame(entry.tabId, entry);
    notifyPanelAndDaemon();
    return { tabId: entry.tabId, ...(execRes?.[0]?.result || {}) };
  }

  if (method === 'click') {
    const target = params.target;
    entry.activity = tr().clicking(typeof target === 'number' ? `[${target}]` : String(target).slice(0, 24));
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (tgt) => {
        function queryDeep(root, sel, depth = 0) {
          if (!root || depth > 6) return null;
          try {
            const direct = root.querySelector(sel);
            if (direct) return direct;
          } catch {
            return null;
          }
          const hosts = root.querySelectorAll('*');
          for (const h of hosts) {
            if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
            if (h.shadowRoot) {
              const hit = queryDeep(h.shadowRoot, sel, depth + 1);
              if (hit) return hit;
            }
          }
          return null;
        }

        function collectDeep(root, sel, depth = 0, acc = []) {
          if (!root || depth > 6) return acc;
          try {
            for (const n of root.querySelectorAll(sel)) acc.push(n);
          } catch {}
          for (const h of root.querySelectorAll('*')) {
            if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
            if (h.shadowRoot) collectDeep(h.shadowRoot, sel, depth + 1, acc);
          }
          return acc;
        }

        let el = null;
        if (typeof tgt === 'number') {
          el = queryDeep(document, `[data-clive-idx="${tgt}"]`);
        } else {
          const raw = String(tgt || '').trim();
          if (raw && /[#.\[\]>:+~=]/.test(raw)) {
            el = queryDeep(document, raw);
          }
          if (!el && raw) {
            const needle = raw.toLowerCase();
            const all = collectDeep(
              document,
              'a, button, summary, label, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"], [role="option"], [role="menuitem"], input[type="submit"], input[type="button"]'
            );
            let fuzzyMatch = null;
            for (const item of all) {
              if (item.closest && item.closest('[data-chrome-live-hud]')) continue;
              const st = window.getComputedStyle(item);
              if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
              const rc = item.getBoundingClientRect();
              if (rc.width < 4 || rc.height < 4) continue;
              const txt = (
                item.textContent ||
                item.value ||
                item.getAttribute('aria-label') ||
                item.getAttribute('title') ||
                ''
              )
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
              if (txt === needle) {
                el = item;
                break;
              }
              if (!fuzzyMatch && needle.length >= 2 && txt.includes(needle)) {
                fuzzyMatch = item;
              }
            }
            if (!el && fuzzyMatch) el = fuzzyMatch;
          }
        }
        if (!el) return { ok: false, error: `Element not found for target: ${tgt}` };
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
          const dLabel = (el.getAttribute('aria-label') || el.textContent || el.value || String(tgt))
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
          return { ok: false, error: `Element is disabled: ${dLabel}` };
        }
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const rect = el.getBoundingClientRect();

        // Gaussian-like center jitter within safe inner 36% zone (never dead-center 0.5000 every time)
        const g1 = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const g2 = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
        const safeSpanX = Math.max(0, Math.min(rect.width * 0.36, rect.width - 6));
        const safeSpanY = Math.max(0, Math.min(rect.height * 0.36, rect.height - 6));
        const cx = Math.round((rect.left + rect.width / 2 + g1 * safeSpanX) * 10) / 10;
        const cy = Math.round((rect.top + rect.height / 2 + g2 * safeSpanY) * 10) / 10;

        const ctrl = window.__chromeLiveHudController__;
        if (ctrl && typeof ctrl.moveCursor === 'function') {
          ctrl.moveCursor({ x: cx, y: cy, kind: 'click', press: true });
          await new Promise((r) => setTimeout(r, 210 + Math.floor(Math.random() * 65)));
        }

        function deriveStableSelector(node) {
          const tag = node.tagName.toLowerCase();
          const tid = node.getAttribute('data-testid');
          if (tid && /^[\w.:-]{1,64}$/.test(tid)) return `[data-testid="${CSS.escape(tid)}"]`;
          if (
            node.id &&
            /^[a-zA-Z][\w-]{1,48}$/.test(node.id) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(node.id) &&
            !/\d{4,}/.test(node.id)
          ) {
            return `#${node.id}`;
          }
          const nm = node.getAttribute('name');
          if (nm && /^[\w.-]{1,48}$/.test(nm)) return `${tag}[name="${CSS.escape(nm)}"]`;
          const aria = (node.getAttribute('aria-label') || '').trim();
          if (aria && aria.length <= 40 && !/["\\\n]/.test(aria)) return `${tag}[aria-label="${aria}"]`;
          return '';
        }

        const learnedSelector = deriveStableSelector(el);
        const label = (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.value ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 42);

        const isVisibleForeground = !document.hidden && rect.width >= 4 && rect.height >= 4;
        if (isVisibleForeground) {
          el.__cliveTrustedReceived = false;
          el.addEventListener(
            'click',
            () => {
              el.__cliveTrustedReceived = true;
            },
            { once: true, capture: true }
          );
          window.__clivePendingClickEl = el;
          return {
            ok: true,
            needHardwareClick: true,
            x: cx,
            y: cy,
            startX: Math.max(12, Math.round(cx + (Math.random() - 0.5) * 90)),
            startY: Math.max(12, Math.round(cy + 40 + Math.random() * 50)),
            tag: el.tagName.toLowerCase(),
            label,
            learnedSelector
          };
        }

        el.click();
        return {
          ok: true,
          needHardwareClick: false,
          x: cx,
          y: cy,
          tag: el.tagName.toLowerCase(),
          label,
          learnedSelector
        };
      },
      args: [target]
    });

    const out = execRes?.[0]?.result;
    if (!out || !out.ok) {
      throw new Error(out?.error || 'Click failed');
    }

    // Dispatch real hardware-level isTrusted:true mouse arc + human dwell press via CDP when visible
    if (out.needHardwareClick) {
      let cdpDispatched = false;
      try {
        // Temporarily lift shield pointer-events so CDP hit-test lands on the real page element
        await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: () => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = 'none';
          }
        });
        await ensureCdpForTab(entry.tabId, entry);
        const arcX = Math.round((out.startX + out.x) / 2 + (Math.random() - 0.5) * 14);
        const arcY = Math.round((out.startY + out.y) / 2 - (4 + Math.random() * 10));
        for (const [mx, my] of [
          [out.startX, out.startY],
          [arcX, arcY],
          [out.x, out.y]
        ]) {
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: mx,
            y: my
          });
          await new Promise((r) => setTimeout(r, 14 + Math.floor(Math.random() * 16)));
        }
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: out.x,
          y: out.y,
          button: 'left',
          buttons: 1,
          clickCount: 1
        });
        // Human finger press-to-release dwell: 45ms ~ 98ms
        await new Promise((r) => setTimeout(r, 45 + Math.floor(Math.random() * 54)));
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: out.x,
          y: out.y,
          button: 'left',
          buttons: 0,
          clickCount: 1
        });
        cdpDispatched = true;
      } catch {}

      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: (didCdp) => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
            const pending = window.__clivePendingClickEl;
            delete window.__clivePendingClickEl;
            if (pending) {
              if (!didCdp || !pending.__cliveTrustedReceived) {
                pending.click();
              }
              delete pending.__cliveTrustedReceived;
            }
          },
          args: [cdpDispatched]
        })
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 220));
    await captureQuickFrame(entry.tabId, entry);
    notifyPanelAndDaemon();
    return {
      tabId: entry.tabId,
      clicked: out.label || out.tag,
      pageUrl: entry.url,
      learnedLabel: out.label ? `点击 · ${out.label}` : '',
      learnedSelector: out.learnedSelector || ''
    };
  }

  if (method === 'type') {
    const { target, text, submit } = params;
    entry.activity = tr().typing;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (tgt, val, shouldSubmit) => {
        function queryDeep(root, sel, depth = 0) {
          if (!root || depth > 6) return null;
          try {
            const direct = root.querySelector(sel);
            if (direct) return direct;
          } catch {
            return null;
          }
          for (const h of root.querySelectorAll('*')) {
            if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
            if (h.shadowRoot) {
              const hit = queryDeep(h.shadowRoot, sel, depth + 1);
              if (hit) return hit;
            }
          }
          return null;
        }

        function collectDeep(root, sel, depth = 0, acc = []) {
          if (!root || depth > 6) return acc;
          try {
            for (const n of root.querySelectorAll(sel)) acc.push(n);
          } catch {}
          for (const h of root.querySelectorAll('*')) {
            if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
            if (h.shadowRoot) collectDeep(h.shadowRoot, sel, depth + 1, acc);
          }
          return acc;
        }

        let el = null;
        if (typeof tgt === 'number') {
          el = queryDeep(document, `[data-clive-idx="${tgt}"]`);
        } else if (typeof tgt === 'string') {
          const raw = tgt.trim();
          if (raw) {
            el = queryDeep(document, raw);
          }
          if (!el && raw) {
            const needle = raw.toLowerCase();
            const inputs = collectDeep(
              document,
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]'
            );
            let partialMatch = null;
            for (const cand of inputs) {
              const rect = cand.getBoundingClientRect();
              if (rect.width < 4 || rect.height < 4) continue;
              const labelText = cand.labels?.[0]?.textContent || '';
              const haystacks = [
                cand.getAttribute('placeholder'),
                cand.getAttribute('aria-label'),
                cand.getAttribute('name'),
                cand.id,
                cand.getAttribute('title'),
                labelText
              ]
                .filter(Boolean)
                .map((s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase());
              if (haystacks.some((h) => h === needle)) {
                el = cand;
                break;
              }
              if (!partialMatch && needle.length >= 2 && haystacks.some((h) => h.includes(needle))) {
                partialMatch = cand;
              }
            }
            if (!el) el = partialMatch;
          }
        }

        // Drill into inner native input/textarea if target matched a wrapper custom element
        if (
          el &&
          !(el instanceof HTMLInputElement) &&
          !(el instanceof HTMLTextAreaElement) &&
          !el.isContentEditable
        ) {
          const inner =
            (el.shadowRoot && el.shadowRoot.querySelector('input, textarea, [contenteditable="true"]')) ||
            el.querySelector?.('input, textarea, [contenteditable="true"]');
          if (inner) el = inner;
        }

        if (!el) return { ok: false, error: `Input element not found: ${tgt}` };
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const jx = ((Math.random() + Math.random()) / 2 - 0.5) * Math.min(rect.width * 0.3, 24);
        const jy = ((Math.random() + Math.random()) / 2 - 0.5) * Math.min(rect.height * 0.3, 8);
        const cx = rect.left + rect.width / 2 + jx;
        const cy = rect.top + rect.height / 2 + jy;

        const ctrl = window.__chromeLiveHudController__;
        if (ctrl && typeof ctrl.moveCursor === 'function') {
          ctrl.moveCursor({ x: cx, y: cy, kind: 'type', press: true });
          await new Promise((r) => setTimeout(r, 210 + Math.floor(Math.random() * 60)));
        }

        el.focus();
        const setInputValue = (node, str) => {
          const proto =
            node instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) nativeSetter.call(node, str);
          else node.value = str;
        };

        // Humanized non-uniform keystroke cadence for visible short queries (<= 28 chars)
        const chars = Array.from(val);
        const useCadence = !document.hidden && chars.length > 0 && chars.length <= 28;
        if (el.isContentEditable) {
          el.textContent = '';
          if (useCadence) {
            let built = '';
            for (const ch of chars) {
              built += ch;
              el.textContent = built;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
              await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 26)));
            }
          } else {
            const sel = window.getSelection?.();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, val);
            if (!inserted) {
              el.textContent = val;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
            }
          }
        } else {
          if (useCadence) {
            setInputValue(el, '');
            let built = '';
            for (const ch of chars) {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
              built += ch;
              setInputValue(el, built);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
              await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 26)));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            setInputValue(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        if (shouldSubmit) {
          const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true
          });
          el.dispatchEvent(enterDown);
          if (el.form) {
            if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
            else el.form.submit();
          }
        }
        function deriveInputSelector(node) {
          const tag = node.tagName.toLowerCase();
          const tid = node.getAttribute('data-testid');
          if (tid && /^[\w.:-]{1,64}$/.test(tid)) return `[data-testid="${CSS.escape(tid)}"]`;
          if (
            node.id &&
            /^[a-zA-Z][\w-]{1,48}$/.test(node.id) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(node.id) &&
            !/\d{4,}/.test(node.id)
          ) {
            return `#${node.id}`;
          }
          const nm = node.getAttribute('name');
          if (nm && /^[\w.-]{1,48}$/.test(nm)) return `${tag}[name="${CSS.escape(nm)}"]`;
          if (String(node.getAttribute('type') || '').toLowerCase() === 'search') {
            return `${tag}[type="search"]`;
          }
          // Only use static UI placeholders (avoid rotating e-commerce promo hotwords like "丹东大草莓")
          const ph = (node.getAttribute('placeholder') || '').trim();
          if (
            ph &&
            ph.length <= 24 &&
            !/["\\\n]/.test(ph) &&
            /(?:搜索|查找|输入|标题|内容|关键词|search|find|filter|enter|type|query|email|url)/i.test(ph)
          ) {
            return `${tag}[placeholder="${ph}"]`;
          }
          const aria = (node.getAttribute('aria-label') || '').trim();
          if (aria && aria.length <= 40 && !/["\\\n]/.test(aria)) return `${tag}[aria-label="${aria}"]`;
          return '';
        }

        const learnedSelector = deriveInputSelector(el);
        const idAndCls = `${el.id || ''} ${el.name || ''} ${el.className || ''}`;
        const isSearchField =
          /(?:search|query|^s$|^q$|^kw$)/i.test(el.name || '') ||
          /search/i.test(idAndCls) ||
          String(el.getAttribute('type') || '').toLowerCase() === 'search';
        const learnedName = isSearchField
          ? '站内搜索框'
          : (
              el.getAttribute('aria-label') ||
              el.labels?.[0]?.textContent ||
              el.getAttribute('name') ||
              el.id ||
              el.getAttribute('placeholder') ||
              '输入框'
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 32);
        const inCodeMirror = Boolean(el.closest?.('.CodeMirror'));
        return { ok: true, x: cx, y: cy, learnedSelector, learnedName, inCodeMirror };
      },
      args: [target, String(text ?? ''), Boolean(submit)]
    });

    const out = execRes?.[0]?.result;
    if (!out || !out.ok) throw new Error(out?.error || 'Type failed');
    if (out.inCodeMirror) {
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          world: 'MAIN',
          func: (v) => {
            const cm = document.querySelector('.CodeMirror')?.CodeMirror;
            if (cm && typeof cm.setValue === 'function') {
              cm.setValue(v);
              cm.save?.();
            }
          },
          args: [String(text ?? '')]
        })
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 220));
    await captureQuickFrame(entry.tabId, entry);
    notifyPanelAndDaemon();
    return {
      tabId: entry.tabId,
      typedLength: String(text ?? '').length,
      submitted: Boolean(submit),
      pageUrl: entry.url,
      learnedLabel: out.learnedName ? `输入 · ${out.learnedName}` : '',
      learnedSelector: out.learnedSelector || ''
    };
  }

  if (method === 'upload') {
    const files = Array.isArray(params.files) ? params.files : [];
    if (files.length === 0) throw new Error('upload requires at least one file path');
    const target = params.target ?? 'auto';
    const exts = files.map((f) => {
      const m = String(f).match(/(\.[a-z0-9]+)$/i);
      return m ? m[1].toLowerCase() : '';
    });

    entry.activity = tr().uploading(files.length);
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await ensureCdpForTab(entry.tabId, entry);
    await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'DOM.enable').catch(() => {});
    await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.enable').catch(() => {});

    const locateExpr = `((tgt, fileExts) => {
      function queryDeep(root, sel, depth = 0) {
        if (!root || depth > 6) return null;
        try {
          const hit = root.querySelector(sel);
          if (hit) return hit;
        } catch {
          return null;
        }
        for (const h of root.querySelectorAll('*')) {
          if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
          if (h.shadowRoot) {
            const sub = queryDeep(h.shadowRoot, sel, depth + 1);
            if (sub) return sub;
          }
        }
        return null;
      }

      function collectDeep(root, sel, depth = 0, acc = []) {
        if (!root || depth > 6) return acc;
        try {
          for (const n of root.querySelectorAll(sel)) acc.push(n);
        } catch {}
        for (const h of root.querySelectorAll('*')) {
          if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
          if (h.shadowRoot) collectDeep(h.shadowRoot, sel, depth + 1, acc);
        }
        return acc;
      }

      function findRelatedFileInput(node) {
        if (!node) return null;
        if (node.tagName === 'INPUT' && String(node.type).toLowerCase() === 'file') return node;
        if (node.tagName === 'LABEL' && node.htmlFor) {
          const byFor = queryDeep(document, '#' + CSS.escape(node.htmlFor));
          if (byFor && byFor.tagName === 'INPUT' && String(byFor.type).toLowerCase() === 'file') return byFor;
        }
        const inner =
          (node.shadowRoot && node.shadowRoot.querySelector('input[type="file"]:not(:disabled)')) ||
          (node.querySelector && node.querySelector('input[type="file"]:not(:disabled)'));
        if (inner) return inner;
        let cur = node.parentElement;
        for (let i = 0; i < 3 && cur; i++) {
          const near = cur.querySelector('input[type="file"]:not(:disabled)');
          if (near) return near;
          cur = cur.parentElement;
        }
        return null;
      }

      let fileInput = null;
      if (typeof tgt === 'number') {
        fileInput = findRelatedFileInput(queryDeep(document, '[data-clive-idx="' + tgt + '"]'));
      } else if (typeof tgt === 'string' && tgt !== 'auto' && tgt !== 'file') {
        const raw = tgt.trim();
        let matched = raw ? queryDeep(document, raw) : null;
        if (!matched && raw) {
          const needle = raw.toLowerCase();
          const clickables = collectDeep(document, 'label, button, a, [role="button"]');
          for (const item of clickables) {
            const txt = (item.textContent || item.getAttribute('aria-label') || item.getAttribute('title') || '')
              .replace(/\\s+/g, ' ')
              .trim()
              .toLowerCase();
            if (txt === needle || (needle.length >= 2 && txt.includes(needle))) {
              matched = item;
              break;
            }
          }
        }
        fileInput = findRelatedFileInput(matched);
      }

      if (!fileInput) {
        const allFileInputs = collectDeep(document, 'input[type="file"]:not(:disabled)');
        if (allFileInputs.length === 1) {
          fileInput = allFileInputs[0];
        } else if (allFileInputs.length > 1) {
          const isImg = fileExts.some((e) => ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(e));
          fileInput =
            allFileInputs.find((inp) => {
              const acc = String(inp.getAttribute('accept') || '').toLowerCase();
              if (!acc) return false;
              return fileExts.some((e) => e && acc.includes(e)) || (isImg && acc.includes('image'));
            }) ||
            allFileInputs.find((inp) => !inp.getAttribute('accept')) ||
            allFileInputs[0];
        }
      }

      if (!fileInput) return null;
      fileInput.__cliveChangeFired = false;
      fileInput.addEventListener(
        'change',
        () => {
          fileInput.__cliveChangeFired = true;
        },
        { once: true }
      );
      return fileInput;
    })(${JSON.stringify(target)}, ${JSON.stringify(exts)})`;

    const evalRes = await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', {
      expression: locateExpr,
      returnByValue: false
    });

    if (evalRes?.result?.objectId) {
      const objectId = evalRes.result.objectId;
      await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'DOM.setFileInputFiles', {
        files,
        objectId
      });

      const inspectRes = await chrome.debugger.sendCommand(
        { tabId: entry.tabId },
        'Runtime.callFunctionOn',
        {
          objectId,
          awaitPromise: true,
          returnByValue: true,
          functionDeclaration: `async function() {
            const inp = this;
            let anchor = inp;
            let rect = anchor.getBoundingClientRect();
            while (anchor && (rect.width < 4 || rect.height < 4) && anchor.parentElement) {
              anchor = anchor.parentElement;
              rect = anchor.getBoundingClientRect();
            }
            const cx = rect.width >= 4 ? rect.left + rect.width / 2 : (window.innerWidth || 1200) * 0.5;
            const cy = rect.height >= 4 ? rect.top + rect.height / 2 : (window.innerHeight || 800) * 0.5;

            await new Promise((r) => setTimeout(r, 40));
            if (!inp.__cliveChangeFired) {
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            delete inp.__cliveChangeFired;

            const names = inp.files ? Array.from(inp.files).map((f) => f.name) : [];
            return { cx, cy, count: names.length, names };
          }`
        }
      );

      const detail = inspectRes?.result?.value || { cx: 600, cy: 400, count: files.length, names: [] };
      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: (x, y) => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl && typeof ctrl.moveCursor === 'function') {
              ctrl.moveCursor({ x, y, kind: 'upload', press: true });
            }
          },
          args: [detail.cx, detail.cy]
        })
        .catch(() => {});

      await chrome.debugger
        .sendCommand({ tabId: entry.tabId }, 'Runtime.releaseObject', { objectId })
        .catch(() => {});

      await new Promise((r) => setTimeout(r, 240));
      await captureQuickFrame(entry.tabId, entry);
      notifyPanelAndDaemon();
      return {
        tabId: entry.tabId,
        mode: 'cdp_file_input',
        uploadedCount: detail.count || files.length,
        fileNames: detail.names
      };
    }

    // Fallback for rich-text editors without <input type="file"> (synthetic paste + drop DataTransfer)
    if (Array.isArray(params.pasteFallback) && params.pasteFallback.length > 0) {
      const fallbackRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
        func: async (tgt, payloads) => {
          let editor = null;
          if (typeof tgt === 'number') {
            editor = document.querySelector(`[data-clive-idx="${tgt}"]`);
          } else if (typeof tgt === 'string' && tgt !== 'auto' && tgt !== 'file') {
            try {
              editor = document.querySelector(tgt);
            } catch {}
          }
          if (!editor) {
            editor =
              document.querySelector('[contenteditable="true"], textarea, [role="textbox"]') ||
              document.activeElement ||
              document.body;
          }
          if (!editor) return { ok: false, error: 'No file input or rich-text editor found on page' };

          const dt = new DataTransfer();
          const names = [];
          for (const item of payloads) {
            const bin = atob(item.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const fileObj = new File([bytes], item.name, { type: item.mimeType || 'application/octet-stream' });
            dt.items.add(fileObj);
            names.push(item.name);
          }

          const rect = editor.getBoundingClientRect();
          const ctrl = window.__chromeLiveHudController__;
          if (ctrl && typeof ctrl.moveCursor === 'function') {
            ctrl.moveCursor({
              x: rect.left + Math.max(20, rect.width / 2),
              y: rect.top + Math.max(20, Math.min(80, rect.height / 2)),
              kind: 'upload',
              press: true
            });
          }

          editor.focus?.();
          const pasteEv = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          const notCancelled = editor.dispatchEvent(pasteEv);
          if (notCancelled) {
            const dropEv = new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt
            });
            editor.dispatchEvent(dropEv);
          }
          return { ok: true, count: names.length, names };
        },
        args: [target, params.pasteFallback]
      });

      const fb = fallbackRes?.[0]?.result;
      if (!fb || !fb.ok) {
        throw new Error(fb?.error || 'No <input type="file"> or paste-capable editor found on page');
      }
      await new Promise((r) => setTimeout(r, 240));
      await captureQuickFrame(entry.tabId, entry);
      notifyPanelAndDaemon();
      return {
        tabId: entry.tabId,
        mode: 'paste_fallback',
        uploadedCount: fb.count,
        fileNames: fb.names
      };
    }

    throw new Error('No <input type="file"> element found on page for upload');
  }

  if (method === 'scroll') {
    const direction = String(params.direction || 'down');
    const amount = Number(params.amount) || 600;
    entry.activity = tr().scrolling(direction);
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (dir, px) => {
        const ctrl = window.__chromeLiveHudController__;
        if (ctrl && typeof ctrl.moveCursor === 'function') {
          ctrl.moveCursor({
            x: Math.round((window.innerWidth || 1200) * (0.48 + Math.random() * 0.08)),
            y: Math.round((window.innerHeight || 800) * (0.44 + Math.random() * 0.08)),
            kind: 'scroll',
            press: false
          });
        }
        if (dir === 'top') {
          window.scrollTo({ top: 0, behavior: document.hidden ? 'instant' : 'smooth' });
        } else if (dir === 'bottom') {
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: document.hidden ? 'instant' : 'smooth'
          });
        } else {
          // Natural ±11% wheel stride jitter + multi-pulse inertial scroll when visible
          const jitterFactor = 0.89 + Math.random() * 0.22;
          const totalDelta = (dir === 'up' ? -1 : 1) * Math.round(Math.abs(px) * jitterFactor);
          if (document.hidden) {
            window.scrollBy({ top: totalDelta, behavior: 'instant' });
          } else {
            const slices = [0.42, 0.35, 0.23];
            for (const ratio of slices) {
              window.scrollBy({ top: Math.round(totalDelta * ratio), behavior: 'smooth' });
              await new Promise((r) => setTimeout(r, 65 + Math.floor(Math.random() * 25)));
            }
          }
        }
        return { scrollY: Math.round(window.scrollY), innerHeight: window.innerHeight };
      },
      args: [direction, amount]
    });

    await new Promise((r) => setTimeout(r, 180));
    await captureQuickFrame(entry.tabId, entry);
    return { tabId: entry.tabId, ...(execRes?.[0]?.result || {}) };
  }

  if (method === 'navigate') {
    const url = String(params.url || '').trim();
    const safety = checkTabUrlAllowed(url);
    if (!safety.allowed) throw new Error(`[GUARDRAIL] ${safety.reason}`);
    entry.activity = tr().navigating;
    await chrome.tabs.update(entry.tabId, { url });
    await waitForTabComplete(entry.tabId, 15000);
    const updated = await chrome.tabs.get(entry.tabId);
    entry.title = updated.title || '';
    entry.url = updated.url || url;
    const postSafety = checkTabUrlAllowed(entry.url);
    if (!postSafety.allowed) {
      await detachManagedTab(entry.tabId, postSafety.reason);
      throw new Error(`[GUARDRAIL] Blocked redirect: ${postSafety.reason}`);
    }
    entry.activity = tr().loaded(entry.title.slice(0, 28));
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await captureQuickFrame(entry.tabId, entry);
    notifyPanelAndDaemon();
    return { tabId: entry.tabId, title: entry.title, url: entry.url };
  }

  if (method === 'screenshot') {
    const b64 = await captureQuickFrame(entry.tabId, entry);
    if (!b64) throw new Error('Unable to capture screenshot frame');
    return { tabId: entry.tabId, mimeType: 'image/jpeg', data: b64 };
  }

  if (method === 'done') {
    const summary = String(params.summary || 'Completed');
    await captureQuickFrame(entry.tabId, entry);
    await stopCdpForTab(entry.tabId);

    if (entry.substate === 'shared') {
      // Never close a user-shared tab! Keep it shared in calm idle state.
      entry.activity = tr().donePrefix(summary);
      await syncHud(entry.tabId, { visible: true, mode: 'shared', activity: entry.activity });
      await syncLiveTabGroups();
      notifyPanelAndDaemon();
      return { tabId: entry.tabId, preservedSharedTab: true, summary };
    }

    // Worker tabs created via `open`: close cleanly so no orphan tabs accumulate.
    const closedTabId = entry.tabId;
    managedTabs.delete(closedTabId);
    await chrome.tabs.remove(closedTabId).catch(() => {});
    await syncLiveTabGroups();
    notifyPanelAndDaemon();
    return { tabId: closedTabId, closedWorkerTab: true, summary };
  }

  if (method === 'wait') {
    const waitMs = Math.min(15000, Math.max(0, Number(params.ms) || 0));
    const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
    const timeoutMs = Math.min(15000, Math.max(300, Number(params.timeoutMs) || 8000));
    entry.activity = tr().waiting;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });

    if (selector) {
      const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
        func: async (sel, maxWait) => {
          function queryDeep(root, s, depth = 0) {
            if (!root || depth > 6) return null;
            try {
              const hit = root.querySelector(s);
              if (hit) return hit;
            } catch {
              return null;
            }
            for (const h of root.querySelectorAll('*')) {
              if (h.hasAttribute && h.hasAttribute('data-chrome-live-hud')) continue;
              if (h.shadowRoot) {
                const sub = queryDeep(h.shadowRoot, s, depth + 1);
                if (sub) return sub;
              }
            }
            return null;
          }
          const deadline = performance.now() + maxWait;
          while (performance.now() < deadline) {
            const found = queryDeep(document, sel);
            if (found) {
              const rect = found.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { matched: true, selector: sel };
              }
            }
            await new Promise((r) => setTimeout(r, 120));
          }
          return { matched: false, selector: sel };
        },
        args: [selector, timeoutMs]
      });
      const res = execRes?.[0]?.result || { matched: false };
      if (!res.matched) {
        throw new Error(`Timed out waiting for selector: ${selector}`);
      }
      return { tabId: entry.tabId, ...res };
    }

    await waitForTabComplete(entry.tabId, timeoutMs);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return { tabId: entry.tabId, waitedMs: waitMs };
  }

  throw new Error(`Unsupported RPC method: ${method}`);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || !managedTabs.has(tabId)) return;
  const entry = managedTabs.get(tabId);

  if (method === 'Page.screencastFrame' && params) {
    chrome.debugger
      .sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
    if (ws && ws.readyState === WebSocket.OPEN && params.data) {
      ws.send(
        JSON.stringify({
          type: 'screencast_frame',
          tabId,
          mimeType: 'image/jpeg',
          data: params.data,
          title: entry.title,
          url: entry.url,
          activity: entry.activity
        })
      );
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId && managedTabs.has(source.tabId)) {
    const entry = managedTabs.get(source.tabId);
    entry.attachedCdp = false;
    entry.screencastActive = false;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Always notify the open side panel when an active tab navigates from chrome://newtab/ to a web URL
  if (tab?.active && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) {
    chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
  }
  if (!managedTabs.has(tabId)) return;
  const entry = managedTabs.get(tabId);
  if (changeInfo.url || changeInfo.status === 'complete') {
    entry.title = tab.title || entry.title;
    entry.url = tab.url || entry.url;
    const safety = checkTabUrlAllowed(entry.url);
    if (!safety.allowed) {
      await detachManagedTab(tabId, safety.reason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId,
            url: entry.url,
            reason: safety.reason
          })
        );
      }
      return;
    }
    if (changeInfo.status === 'complete') {
      await syncHud(tabId, {
        visible: true,
        mode: entry.paused ? 'paused' : entry.uiMode || 'working',
        activity: entry.activity
      });
    }
    notifyPanelAndDaemon();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (managedTabs.has(tabId)) {
    const entry = managedTabs.get(tabId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    managedTabs.delete(tabId);
    rememberDetachedTab(tabId, 'Tab closed', false);
    syncLiveTabGroups();
    notifyPanelAndDaemon();
  }
});

chrome.tabs.onActivated.addListener(() => {
  chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
});

chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-share-tab') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) await shareTab(activeTab, true);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'chrome-live-toggle-share',
      title: 'Share / Release tab with Chrome Live',
      contexts: ['page']
    });
  });
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.45 });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'chrome-live-toggle-share' && tab) {
    await shareTab(tab, true);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    connectWebSocket();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== 'string') {
      sendResponse({ ok: false });
      return;
    }
    if (msg.type === 'hud:user_event') {
      const senderTabId = sender?.tab?.id;
      if (typeof senderTabId === 'number' && managedTabs.has(senderTabId)) {
        const entry = managedTabs.get(senderTabId);
        if (msg.event === 'release') {
          await detachManagedTab(senderTabId, tr().released);
        } else if (msg.event === 'pause') {
          entry.paused = true;
          entry.uiMode = 'paused';
          entry.activity = currentLang === 'zh' ? '已暂停 · 人工接管中' : 'Paused · Manual control';
          await syncLiveTabGroups();
          notifyPanelAndDaemon();
        } else if (msg.event === 'resume') {
          if (entry.relayPopoutWinId) {
            await mergeRelayTabBack(entry);
          } else {
            entry.paused = false;
            entry.uiMode = 'working';
            entry.activity = currentLang === 'zh' ? '已恢复锁定操控' : 'Resumed automation';
            await syncLiveTabGroups();
            notifyPanelAndDaemon();
          }
        }
      } else if (typeof senderTabId === 'number' && msg.event === 'release') {
        await chrome.tabs.ungroup(senderTabId).catch(() => {});
        await syncLiveTabGroups();
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:get_state') {
      let playbook = { enabled: false, siteCount: 0 };
      if (bridgeConfig.token && ws && ws.readyState === WebSocket.OPEN) {
        try {
          const r = await fetch(`http://${bridgeConfig.host}:${bridgeConfig.port}/api/health`, {
            headers: { 'X-Chrome-Live-Token': bridgeConfig.token },
            cache: 'no-store'
          });
          if (r.ok) {
            const j = await r.json();
            if (j && j.playbook) playbook = j.playbook;
          }
        } catch {}
      }

      let currentActiveTab = null;
      try {
        let [act] = await chrome.tabs.query(
          typeof msg.windowId === 'number'
            ? { active: true, windowId: msg.windowId }
            : { active: true, lastFocusedWindow: true, windowType: 'normal' }
        );
        if (!act && typeof msg.windowId !== 'number') {
          [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        }
        if (act && typeof act.id === 'number') {
          const safety = checkTabUrlAllowed(act.url || '');
          const managed = managedTabs.get(act.id);
          currentActiveTab = {
            tabId: act.id,
            title: act.title || '',
            url: act.url || '',
            isShared: Boolean(managed),
            isManaged: Boolean(managed),
            isPaused: Boolean(managed?.paused),
            uiMode: managed?.uiMode || '',
            safetyAllowed: safety.allowed,
            safetyReason: safety.reason || ''
          };
        }
      } catch {}

      sendResponse({
        ok: true,
        lang: currentLang,
        wsConnected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        port: bridgeConfig.port,
        token: bridgeConfig.token,
        currentActiveTab,
        tabs: serializeTabs(),
        customBlockedDomains,
        playbook,
        audit: localAudit
      });
      return;
    }
    if (msg.type === 'panel:get_playbooks_full') {
      if (!bridgeConfig.token) {
        sendResponse({ ok: false, sites: {} });
        return;
      }
      try {
        const r = await fetch(`http://${bridgeConfig.host}:${bridgeConfig.port}/api/playbook`, {
          headers: { 'X-Chrome-Live-Token': bridgeConfig.token },
          cache: 'no-store'
        });
        const j = await r.json();
        sendResponse(j);
      } catch {
        sendResponse({ ok: false, sites: {} });
      }
      return;
    }
    if (msg.type === 'panel:playbook_action') {
      if (!bridgeConfig.token) {
        sendResponse({ ok: false, error: 'Not paired' });
        return;
      }
      try {
        const r = await fetch(`http://${bridgeConfig.host}:${bridgeConfig.port}/api/playbook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Chrome-Live-Token': bridgeConfig.token
          },
          body: JSON.stringify(msg.body || {})
        });
        const json = await r.json();
        sendResponse(json);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Playbook API error' });
      }
      return;
    }
    if (msg.type === 'panel:set_lang') {
      if (msg.lang === 'zh' || msg.lang === 'en') {
        currentLang = msg.lang;
        await chrome.storage.local.set({ [STORAGE_LANG_KEY]: currentLang });
        for (const entry of managedTabs.values()) {
          await syncHud(entry.tabId, {
            lang: currentLang,
            visible: true,
            mode: entry.paused ? 'paused' : entry.uiMode || 'working'
          });
        }
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
      }
      sendResponse({ ok: true, lang: currentLang });
      return;
    }
    if (msg.type === 'panel:reconnect') {
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
      connectWebSocket();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:share_active_tab') {
      let [activeTab] = await chrome.tabs.query(
        typeof msg.windowId === 'number'
          ? { active: true, windowId: msg.windowId }
          : { active: true, lastFocusedWindow: true, windowType: 'normal' }
      );
      if (!activeTab && typeof msg.windowId !== 'number') {
        [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      if (activeTab) await shareTab(activeTab, true);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:focus_tab') {
      if (typeof msg.tabId === 'number') {
        const t = await chrome.tabs.update(msg.tabId, { active: true }).catch(() => null);
        if (t && typeof t.windowId === 'number') {
          await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:toggle_relay_tab') {
      if (typeof msg.tabId === 'number' && managedTabs.has(msg.tabId)) {
        const entry = managedTabs.get(msg.tabId);
        if (entry.relayPopoutWinId) {
          await mergeRelayTabBack(entry);
        } else {
          await popoutRelayTab(entry, true);
        }
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:toggle_pause_tab') {
      if (typeof msg.tabId === 'number' && managedTabs.has(msg.tabId)) {
        const entry = managedTabs.get(msg.tabId);
        entry.paused = !entry.paused;
        entry.uiMode = entry.paused ? 'paused' : 'working';
        entry.activity = entry.paused
          ? currentLang === 'zh'
            ? '已暂停 · 人工接管中'
            : 'Paused · Manual control'
          : currentLang === 'zh'
            ? '已恢复锁定操控'
            : 'Resumed automation';
        await syncHud(entry.tabId, {
          visible: true,
          mode: entry.uiMode,
          activity: entry.activity
        });
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:clear_audit') {
      localAudit = [];
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:detach_tab') {
      if (typeof msg.tabId === 'number') await detachManagedTab(msg.tabId, 'Detached from console');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:release_all') {
      for (const tabId of Array.from(managedTabs.keys())) {
        await detachManagedTab(tabId, 'Released all');
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:save_config') {
      bridgeConfig = {
        host: '127.0.0.1',
        port: Number(msg.port) || 28196,
        token: String(msg.token || '').trim()
      };
      await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: bridgeConfig });
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
      connectWebSocket();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'panel:save_guardrails') {
      customBlockedDomains = Array.isArray(msg.customBlockedDomains)
        ? msg.customBlockedDomains.slice(0, 200)
        : [];
      await chrome.storage.local.set({ [STORAGE_GUARDRAILS_KEY]: customBlockedDomains });
      notifyPanelAndDaemon();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown panel message' });
  })();
  return true;
});

loadBootstrapAndStorage().then(() => {
  reconcileHudAfterStartup();
  syncLiveTabGroups();
  connectWebSocket();
});
