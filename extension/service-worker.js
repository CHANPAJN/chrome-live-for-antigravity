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
  'stripe.com',
  'checkout.stripe.com',
  'billing.stripe.com',
  'dashboard.stripe.com',
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

const CHECKOUT_SEGMENT_RX =
  /(?:^|\/)(?:checkout|pay|payment|payments|cashier|billing|wallet\/transfer)(?:\/|\?|$|#|;|\.[a-z0-9]{1,8}(?:\/|\?|$|#|;))/i;

const CHECKOUT_SUBDOMAIN_RX = /(?:^|\.)(?:checkout|pay|payment|payments|cashier|billing)\./i;

function isHighEntropyPathSegment(rawSegment) {
  if (!rawSegment) return false;
  let segment = String(rawSegment).split(';')[0];
  if (segment.length < 32) return false;
  if (segment.includes('%')) {
    segment = segment.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
  if (segment.length < 32) return false;
  if (/^eyJ[A-Za-z0-9._~+/=-]{10,}$/.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (segment.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/.test(segment)) {
    const hasDigit = /\d/.test(segment);
    const hasUpper = /[A-Z]/.test(segment);
    const hasLower = /[a-z]/.test(segment);
    const hasB64Punct = /[+/=]/.test(segment);
    if (
      (hasDigit && (hasUpper || hasLower)) ||
      hasB64Punct ||
      (hasUpper && hasLower && !segment.includes('-'))
    ) {
      return true;
    }
  }
  return false;
}

function canonicalizeRouteForGuardrail(rawSegment) {
  if (!rawSegment) return { ok: true, rawPath: '/', path: '/' };
  let decoded = String(rawSegment);
  if (decoded.includes('%')) {
    if (/%(?![0-9A-Fa-f]{2})/.test(decoded)) {
      return { ok: false, rawPath: '', path: '' };
    }
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return { ok: false, rawPath: '', path: '' };
    }
    for (let round = 1; round < 6; round++) {
      if (!/%[0-9A-Fa-f]{2}/.test(decoded)) break;
      let malformedUtf8 = false;
      const next = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          malformedUtf8 = true;
          return seq;
        }
      });
      if (malformedUtf8) {
        return { ok: false, rawPath: '', path: '' };
      }
      if (next === decoded) break;
      decoded = next;
    }
    if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
      return { ok: false, rawPath: '', path: '' };
    }
  }
  const normalized = decoded.replace(/\\/g, '/');
  const qIdx = normalized.indexOf('?');
  const pathPart = qIdx === -1 ? normalized : normalized.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : normalized.slice(qIdx);
  const rawPieces = [];
  const stack = [];
  for (const seg of pathPart.split('/')) {
    const cleanSeg = seg.split(';')[0];
    if (!cleanSeg || cleanSeg === '.') continue;
    rawPieces.push(cleanSeg);
    if (cleanSeg === '..') {
      stack.pop();
      continue;
    }
    stack.push(cleanSeg);
  }
  return {
    ok: true,
    rawPath: `/${rawPieces.join('/')}${queryPart}`,
    path: `/${stack.join('/')}${queryPart}`
  };
}

const SAFE_ATTR_SELECTOR_ALLOWLIST_RX =
  /^(?:id|class|name|type|role|placeholder|aria-(?:label|expanded|selected|checked|controls|current|disabled)|title|for|disabled|checked|selected|readonly|required|multiple|contenteditable|tabindex|data-(?:testid|test|cy|qa|clive-idx|index|id|action|role|tab|state)|target|alt)$/i;

const SAFE_FUNCTIONAL_PSEUDO_RX =
  /^(?:nth-child|nth-last-child|nth-of-type|nth-last-of-type|not|is|where)$/i;

function assertSafeModelSelector(rawSelector) {
  if (typeof rawSelector !== 'string') return;
  const s = rawSelector.trim();
  if (!s) return;
  // Unconditionally forbid CSS escapes (`\`) and CSS comment tokens (`/*`, `*/`) anywhere in the string
  // so quote-aware browser CSS lexers and guardrail checks can never diverge!
  if (s.includes('\\') || s.includes('/*') || s.includes('*/')) {
    throw new Error('[GUARDRAIL] CSS escape sequences and comments are blocked in automation selectors');
  }

  let quoteChar = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let attrStart = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }
    if (ch === '[') {
      if (bracketDepth === 0) attrStart = i + 1;
      bracketDepth += 1;
      if (bracketDepth > 1) {
        throw new Error('[GUARDRAIL] Nested CSS attribute brackets are blocked');
      }
      continue;
    }
    if (ch === ']') {
      if (bracketDepth <= 0) {
        throw new Error('[GUARDRAIL] Unbalanced closing bracket in CSS selector');
      }
      bracketDepth -= 1;
      const inner = s.slice(attrStart, i).trim();
      if (!inner) {
        throw new Error('[GUARDRAIL] Empty CSS attribute selector is blocked');
      }
      // Scan inner attribute expression outside quotes for operator & attribute name
      let innerQuote = '';
      let eqIndex = -1;
      for (let j = 0; j < inner.length; j++) {
        const ic = inner[j];
        if (innerQuote) {
          if (ic === innerQuote) innerQuote = '';
          continue;
        }
        if (ic === '"' || ic === "'") {
          innerQuote = ic;
          continue;
        }
        if (ic === '=') {
          const prevChar = j > 0 ? inner[j - 1] : '';
          if (prevChar === '*' || prevChar === '^' || prevChar === '$' || prevChar === '~' || prevChar === '|') {
            throw new Error('[GUARDRAIL] CSS attribute substring/prefix/suffix operators (*=, ^=, $=, ~=, |=) are blocked');
          }
          if (eqIndex !== -1) {
            throw new Error('[GUARDRAIL] Malformed multiple "=" operators in CSS attribute selector');
          }
          eqIndex = j;
        }
      }
      const rawAttr = (eqIndex === -1 ? inner : inner.slice(0, eqIndex)).trim().replace(/^\*?\|/, '').trim();
      if (!SAFE_ATTR_SELECTOR_ALLOWLIST_RX.test(rawAttr)) {
        throw new Error(`[GUARDRAIL] CSS attribute selector on "${rawAttr}" is restricted for credential safety`);
      }
      continue;
    }
    if (bracketDepth === 0 && ch === ':') {
      const rest = s.slice(i + 1);
      const fnMatch = rest.match(/^:?([a-zA-Z_-][a-zA-Z0-9_-]*)\s*\(/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        if (!SAFE_FUNCTIONAL_PSEUDO_RX.test(fnName)) {
          throw new Error(`[GUARDRAIL] Functional CSS pseudo-class ":${fnName}()" is blocked to prevent hidden-DOM probing`);
        }
      }
      continue;
    }
    if (bracketDepth === 0 && ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (bracketDepth === 0 && ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) {
        throw new Error('[GUARDRAIL] Unbalanced closing parenthesis in CSS selector');
      }
    }
  }

  if (quoteChar || bracketDepth !== 0 || parenDepth !== 0) {
    throw new Error('[GUARDRAIL] Unbalanced quotes, brackets, or parentheses in CSS selector');
  }
}

let bridgeConfig = {
  host: '127.0.0.1',
  port: 28196,
  token: ''
};
let customBlockedDomains = [];

let ws = null;
let wsAuthed = false;
let wsSuppressedByOtherProfile = false;
let wsReconnectTimer = null;
let localAudit = [];

function generateRandomHex(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message || '')));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function constantTimeHexEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256HexWeb(text) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text ?? '')));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function signedDaemonFetch(routePath, method = 'GET', bodyObj = null) {
  const m = String(method || 'GET').toUpperCase();
  const bodyStr = bodyObj !== null && bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
  const bodyByteLen = bodyStr ? new TextEncoder().encode(bodyStr).byteLength : 0;
  const ts = String(Date.now());
  const nonce = generateRandomHex(16);
  const bodyHash = await sha256HexWeb(bodyStr);
  const hdrSig = await hmacSha256Hex(
    bridgeConfig.token,
    JSON.stringify(['chrome-live:http-hdr:v2', m, routePath, ts, nonce, bodyByteLen])
  );
  const sig = await hmacSha256Hex(
    bridgeConfig.token,
    JSON.stringify(['chrome-live:http-req:v2', m, routePath, ts, nonce, bodyHash])
  );
  const headers = {
    'X-Chrome-Live-Ts': ts,
    'X-Chrome-Live-Nonce': nonce,
    'X-Chrome-Live-Hdr-Sig': hdrSig,
    'X-Chrome-Live-Sig': sig
  };
  if (bodyStr) {
    headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(`http://${bridgeConfig.host}:${bridgeConfig.port}${routePath}`, {
    method: m,
    headers,
    body: bodyStr || undefined,
    cache: 'no-store'
  });
  const serverSig = resp.headers.get('x-chrome-live-server-sig') || '';
  const expectedServerSig = await hmacSha256Hex(
    bridgeConfig.token,
    JSON.stringify(['chrome-live:http-res:v2', resp.status, ts, nonce])
  );
  if (!constantTimeHexEqual(serverSig, expectedServerSig)) {
    throw new Error('Unverified local service response signature');
  }
  return resp;
}

// tabId -> { tabId, substate: 'shared'|'worker', uiMode: string, attachedCdp: boolean, screencastActive: boolean, paused: boolean, title: string, url: string, activity: string, idleTimer: any }
const managedTabs = new Map();
const hudSyncLocks = new Map();
let liveTabGroupId = null;
let extractWindowId = null;
let extractWindowPromise = null;
let groupSerializeChain = Promise.resolve();
let activeExtractJobs = 0;

const LOCAL_AUDIT_SENSITIVE_PARAM_RX =
  /(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))/i;
const LOCAL_HASH_SENSITIVE_PAIR_RX =
  /([#?&])([^=&#]*(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))[^=&#]*)=([^&#]*)/gi;

function scrubLocalMatrixSegment(seg) {
  if (!seg || !seg.includes(';')) return seg;
  const pieces = seg.split(';');
  const head = isHighEntropyPathSegment(pieces[0]) ? 'REDACTED' : pieces[0];
  let changed = head !== pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    const eqIdx = pieces[i].indexOf('=');
    if (eqIdx === -1) continue;
    const mk = pieces[i].slice(0, eqIdx);
    const mv = pieces[i].slice(eqIdx + 1);
    if (LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(mk) || isHighEntropyPathSegment(mv)) {
      pieces[i] = `${mk}=REDACTED`;
      changed = true;
    }
  }
  pieces[0] = head;
  return changed ? pieces.join(';') : seg;
}

function scrubLocalQueryString(rawQuery) {
  if (!rawQuery || !rawQuery.startsWith('?')) return { text: rawQuery || '', changed: false };
  const rawBody = rawQuery.slice(1);
  if (!rawBody) return { text: rawQuery, changed: false };
  let changed = false;
  const pairs = rawBody.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      if (isHighEntropyPathSegment(pair)) {
        changed = true;
        return 'REDACTED';
      }
      return pair;
    }
    const rawK = pair.slice(0, eq);
    const rawV = pair.slice(eq + 1);
    let decK = rawK;
    try {
      decK = decodeURIComponent(rawK.replace(/\+/g, ' '));
    } catch {}
    if (LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(decK) || isHighEntropyPathSegment(rawV)) {
      changed = true;
      return `${rawK}=REDACTED`;
    }
    return pair;
  });
  return { text: changed ? `?${pairs.join('&')}` : rawQuery, changed };
}

function redactAuditUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl.trim());
    let changed = false;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      changed = true;
    }
    if (parsed.pathname) {
      const parts = parsed.pathname.split('/');
      let pathChanged = false;
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        if (parts[i].includes(';')) {
          const nextSeg = scrubLocalMatrixSegment(parts[i]);
          if (nextSeg !== parts[i]) {
            parts[i] = nextSeg;
            pathChanged = true;
          }
        } else if (isHighEntropyPathSegment(parts[i])) {
          parts[i] = 'REDACTED';
          pathChanged = true;
        }
      }
      if (pathChanged) {
        parsed.pathname = parts.join('/');
        changed = true;
      }
    }
    if (parsed.search) {
      for (const [k, v] of parsed.searchParams.entries()) {
        if (LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(k) || isHighEntropyPathSegment(v)) {
          parsed.searchParams.set(k, 'REDACTED');
          changed = true;
        }
      }
    }
    if (parsed.hash) {
      let cleanedHash = parsed.hash.replace(LOCAL_HASH_SENSITIVE_PAIR_RX, '$1$2=REDACTED');
      if (cleanedHash === parsed.hash && /^#!?(?:eyJ[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{32,})$/.test(parsed.hash)) {
        cleanedHash = '#REDACTED';
      } else {
        const prefixMatch = cleanedHash.match(/^(#!?)/);
        const hashPrefix = prefixMatch ? prefixMatch[1] : '#';
        const body = cleanedHash.slice(hashPrefix.length);
        const qPos = body.indexOf('?');
        const hPath = qPos === -1 ? body : body.slice(0, qPos);
        const hQuery = qPos === -1 ? '' : body.slice(qPos);
        const hParts = hPath.split('/');
        let hChanged = false;
        for (let i = 0; i < hParts.length; i++) {
          if (!hParts[i]) continue;
          if (hParts[i].includes(';')) {
            const nextSeg = scrubLocalMatrixSegment(hParts[i]);
            if (nextSeg !== hParts[i]) {
              hParts[i] = nextSeg;
              hChanged = true;
            }
          } else if (isHighEntropyPathSegment(hParts[i])) {
            hParts[i] = 'REDACTED';
            hChanged = true;
          }
        }
        const scrubbedHQuery = scrubLocalQueryString(hQuery);
        if (hChanged || scrubbedHQuery.changed) {
          cleanedHash = `${hashPrefix}${hParts.join('/')}${scrubbedHQuery.text}`;
        }
      }
      if (cleanedHash !== parsed.hash) {
        parsed.hash = cleanedHash;
        changed = true;
      }
    }
    return changed ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

function redactUrlsInTextLocal(rawText) {
  if (typeof rawText !== 'string' || !/https?:\/\//i.test(rawText)) return rawText;
  return rawText.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (match) => {
    const punctMatch = match.match(/([.,;:!?]+)$/);
    const coreUrl = punctMatch ? match.slice(0, -punctMatch[1].length) : match;
    const suffix = punctMatch ? punctMatch[1] : '';
    return redactAuditUrl(coreUrl) + suffix;
  });
}

function sanitizeLocalAuditNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) {
    return typeof node === 'string' ? redactUrlsInTextLocal(node) : node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeLocalAuditNode(item, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'url' || k === 'frameUrl' || k === 'targetUrl') && typeof v === 'string') {
      out[k] = redactAuditUrl(v);
    } else if (typeof v === 'string') {
      out[k] = redactUrlsInTextLocal(v);
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeLocalAuditNode(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function pushLocalAudit(action, detail = {}, status = 'ok') {
  const safeDetail = sanitizeLocalAuditNode(detail);
  localAudit.unshift({ ts: Date.now(), action, detail: safeDetail, status });
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
  if (CHECKOUT_SUBDOMAIN_RX.test(host)) {
    return { allowed: false, reason: `Protected payment/cashier subdomain (${host})` };
  }
  const canonPath = canonicalizeRouteForGuardrail(parsed.pathname);
  if (!canonPath.ok) {
    return { allowed: false, reason: 'Malformed percent-encoding in URL pathname' };
  }
  const rawHash = parsed.hash ? parsed.hash.replace(/^#+!?/, '') : '';
  const canonHash = rawHash ? canonicalizeRouteForGuardrail(rawHash) : { ok: true, rawPath: '', path: '' };
  if (!canonHash.ok) {
    return { allowed: false, reason: 'Malformed percent-encoding in URL fragment' };
  }
  if (
    CHECKOUT_SEGMENT_RX.test(canonPath.rawPath) ||
    CHECKOUT_SEGMENT_RX.test(canonPath.path) ||
    (canonHash.rawPath && CHECKOUT_SEGMENT_RX.test(canonHash.rawPath)) ||
    (canonHash.path && CHECKOUT_SEGMENT_RX.test(canonHash.path))
  ) {
    return { allowed: false, reason: 'Protected checkout/payment route' };
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
        if (!liveTab.discarded) {
          const fSafety = await inspectEmbeddedFramesSafety(item.tabId);
          if (!fSafety.allowed) continue;
        }
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
  // Priority 1: consume one-time `.local-runtime.json` bootstrap if `chrome-live setup` was just run
  // (daemon automatically shreds this file upon successful mutual-HMAC handshake).
  let loadedFromBootstrap = false;
  try {
    const resp = await fetch(chrome.runtime.getURL('.local-runtime.json'), { cache: 'no-store' });
    if (resp.ok) {
      const json = await resp.json();
      if (json && typeof json.token === 'string' && json.token.trim().length >= 16) {
        bridgeConfig = {
          host: '127.0.0.1',
          port: Number(json.port) || 28196,
          token: json.token.trim()
        };
        await chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: bridgeConfig });
        loadedFromBootstrap = true;
      }
    }
  } catch {
    // .local-runtime.json already shredded or not created yet; fall back to chrome.storage.local
  }

  if (!loadedFromBootstrap && stored[STORAGE_CONFIG_KEY] && stored[STORAGE_CONFIG_KEY].token) {
    bridgeConfig = {
      host: '127.0.0.1',
      port: Number(stored[STORAGE_CONFIG_KEY].port) || 28196,
      token: String(stored[STORAGE_CONFIG_KEY].token)
    };
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
      url: redactAuditUrl(entry.url),
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
  if (ws && ws.readyState === WebSocket.OPEN && wsAuthed) {
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

async function connectWebSocket(forceManual = false) {
  if (forceManual) wsSuppressedByOtherProfile = false;
  if (!bridgeConfig.token || wsSuppressedByOtherProfile) return;
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

  const wsUrl = `ws://${bridgeConfig.host}:${bridgeConfig.port}/ws/extension`;
  try {
    const sock = new WebSocket(wsUrl);
    ws = sock;
    wsAuthed = false;
    const clientNonce = generateRandomHex(32);

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      // Mutual HMAC-SHA256 challenge-response: never send pairing token or tabs until daemon proves its identity
      sock.send(JSON.stringify({ type: 'auth_init', clientNonce }));
    });

    sock.addEventListener('message', async (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!wsAuthed) {
        if (msg && msg.type === 'auth_challenge' && typeof msg.serverNonce === 'string' && typeof msg.serverProof === 'string') {
          const expectedServerProof = await hmacSha256Hex(
            bridgeConfig.token,
            JSON.stringify(['chrome-live:ws-auth:v2', 'server', clientNonce, msg.serverNonce])
          );
          if (!constantTimeHexEqual(msg.serverProof, expectedServerProof)) {
            pushLocalAudit('auth_rejected', { reason: 'Daemon serverProof mismatch' }, 'blocked');
            sock.close(4003, 'Daemon identity verification failed');
            return;
          }
          const clientProof = await hmacSha256Hex(
            bridgeConfig.token,
            JSON.stringify(['chrome-live:ws-auth:v2', 'client', clientNonce, msg.serverNonce])
          );
          wsAuthed = true;
          sock.send(
            JSON.stringify({
              type: 'auth_response',
              clientProof,
              version: EXT_VERSION,
              tabs: serializeTabs(),
              customBlockedDomains
            })
          );
          chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
          return;
        }
        sock.close(4003, 'Expected auth_challenge');
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

    sock.addEventListener('close', (ev) => {
      if (ws === sock) {
        ws = null;
        wsAuthed = false;
        if (ev && ev.code === 4009) {
          wsSuppressedByOtherProfile = true;
          pushLocalAudit('ws_yielded', { reason: 'Active in another browser profile (click Reconnect to take over)' });
          chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
          return;
        }
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
  // Never re-lock or re-show HUD on a tab that has already been released/detached!
  if ((!entry || entry.detached) && payload?.visible !== false) {
    return;
  }
  // Never allow an in-flight working update to overwrite a user-initiated pause or detach
  if (
    entry &&
    (entry.paused || entry.detached) &&
    payload &&
    payload.mode === 'working' &&
    payload.clearUserPauseLock !== true
  ) {
    return;
  }
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
        entry.uiMode = 'paused';
        await stopCdpForTab(tabId, entry);
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
      } else if (ev === 'resume') {
        entry.paused = false;
        entry.uiMode = 'working';
        await syncHud(tabId, { visible: true, mode: 'working', clearUserPauseLock: true });
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
      } else if (ev === 'release') {
        await detachManagedTab(tabId, tr().released);
      }
    }
  } catch {}
}

async function verifyEntryStillControllable(entry) {
  assertStillActiveAndUnpaused(entry);
  await pollHudUserEvents(entry.tabId, entry);
  assertStillActiveAndUnpaused(entry);
}

function resetCdpIdleTimer(entry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    stopCdpForTab(entry.tabId).catch(() => {});
  }, CDP_IDLE_DETACH_MS);
}

function isEntryLiveForCdp(tabId, entry) {
  return Boolean(entry && !entry.detached && !entry.paused && managedTabs.get(tabId) === entry);
}

async function ensureCdpForTab(tabId, entry) {
  if (!isEntryLiveForCdp(tabId, entry)) {
    throw new Error('Tab automation is paused or released by user');
  }
  resetCdpIdleTimer(entry);
  if (entry.attachedCdp) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  if (!isEntryLiveForCdp(tabId, entry)) {
    await stopCdpForTab(tabId, entry);
    throw new Error('Tab automation was paused or released during debugger attach');
  }
  entry.attachedCdp = true;
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
  if (!isEntryLiveForCdp(tabId, entry)) {
    await stopCdpForTab(tabId, entry);
    throw new Error('Tab automation was paused or released before screencast start');
  }
  await chrome.debugger
    .sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 68,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 2
    })
    .then(() => {
      if (isEntryLiveForCdp(tabId, entry)) {
        entry.screencastActive = true;
      } else {
        stopCdpForTab(tabId, entry).catch(() => {});
      }
    })
    .catch(() => {});
}

async function stopCdpForTab(tabId, entryOverride = null) {
  const entry = entryOverride || managedTabs.get(tabId) || null;
  if (entry?.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (entry) {
    entry.screencastActive = false;
    entry.attachedCdp = false;
  }
  // Always attempt stopScreencast + detach unconditionally so mid-attach cancellations never leave an orphan debugger
  await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function captureQuickFrame(tabId, entry, timeoutMs = 1200) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !wsAuthed || !isEntryLiveForCdp(tabId, entry)) return null;
  await pollHudUserEvents(tabId, entry);
  if (!isEntryLiveForCdp(tabId, entry)) return null;
  try {
    // Re-verify live tab URL and embedded sub-frames BEFORE attaching debugger or taking a post-action screenshot
    const liveTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!liveTab || !isEntryLiveForCdp(tabId, entry)) return null;
    entry.title = liveTab.title || entry.title;
    entry.url = liveTab.url || entry.url;
    const urlSafety = checkTabUrlAllowed(entry.url || '');
    if (!urlSafety.allowed) {
      await detachManagedTab(tabId, urlSafety.reason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId,
            url: redactAuditUrl(entry.url),
            reason: urlSafety.reason
          })
        );
      }
      return null;
    }
    const subSafety = await inspectEmbeddedFramesSafety(tabId);
    if (!subSafety.allowed) {
      await detachManagedTab(tabId, subSafety.reason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId,
            url: redactAuditUrl(subSafety.frameUrl || entry.url),
            reason: subSafety.reason
          })
        );
      }
      return null;
    }
    if (!isEntryLiveForCdp(tabId, entry)) return null;

    await Promise.race([
      ensureCdpForTab(tabId, entry),
      new Promise((resolve) => setTimeout(resolve, 900))
    ]);
    if (!entry.attachedCdp || !isEntryLiveForCdp(tabId, entry)) return null;
    const shot = await Promise.race([
      chrome.debugger
        .sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'jpeg',
          quality: 72
        })
        .catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
    if (!isEntryLiveForCdp(tabId, entry)) {
      await stopCdpForTab(tabId, entry);
      return null;
    }
    if (shot && shot.data) {
      ws.send(
        JSON.stringify({
          type: 'screencast_frame',
          tabId,
          mimeType: 'image/jpeg',
          data: shot.data,
          title: redactUrlsInTextLocal(entry.title || ''),
          url: redactAuditUrl(entry.url),
          activity: redactUrlsInTextLocal(entry.activity || '')
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
  if (entry) {
    entry.detached = true;
    entry.paused = true;
  }
  // Stop screencast and detach chrome.debugger BEFORE deleting entry from managedTabs
  await stopCdpForTab(tabId, entry);
  managedTabs.delete(tabId);
  rememberDetachedTab(tabId, reason, isGuardrail);
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
  if (wsSuppressedByOtherProfile) {
    connectWebSocket(true);
  }
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

  const embeddedSafety = await inspectEmbeddedFramesSafety(tab.id);
  if (!embeddedSafety.allowed) {
    pushLocalAudit(
      'share_tab',
      { tabId: tab.id, url: tab.url, frameUrl: embeddedSafety.frameUrl, reason: embeddedSafety.reason },
      'blocked'
    );
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
  // Immediately stop screencast and detach CDP before handing control to the user
  await stopCdpForTab(entry.tabId, entry);

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
  pushLocalAudit('relay_popout', { tabId: entry.tabId, url: entry.url });
  notifyPanelAndDaemon();
  return { tabId: entry.tabId, inRelayPopout: true, relayWindowId: entry.relayPopoutWinId };
}

async function mergeRelayTabBack(entry, { resumedByUserInBrowser = false } = {}) {
  if (!entry.relayPopoutWinId) {
    throw new Error(
      'Tab is not in a standalone relay popout window; paused tabs must be resumed by the user inside Chrome.'
    );
  }
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

  const groupColor = resumedByUserInBrowser ? 'cyan' : 'yellow';
  const groupLabel = resumedByUserInBrowser ? tr().groupTitle : tr().groupPaused;

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
        resumedByUserInBrowser,
        groupColor,
        groupLabel
      );
    } else if (prevOriginGroupId >= 0) {
      await chrome.tabs
        .group({ tabIds: [entry.tabId], groupId: prevOriginGroupId })
        .catch(() => {});
    }
  }

  // Only browser-originated user gestures can lift `paused`; external RPCs merge the window while keeping it paused
  if (resumedByUserInBrowser) {
    entry.paused = false;
    entry.uiMode = 'working';
    entry.activity = currentLang === 'zh' ? '已交还归队 · AI 恢复接管' : 'Merged back · AI resumed';
  } else {
    entry.paused = true;
    entry.uiMode = 'paused';
    entry.activity =
      currentLang === 'zh'
        ? '已合回原窗口（仍暂停 · 点继续恢复 AI）'
        : 'Merged to main window (Paused · Click Resume in Chrome)';
  }

  await syncHud(entry.tabId, {
    visible: true,
    mode: entry.uiMode,
    activity: entry.activity,
    clearUserPauseLock: Boolean(resumedByUserInBrowser)
  });
  await syncLiveTabGroups();
  if (resumedByUserInBrowser) {
    await captureQuickFrame(entry.tabId, entry);
  }
  pushLocalAudit('relay_merge', {
    tabId: entry.tabId,
    url: entry.url,
    resumed: resumedByUserInBrowser
  });
  notifyPanelAndDaemon();
  return {
    tabId: entry.tabId,
    inRelayPopout: false,
    paused: entry.paused,
    mergedToWindowId: targetWindowId
  };
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
  if (managedTabs.size === 0) {
    throw new Error(
      'No shared or controlled tab available. Share a tab with Alt+Shift+L or run "chrome-live open <url>".'
    );
  }
  if (managedTabs.size > 1) {
    const activeIds = Array.from(managedTabs.keys()).join(', ');
    throw new Error(
      `Multiple tabs are currently controlled (${activeIds}); specify an explicit tabId to prevent cross-tab actions.`
    );
  }
  return managedTabs.values().next().value;
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

function assertStillActiveAndUnpaused(entry) {
  if (!entry || !managedTabs.has(entry.tabId)) {
    throw new Error('Aborted: tab was released by user');
  }
  if (entry.paused) {
    throw new Error('Aborted: tab automation is currently paused by user');
  }
}

// Passive 0x0 SDK anti-fraud/telemetry beacons loaded globally on non-payment community sites (e.g. Discourse / linux.do).
// Only applied to non-top-level sub-frames (frameId !== 0); interactive payment inputs (elements-inner-*, checkout.*, hooks.*) remain strictly blocked.
function isPassiveTelemetrySubframeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const p = parsed.pathname || '';
  if ((host === 'm.stripe.network' || host === 'm.stripe.com') && /^\/(?:inner\.html)?$/i.test(p)) {
    return true;
  }
  if (
    host === 'js.stripe.com' &&
    /^\/v[23]\/(?:m-outer-[A-Za-z0-9._-]+\.html|controller-[A-Za-z0-9._-]+\.html|hcaptcha-invisible-[A-Za-z0-9._-]+\.html|fingerprinted\/)/i.test(
      p
    )
  ) {
    return true;
  }
  return false;
}

async function inspectEmbeddedFramesSafety(tabId) {
  if (chrome.webNavigation?.getAllFrames) {
    const navFrames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (Array.isArray(navFrames)) {
      for (const nf of navFrames) {
        if (!nf || !nf.url || nf.url === 'about:blank' || nf.errorOccurred) continue;
        if (nf.frameId !== 0 && isPassiveTelemetrySubframeUrl(nf.url)) continue;
        const nfSafety = checkTabUrlAllowed(nf.url);
        if (!nfSafety.allowed) {
          return {
            allowed: false,
            frameUrl: nf.url,
            reason: `Embedded payment/protected sub-frame: ${nfSafety.reason}`
          };
        }
      }
    }
  }

  const iframeRes = await runHudScriptSafe(tabId, {
    func: () => {
      const urls = [];
      const namedFrames = new Set();
      const collectFrames = (root, depth = 0) => {
        if (!root || depth > 6) return;
        for (const frame of root.querySelectorAll('iframe, frame')) {
          const fName = (frame.getAttribute('name') || '').trim();
          if (fName) namedFrames.add(fName);
          const st = window.getComputedStyle(frame);
          const rc = frame.getBoundingClientRect();
          const isVisible =
            st.display !== 'none' &&
            st.visibility !== 'hidden' &&
            st.opacity !== '0' &&
            rc.width >= 24 &&
            rc.height >= 24;
          if (isVisible) {
            const src = frame.src || frame.getAttribute('src') || '';
            if (/^https?:/i.test(src)) urls.push(src);
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) collectFrames(el.shadowRoot, depth + 1);
        }
      };
      const collectTargetedForms = (root, depth = 0) => {
        if (!root || depth > 6) return;
        if (namedFrames.size > 0) {
          for (const form of root.querySelectorAll('form[target]')) {
            const tgt = (form.getAttribute('target') || '').trim();
            const act = form.action || form.getAttribute('action') || '';
            if (tgt && namedFrames.has(tgt) && /^https?:/i.test(act)) {
              urls.push(act);
            }
          }
          for (const btn of root.querySelectorAll('button[formtarget], input[formtarget], button[formaction], input[formaction]')) {
            const effTarget = (btn.getAttribute('formtarget') || btn.form?.getAttribute('target') || '').trim();
            const effAction = btn.formAction || btn.getAttribute('formaction') || btn.form?.action || '';
            if (effTarget && namedFrames.has(effTarget) && /^https?:/i.test(effAction)) {
              urls.push(effAction);
            }
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) collectTargetedForms(el.shadowRoot, depth + 1);
        }
      };
      collectFrames(document);
      collectTargetedForms(document);
      return urls;
    }
  });
  const embeddedUrls = iframeRes?.[0]?.result;
  if (Array.isArray(embeddedUrls)) {
    for (const fUrl of embeddedUrls) {
      const fSafety = checkTabUrlAllowed(fUrl);
      if (!fSafety.allowed) {
        return {
          allowed: false,
          frameUrl: fUrl,
          reason: `Embedded payment/protected iframe: ${fSafety.reason}`
        };
      }
    }
  }
  return { allowed: true, frameUrl: '', reason: '' };
}

async function assertTabReadyForAction(entry) {
  await pollHudUserEvents(entry.tabId, entry);
  assertStillActiveAndUnpaused(entry);
  let liveTab = await chrome.tabs.get(entry.tabId);
  if (liveTab.discarded) {
    await chrome.tabs.reload(entry.tabId).catch(() => {});
    await waitForTabComplete(entry.tabId, 9000);
    liveTab = await chrome.tabs.get(entry.tabId);
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
          url: redactAuditUrl(entry.url),
          reason: safety.reason
        })
      );
    }
    throw new Error(`[GUARDRAIL] Detached tab because it navigated to ${safety.reason}`);
  }

  const subCheck = await inspectEmbeddedFramesSafety(entry.tabId);
  if (!subCheck.allowed) {
    await detachManagedTab(entry.tabId, subCheck.reason, true);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'guardrail_trip',
          tabId: entry.tabId,
          url: redactAuditUrl(subCheck.frameUrl || entry.url),
          reason: subCheck.reason
        })
      );
    }
    throw new Error(`[GUARDRAIL] Detached tab due to ${subCheck.reason}`);
  }

  // Re-verify pause/detach after async frame inspection so mid-check user pauses are never overwritten!
  await verifyEntryStillControllable(entry);
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

  if (method === 'share_active') {
    throw new Error(
      'Sharing an existing signed-in tab requires explicit user confirmation in Chrome (press Alt+Shift+L or click "Share Current Tab" in the extension panel).'
    );
  }

  if (method === 'focus_tab') {
    const entry = resolveTargetEntry(params.tabId);
    await assertTabReadyForAction(entry);
    const tab = await chrome.tabs.update(entry.tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return { tabId: entry.tabId, focused: true };
  }

  if (method === 'relay_popout') {
    const entry = resolveTargetEntry(params.tabId);
    if (entry.paused && !entry.relayPopoutWinId) {
      throw new Error(
        'Tab automation is currently paused by user; resume inside Chrome before opening a relay window.'
      );
    }
    return await popoutRelayTab(entry, params.focus !== false);
  }

  if (method === 'relay_merge') {
    const entry = resolveTargetEntry(params.tabId);
    return await mergeRelayTabBack(entry);
  }

  if (method === 'remote_interact') {
    const entry = resolveTargetEntry(params.tabId);
    await assertTabReadyForAction(entry);
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
          if (!ctrl || !ctrl._state?.visible || ctrl._state?.mode !== 'working') {
            return { aborted: true };
          }
          if (ctrl.shieldEl) ctrl.shieldEl.style.pointerEvents = 'none';
          if (typeof ctrl.moveCursor === 'function') {
            ctrl.moveCursor({ x: px, y: py, kind: 'click', press: true });
          }
          return { aborted: false, px, py, hidden: document.hidden };
        },
        args: [rx, ry]
      });
      const vp = vpRes?.[0]?.result || { aborted: false, px: 640, py: 400, hidden: false };
      if (vp.aborted) {
        await verifyEntryStillControllable(entry);
        throw new Error('Aborted: tab automation was paused or released by user');
      }
      const restoreRemoteShield = async () => {
        await chrome.scripting
          .executeScript({
            target: { tabId: entry.tabId },
            injectImmediately: true,
            func: () => {
              const ctrl = window.__chromeLiveHudController__;
              if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
            }
          })
          .catch(() => {});
      };

      await pollHudUserEvents(entry.tabId, entry);
      if (!managedTabs.has(entry.tabId) || entry.paused) {
        await restoreRemoteShield();
        assertStillActiveAndUnpaused(entry);
      }

      let hitViaCdp = false;
      let cdpFailedWhileDetached = false;
      if (!vp.hidden) {
        try {
          await ensureCdpForTab(entry.tabId, entry);
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: vp.px,
            y: vp.py
          });
          assertStillActiveAndUnpaused(entry);
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: vp.px,
            y: vp.py,
            button: 'left',
            buttons: 1,
            clickCount: 1
          });
          await new Promise((r) => setTimeout(r, 52));
          assertStillActiveAndUnpaused(entry);
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: vp.px,
            y: vp.py,
            button: 'left',
            buttons: 0,
            clickCount: 1
          });
          hitViaCdp = true;
        } catch {
          await pollHudUserEvents(entry.tabId, entry);
          if (!managedTabs.has(entry.tabId) || entry.paused || entry.detached || !entry.attachedCdp) {
            cdpFailedWhileDetached = true;
            await restoreRemoteShield();
            assertStillActiveAndUnpaused(entry);
          }
        }
      }

      await pollHudUserEvents(entry.tabId, entry);
      if (!managedTabs.has(entry.tabId) || entry.paused || entry.detached || cdpFailedWhileDetached) {
        await restoreRemoteShield();
        assertStillActiveAndUnpaused(entry);
        throw new Error('Aborted: debugger was detached during remote click');
      }

      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: (px, py, usedCdp) => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
            if (!ctrl || ctrl._state?.visible === false || ctrl._state?.mode !== 'working') return;
            if (!usedCdp) {
              const targetEl = document.elementFromPoint(px, py);
              if (targetEl) {
                targetEl.focus?.();
                targetEl.click?.();
              }
            }
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
      await verifyEntryStillControllable(entry);
      const keyRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
        func: (str, sub, ceIdx) => {
          let activeDoc = document;
          let el =
            ceIdx >= 0
              ? document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')[ceIdx]
              : document.activeElement;
          const initialActiveHost = el;
          const startedInFrame =
            Boolean(initialActiveHost) &&
            (initialActiveHost.tagName === 'IFRAME' || initialActiveHost.tagName === 'FRAME');
          for (let fHop = 0; fHop < 4 && el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME'); fHop++) {
            try {
              const subDoc = el.contentDocument;
              if (!subDoc) {
                el = null;
                break;
              }
              activeDoc = subDoc;
              el = subDoc.activeElement || null;
            } catch {
              el = null;
              break;
            }
          }
          if (startedInFrame && !el) {
            return {
              ok: false,
              error: '[GUARDRAIL] Cross-origin iframe input cannot be typed remotely; use Popout / Pause in Chrome'
            };
          }
          while (el && el.shadowRoot && el.shadowRoot.activeElement) {
            el = el.shadowRoot.activeElement;
          }
          const getTag = (n) => String(n?.tagName || '').toLowerCase();
          if (
            !el ||
            el === activeDoc.body ||
            (getTag(el) !== 'input' && getTag(el) !== 'textarea' && !el.isContentEditable)
          ) {
            if (startedInFrame) {
              return { ok: false, error: 'No active input field inside focused iframe' };
            }
            el = document.querySelector(
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, [contenteditable]:not([contenteditable="false"])'
            );
          }
          if (!el) return { ok: false, error: 'No active input field' };
          const ownerWin = el.ownerDocument?.defaultView || window;
          const st = ownerWin.getComputedStyle(el);
          const tSec = String(st.webkitTextSecurity || st.getPropertyValue('-webkit-text-security') || '').toLowerCase();
          // Detect 4..8 single-character split OTP/PIN box groups
          let isSplitOtpBox = false;
          if (getTag(el) === 'input' && (el.maxLength === 1 || Number(el.getAttribute?.('maxlength')) === 1)) {
            let grp = el.parentElement || (el.getRootNode?.()?.host ? el.getRootNode() : null);
            for (let gHop = 0; gHop < 3 && grp; gHop++) {
              if (typeof grp.querySelectorAll === 'function' && grp.querySelectorAll('input[maxlength="1"]').length >= 4) {
                isSplitOtpBox = true;
                break;
              }
              grp = grp.parentElement || (grp.getRootNode?.()?.host ?? null);
            }
          }
          const metaTokens = [];
          const autoTokens = [];
          const visitedNodes = new Set();
          const harvestNodeHints = (node, hop = 0) => {
            if (!node || typeof node.getAttribute !== 'function' || visitedNodes.has(node)) return;
            visitedNodes.add(node);
            autoTokens.push(node.getAttribute('autocomplete') || '');
            metaTokens.push(
              node.getAttribute('name'),
              node.id,
              node.getAttribute('placeholder'),
              node.getAttribute('aria-label'),
              node.getAttribute('title')
            );
            if (node.labels) {
              for (const lb of Array.from(node.labels)) metaTokens.push(lb.textContent || '');
            }
            const wrapLb = node.closest?.('label');
            if (wrapLb) metaTokens.push(wrapLb.textContent || '');
            const labelledBy = node.getAttribute('aria-labelledby') || '';
            const rootNode = node.getRootNode?.();
            const docObj = node.ownerDocument || document;
            for (const lid of labelledBy.split(/\s+/).filter(Boolean)) {
              const lNode =
                (rootNode && typeof rootNode.getElementById === 'function' ? rootNode.getElementById(lid) : null) ||
                docObj.getElementById(lid);
              if (lNode) metaTokens.push(lNode.textContent || '');
            }
            // Harvest adjacent preceding label siblings inside UI form rows (AntD / ElementPlus / Tailwind) without bleeding from prior input rows
            if (hop <= 4) {
              let sib = node.previousElementSibling;
              for (let sHop = 0; sHop < 2 && sib; sHop++, sib = sib.previousElementSibling) {
                const hasOtherInput =
                  typeof sib.querySelector === 'function' &&
                  Boolean(sib.querySelector('input, textarea, select, [contenteditable="true"]'));
                if (!hasOtherInput) {
                  const sibTxt = String(sib.textContent || '').trim();
                  if (sibTxt.length > 0 && sibTxt.length <= 64) {
                    metaTokens.push(sibTxt);
                  }
                }
              }
            }
          };
          let cursorNode = el;
          for (let hop = 0; hop < 8 && cursorNode; hop++) {
            harvestNodeHints(cursorNode, hop);
            const rn = cursorNode.getRootNode?.();
            cursorNode =
              cursorNode.parentElement ||
              (rn && rn.host ? rn.host : null) ||
              cursorNode.ownerDocument?.defaultView?.frameElement ||
              null;
          }
          if (initialActiveHost) harvestNodeHints(initialActiveHost, 0);
          const autoAttr = autoTokens.join(' ').toLowerCase();
          const rawMeta = metaTokens.filter(Boolean).join(' ');
          const decamelMeta = rawMeta
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
          if (
            isSplitOtpBox ||
            (getTag(el) === 'input' && String(el.type).toLowerCase() === 'password') ||
            (tSec && tSec !== 'none') ||
            /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(autoAttr) ||
            /(?:passw(?:or)?d|passcode|one[-_\s]?time|verif(?:y|ication)[-_\s]*(?:code|input|token|num)?|security[-_\s]*(?:code|key|token)|auth(?:entication)?[-_\s]*(?:code|token|key)|sms[-_\s]*(?:code|input|otp|token)|login[-_\s]*code|dynamic[-_\s]*code|card[-_\s]*(?:number|num|no)|api[-_\s]*key|access[-_\s]*(?:key|token)|private[-_\s]*key|client[-_\s]*secret|secret[-_\s]*(?:key|token|code)?|captcha|(?:^|[^a-zA-Z])(?:otp|totp|2fa|mfa|cvv|cvc|csc|pwd|pin|apikey|secret|token)(?:$|[^a-zA-Z])|密码|口令|验证码|动态码|安全码|校验码|密钥|私钥|令牌)/i.test(
              decamelMeta
            )
          ) {
            return {
              ok: false,
              error: '[GUARDRAIL] Remote typing into password or OTP fields is disabled; use Popout / Pause in Chrome'
            };
          }
          el.focus?.();
          if (el.isContentEditable) {
            const sel = ownerWin.getSelection?.();
            if (sel) {
              const range = (el.ownerDocument || document).createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            const docExec = el.ownerDocument || document;
            const inserted = typeof docExec.execCommand === 'function' && docExec.execCommand('insertText', false, str);
            if (!inserted) {
              el.textContent = str;
              el.dispatchEvent(new ownerWin.InputEvent('input', { bubbles: true, data: str }));
            }
          } else {
            const proto =
              getTag(el) === 'textarea'
                ? ownerWin.HTMLTextAreaElement.prototype
                : ownerWin.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, str);
            else el.value = str;
            el.dispatchEvent(new ownerWin.Event('input', { bubbles: true }));
            el.dispatchEvent(new ownerWin.Event('change', { bubbles: true }));
          }
          if (sub) {
            el.dispatchEvent(new ownerWin.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            el.form?.requestSubmit?.();
          }
          return { ok: true };
        },
        args: [val, shouldSubmit, ceIndex]
      });
      const kOut = keyRes?.[0]?.result;
      if (kOut && kOut.ok === false) {
        throw new Error(kOut.error || 'Remote text input rejected');
      }
      await new Promise((r) => setTimeout(r, 220));
      await verifyEntryStillControllable(entry);
      await captureQuickFrame(entry.tabId, entry);
      notifyPanelAndDaemon();
      return { tabId: entry.tabId, typed: val.length };
    }

    throw new Error(`Unsupported remote_interact kind: ${kind}`);
  }

  if (method === 'inspect_region') {
    const entry = resolveTargetEntry(params.tabId);
    await assertTabReadyForAction(entry);
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
          'a[href], button, input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="searchbox"], [role="combobox"], h1, h2, h3, td, li'
        );
        const scored = [];
        for (const el of cands) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const overlapW = Math.min(r.right, xMax) - Math.max(r.left, xMin);
          const overlapH = Math.min(r.bottom, yMax) - Math.max(r.top, yMin);
          if (overlapW < 3 || overlapH < 3) continue;
          const tagLower = el.tagName.toLowerCase();
          const inputType = tagLower === 'input' ? String(el.type || 'text').toLowerCase() : '';
          const autoAttr = String(el.getAttribute('autocomplete') || '').toLowerCase();
          const roleLower = String(el.getAttribute('role') || '').trim().toLowerCase();
          const elStyle = window.getComputedStyle(el);
          const textSec = String(elStyle.webkitTextSecurity || elStyle.getPropertyValue('-webkit-text-security') || '').toLowerCase();
          const isSensitiveInput =
            inputType === 'password' ||
            (textSec && textSec !== 'none') ||
            /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(autoAttr);
          const isButtonInput =
            tagLower === 'input' && /^(?:button|submit|reset)$/i.test(inputType);
          const isUserValueField =
            (tagLower === 'input' && !isButtonInput) ||
            tagLower === 'textarea' ||
            tagLower === 'select' ||
            el.isContentEditable ||
            /^(?:textbox|searchbox|combobox|spinbutton)$/.test(roleLower);
          // Never read user-typed .value, nested <textarea>/contenteditable/editor drafts, or hidden text across Shadow DOM
          const REGION_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isInsideSkipped = (node) => {
            let cur = node instanceof Element ? node : node?.parentElement;
            while (cur) {
              if (cur.isContentEditable || cur.matches?.(REGION_SKIP_SEL) || cur.closest?.(REGION_SKIP_SEL)) return true;
              const rn = cur.getRootNode?.();
              cur = rn && rn instanceof ShadowRoot ? rn.host : null;
            }
            return false;
          };
          const extractCleanText = (rootNode) => {
            if (!rootNode) return '';
            const outParts = [];
            const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = tw.nextNode())) {
              const p = tn.parentElement;
              if (p && !isInsideSkipped(p)) {
                outParts.push(tn.nodeValue || '');
              }
            }
            return outParts.join(' ');
          };
          const safeValueLabel = isButtonInput ? el.value || '' : '';
          const safeTextLabel = isUserValueField || isSensitiveInput ? '' : extractCleanText(el);
          const rawLabel = (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            safeTextLabel ||
            safeValueLabel ||
            el.getAttribute('title') ||
            el.getAttribute('name') ||
            el.id ||
            (isSensitiveInput ? '(password)' : '')
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 72);
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

    const ALLOWED_BATCH_ACTIONS = new Set([
      'open',
      'navigate',
      'type',
      'click',
      'upload',
      'scroll',
      'wait',
      'snapshot',
      'screenshot',
      'done'
    ]);
    for (let i = 0; i < steps.length; i++) {
      const rawStep = steps[i];
      if (!rawStep || typeof rawStep !== 'object') continue;
      const action = String(rawStep.action || rawStep.method || rawStep.cmd || '').trim();
      if (!ALLOWED_BATCH_ACTIONS.has(action)) {
        throw new Error(`[GUARDRAIL] Action "${action}" at batch step ${i} is not permitted inside batch pipelines`);
      }

      const stepParams = { ...rawStep };
      delete stepParams.action;
      delete stepParams.method;
      delete stepParams.cmd;
      if (stepParams.tabId === undefined && currentTabId !== undefined) {
        stepParams.tabId = currentTabId;
      }

      if (
        action !== 'open' &&
        currentTabId !== undefined &&
        managedTabs.has(currentTabId) &&
        !managedTabs.get(currentTabId).paused
      ) {
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
    const openSubCheck = await inspectEmbeddedFramesSafety(created.id);
    if (!openSubCheck.allowed) {
      await chrome.tabs.remove(created.id).catch(() => {});
      throw new Error(`[GUARDRAIL] Opened page embeds protected frame: ${openSubCheck.reason}`);
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
            if (hostWindowId !== extractWindowId && typeof workerTab.id === 'number') {
              await placeInBackgroundTabGroup(workerTab.id, workerTab.windowId);
            }
            await waitForTabComplete(workerTab.id, 15000);
            const finalTab = await chrome.tabs.get(workerTab.id);
            const postSafety = checkTabUrlAllowed(finalTab.url || '');
            if (!postSafety.allowed) {
              return { url: targetUrl, error: postSafety.reason };
            }
            const preExtractSubCheck = await inspectEmbeddedFramesSafety(workerTab.id);
            if (!preExtractSubCheck.allowed) {
              return { url: targetUrl, error: `[GUARDRAIL] ${preExtractSubCheck.reason}` };
            }

            const injected = await chrome.scripting.executeScript({ target: { tabId: workerTab.id  }, injectImmediately: true,
              func: async (steps) => {
                for (let i = 0; i < steps; i++) {
                  window.scrollBy(0, Math.round(window.innerHeight * 0.85));
                  await new Promise((r) => setTimeout(r, 320));
                }
                const root =
                  document.querySelector('article, main, [role="main"]') || document.body;
                const SKIP_TAGS = new Set([
                  'STYLE',
                  'SCRIPT',
                  'NOSCRIPT',
                  'TEMPLATE',
                  'SVG',
                  'TEXTAREA',
                  'SELECT',
                  'OPTION'
                ]);
                const SKIP_CLOSEST =
                  'style, script, noscript, template, textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
                const isInsideSkipped = (node) => {
                  let cur = node instanceof Element ? node : node?.parentElement;
                  while (cur) {
                    if (cur.isContentEditable || cur.matches?.(SKIP_CLOSEST) || cur.closest?.(SKIP_CLOSEST)) return true;
                    const rn = cur.getRootNode?.();
                    cur = rn && rn instanceof ShadowRoot ? rn.host : null;
                  }
                  return false;
                };
                const visCache = new WeakMap();
                const isElemVisible = (el) => {
                  if (visCache.has(el)) return visCache.get(el);
                  const cs = window.getComputedStyle(el);
                  const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || '').toLowerCase();
                  let v = (!tSec || tSec === 'none');
                  if (v) {
                    if (typeof el.checkVisibility === 'function') {
                      v = el.checkVisibility({ checkVisibilityCSS: true });
                    } else {
                      v = cs.display !== 'none' && cs.visibility !== 'hidden';
                    }
                  }
                  visCache.set(el, v);
                  return v;
                };
                let text = '';
                if (root) {
                  const parts = [];
                  let accLen = 0;
                  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                  let node;
                  while ((node = walker.nextNode())) {
                    const p = node.parentElement;
                    if (!p) continue;
                    if (SKIP_TAGS.has(p.tagName) || isInsideSkipped(p) || !isElemVisible(p)) {
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
            const extractedItem = injected?.[0]?.result || { url: targetUrl, text: '', images: [] };
            // Re-verify post-scroll final URL & sub-frames against late SPA/JS redirects into checkout/payment routes!
            const afterScrollTab = await chrome.tabs.get(workerTab.id).catch(() => null);
            const lateUrlCheck = checkTabUrlAllowed(afterScrollTab?.url || extractedItem.finalUrl || '');
            if (!lateUrlCheck.allowed) {
              return { url: targetUrl, error: `[GUARDRAIL] ${lateUrlCheck.reason}` };
            }
            if (extractedItem.finalUrl) {
              const resUrlCheck = checkTabUrlAllowed(extractedItem.finalUrl);
              if (!resUrlCheck.allowed) {
                return { url: targetUrl, error: `[GUARDRAIL] ${resUrlCheck.reason}` };
              }
            }
            if (chrome.webNavigation?.getAllFrames) {
              const subFrames = await chrome.webNavigation.getAllFrames({ tabId: workerTab.id }).catch(() => null);
              if (Array.isArray(subFrames)) {
                for (const sf of subFrames) {
                  if (sf?.url && sf.url !== 'about:blank' && !sf.errorOccurred) {
                    if (sf.frameId !== 0 && isPassiveTelemetrySubframeUrl(sf.url)) continue;
                    const sfCheck = checkTabUrlAllowed(sf.url);
                    if (!sfCheck.allowed) {
                      return { url: targetUrl, error: `[GUARDRAIL] Embedded protected frame: ${sfCheck.reason}` };
                    }
                  }
                }
              }
            }
            return extractedItem;
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
    await verifyEntryStillControllable(entry);

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: (limit) => {
        const SELECTORS =
          'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="switch"], [role="radio"], [role="checkbox"], [role="option"], [role="menuitem"], [contenteditable]:not([contenteditable="false"]), label:has(input[type="radio"]), label:has(input[type="checkbox"])';

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
          const inputType = tagLower === 'input' ? String(node.type || 'text').toLowerCase() : '';
          const autoAttr = String(node.getAttribute('autocomplete') || '').toLowerCase();
          const roleAttr = (node.getAttribute('role') || '').trim().toLowerCase();
          const textSec = String(style.webkitTextSecurity || style.getPropertyValue('-webkit-text-security') || '').toLowerCase();
          const isSensitiveField =
            inputType === 'password' ||
            (textSec && textSec !== 'none') ||
            /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(autoAttr);
          const isButtonInput =
            tagLower === 'input' && /^(?:button|submit|reset)$/i.test(inputType);
          const isUserValueField =
            (tagLower === 'input' && !isButtonInput) ||
            tagLower === 'textarea' ||
            tagLower === 'select' ||
            node.isContentEditable ||
            /^(?:textbox|searchbox|combobox|spinbutton)$/.test(roleAttr);
          // Never expose user-entered password/OTP/input values or nested editor draft text as element labels
          const SNAP_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isSnapSkipped = (n) => {
            let cur = n instanceof Element ? n : n?.parentElement;
            while (cur) {
              if (cur.isContentEditable || cur.matches?.(SNAP_SKIP_SEL) || cur.closest?.(SNAP_SKIP_SEL)) return true;
              const rn = cur.getRootNode?.();
              cur = rn && rn instanceof ShadowRoot ? rn.host : null;
            }
            return false;
          };
          const extractCleanText = (rootNode) => {
            if (!rootNode) return '';
            const outParts = [];
            const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = tw.nextNode())) {
              const p = tn.parentElement;
              if (p && !isSnapSkipped(p)) {
                outParts.push(tn.nodeValue || '');
              }
            }
            return outParts.join(' ');
          };
          const rawLabel =
            node.getAttribute('aria-label') ||
            node.getAttribute('placeholder') ||
            (isUserValueField || isSensitiveField ? '' : extractCleanText(node)) ||
            (isButtonInput ? node.value : '') ||
            node.getAttribute('title') ||
            (isSensitiveField ? '(password)' : '') ||
            '';
          const label = String(rawLabel).replace(/\s+/g, ' ').trim().slice(0, 90);
          let stableSelector;
          const isControl =
            !isSensitiveField &&
            (tagLower === 'input' ||
              tagLower === 'textarea' ||
              tagLower === 'select' ||
              tagLower === 'button' ||
              /^(?:textbox|searchbox|combobox|switch|radio|checkbox|option|menuitem)$/.test(roleAttr));
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
          const ALERT_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isAlertSkipped = (n) => {
            let cur = n instanceof Element ? n : n?.parentElement;
            while (cur) {
              if (cur.isContentEditable || cur.matches?.(ALERT_SKIP_SEL) || cur.closest?.(ALERT_SKIP_SEL)) return true;
              const rn = cur.getRootNode?.();
              cur = rn && rn instanceof ShadowRoot ? rn.host : null;
            }
            return false;
          };
          const cleanAlertParts = [];
          const aWalker = document.createTreeWalker(aNode, NodeFilter.SHOW_TEXT);
          let aTn;
          while ((aTn = aWalker.nextNode())) {
            const ap = aTn.parentElement;
            if (ap && !isAlertSkipped(ap)) {
              cleanAlertParts.push(aTn.nodeValue || '');
            }
          }
          const txt = cleanAlertParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
          if (txt && txt.length >= 2) alertSet.add(txt);
        }
        const alerts = Array.from(alertSet);

        const mainRoot = document.querySelector('main, article, [role="main"]') || document.body;
        const SKIP_TAGS = new Set([
          'STYLE',
          'SCRIPT',
          'NOSCRIPT',
          'TEMPLATE',
          'SVG',
          'TEXTAREA',
          'SELECT',
          'OPTION'
        ]);
        const SKIP_CLOSEST =
          'style, script, noscript, template, textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
        const isInsideSkipped = (n) => {
          let cur = n instanceof Element ? n : n?.parentElement;
          while (cur) {
            if (cur.isContentEditable || cur.matches?.(SKIP_CLOSEST) || cur.closest?.(SKIP_CLOSEST)) return true;
            const rn = cur.getRootNode?.();
            cur = rn && rn instanceof ShadowRoot ? rn.host : null;
          }
          return false;
        };
        const visCache = new WeakMap();
        const isElemVisible = (el) => {
          if (visCache.has(el)) return visCache.get(el);
          const cs = window.getComputedStyle(el);
          const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || '').toLowerCase();
          let v = (!tSec || tSec === 'none');
          if (v) {
            if (typeof el.checkVisibility === 'function') {
              v = el.checkVisibility({ checkVisibilityCSS: true });
            } else {
              v = cs.display !== 'none' && cs.visibility !== 'hidden';
            }
          }
          visCache.set(el, v);
          return v;
        };
        let excerpt = '';
        if (mainRoot) {
          const parts = [];
          let accLen = 0;
          const walker = document.createTreeWalker(mainRoot, NodeFilter.SHOW_TEXT);
          let tNode;
          while ((tNode = walker.nextNode())) {
            const p = tNode.parentElement;
            if (!p) continue;
            if (SKIP_TAGS.has(p.tagName) || isInsideSkipped(p) || !isElemVisible(p)) {
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

    await verifyEntryStillControllable(entry);
    await captureQuickFrame(entry.tabId, entry);
    notifyPanelAndDaemon();
    return { tabId: entry.tabId, ...(execRes?.[0]?.result || {}) };
  }

  if (method === 'click') {
    const target = params.target;
    if (typeof target === 'string') {
      assertSafeModelSelector(target);
    }
    entry.activity = tr().clicking(typeof target === 'number' ? `[${target}]` : String(target).slice(0, 24));
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);

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

        const CLICK_SKIP_SEL =
          'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
        const isClickSkipped = (n) => {
          let cur = n instanceof Element ? n : n?.parentElement;
          while (cur) {
            if (cur.isContentEditable || cur.matches?.(CLICK_SKIP_SEL) || cur.closest?.(CLICK_SKIP_SEL)) return true;
            const rn = cur.getRootNode?.();
            cur = rn && rn instanceof ShadowRoot ? rn.host : null;
          }
          return false;
        };

        function extractCleanContainerText(rootNode) {
          if (!rootNode) return '';
          const outParts = [];
          const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = tw.nextNode())) {
            const p = tn.parentElement;
            if (p && !isClickSkipped(p)) {
              outParts.push(tn.nodeValue || '');
            }
          }
          return outParts.join(' ');
        }

        function isInteractableElement(cand) {
          if (!cand || !(cand instanceof Element)) return false;
          const tg = cand.tagName.toLowerCase();
          if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
            return false;
          }
          if (tg === 'input' && String(cand.type || '').toLowerCase() === 'hidden') return false;
          if (cand.closest?.('[data-chrome-live-hud]')) return false;
          const st = window.getComputedStyle(cand);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const rc = cand.getBoundingClientRect();
          return rc.width >= 2 && rc.height >= 2;
        }

        let el = null;
        if (typeof tgt === 'number') {
          const hit = queryDeep(document, `[data-clive-idx="${tgt}"]`);
          if (isInteractableElement(hit)) el = hit;
        } else {
          const raw = String(tgt || '').trim();
          if (raw && /[#.\[\]>:+~=]/.test(raw)) {
            const hit = queryDeep(document, raw);
            if (isInteractableElement(hit)) el = hit;
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
              const iTag = item.tagName.toLowerCase();
              const iRole = String(item.getAttribute('role') || '').trim().toLowerCase();
              const iBtn = iTag === 'input' && /^(?:button|submit|reset)$/i.test(String(item.type || ''));
              const iUserVal =
                (iTag === 'input' && !iBtn) ||
                iTag === 'textarea' ||
                iTag === 'select' ||
                item.isContentEditable ||
                /^(?:textbox|searchbox|combobox|spinbutton)$/.test(iRole);
              const txt = (
                (iUserVal ? '' : extractCleanContainerText(item)) ||
                (iBtn ? item.value : '') ||
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
        const elTagLower = el.tagName.toLowerCase();
        const elInputType = elTagLower === 'input' ? String(el.type || 'text').toLowerCase() : '';
        const elAutoAttr = String(el.getAttribute('autocomplete') || '').toLowerCase();
        const elRoleAttr = String(el.getAttribute('role') || '').trim().toLowerCase();
        let elHasTextSecurity = false;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && typeof Element !== 'undefined' && el instanceof Element) {
          const elCs = window.getComputedStyle(el);
          const tSec = String(elCs.webkitTextSecurity || elCs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
          elHasTextSecurity = Boolean(tSec && tSec !== 'none');
        }
        const elIsSensitive =
          elInputType === 'password' ||
          elHasTextSecurity ||
          /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(elAutoAttr);
        const elIsButtonInput =
          elTagLower === 'input' && /^(?:button|submit|reset)$/i.test(elInputType);
        const elIsUserValueField =
          (elTagLower === 'input' && !elIsButtonInput) ||
          elTagLower === 'textarea' ||
          elTagLower === 'select' ||
          el.isContentEditable ||
          /^(?:textbox|searchbox|combobox|spinbutton)$/.test(elRoleAttr);
        const extractSafeNodeText = (rootNode) => extractCleanContainerText(rootNode);
        // Never leak user-entered password/OTP/input values or nested drafts in disabled errors or click receipts
        const safeElemLabel = (maxLen) =>
          (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            (elIsUserValueField || elIsSensitive ? '' : extractSafeNodeText(el)) ||
            (elIsButtonInput ? el.value : '') ||
            el.getAttribute('title') ||
            (elIsSensitive ? '(password)' : '') ||
            el.getAttribute('name') ||
            el.id ||
            elTagLower
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLen);

        if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
          const dLabel = safeElemLabel(60);
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

        const learnedSelector = elIsSensitive ? '' : deriveStableSelector(el);
        const label = safeElemLabel(42);

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

        if (ctrl && (!ctrl._state?.visible || ctrl._state?.mode === 'paused')) {
          return { ok: false, error: 'Aborted: tab automation was paused or released by user' };
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

    // Dispatch real hardware-level isTrusted:true quadratic Bezier mouse arc + approach deceleration via CDP
    if (out.needHardwareClick) {
      const cleanupPendingClickInPage = async () => {
        await chrome.scripting
          .executeScript({
            target: { tabId: entry.tabId },
            injectImmediately: true,
            func: () => {
              const ctrl = window.__chromeLiveHudController__;
              if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
              const pending = window.__clivePendingClickEl;
              delete window.__clivePendingClickEl;
              if (pending) delete pending.__cliveTrustedReceived;
            }
          })
          .catch(() => {});
      };

      await pollHudUserEvents(entry.tabId, entry);
      if (!managedTabs.has(entry.tabId) || entry.paused || entry.detached) {
        await cleanupPendingClickInPage();
        assertStillActiveAndUnpaused(entry);
      }

      let cdpDispatched = false;
      let cdpDetachedMidFlight = false;
      try {
        // Temporarily lift shield pointer-events so CDP hit-test lands on the real page element
        await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: () => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = 'none';
          }
        });
        await ensureCdpForTab(entry.tabId, entry);
        // Quadratic Bezier control point + approach deceleration schedule (smaller spatial steps & slightly longer dwell near target)
        const ctrlX = Math.round((out.startX + out.x) / 2 + (Math.random() - 0.5) * 28);
        const ctrlY = Math.round((out.startY + out.y) / 2 - (10 + Math.random() * 18));
        const bezierSchedule = [
          [0.18, 9],
          [0.38, 10],
          [0.58, 12],
          [0.76, 15],
          [0.90, 19],
          [1.0, 22]
        ];
        for (const [tVal, stepWaitMs] of bezierSchedule) {
          assertStillActiveAndUnpaused(entry);
          const inv = 1 - tVal;
          const mx = Math.round((inv * inv * out.startX + 2 * inv * tVal * ctrlX + tVal * tVal * out.x) * 10) / 10;
          const my = Math.round((inv * inv * out.startY + 2 * inv * tVal * ctrlY + tVal * tVal * out.y) * 10) / 10;
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: mx,
            y: my
          });
          await new Promise((r) => setTimeout(r, stepWaitMs + Math.floor(Math.random() * 7)));
        }
        assertStillActiveAndUnpaused(entry);
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
        assertStillActiveAndUnpaused(entry);
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: out.x,
          y: out.y,
          button: 'left',
          buttons: 0,
          clickCount: 1
        });
        cdpDispatched = true;
      } catch {
        await pollHudUserEvents(entry.tabId, entry);
        if (!managedTabs.has(entry.tabId) || entry.paused || entry.detached || !entry.attachedCdp) {
          cdpDetachedMidFlight = true;
          await cleanupPendingClickInPage();
          assertStillActiveAndUnpaused(entry);
        }
      }

      await pollHudUserEvents(entry.tabId, entry);
      if (!managedTabs.has(entry.tabId) || entry.paused || entry.detached || cdpDetachedMidFlight) {
        await cleanupPendingClickInPage();
        assertStillActiveAndUnpaused(entry);
        throw new Error('Aborted: debugger was detached during click');
      }

      await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
          func: (didCdp) => {
            const ctrl = window.__chromeLiveHudController__;
            if (ctrl?.shieldEl) ctrl.shieldEl.style.pointerEvents = '';
            const pending = window.__clivePendingClickEl;
            delete window.__clivePendingClickEl;
            if (pending) {
              const hudStillWorking = ctrl && ctrl._state?.visible === true && ctrl._state?.mode === 'working';
              if (hudStillWorking && (!didCdp || !pending.__cliveTrustedReceived)) {
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
    await verifyEntryStillControllable(entry);
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
    if (typeof target === 'string') {
      assertSafeModelSelector(target);
    }
    entry.activity = tr().typing;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);

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

        function isValidTypeTarget(cand) {
          if (!cand || !(cand instanceof Element)) return false;
          const tg = cand.tagName.toLowerCase();
          if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
            return false;
          }
          if (tg === 'input' && String(cand.type || '').toLowerCase() === 'hidden') return false;
          if (cand.closest?.('[data-chrome-live-hud]')) return false;
          const st = window.getComputedStyle(cand);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const rc = cand.getBoundingClientRect();
          return rc.width >= 2 && rc.height >= 2;
        }

        let el = null;
        if (typeof tgt === 'number') {
          const hit = queryDeep(document, `[data-clive-idx="${tgt}"]`);
          if (isValidTypeTarget(hit)) el = hit;
        } else if (typeof tgt === 'string') {
          const raw = tgt.trim();
          if (raw) {
            const hit = queryDeep(document, raw);
            if (isValidTypeTarget(hit)) el = hit;
          }
          if (!el && raw) {
            const needle = raw.toLowerCase();
            const inputs = collectDeep(
              document,
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]'
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

        // Drill into inner native input/textarea if target matched a wrapper custom element (while preserving outer host metadata!)
        const outerMatchedEl = el;
        if (
          el &&
          !(el instanceof HTMLInputElement) &&
          !(el instanceof HTMLTextAreaElement) &&
          !el.isContentEditable
        ) {
          const inner =
            (el.shadowRoot &&
              el.shadowRoot.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"])')) ||
            el.querySelector?.('input, textarea, [contenteditable]:not([contenteditable="false"])');
          if (inner) el = inner;
        }

        if (!el) return { ok: false, error: `Input element not found: ${tgt}` };
        const elStyle = window.getComputedStyle(el);
        const elTextSec = String(elStyle.webkitTextSecurity || elStyle.getPropertyValue('-webkit-text-security') || '').toLowerCase();
        // Detect 4..8 single-character split OTP/PIN input boxes
        let isSplitOtpInput = false;
        const isInputNode =
          el instanceof HTMLInputElement || String(el.tagName || '').toLowerCase() === 'input';
        if (isInputNode && (el.maxLength === 1 || Number(el.getAttribute?.('maxlength')) === 1)) {
          let grp = el.parentElement || (el.getRootNode?.()?.host ? el.getRootNode() : null);
          for (let gHop = 0; gHop < 3 && grp; gHop++) {
            if (typeof grp.querySelectorAll === 'function' && grp.querySelectorAll('input[maxlength="1"]').length >= 4) {
              isSplitOtpInput = true;
              break;
            }
            grp = grp.parentElement || (grp.getRootNode?.()?.host ?? null);
          }
        }
        const elMetaBucket = [];
        const elAutoBucket = [];
        const seenAncestors = new Set();
        const collectFromNode = (node, hop = 0) => {
          if (!node || typeof node.getAttribute !== 'function' || seenAncestors.has(node)) return;
          seenAncestors.add(node);
          elAutoBucket.push(node.getAttribute('autocomplete') || '');
          elMetaBucket.push(
            node.getAttribute('name'),
            node.id,
            node.getAttribute('placeholder'),
            node.getAttribute('aria-label'),
            node.getAttribute('title')
          );
          if (node.labels) {
            for (const lb of Array.from(node.labels)) elLabelPush(lb.textContent || '');
          }
          const wLb = node.closest?.('label');
          if (wLb) elLabelPush(wLb.textContent || '');
          const labelledBy = node.getAttribute('aria-labelledby') || '';
          const rootObj = node.getRootNode?.();
          for (const lid of labelledBy.split(/\s+/).filter(Boolean)) {
            const lNode =
              (rootObj && typeof rootObj.getElementById === 'function' ? rootObj.getElementById(lid) : null) ||
              document.getElementById(lid);
            if (lNode) elLabelPush(lNode.textContent || '');
          }
          // Harvest adjacent preceding label siblings inside UI form rows (AntD / ElementPlus / Tailwind) without bleeding from prior input rows
          if (hop <= 4) {
            let sib = node.previousElementSibling;
            for (let sHop = 0; sHop < 2 && sib; sHop++, sib = sib.previousElementSibling) {
              const hasOtherInput =
                typeof sib.querySelector === 'function' &&
                Boolean(sib.querySelector('input, textarea, select, [contenteditable="true"]'));
              if (!hasOtherInput) {
                const sibTxt = String(sib.textContent || '').trim();
                if (sibTxt.length > 0 && sibTxt.length <= 64) {
                  elLabelPush(sibTxt);
                }
              }
            }
          }
        };
        function elLabelPush(txt) {
          if (txt) elMetaBucket.push(txt);
        }
        let walkNode = el;
        for (let hop = 0; hop < 8 && walkNode; hop++) {
          collectFromNode(walkNode, hop);
          const rn = walkNode.getRootNode?.();
          walkNode = walkNode.parentElement || (rn && rn.host ? rn.host : null);
        }
        if (typeof outerMatchedEl !== 'undefined' && outerMatchedEl) {
          collectFromNode(outerMatchedEl, 0);
        }
        const elAuto = elAutoBucket.join(' ').toLowerCase();
        const rawMetaHints = elMetaBucket.filter(Boolean).join(' ');
        const decamelMetaHints = rawMetaHints
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
        if (
          isSplitOtpInput ||
          (isInputNode && String(el.type || '').toLowerCase() === 'password') ||
          (elTextSec && elTextSec !== 'none') ||
          /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(elAuto) ||
          /(?:passw(?:or)?d|passcode|one[-_\s]?time|verif(?:y|ication)[-_\s]*(?:code|input|token|num)?|security[-_\s]*(?:code|key|token)|auth(?:entication)?[-_\s]*(?:code|token|key)|sms[-_\s]*(?:code|input|otp|token)|login[-_\s]*code|dynamic[-_\s]*code|card[-_\s]*(?:number|num|no)|api[-_\s]*key|access[-_\s]*(?:key|token)|private[-_\s]*key|client[-_\s]*secret|secret[-_\s]*(?:key|token|code)?|captcha|(?:^|[^a-zA-Z])(?:otp|totp|2fa|mfa|cvv|cvc|csc|pwd|pin|apikey|secret|token)(?:$|[^a-zA-Z])|密码|口令|验证码|动态码|安全码|校验码|密钥|私钥|令牌)/i.test(
            decamelMetaHints
          )
        ) {
          return {
            ok: false,
            error:
              '[GUARDRAIL] Automated typing into password, OTP, or payment security fields is blocked; use Pause / Popout to enter credentials manually in Chrome'
          };
        }
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
        const isHudAborted = () => Boolean(ctrl && (ctrl._state?.visible === false || ctrl._state?.mode === 'paused'));
        if (isHudAborted()) {
          return { ok: false, error: 'Aborted: tab automation was paused or released by user' };
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
              if (isHudAborted()) {
                return { ok: false, error: 'Aborted mid-typing: tab automation was paused or released by user' };
              }
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
              if (isHudAborted()) {
                return { ok: false, error: 'Aborted mid-typing: tab automation was paused or released by user' };
              }
              el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
              built += ch;
              setInputValue(el, built);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
              await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 26)));
            }
            if (isHudAborted()) {
              return { ok: false, error: 'Aborted mid-typing: tab automation was paused or released by user' };
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            setInputValue(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        if (isHudAborted()) {
          return { ok: false, error: 'Aborted before submit: tab automation was paused or released by user' };
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

        const tInputType = String(el.getAttribute?.('type') || el.type || '').toLowerCase();
        const tAutoAttr = String(el.getAttribute?.('autocomplete') || '').toLowerCase();
        const tMeta = `${el.id || ''} ${el.name || ''} ${el.getAttribute?.('placeholder') || ''} ${el.getAttribute?.('aria-label') || ''}`;
        const isSensitiveTypeTarget =
          tInputType === 'password' ||
          /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(tAutoAttr) ||
          /(?:password|passwd|passcode|pwd|one-time|otp|2fa|totp|cvv|cvc|secret|pin|token|sms|verify|captcha|密码|口令|验证码|动态码|安全码|密钥|支付)/i.test(tMeta);
        const learnedSelector = isSensitiveTypeTarget ? '' : deriveInputSelector(el);
        const idAndCls = `${el.id || ''} ${el.name || ''} ${el.className || ''}`;
        const isSearchField =
          /(?:search|query|^s$|^q$|^kw$)/i.test(el.name || '') ||
          /search/i.test(idAndCls) ||
          tInputType === 'search';
        const extractSafeLabelNode = (lblNode) => {
          if (!lblNode) return '';
          const parts = [];
          const tw = document.createTreeWalker(lblNode, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = tw.nextNode())) {
            const p = tn.parentElement;
            if (
              p &&
              !p.isContentEditable &&
              !p.closest(
                'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"], style, script'
              )
            ) {
              parts.push(tn.nodeValue || '');
            }
          }
          return parts.join(' ').trim();
        };
        const learnedName = isSensitiveTypeTarget
          ? ''
          : isSearchField
            ? '站内搜索框'
            : (
                el.getAttribute('aria-label') ||
                extractSafeLabelNode(el.labels?.[0]) ||
                el.getAttribute('name') ||
                el.id ||
                el.getAttribute('placeholder') ||
                '输入框'
              )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 32);
        const cmHost = el.closest?.('.CodeMirror') || null;
        let cmTargetToken = '';
        if (cmHost) {
          cmTargetToken = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          cmHost.setAttribute('data-clive-cm-target', cmTargetToken);
        }
        return { ok: true, x: cx, y: cy, learnedSelector, learnedName, cmTargetToken };
      },
      args: [target, String(text ?? ''), Boolean(submit)]
    });

    const out = execRes?.[0]?.result;
    if (!out || !out.ok) throw new Error(out?.error || 'Type failed');
    await verifyEntryStillControllable(entry);
    if (out.cmTargetToken) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: entry.tabId },
          injectImmediately: true,
          world: 'MAIN',
          func: (v, tok) => {
            const host = document.querySelector(`[data-clive-cm-target="${tok}"]`);
            if (!host) return;
            host.removeAttribute('data-clive-cm-target');
            const cm = host.CodeMirror;
            if (cm && typeof cm.setValue === 'function') {
              cm.setValue(v);
              cm.save?.();
            }
          },
          args: [String(text ?? ''), out.cmTargetToken]
        });
      } catch {
        await chrome.scripting
          .executeScript({
            target: { tabId: entry.tabId },
            injectImmediately: true,
            func: (tok) => {
              document.querySelector(`[data-clive-cm-target="${tok}"]`)?.removeAttribute('data-clive-cm-target');
            },
            args: [out.cmTargetToken]
          })
          .catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 220));
    await verifyEntryStillControllable(entry);
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
    if (typeof params.target === 'string') {
      assertSafeModelSelector(params.target);
    }
    const EXT_SENSITIVE_BASE_RX =
      /^(?:(?!.*\.pub$)id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-].+)|authorized_keys|known_hosts|auth\.token|site-playbooks\.json|daemon\.pid|spawn\.(?:lock|cooldown)|\.local-runtime\.json|agent_vault\.enc|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|credentials(?:\.json)?|application_default_credentials\.json|Local\s+State|Cookies(?:-journal)?|cookies\.sqlite|key[34]\.db|cert9\.db|logins\.json|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore)|.*\.tfstate(?:\.backup)?)$/i;
    for (const rawFile of files) {
      const fStr = String(rawFile || '').trim();
      const withoutDrive = fStr.replace(/^[A-Za-z]:/, '');
      const base = fStr.split(/[\\/]/).pop()?.replace(/[.\s]+$/, '') || '';
      if (!base || withoutDrive.includes(':') || EXT_SENSITIVE_BASE_RX.test(base)) {
        throw new Error(`[GUARDRAIL] Blocked sensitive or malformed upload path: ${base || 'invalid'}`);
      }
    }

    const target = params.target ?? 'auto';
    const exts = files.map((f) => {
      const m = String(f).match(/(\.[a-z0-9]+)$/i);
      return m ? m[1].toLowerCase() : '';
    });

    entry.activity = tr().uploading(files.length);
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await ensureCdpForTab(entry.tabId, entry);
    await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Page.enable').catch(() => {});
    await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'DOM.enable').catch(() => {});
    await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.enable').catch(() => {});
    assertStillActiveAndUnpaused(entry);

    // Execute file-input locator inside a fresh isolated world so untrusted page JS cannot poison prototypes
    let isolatedContextId = undefined;
    try {
      const treeRes = await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Page.getFrameTree');
      const mainFrameId = treeRes?.frameTree?.frame?.id;
      if (mainFrameId) {
        const worldRes = await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Page.createIsolatedWorld', {
          frameId: mainFrameId,
          worldName: 'ChromeLiveUploadIsolated',
          grantUniversalAccess: false
        });
        isolatedContextId = worldRes?.executionContextId;
      }
    } catch {}

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
      returnByValue: false,
      ...(typeof isolatedContextId === 'number' ? { contextId: isolatedContextId } : {})
    });

    if (evalRes?.result?.objectId) {
      const objectId = evalRes.result.objectId;
      await pollHudUserEvents(entry.tabId, entry);
      assertStillActiveAndUnpaused(entry);
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
      await verifyEntryStillControllable(entry);
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
      await verifyEntryStillControllable(entry);
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
              document.querySelector('[contenteditable]:not([contenteditable="false"]), textarea, [role="textbox"]') ||
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
          if (ctrl && (!ctrl._state?.visible || ctrl._state?.mode === 'paused')) {
            return { ok: false, error: 'Aborted: tab automation was paused or released by user' };
          }
          if (ctrl && typeof ctrl.moveCursor === 'function') {
            ctrl.moveCursor({
              x: rect.left + Math.max(20, rect.width / 2),
              y: rect.top + Math.max(20, Math.min(80, rect.height / 2)),
              kind: 'upload',
              press: true
            });
          }
          if (ctrl && (!ctrl._state?.visible || ctrl._state?.mode === 'paused')) {
            return { ok: false, error: 'Aborted: tab automation was paused or released by user' };
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
      await verifyEntryStillControllable(entry);
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
    await verifyEntryStillControllable(entry);

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (dir, px) => {
        const ctrl = window.__chromeLiveHudController__;
        const isAborted = () => Boolean(ctrl && (!ctrl._state?.visible || ctrl._state?.mode === 'paused'));
        if (isAborted()) {
          return { ok: false, error: 'Aborted: tab automation was paused or released by user' };
        }
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
              if (isAborted()) {
                return { ok: false, error: 'Aborted mid-scroll: tab automation was paused or released by user' };
              }
              window.scrollBy({ top: Math.round(totalDelta * ratio), behavior: 'smooth' });
              await new Promise((r) => setTimeout(r, 65 + Math.floor(Math.random() * 25)));
            }
          }
        }
        return { ok: true, scrollY: Math.round(window.scrollY), innerHeight: window.innerHeight };
      },
      args: [direction, amount]
    });

    const sOut = execRes?.[0]?.result;
    if (sOut && sOut.ok === false) {
      throw new Error(sOut.error || 'Scroll aborted');
    }
    await new Promise((r) => setTimeout(r, 180));
    await verifyEntryStillControllable(entry);
    await captureQuickFrame(entry.tabId, entry);
    return { tabId: entry.tabId, ...(sOut || {}) };
  }

  if (method === 'navigate') {
    const url = String(params.url || '').trim();
    const safety = checkTabUrlAllowed(url);
    if (!safety.allowed) throw new Error(`[GUARDRAIL] ${safety.reason}`);
    await verifyEntryStillControllable(entry);
    entry.activity = tr().navigating;
    await chrome.tabs.update(entry.tabId, { url });
    await waitForTabComplete(entry.tabId, 15000);
    await verifyEntryStillControllable(entry);
    const updated = await chrome.tabs.get(entry.tabId);
    entry.title = updated.title || '';
    entry.url = updated.url || url;
    const postSafety = checkTabUrlAllowed(entry.url);
    if (!postSafety.allowed) {
      await detachManagedTab(entry.tabId, postSafety.reason, true);
      throw new Error(`[GUARDRAIL] Blocked redirect: ${postSafety.reason}`);
    }
    const navSubCheck = await inspectEmbeddedFramesSafety(entry.tabId);
    if (!navSubCheck.allowed) {
      await detachManagedTab(entry.tabId, navSubCheck.reason, true);
      throw new Error(`[GUARDRAIL] Blocked embedded payment frame: ${navSubCheck.reason}`);
    }
    entry.activity = tr().loaded(entry.title.slice(0, 28));
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);
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
    await pollHudUserEvents(entry.tabId, entry);
    assertStillActiveAndUnpaused(entry);
    await captureQuickFrame(entry.tabId, entry);
    await stopCdpForTab(entry.tabId, entry);

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
    if (selector) {
      assertSafeModelSelector(selector);
    }
    const timeoutMs = Math.min(15000, Math.max(300, Number(params.timeoutMs) || 8000));
    entry.activity = tr().waiting;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);

    if (selector) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await verifyEntryStillControllable(entry);
        const execRes = await chrome.scripting.executeScript({
          target: { tabId: entry.tabId },
          injectImmediately: true,
          func: (sel) => {
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
            const found = queryDeep(document, sel);
            if (!found || !(found instanceof Element)) return false;
            const tg = found.tagName.toLowerCase();
            if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
              return false;
            }
            if (tg === 'input' && String(found.type || '').toLowerCase() === 'hidden') return false;
            const st = window.getComputedStyle(found);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            const rect = found.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          args: [selector]
        });
        if (execRes?.[0]?.result === true) {
          await verifyEntryStillControllable(entry);
          return { tabId: entry.tabId, matched: true, selector };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Timed out waiting for selector: ${selector}`);
    }

    await waitForTabComplete(entry.tabId, timeoutMs);
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitMs) {
      await verifyEntryStillControllable(entry);
      const stepSleep = Math.min(250, waitMs - (Date.now() - waitStart));
      if (stepSleep > 0) await new Promise((r) => setTimeout(r, stepSleep));
    }
    await verifyEntryStillControllable(entry);
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
    if (entry.paused) {
      stopCdpForTab(tabId, entry).catch(() => {});
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN && wsAuthed && params.data) {
      ws.send(
        JSON.stringify({
          type: 'screencast_frame',
          tabId,
          mimeType: 'image/jpeg',
          data: params.data,
          title: redactUrlsInTextLocal(entry.title || ''),
          url: redactAuditUrl(entry.url),
          activity: redactUrlsInTextLocal(entry.activity || '')
        })
      );
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source?.tabId;
  if (tabId && managedTabs.has(tabId)) {
    const entry = managedTabs.get(tabId);
    entry.attachedCdp = false;
    entry.screencastActive = false;
    if (reason === 'canceled_by_user') {
      detachManagedTab(tabId, 'Canceled by user in Chrome banner').catch(() => {});
    }
  }
});

async function handleWebNavGuardrail(details) {
  if (!details || typeof details.tabId !== 'number' || !managedTabs.has(details.tabId)) return;
  if (!details.url || details.url === 'about:blank') return;
  if (details.frameId !== 0 && isPassiveTelemetrySubframeUrl(details.url)) return;
  const safety = checkTabUrlAllowed(details.url);
  if (!safety.allowed) {
    const reason =
      details.frameId === 0
        ? safety.reason
        : `Embedded payment/protected sub-frame: ${safety.reason}`;
    await detachManagedTab(details.tabId, reason, true).catch(() => {});
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'guardrail_trip',
          tabId: details.tabId,
          url: redactAuditUrl(details.url),
          reason
        })
      );
    }
  }
}

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onCommitted.addListener(handleWebNavGuardrail);
}
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(handleWebNavGuardrail);
}
if (chrome.webNavigation?.onReferenceFragmentUpdated) {
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleWebNavGuardrail);
}

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
            url: redactAuditUrl(entry.url),
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

async function autoMergeClosedRelayTab(closedEntry) {
  const restoreUrl = typeof closedEntry?.url === 'string' ? closedEntry.url.trim() : '';
  if (!/^https?:\/\//i.test(restoreUrl)) return;
  const safety = checkTabUrlAllowed(restoreUrl);
  if (!safety.allowed) return;

  const prevOriginWinId = closedEntry.originWindowId;
  const prevOriginIndex = closedEntry.originIndex;
  const prevOriginGroupId = typeof closedEntry.originGroupId === 'number' ? closedEntry.originGroupId : -1;
  const prevRelayWinId = closedEntry.relayPopoutWinId;

  let targetWindowId = null;
  if (typeof prevOriginWinId === 'number') {
    const origExists = await chrome.windows.get(prevOriginWinId).catch(() => null);
    if (origExists && origExists.type === 'normal') {
      targetWindowId = origExists.id;
    }
  }
  if (targetWindowId === null) {
    const allNormal = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    const fallbackWin = allNormal.find((w) => w.id !== prevRelayWinId);
    if (fallbackWin) targetWindowId = fallbackWin.id;
  }
  if (targetWindowId === null) return;

  let targetIndex;
  if (typeof prevOriginIndex === 'number' && prevOriginIndex >= 0) {
    const winTabs = await chrome.tabs.query({ windowId: targetWindowId }).catch(() => []);
    targetIndex = Math.min(prevOriginIndex, winTabs.length);
  }

  const createProps = {
    windowId: targetWindowId,
    url: restoreUrl,
    active: false
  };
  if (typeof targetIndex === 'number') createProps.index = targetIndex;

  const created = await chrome.tabs.create(createProps).catch(() => null);
  if (!created || typeof created.id !== 'number') return;

  const isWorker = closedEntry.substate === 'worker';
  if (isWorker) {
    await placeInBackgroundTabGroup(created.id, targetWindowId, false, 'yellow', tr().groupPaused);
  } else if (prevOriginGroupId >= 0) {
    await chrome.tabs
      .group({ tabIds: [created.id], groupId: prevOriginGroupId })
      .catch(async () => {
        await placeInBackgroundTabGroup(created.id, targetWindowId, false, 'yellow', tr().groupPaused);
      });
  } else {
    await placeInBackgroundTabGroup(created.id, targetWindowId, false, 'yellow', tr().groupPaused);
  }

  // Closing a paused relay window MUST preserve `paused: true` (and capture zero frames) until the user explicitly clicks Resume
  const restoredActivity =
    currentLang === 'zh'
      ? '副屏已关闭 · 已归队（仍暂停，点继续恢复 AI）'
      : 'Relay closed · Merged back (Paused · Click Resume in Chrome)';
  const restoredEntry = {
    tabId: created.id,
    substate: isWorker ? 'worker' : 'shared',
    uiMode: 'paused',
    attachedCdp: false,
    screencastActive: false,
    paused: true,
    title: created.title || closedEntry.title || '',
    url: created.url || restoreUrl,
    activity: restoredActivity,
    idleTimer: null
  };
  managedTabs.set(created.id, restoredEntry);
  notifyPanelAndDaemon();

  await waitForTabComplete(created.id, 12000).catch(() => {});
  const updatedTab = await chrome.tabs.get(created.id).catch(() => null);
  if (!updatedTab || !managedTabs.has(created.id)) return;

  const postSafety = checkTabUrlAllowed(updatedTab.url || '');
  if (!postSafety.allowed) {
    await detachManagedTab(created.id, postSafety.reason, true);
    return;
  }
  const postFrameSafety = await inspectEmbeddedFramesSafety(created.id);
  if (!postFrameSafety.allowed) {
    await detachManagedTab(created.id, postFrameSafety.reason, true);
    return;
  }

  restoredEntry.title = updatedTab.title || restoredEntry.title;
  restoredEntry.url = updatedTab.url || restoredEntry.url;
  await syncHud(created.id, {
    visible: true,
    mode: 'paused',
    activity: restoredEntry.activity
  });
  await syncLiveTabGroups();
  pushLocalAudit('relay_auto_merge', {
    previousTabId: closedEntry.tabId,
    tabId: created.id,
    url: restoredEntry.url,
    paused: true
  });
  notifyPanelAndDaemon();
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (managedTabs.has(tabId)) {
    const entry = managedTabs.get(tabId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const shouldAutoMergeRelay =
      typeof entry.relayPopoutWinId === 'number' &&
      (removeInfo?.isWindowClosing || removeInfo?.windowId === entry.relayPopoutWinId);
    managedTabs.delete(tabId);
    if (shouldAutoMergeRelay) {
      autoMergeClosedRelayTab(entry).catch(() => {
        rememberDetachedTab(tabId, 'Tab closed', false);
        syncLiveTabGroups();
        notifyPanelAndDaemon();
      });
      return;
    }
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
    if (!msg || typeof msg.type !== 'string' || !sender || sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: 'Invalid or unauthorized sender' });
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
          await stopCdpForTab(senderTabId, entry);
          await syncLiveTabGroups();
          notifyPanelAndDaemon();
        } else if (msg.event === 'resume') {
          if (entry.relayPopoutWinId) {
            await mergeRelayTabBack(entry, { resumedByUserInBrowser: true });
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
    // Enforce strict extension-page origin isolation: content scripts (`sender.tab`) MUST NEVER access `panel:*` RPCs or pairing tokens
    if (msg.type.startsWith('panel:')) {
      const expectedPanelPrefix = chrome.runtime.getURL('panel/');
      if (sender.tab || typeof sender.url !== 'string' || !sender.url.startsWith(expectedPanelPrefix)) {
        sendResponse({ ok: false, error: 'Unauthorized sender: extension panel context required' });
        return;
      }
    }
    if (msg.type === 'panel:get_state') {
      let playbook = { enabled: false, siteCount: 0 };
      if (bridgeConfig.token && ws && ws.readyState === WebSocket.OPEN && wsAuthed) {
        try {
          const r = await signedDaemonFetch('/api/health', 'GET');
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
      if (!bridgeConfig.token || !wsAuthed) {
        sendResponse({ ok: false, sites: {} });
        return;
      }
      try {
        const r = await signedDaemonFetch('/api/playbook', 'GET');
        const j = await r.json();
        sendResponse(j);
      } catch {
        sendResponse({ ok: false, sites: {} });
      }
      return;
    }
    if (msg.type === 'panel:playbook_action') {
      if (!bridgeConfig.token || !wsAuthed) {
        sendResponse({ ok: false, error: 'Daemon not verified or not paired' });
        return;
      }
      try {
        const r = await signedDaemonFetch('/api/playbook', 'POST', msg.body || {});
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
      connectWebSocket(true);
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
          await mergeRelayTabBack(entry, { resumedByUserInBrowser: true });
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
        if (entry.paused) {
          await stopCdpForTab(entry.tabId, entry);
        }
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
          activity: entry.activity,
          clearUserPauseLock: !entry.paused
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
      connectWebSocket(true);
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
