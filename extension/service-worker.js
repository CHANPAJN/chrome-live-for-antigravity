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
  'bankcomm.com'
];

const CHECKOUT_SEGMENT_RX =
  /(?:^|\/)(?:checkout|pay|payment|payments|cashier|billing|wallet\/transfer)(?:\/|\?|$|#|;|\.[a-z0-9]{1,8}(?:\/|\?|$|#|;))/i;

const CHECKOUT_SUBDOMAIN_RX = /(?:^|\.)(?:checkout|pay|payment|payments|cashier|billing)\./i;

function isHighEntropyPathSegment(rawSegment, options = {}) {
  if (!rawSegment) return false;
  const splitMatrix = options.splitMatrix !== false;
  let segment = splitMatrix ? String(rawSegment).split(';')[0] : String(rawSegment);
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
  if (/^eyJ[A-Za-z0-9._~+/=;-]{10,}$/.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (segment.length >= 32 && /^[A-Za-z0-9._~+/=;-]+$/.test(segment)) {
    const hasDigit = /\d/.test(segment);
    const hasUpper = /[A-Z]/.test(segment);
    const hasLower = /[a-z]/.test(segment);
    const hasB64Punct = /[+/=;]/.test(segment);
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

function decodeNestedPercentLocal(str) {
  let changed = false;
  const out = str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      const dec = decodeURIComponent(seq);
      if (dec !== seq) changed = true;
      return dec;
    } catch {
      const partial = seq.replace(/%[0-7][0-9A-Fa-f]/g, (asciiHex) => decodeURIComponent(asciiHex));
      if (partial !== seq) changed = true;
      return partial;
    }
  });
  return { out, changed };
}

function canonicalizeRouteForGuardrail(rawSegment, splitRawQuery = false) {
  if (!rawSegment) return { ok: true, rawPath: '/', path: '/' };
  const inputStr = String(rawSegment);
  const rawQIdx = splitRawQuery ? inputStr.indexOf('?') : -1;
  let decoded = rawQIdx === -1 ? inputStr : inputStr.slice(0, rawQIdx);
  const queryPart = rawQIdx === -1 ? '' : inputStr.slice(rawQIdx);
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
      const step = decodeNestedPercentLocal(decoded);
      if (!step.changed) break;
      decoded = step.out;
    }
    if (/%[0-9A-Fa-f]{2}/.test(decoded) && decodeNestedPercentLocal(decoded).changed) {
      return { ok: false, rawPath: '', path: '' };
    }
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^[/]*!+/, '/');
  const rawPieces = [];
  const stack = [];
  for (const seg of normalized.split('/')) {
    const cleanSeg = seg.split(';')[0];
    if (!cleanSeg || cleanSeg === '.') continue;
    if (cleanSeg === '..') {
      rawPieces.push('..');
      stack.pop();
      continue;
    }
    const strippedSeg = cleanSeg.replace(/\.+$/, '');
    if (!strippedSeg) continue;
    rawPieces.push(strippedSeg);
    stack.push(strippedSeg);
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
    try {
      resp.body?.cancel?.().catch(() => {});
    } catch {}
    throw new Error('Unverified local service response signature');
  }
  return resp;
}

// tabId -> { tabId, substate: 'shared'|'worker', uiMode: string, attachedCdp: boolean, screencastActive: boolean, paused: boolean, title: string, url: string, activity: string, idleTimer: any }
const managedTabs = new Map();
const hudSyncLocks = new Map();
const activeExtractTabIds = new Set();
let liveTabGroupId = null;
let extractWindowId = null;
let extractWindowPromise = null;
let groupSerializeChain = Promise.resolve();
let activeExtractJobs = 0;
let swInitPromise = null;

async function ensureSwInitialized() {
  if (swInitPromise) {
    try {
      await swInitPromise;
    } catch {}
  }
}

const LOCAL_AUDIT_SENSITIVE_PARAM_RX =
  /(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))/i;
const LOCAL_HASH_SENSITIVE_PAIR_RX =
  /([#?&])([^=&#]*(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))[^=&#]*)=([^&#]*)/gi;

function scrubLocalMatrixSegment(seg) {
  if (!seg || !seg.includes(';')) return seg;
  const pieces = seg.split(';');
  const head = isHighEntropyPathSegment(pieces[0], { splitMatrix: true }) ? 'REDACTED' : pieces[0];
  let changed = head !== pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    const eqIdx = pieces[i].indexOf('=');
    if (eqIdx === -1) {
      if (isHighEntropyPathSegment(pieces[i], { splitMatrix: false })) {
        pieces[i] = 'REDACTED';
        changed = true;
      }
      continue;
    }
    const mk = pieces[i].slice(0, eqIdx);
    const mv = pieces[i].slice(eqIdx + 1);
    let decMk = mk;
    try {
      decMk = decodeURIComponent(mk.replace(/\+/g, ' '));
    } catch {}
    if (LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(decMk)) {
      pieces[i] = `${mk}=REDACTED`;
      changed = true;
    } else {
      const nestedMv = scrubLocalNestedValue(mv, 0);
      if (nestedMv.changed) {
        pieces[i] = `${mk}=${nestedMv.value}`;
        changed = true;
      }
    }
  }
  pieces[0] = head;
  return changed ? pieces.join(';') : seg;
}

function scrubLocalNestedValue(rawV, depth = 0) {
  if (!rawV || depth > 4) return { value: rawV, changed: false };
  if (isHighEntropyPathSegment(rawV, { splitMatrix: false })) {
    return { value: 'REDACTED', changed: true };
  }
  let decV = rawV;
  let decodeLayers = 0;
  for (let round = 0; round < 4; round++) {
    if (!decV.includes('%')) break;
    try {
      const next = decodeURIComponent(decV);
      if (next === decV) break;
      decV = next;
      decodeLayers++;
    } catch {
      break;
    }
  }
  const reencodeLayers = (str) => {
    let out = str;
    for (let r = 0; r < decodeLayers; r++) {
      out = encodeURIComponent(out);
    }
    return out;
  };
  if (isHighEntropyPathSegment(decV, { splitMatrix: false })) {
    return { value: 'REDACTED', changed: true };
  }
  if (/^https?:\/\//i.test(decV.trim())) {
    const redUrl = redactAuditUrl(decV.trim(), depth + 1);
    if (redUrl !== decV.trim()) {
      return { value: reencodeLayers(redUrl), changed: true };
    }
  } else if (/https?:\/\//i.test(decV)) {
    const redTxt = redactUrlsInTextLocal(decV);
    if (redTxt !== decV) {
      return { value: reencodeLayers(redTxt), changed: true };
    }
  } else if (decV.includes('=') || decV.includes('&') || decV.includes('#')) {
    const subScrub = scrubLocalQueryString(`?${decV}`, depth + 1);
    if (subScrub.changed) {
      const inner = subScrub.text.slice(1);
      return { value: reencodeLayers(inner), changed: true };
    }
  }
  return { value: rawV, changed: false };
}

function scrubLocalQueryString(rawQuery, depth = 0) {
  if (!rawQuery || !rawQuery.startsWith('?') || depth > 3) return { text: rawQuery || '', changed: false };
  const rawBody = rawQuery.slice(1);
  if (!rawBody) return { text: rawQuery, changed: false };
  let changed = false;
  const tokens = rawBody.split(/([&#?])/);
  for (let i = 0; i < tokens.length; i += 2) {
    const pair = tokens[i];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      if (isHighEntropyPathSegment(pair, { splitMatrix: false })) {
        tokens[i] = 'REDACTED';
        changed = true;
      }
      continue;
    }
    const rawK = pair.slice(0, eq);
    const rawV = pair.slice(eq + 1);
    if ((rawV === '' || /^=+$/.test(rawV)) && isHighEntropyPathSegment(rawK, { splitMatrix: false })) {
      tokens[i] = 'REDACTED';
      changed = true;
      continue;
    }
    let decK = rawK;
    try {
      decK = decodeURIComponent(rawK.replace(/\+/g, ' '));
    } catch {}
    if (LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(decK)) {
      tokens[i] = `${rawK}=REDACTED`;
      changed = true;
      continue;
    }
    const nested = scrubLocalNestedValue(rawV, depth);
    if (nested.changed) {
      tokens[i] = `${rawK}=${nested.value}`;
      changed = true;
    }
  }
  return { text: changed ? `?${tokens.join('')}` : rawQuery, changed };
}

function redactAuditUrl(rawUrl, depth = 0) {
  if (!rawUrl || typeof rawUrl !== 'string' || depth > 3) return rawUrl;
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
        } else if (isHighEntropyPathSegment(parts[i], { splitMatrix: true })) {
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
      const scrubbedSearch = scrubLocalQueryString(parsed.search, depth);
      if (scrubbedSearch.changed) {
        parsed.search = scrubbedSearch.text;
        changed = true;
      }
    }
    if (parsed.hash) {
      const prefixMatch = parsed.hash.match(/^(#!?)/);
      const hashPrefix = prefixMatch ? prefixMatch[1] : '#';
      const rawHashBody = parsed.hash.slice(hashPrefix.length);
      let cleanedHash = parsed.hash;

      const hashNoPad = rawHashBody.replace(/=+$/, '');
      const isBareSingleToken =
        Boolean(rawHashBody) &&
        !rawHashBody.includes('/') &&
        !rawHashBody.includes('?') &&
        !rawHashBody.includes('&') &&
        !rawHashBody.includes('#') &&
        !hashNoPad.includes('=') &&
        (isHighEntropyPathSegment(hashNoPad, { splitMatrix: false }) ||
          /^(?:eyJ[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{32,})$/.test(rawHashBody));
      const isBareSlashBase64Token =
        Boolean(rawHashBody) &&
        !rawHashBody.startsWith('/') &&
        rawHashBody.includes('/') &&
        !rawHashBody.includes('?') &&
        !rawHashBody.includes('&') &&
        !rawHashBody.includes('#') &&
        !hashNoPad.includes('=') &&
        rawHashBody.length >= 32 &&
        /^[A-Za-z0-9+/]+=*$/.test(rawHashBody) &&
        (/[+=]/.test(rawHashBody) || (/\d/.test(rawHashBody) && /[A-Z]/.test(rawHashBody) && /[a-z]/.test(rawHashBody)));

      if (isBareSingleToken || isBareSlashBase64Token) {
        cleanedHash = `${hashPrefix}REDACTED`;
      } else if (
        !rawHashBody.startsWith('/') &&
        !rawHashBody.includes('?') &&
        (rawHashBody.includes('=') || rawHashBody.includes('&') || rawHashBody.includes('#'))
      ) {
        const scrubbedFragPairs = scrubLocalQueryString(`?${rawHashBody}`, depth);
        if (scrubbedFragPairs.changed) {
          cleanedHash = `${hashPrefix}${scrubbedFragPairs.text.slice(1)}`;
        }
      } else {
        const qPos = rawHashBody.indexOf('?');
        const hPath = qPos === -1 ? rawHashBody : rawHashBody.slice(0, qPos);
        const hQuery = qPos === -1 ? '' : rawHashBody.slice(qPos);
        const hParts = hPath.split('/');
        let hChanged = false;
        for (let i = 0; i < hParts.length; i++) {
          const seg = hParts[i];
          if (!seg) continue;
          if (seg.includes('=') || seg.includes('&') || seg.includes('#')) {
            const scrubbedSegPairs = scrubLocalQueryString(`?${seg}`, depth);
            if (scrubbedSegPairs.changed) {
              hParts[i] = scrubbedSegPairs.text.slice(1);
              hChanged = true;
              continue;
            }
          }
          if (seg.includes(';')) {
            const nextSeg = scrubLocalMatrixSegment(seg);
            if (nextSeg !== seg) {
              hParts[i] = nextSeg;
              hChanged = true;
            }
          } else if (isHighEntropyPathSegment(seg, { splitMatrix: true })) {
            hParts[i] = 'REDACTED';
            hChanged = true;
          }
        }
        const scrubbedHQuery = scrubLocalQueryString(hQuery, depth);
        if (hChanged || scrubbedHQuery.changed) {
          cleanedHash = `${hashPrefix}${hParts.join('/')}${scrubbedHQuery.text}`;
        }
      }

      cleanedHash = cleanedHash.replace(/([#?&])([^=&#]+)=([^&#]*)/g, (full, sep, rawKey) => {
        let decKey = rawKey;
        if (rawKey.includes('%')) {
          try {
            decKey = decodeURIComponent(rawKey);
          } catch {}
        }
        return LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(rawKey) || LOCAL_AUDIT_SENSITIVE_PARAM_RX.test(decKey)
          ? `${sep}${rawKey}=REDACTED`
          : full;
      });
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

function splitLocalBalancedUrlSuffix(rawMatch) {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openBrace = 0;
  let closeBrace = 0;
  for (let i = 0; i < rawMatch.length; i++) {
    const c = rawMatch[i];
    if (c === '(') openParen++;
    else if (c === ')') closeParen++;
    else if (c === '[') openBracket++;
    else if (c === ']') closeBracket++;
    else if (c === '{') openBrace++;
    else if (c === '}') closeBrace++;
  }
  let end = rawMatch.length;
  while (end > 0) {
    const ch = rawMatch[end - 1];
    if (/[.,;:!?]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ')' && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (ch === ']' && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (ch === '}' && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return { coreUrl: rawMatch.slice(0, end), suffix: rawMatch.slice(end) };
}

function redactUrlsInTextLocal(rawText) {
  if (typeof rawText !== 'string' || !/https?:\/\//i.test(rawText)) return rawText;
  return rawText.replace(/https?:\/\/[^\s"'<>`\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/gi, (match) => {
    const { coreUrl, suffix } = splitLocalBalancedUrlSuffix(match);
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
  const canonPath = canonicalizeRouteForGuardrail(parsed.pathname, false);
  if (!canonPath.ok) {
    return { allowed: false, reason: 'Malformed percent-encoding in URL pathname' };
  }
  let hashMatchedCheckout = false;
  if (parsed.hash && parsed.hash.length > 1) {
    const subChunks = parsed.hash.slice(1).split('#');
    for (const chunk of subChunks) {
      const cleanChunk = chunk.replace(/^!+/, '');
      if (!cleanChunk) continue;
      const canonChunk = canonicalizeRouteForGuardrail(cleanChunk, true);
      if (!canonChunk.ok) {
        return { allowed: false, reason: 'Malformed percent-encoding in URL fragment' };
      }
      if (
        (canonChunk.rawPath && CHECKOUT_SEGMENT_RX.test(canonChunk.rawPath)) ||
        (canonChunk.path && CHECKOUT_SEGMENT_RX.test(canonChunk.path))
      ) {
        hashMatchedCheckout = true;
      }
    }
  }
  if (
    CHECKOUT_SEGMENT_RX.test(canonPath.rawPath) ||
    CHECKOUT_SEGMENT_RX.test(canonPath.path) ||
    hashMatchedCheckout
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
          replacedTabId: typeof item.replacedTabId === 'number' ? item.replacedTabId : null,
          substate: item.substate === 'shared' ? 'shared' : 'worker',
          uiMode: item.uiMode || 'working',
          attachedCdp: false,
          screencastActive: false,
          paused: Boolean(item.paused),
          originWindowId: typeof item.originWindowId === 'number' ? item.originWindowId : null,
          originIndex: typeof item.originIndex === 'number' ? item.originIndex : null,
          originGroupId: typeof item.originGroupId === 'number' ? item.originGroupId : -1,
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

  // Restore session tabs AFTER customBlockedDomains and bridgeConfig.port are loaded!
  await restoreSessionState();
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
      originGroupId: typeof entry.originGroupId === 'number' ? entry.originGroupId : -1,
      relayPopoutWinId: entry.relayPopoutWinId ?? null,
      replacedTabId: typeof entry.replacedTabId === 'number' ? entry.replacedTabId : null,
      attachedCdp: entry.attachedCdp,
      title: redactUrlsInTextLocal(entry.title || ''),
      url: redactAuditUrl(entry.url),
      activity: redactUrlsInTextLocal(entry.activity || '')
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
  const { allFrames, ...restOpts } = opts || {};
  const targetSpec = allFrames ? { tabId, allFrames: true } : { tabId };
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: targetSpec, ...restOpts }),
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
              Element.prototype.hasAttribute.call(el, 'data-chrome-live-hud') ||
              (el.tagName === 'DIV' &&
                el.id === '' &&
                el.className === '' &&
                el.childElementCount === 0 &&
                (el.getAttribute('style') || '').match(/214748364[67]/))
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
      if (!tab || typeof tab.id !== 'number') continue;
      const urlCheck = checkTabUrlAllowed(tab.url || '');
      if (!urlCheck.allowed) {
        if (managedTabs.has(tab.id)) {
          if (typeof detachManagedTab === 'function') {
            await detachManagedTab(tab.id, urlCheck.reason || 'Protected URL', true);
          } else {
            managedTabs.delete(tab.id);
          }
        }
        continue;
      }
      if (tab.discarded || !/^https?:/i.test(tab.url || '')) continue;
      const entry = managedTabs.get(tab.id);
      if (entry) {
        await pollHudUserEvents(tab.id, entry);
        if (!managedTabs.has(tab.id)) continue;
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
                Element.prototype.hasAttribute.call(el, 'data-chrome-live-hud') ||
                (el.tagName === 'DIV' &&
                  el.id === '' &&
                  el.className === '' &&
                  el.childElementCount === 0 &&
                  (el.getAttribute('style') || '').match(/214748364[67]/))
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
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.events)) {
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
          return;
        }
      }
    }
    // Fail-safe live HUD state reconciliation (defeats MV3 Service Worker dormancy/wakeup races!)
    if (managedTabs.has(tabId)) {
      if (state.visible === false) {
        await detachManagedTab(tabId, tr().released);
        return;
      }
      if (state.mode === 'paused' && !entry.paused) {
        entry.paused = true;
        entry.uiMode = 'paused';
        await stopCdpForTab(tabId, entry);
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
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
    const pendingSafety = liveTab.pendingUrl ? checkTabUrlAllowed(liveTab.pendingUrl) : { allowed: true, reason: '' };
    if (!urlSafety.allowed || !pendingSafety.allowed) {
      const tripUrl = !urlSafety.allowed ? entry.url : liveTab.pendingUrl;
      const tripReason = !urlSafety.allowed ? urlSafety.reason : pendingSafety.reason;
      await detachManagedTab(tabId, tripReason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId,
            url: redactAuditUrl(tripUrl),
            reason: tripReason
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
    // Re-verify liveTab.url AND pendingUrl AFTER captureScreenshot completes to defeat mid-navigation checkout race!
    const postShotTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!postShotTab) return null;
    const postUrlCheck = checkTabUrlAllowed(postShotTab.url || '');
    const postPendingCheck = postShotTab.pendingUrl ? checkTabUrlAllowed(postShotTab.pendingUrl) : { allowed: true, reason: '' };
    if (!postUrlCheck.allowed || !postPendingCheck.allowed) {
      const pReason = !postUrlCheck.allowed ? postUrlCheck.reason : postPendingCheck.reason;
      const pUrl = !postUrlCheck.allowed ? postShotTab.url : postShotTab.pendingUrl;
      await detachManagedTab(tabId, pReason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'guardrail_trip', tabId, url: redactAuditUrl(pUrl || ''), reason: pReason }));
      }
      return null;
    }
    entry.title = postShotTab.title || entry.title;
    entry.url = postShotTab.url || entry.url;
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
        if (activeExtractTabIds.has(t.id)) {
          activeManagedInGroup.push({ tabId: t.id, paused: false, uiMode: 'working' });
          continue;
        }
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

  let safety = checkTabUrlAllowed(tab.url || '');
  if (!safety.allowed) {
    pushLocalAudit('share_tab', { tabId: tab.id, url: tab.url, reason: safety.reason }, 'blocked');
    notifyPanelAndDaemon();
    return;
  }

  // Wake discarded background tabs before inspecting embedded sub-frames so Alt+Shift+L sharing succeeds cleanly
  if (tab.discarded) {
    await chrome.tabs.reload(tab.id).catch(() => {});
    await waitForTabComplete(tab.id, 9000);
    const reloaded = await chrome.tabs.get(tab.id).catch(() => null);
    if (!reloaded) return;
    tab = reloaded;
    safety = checkTabUrlAllowed(tab.url || '');
    if (!safety.allowed) {
      pushLocalAudit('share_tab', { tabId: tab.id, url: tab.url, reason: safety.reason }, 'blocked');
      notifyPanelAndDaemon();
      return;
    }
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
  pushLocalAudit('share_tab', { tabId: tab.id, url: tab.url });
  notifyPanelAndDaemon();
  await captureQuickFrame(tab.id, entry);
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

  let targetWindowId = null;
  let placeholderBlankTabId = null;
  if (typeof prevOriginWinId === 'number') {
    const origExists = await chrome.windows.get(prevOriginWinId).catch(() => null);
    if (origExists && origExists.type === 'normal') {
      targetWindowId = origExists.id;
    }
  }
  if (targetWindowId === null) {
    const curTab = await chrome.tabs.get(entry.tabId).catch(() => null);
    const allNormal = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    const otherWin = allNormal.find((w) => w.id !== curTab?.windowId && w.id !== entry.relayPopoutWinId);
    if (otherWin) targetWindowId = otherWin.id;
  }
  if (targetWindowId === null) {
    const createdWin = await chrome.windows.create({
      type: 'normal',
      focused: Boolean(resumedByUserInBrowser)
    });
    if (!createdWin || typeof createdWin.id !== 'number') {
      throw new Error('Unable to locate or create a main Chrome window to merge the relay tab');
    }
    targetWindowId = createdWin.id;
    const initTab = Array.isArray(createdWin.tabs) ? createdWin.tabs[0] : null;
    if (initTab && typeof initTab.id === 'number' && initTab.id !== entry.tabId) {
      placeholderBlankTabId = initTab.id;
    }
  }

  const groupColor = resumedByUserInBrowser ? 'cyan' : 'yellow';
  const groupLabel = resumedByUserInBrowser ? tr().groupTitle : tr().groupPaused;

  const movedTab = await chrome.tabs.move(entry.tabId, {
    windowId: targetWindowId,
    index: typeof prevOriginIndex === 'number' ? prevOriginIndex : -1
  });
  const actualMoved = Array.isArray(movedTab) ? movedTab[0] : movedTab;
  if (actualMoved && typeof actualMoved.windowId === 'number' && actualMoved.windowId !== targetWindowId) {
    throw new Error('Failed to move relay popout tab back into main window');
  }
  if (placeholderBlankTabId !== null) {
    await chrome.tabs.remove(placeholderBlankTabId).catch(() => {});
  }

  // Only clear popout tracking AFTER chrome.tabs.move is confirmed to have succeeded!
  entry.relayPopoutWinId = null;
  entry.originWindowId = null;
  entry.originIndex = null;
  entry.originGroupId = -1;

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
  pushLocalAudit('relay_merge', {
    tabId: entry.tabId,
    url: entry.url,
    resumed: resumedByUserInBrowser
  });
  notifyPanelAndDaemon();
  if (resumedByUserInBrowser) {
    await captureQuickFrame(entry.tabId, entry);
  }
  return {
    tabId: entry.tabId,
    inRelayPopout: false,
    paused: entry.paused,
    mergedToWindowId: targetWindowId
  };
}

function resolveTargetEntry(requestedTabId) {
  if (requestedTabId !== undefined && requestedTabId !== null && requestedTabId !== '') {
    const numId = typeof requestedTabId === 'number' ? requestedTabId : Number(requestedTabId);
    if (!Number.isSafeInteger(numId) || numId <= 0) {
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

// Passive 0x0 SDK anti-fraud/telemetry beacons and standard HTML5 `about:srcdoc` / `about:blank` sub-frames
// loaded on community sites (e.g. Discourse / linux.do). Only applied to non-top-level sub-frames (frameId !== 0);
// interactive payment inputs (elements-inner-*, checkout.*, hooks.*) and `javascript:`/`data:`/`chrome:` frames remain blocked.
function isPassiveTelemetrySubframeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (/^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(trimmed)) {
    return true;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
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
    /^\/v[23]\/(?:fingerprinted\/)?(?:m-outer|controller|hcaptcha-invisible)-[A-Za-z0-9._-]+\.html$/i.test(
      p
    )
  ) {
    return true;
  }
  return false;
}

async function inspectEmbeddedFramesSafety(tabId) {
  const curTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!curTab) {
    return { allowed: false, frameUrl: '', reason: 'Target tab closed during frame safety check' };
  }
  if (!curTab.url || curTab.url === 'about:blank') {
    return { allowed: true, frameUrl: '', reason: '' };
  }

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

  const iframeRes = await runHudScriptSafe(
    tabId,
    {
      allFrames: true,
      func: () => {
        const rawGetAttr = Element.prototype.getAttribute;
        const rawHasAttr = Element.prototype.hasAttribute;
        const safeAttr = (el, attrName) => {
          try {
            const v = rawGetAttr.call(el, attrName);
            return typeof v === 'string' ? v.trim() : '';
          } catch {
            return '';
          }
        };
        const safeHasAttr = (el, attrName) => {
          try {
            return Boolean(rawHasAttr.call(el, attrName));
          } catch {
            return false;
          }
        };
        const _baseUriGet =
          typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI')?.get : null;
        const resolveAbsHttpUrl = (rawVal, ownerDoc) => {
          if (!rawVal) return '';
          try {
            const docRef = ownerDoc || document;
            const rawBase =
              _baseUriGet && typeof Node !== 'undefined' && docRef instanceof Node
                ? _baseUriGet.call(docRef)
                : typeof docRef?.baseURI === 'string'
                  ? docRef.baseURI
                  : typeof document?.baseURI === 'string'
                    ? document.baseURI
                    : '';
            const base = typeof rawBase === 'string' && rawBase ? rawBase : location.href;
            const resolved = new URL(rawVal, base).href;
            return /^https?:/i.test(resolved) ? resolved : '';
          } catch {
            return '';
          }
        };
        const urls = [];
        const namedFrames = new Set();
        const seenDocs = new Set();
        const collectFrames = (root, depth = 0) => {
          if (!root || depth > 6) return;
          if (root.nodeType === 9) {
            if (seenDocs.has(root)) return;
            seenDocs.add(root);
          }
          const winObj = root.defaultView || root.ownerDocument?.defaultView || window;
          for (const frame of root.querySelectorAll('iframe, frame')) {
            const fName = safeAttr(frame, 'name');
            if (fName) namedFrames.add(fName);
            const st = winObj.getComputedStyle(frame);
            const rc = frame.getBoundingClientRect();
            const isVisible =
              st.display !== 'none' &&
              st.visibility !== 'hidden' &&
              st.opacity !== '0' &&
              rc.width >= 24 &&
              rc.height >= 24;
            if (isVisible) {
              const absSrc = resolveAbsHttpUrl(safeAttr(frame, 'src'), frame.ownerDocument);
              if (absSrc) urls.push(absSrc);
            }
            try {
              if (frame.contentDocument) collectFrames(frame.contentDocument, depth + 1);
            } catch {}
          }
          for (const plug of root.querySelectorAll('object, embed')) {
            const st = winObj.getComputedStyle(plug);
            const rc = plug.getBoundingClientRect();
            const isVis =
              st.display !== 'none' &&
              st.visibility !== 'hidden' &&
              st.opacity !== '0' &&
              rc.width >= 24 &&
              rc.height >= 24;
            if (isVis) {
              const rawPlugUrl = safeAttr(plug, 'data') || safeAttr(plug, 'src');
              const absPlug = resolveAbsHttpUrl(rawPlugUrl, plug.ownerDocument);
              if (absPlug) urls.push(absPlug);
            }
          }
          for (const el of root.querySelectorAll('*')) {
            const sr =
              (typeof Element !== 'undefined' && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(el)) ||
              (el.shadowRoot && typeof el.shadowRoot.querySelectorAll === 'function' ? el.shadowRoot : null);
            if (sr) collectFrames(sr, depth + 1);
          }
        };
        const seenNavDocs = new Set();
        const collectTargetedNavigations = (root, depth = 0) => {
          if (!root || depth > 6) return;
          if (root.nodeType === 9) {
            if (seenNavDocs.has(root)) return;
            seenNavDocs.add(root);
          }
          if (namedFrames.size > 0) {
            for (const form of root.querySelectorAll('form')) {
              const tgt = safeAttr(form, 'target');
              if (tgt && namedFrames.has(tgt) && safeHasAttr(form, 'action')) {
                const absAct = resolveAbsHttpUrl(safeAttr(form, 'action'), form.ownerDocument);
                if (absAct) urls.push(absAct);
              }
            }
            for (const btn of root.querySelectorAll('button, input')) {
              if (!safeHasAttr(btn, 'formtarget') && !safeHasAttr(btn, 'formaction')) continue;
              const ownerForm =
                btn.form instanceof HTMLFormElement
                  ? btn.form
                  : Element.prototype.closest?.call(btn, 'form') || null;
              const effTarget = safeHasAttr(btn, 'formtarget')
                ? safeAttr(btn, 'formtarget')
                : ownerForm
                  ? safeAttr(ownerForm, 'target')
                  : '';
              if (!effTarget || !namedFrames.has(effTarget)) continue;
              const rawAct = safeHasAttr(btn, 'formaction')
                ? safeAttr(btn, 'formaction')
                : ownerForm && safeHasAttr(ownerForm, 'action')
                  ? safeAttr(ownerForm, 'action')
                  : '';
              const absAct = resolveAbsHttpUrl(rawAct, btn.ownerDocument);
              if (absAct) urls.push(absAct);
            }
            for (const link of root.querySelectorAll('a[target][href], area[target][href]')) {
              const lTarget = safeAttr(link, 'target');
              if (lTarget && namedFrames.has(lTarget)) {
                const absHref = resolveAbsHttpUrl(safeAttr(link, 'href'), link.ownerDocument);
                if (absHref) urls.push(absHref);
              }
            }
          }
          for (const frame of root.querySelectorAll('iframe, frame')) {
            try {
              if (frame.contentDocument) collectTargetedNavigations(frame.contentDocument, depth + 1);
            } catch {}
          }
          for (const el of root.querySelectorAll('*')) {
            const sr =
              (typeof Element !== 'undefined' && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(el)) ||
              (el.shadowRoot && typeof el.shadowRoot.querySelectorAll === 'function' ? el.shadowRoot : null);
            if (sr) collectTargetedNavigations(sr, depth + 1);
          }
        };
        try {
          if (typeof window.top !== 'undefined' && window.top && window.top !== window && window.top.document) {
            collectFrames(window.top.document);
          }
        } catch {}
        collectFrames(document);
        collectTargetedNavigations(document);
        return urls;
      }
    },
    2500
  );

  // Fail-Closed if DOM frame inspection timed out or could not execute on a live HTTP(S) page
  if (!Array.isArray(iframeRes) || iframeRes.length === 0) {
    return {
      allowed: false,
      frameUrl: curTab.url,
      reason: 'Embedded frame safety inspection timed out or failed'
    };
  }

  for (const frameEntry of iframeRes) {
    const embeddedUrls = frameEntry?.result;
    if (!Array.isArray(embeddedUrls)) continue;
    for (const fUrl of embeddedUrls) {
      if (isPassiveTelemetrySubframeUrl(fUrl)) continue;
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
  const pendingSafety = liveTab.pendingUrl ? checkTabUrlAllowed(liveTab.pendingUrl) : { allowed: true, reason: '' };
  if (!safety.allowed || !pendingSafety.allowed) {
    const failReason = !safety.allowed ? safety.reason : pendingSafety.reason;
    const failUrl = !safety.allowed ? entry.url : liveTab.pendingUrl;
    await detachManagedTab(entry.tabId, failReason, true);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'guardrail_trip',
          tabId: entry.tabId,
          url: redactAuditUrl(failUrl || ''),
          reason: failReason
        })
      );
    }
    throw new Error(`[GUARDRAIL] Detached tab because it navigated to ${failReason}`);
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
          const getOpenShadow = (n) => {
            if (!n) return null;
            try {
              if (typeof Element !== 'undefined') {
                const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
                if (sr) return sr;
              }
            } catch {}
            return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
          };
          while (el && getOpenShadow(el) && getOpenShadow(el).activeElement) {
            el = getOpenShadow(el).activeElement;
          }
          const _tagGet = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
          const _ceGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get;
          const getTag = (n) => String((n instanceof Element && _tagGet ? _tagGet.call(n) : n?.tagName) || '').toLowerCase();
          const isCE = (n) => Boolean(n instanceof HTMLElement && _ceGet ? _ceGet.call(n) : false);
          if (
            !el ||
            el === activeDoc.body ||
            (getTag(el) !== 'input' && getTag(el) !== 'textarea' && !isCE(el))
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
          el.focus?.();
          if (isCE(el)) {
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
            if (el.form && el.form instanceof ownerWin.HTMLFormElement) {
              if (typeof ownerWin.HTMLFormElement.prototype.requestSubmit === 'function') {
                ownerWin.HTMLFormElement.prototype.requestSubmit.call(el.form);
              } else {
                ownerWin.HTMLFormElement.prototype.submit.call(el.form);
              }
            }
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

        function getOpenShadow(n) {
          if (!n) return null;
          try {
            if (typeof Element !== 'undefined') {
              const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
              if (sr) return sr;
            }
          } catch {}
          return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
        }

        function collectDeep(root, sel, depth = 0, acc = []) {
          if (!root || depth > 6) return acc;
          try {
            for (const n of root.querySelectorAll(sel)) acc.push(n);
          } catch {}
          for (const h of root.querySelectorAll('*')) {
            if (h === window.__chromeLiveHudController__?.hostEl) continue;
            const sr = getOpenShadow(h);
            if (sr) collectDeep(sr, sel, depth + 1, acc);
          }
          return acc;
        }

        const _pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
        const _sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
        const _tsGet = typeof Text !== 'undefined' ? Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get : null;
        const _tagGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get : null;
        const _idGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'id')?.get : null;
        const _ceGet =
          typeof HTMLElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get
            : null;
        const _rootFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
        const _matchFn = typeof Element !== 'undefined' ? Element.prototype.matches : null;
        const _closeFn = typeof Element !== 'undefined' ? Element.prototype.closest : null;
        const _visFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
        const _attrFn = typeof Element !== 'undefined' ? Element.prototype.getAttribute : null;

        const safeTagLower = (n) => {
          if (!n) return '';
          const raw =
            _tagGet && typeof Element !== 'undefined' && n instanceof Element
              ? _tagGet.call(n)
              : typeof n.tagName === 'string'
                ? n.tagName
                : '';
          return String(raw).toLowerCase();
        };
        const safeId = (n) => {
          if (!n) return '';
          if (_idGet && typeof Element !== 'undefined' && n instanceof Element) return String(_idGet.call(n) || '');
          return typeof n.id === 'string' ? n.id : '';
        };
        const safeIsCE = (n) => {
          if (!n) return false;
          if (_ceGet && typeof HTMLElement !== 'undefined' && n instanceof HTMLElement) return Boolean(_ceGet.call(n));
          return n.isContentEditable === true;
        };
        const safeParent = (n) => {
          if (!n) return null;
          if (_pGet && typeof Node !== 'undefined' && n instanceof Node) return _pGet.call(n);
          return n.parentElement && !(safeTagLower(n) === 'form' && 'form' in n.parentElement) ? n.parentElement : null;
        };
        const safeSlot = (n) => {
          if (!n) return null;
          if (_sGet && typeof Element !== 'undefined' && n instanceof Element) return _sGet.call(n);
          if (_tsGet && typeof Text !== 'undefined' && n instanceof Text) return _tsGet.call(n);
          return n.assignedSlot && !(safeTagLower(n) === 'form' && 'form' in n.assignedSlot) ? n.assignedSlot : null;
        };
        const safeRoot = (n) => {
          if (!n) return null;
          if (_rootFn && typeof Node !== 'undefined' && n instanceof Node) return _rootFn.call(n);
          return typeof n.getRootNode === 'function' ? n.getRootNode() : null;
        };
        const safeMatches = (n, sel) => {
          if (!n) return false;
          if (_matchFn && typeof Element !== 'undefined' && n instanceof Element) return _matchFn.call(n, sel);
          return typeof n.matches === 'function' ? n.matches(sel) : false;
        };
        const safeClosest = (n, sel) => {
          if (!n) return null;
          if (_closeFn && typeof Element !== 'undefined' && n instanceof Element) return _closeFn.call(n, sel);
          return typeof n.closest === 'function' ? n.closest(sel) : null;
        };
        const safeCheckVis = (n) => {
          if (!n) return false;
          if (_visFn && typeof Element !== 'undefined' && n instanceof Element) {
            return _visFn.call(n, { checkVisibilityCSS: true, checkOpacity: true });
          }
          return typeof n.checkVisibility === 'function'
            ? n.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            : true;
        };
        const safeGetAttr = (n, k) => {
          if (!n) return null;
          if (_attrFn && typeof Element !== 'undefined' && n instanceof Element) return _attrFn.call(n, k);
          return typeof n.getAttribute === 'function' ? n.getAttribute(k) : null;
        };
        const isElementFlatVisible = (node) => {
          if (!node || !safeCheckVis(node)) return false;
          const seen = new Set();
          let cur = node;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) {
              return false;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return true;
        };
        const NESTED_EDITOR_OR_HIDDEN_SEL =
          '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
        const isNestedInsideEditorOrHidden = (elNode) => {
          const seen = new Set();
          const startRn = safeRoot(elNode);
          let cur = safeSlot(elNode) || safeParent(elNode) || (startRn && startRn.host ? startRn.host : null);
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (safeIsCE(cur) || safeMatches(cur, NESTED_EDITOR_OR_HIDDEN_SEL) || safeClosest(cur, NESTED_EDITOR_OR_HIDDEN_SEL)) {
              return true;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };

        const cands = collectDeep(
          document,
          'a[href], button, input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="searchbox"], [role="combobox"], h1, h2, h3, td, li'
        );
        const scored = [];
        for (const el of cands) {
          if (safeClosest(el, '[data-chrome-live-hud]') || isNestedInsideEditorOrHidden(el)) continue;
          if (!isElementFlatVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const overlapW = Math.min(r.right, xMax) - Math.max(r.left, xMin);
          const overlapH = Math.min(r.bottom, yMax) - Math.max(r.top, yMin);
          if (overlapW < 3 || overlapH < 3) continue;
          const tagLower = safeTagLower(el);
          const inputType = tagLower === 'input' ? String(el.type || 'text').toLowerCase() : '';
          const autoAttr = String(safeGetAttr(el, 'autocomplete') || '').toLowerCase();
          const roleLower = String(safeGetAttr(el, 'role') || '').trim().toLowerCase();
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
            safeIsCE(el) ||
            /^(?:textbox|searchbox|combobox|spinbutton)$/.test(roleLower);
          // Never read user-typed .value, nested <textarea>/contenteditable/editor drafts, or hidden text across Shadow DOM
          const REGION_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const REGION_ANCESTOR_SKIP_SEL =
            '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isInsideSkipped = (node, stopRoot) => {
            const seen = new Set();
            let cur = node instanceof Element ? node : safeSlot(node) || safeParent(node);
            let passedStop = false;
            while (cur && !seen.has(cur)) {
              seen.add(cur);
              if (!passedStop && (safeIsCE(cur) || safeMatches(cur, REGION_SKIP_SEL) || safeClosest(cur, REGION_SKIP_SEL))) {
                return true;
              }
              if (safeIsCE(cur) || safeMatches(cur, REGION_ANCESTOR_SKIP_SEL) || safeClosest(cur, REGION_ANCESTOR_SKIP_SEL)) {
                return true;
              }
              if (!safeCheckVis(cur)) return true;
              const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
              const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
              if (
                cs.display === 'none' ||
                cs.visibility === 'hidden' ||
                cs.visibility === 'collapse' ||
                cs.opacity === '0' ||
                (tSec && tSec !== 'none')
              ) {
                return true;
              }
              const sl = safeSlot(cur);
              if (sl) {
                cur = sl;
                continue;
              }
              if (cur === stopRoot) {
                passedStop = true;
              }
              const rn = safeRoot(cur);
              cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
            }
            return false;
          };
          const extractCleanText = (rootNode) => {
            if (!rootNode) return '';
            const outParts = [];
            const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(rootNode, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = tw.nextNode())) {
              const _tnSl = safeSlot(tn); const _tnPar = safeParent(tn); if (!_tnSl && _tnPar && (typeof getOpenShadow === 'function' ? getOpenShadow(_tnPar) : Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(_tnPar))) continue; const startEl = _tnSl || _tnPar;
              if (startEl && !isInsideSkipped(startEl, rootNode)) {
                outParts.push(tn.nodeValue || '');
              }
            }
            return outParts.join(' ');
          };
          const safeValueLabel = isButtonInput ? el.value || '' : '';
          const safeTextLabel = isUserValueField || isSensitiveInput ? '' : extractCleanText(el);
          const elIdStr = safeId(el);
          const rawLabel = (
            safeGetAttr(el, 'aria-label') ||
            safeGetAttr(el, 'placeholder') ||
            safeTextLabel ||
            safeValueLabel ||
            safeGetAttr(el, 'title') ||
            safeGetAttr(el, 'name') ||
            elIdStr ||
            (isSensitiveInput ? '(password)' : '')
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 72);
          const isFormField =
            tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select' || safeIsCE(el);
          const label =
            rawLabel || (isFormField ? `<${tagLower}${el.type ? `[type=${el.type}]` : ''}>` : '');
          if (!label) continue;
          const tid = safeGetAttr(el, 'data-testid');
          const elNameStr = safeGetAttr(el, 'name') || '';
          const selector =
            tid && /^[\w.:-]{1,64}$/.test(tid)
              ? `[data-testid="${tid}"]`
              : elIdStr && /^[a-zA-Z][\w-]{1,48}$/.test(elIdStr)
                ? `#${elIdStr}`
                : elIdStr && /^[\w.:-]{1,64}$/.test(elIdStr)
                  ? `[id="${elIdStr}"]`
                  : elNameStr && /^[\w.:-]{1,64}$/.test(elNameStr)
                    ? `${tagLower}[name="${elNameStr}"]`
                    : tagLower;
          const area = Math.max(16, r.width * r.height);
          scored.push({
            area,
            item: {
              tag: tagLower,
              label,
              selector,
              href: tagLower === 'a' ? el.href : undefined
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

    let currentTabId = undefined;
    if (params.tabId !== undefined && params.tabId !== null && params.tabId !== '') {
      if (typeof params.tabId !== 'number' || !Number.isSafeInteger(params.tabId) || params.tabId <= 0) {
        throw new Error(`Invalid tabId parameter: ${params.tabId}`);
      }
      currentTabId = params.tabId;
    }
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
      'done'
    ]);
    for (let i = 0; i < steps.length; i++) {
      const rawStep = steps[i];
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
        throw new Error(`Batch step ${i} must be an object`);
      }
      const action = String(rawStep.action || rawStep.method || rawStep.cmd || '').trim();
      if (!ALLOWED_BATCH_ACTIONS.has(action)) {
        throw new Error(`[GUARDRAIL] Action "${action}" at batch step ${i} is not permitted inside batch pipelines`);
      }

      const stepParams = { ...rawStep };
      delete stepParams.action;
      delete stepParams.method;
      delete stepParams.cmd;
      if (stepParams.tabId === undefined || stepParams.tabId === null || stepParams.tabId === '') {
        if (currentTabId !== undefined) {
          stepParams.tabId = currentTabId;
        } else {
          delete stepParams.tabId;
        }
      } else if (typeof stepParams.tabId !== 'number' || !Number.isSafeInteger(stepParams.tabId) || stepParams.tabId <= 0) {
        throw new Error(`Invalid tabId parameter at batch step ${i}: ${stepParams.tabId}`);
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
    if (typeof params.url !== 'string' || !params.url.trim()) {
      throw new Error('[GUARDRAIL] URL parameter must be a non-empty string');
    }
    const url = params.url.trim();
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
    notifyPanelAndDaemon();
    await captureQuickFrame(created.id, entry);
    return { tabId: created.id, title: entry.title, url: entry.url };
  }

  if (method === 'extract') {
    const urls = Array.isArray(params.urls) ? params.urls.slice(0, 8) : [];
    const scrollSteps = Math.min(5, Math.max(0, Number(params.scrollSteps ?? 1)));
    if (urls.length === 0) throw new Error('extract requires at least one URL');
    for (const u of urls) {
      if (typeof u !== 'string' || !u.trim()) {
        throw new Error('[GUARDRAIL] Every extract URL must be a non-empty string');
      }
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
            if (typeof workerTab.id === 'number') {
              activeExtractTabIds.add(workerTab.id);
            }
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
                const _pGet = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get;
                const _sGet = Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get;
                const _tsGet = Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get;
                const _tagGet = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
                const _ceGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get;
                const _rootFn = Node.prototype.getRootNode;
                const _matchFn = Element.prototype.matches;
                const _closeFn = Element.prototype.closest;
                const _visFn = Element.prototype.checkVisibility;
                const sParent = (x) => (x && _pGet && x instanceof Node ? _pGet.call(x) : null);
                const sSlot = (x) =>
                  !x
                    ? null
                    : _sGet && x instanceof Element
                      ? _sGet.call(x)
                      : _tsGet && x instanceof Text
                        ? _tsGet.call(x)
                        : null;
                const sRoot = (x) => (x && _rootFn && x instanceof Node ? _rootFn.call(x) : null);
                const sTag = (x) => (x && _tagGet && x instanceof Element ? String(_tagGet.call(x) || '').toUpperCase() : '');
                const sIsCE = (x) => Boolean(x && _ceGet && x instanceof HTMLElement && _ceGet.call(x));

                const SKIP_CLOSEST =
                  'style, script, noscript, template, textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
                const isInsideSkipped = (node) => {
                  const seen = new Set();
                  let cur = node instanceof Element ? node : sSlot(node) || sParent(node);
                  while (cur && !seen.has(cur)) {
                    seen.add(cur);
                    if (
                      sIsCE(cur) ||
                      (_matchFn && cur instanceof Element && _matchFn.call(cur, SKIP_CLOSEST)) ||
                      (_closeFn && cur instanceof Element && _closeFn.call(cur, SKIP_CLOSEST))
                    ) {
                      return true;
                    }
                    const sl = sSlot(cur);
                    if (sl) {
                      cur = sl;
                      continue;
                    }
                    const rn = sRoot(cur);
                    cur = sParent(cur) || (rn && rn.host ? rn.host : null);
                  }
                  return false;
                };
                const visCache = new WeakMap();
                const isSingleElemVisible = (el) => {
                  if (visCache.has(el)) return visCache.get(el);
                  const cs = window.getComputedStyle(el);
                  const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || '').toLowerCase();
                  let v = (!tSec || tSec === 'none') && cs.opacity !== '0' && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
                  if (v && typeof _visFn === 'function' && el instanceof Element) {
                    v = _visFn.call(el, { checkVisibilityCSS: true, checkOpacity: true });
                  }
                  visCache.set(el, v);
                  return v;
                };
                const isFlatVisible = (startEl) => {
                  const seen = new Set();
                  let cur = startEl;
                  while (cur && !seen.has(cur)) {
                    seen.add(cur);
                    if (!isSingleElemVisible(cur)) return false;
                    const sl = sSlot(cur);
                    if (sl) {
                      cur = sl;
                      continue;
                    }
                    const rn = sRoot(cur);
                    cur = sParent(cur) || (rn && rn.host ? rn.host : null);
                  }
                  return true;
                };
                let text = '';
                if (root) {
                  const parts = [];
                  let accLen = 0;
                  const walker = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(root, NodeFilter.SHOW_TEXT);
                  let node;
                  while ((node = walker.nextNode())) {
                    const p = sParent(node); const _nSl = sSlot(node); if (!_nSl && p && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(p)) continue;
                    const startEl = _nSl || p;
                    if (!startEl) continue;
                    if ((p && SKIP_TAGS.has(sTag(p))) || isInsideSkipped(startEl) || !isFlatVisible(startEl)) {
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
              activeExtractTabIds.delete(workerTab.id);
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

  if (method === 'done') {
    const summary = String(params.summary || 'Completed');
    const hasExplicitDoneTab =
      params.tabId !== undefined && params.tabId !== null && params.tabId !== '';

    if (hasExplicitDoneTab) {
      const targetEntry = resolveTargetEntry(params.tabId);
      await pollHudUserEvents(targetEntry.tabId, targetEntry);
      assertStillActiveAndUnpaused(targetEntry);
      await stopCdpForTab(targetEntry.tabId, targetEntry);

      if (targetEntry.substate === 'shared') {
        targetEntry.uiMode = 'shared';
        targetEntry.activity = tr().donePrefix(summary);
        await syncHud(targetEntry.tabId, { visible: true, mode: 'shared', activity: targetEntry.activity });
        await syncLiveTabGroups();
        notifyPanelAndDaemon();
        return { tabId: targetEntry.tabId, preservedSharedTab: true, summary };
      }

      const closedTabId = targetEntry.tabId;
      managedTabs.delete(closedTabId);
      await chrome.tabs.remove(closedTabId).catch(() => {});
      await syncLiveTabGroups();
      notifyPanelAndDaemon();
      return { tabId: closedTabId, closedWorkerTab: true, summary };
    }

    // No explicit tabId: cleanly close all unpaused temporary worker tabs and return shared tabs to calm idle state!
    const closedWorkerTabs = [];
    const preservedSharedTabs = [];
    for (const item of Array.from(managedTabs.values())) {
      await pollHudUserEvents(item.tabId, item);
      if (!managedTabs.has(item.tabId)) continue;
      await stopCdpForTab(item.tabId, item);
      if (item.substate === 'shared') {
        if (!item.paused) {
          item.uiMode = 'shared';
          item.activity = tr().donePrefix(summary);
          await syncHud(item.tabId, { visible: true, mode: 'shared', activity: item.activity });
        }
        preservedSharedTabs.push(item.tabId);
      } else if (!item.paused) {
        const wId = item.tabId;
        managedTabs.delete(wId);
        await chrome.tabs.remove(wId).catch(() => {});
        closedWorkerTabs.push(wId);
      }
    }
    await syncLiveTabGroups();
    notifyPanelAndDaemon();
    const firstId = closedWorkerTabs[0] ?? preservedSharedTabs[0] ?? null;
    return {
      ...(firstId !== null ? { tabId: firstId } : {}),
      closedWorkerTab: closedWorkerTabs.length > 0,
      preservedSharedTab: preservedSharedTabs.length > 0 && closedWorkerTabs.length === 0,
      closedWorkerTabs,
      preservedSharedTabs,
      summary
    };
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
            if (host instanceof Element && Element.prototype.hasAttribute.call(host, 'data-chrome-live-hud')) continue;
            const sr =
              (typeof Element !== 'undefined' && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(host)) ||
              (host.shadowRoot && typeof host.shadowRoot.querySelectorAll === 'function' ? host.shadowRoot : null);
            if (sr) {
              collectDeep(sr, sel, depth + 1, acc);
            }
          }
          return acc;
        }

        const _pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
        const _sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
        const _tsGet = typeof Text !== 'undefined' ? Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get : null;
        const _tagGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get : null;
        const _idGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'id')?.get : null;
        const _ceGet =
          typeof HTMLElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get
            : null;
        const _rootFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
        const _matchFn = typeof Element !== 'undefined' ? Element.prototype.matches : null;
        const _closeFn = typeof Element !== 'undefined' ? Element.prototype.closest : null;
        const _visFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
        const _attrFn = typeof Element !== 'undefined' ? Element.prototype.getAttribute : null;
        const _setAttrFn = typeof Element !== 'undefined' ? Element.prototype.setAttribute : null;

        const safeTagLower = (n) => {
          if (!n) return '';
          const raw =
            _tagGet && typeof Element !== 'undefined' && n instanceof Element
              ? _tagGet.call(n)
              : typeof n.tagName === 'string'
                ? n.tagName
                : '';
          return String(raw).toLowerCase();
        };
        const safeId = (n) => {
          if (!n) return '';
          if (_idGet && typeof Element !== 'undefined' && n instanceof Element) return String(_idGet.call(n) || '');
          return typeof n.id === 'string' ? n.id : '';
        };
        const safeIsCE = (n) => {
          if (!n) return false;
          if (_ceGet && typeof HTMLElement !== 'undefined' && n instanceof HTMLElement) return Boolean(_ceGet.call(n));
          return n.isContentEditable === true;
        };
        const safeParent = (n) => {
          if (!n) return null;
          if (_pGet && typeof Node !== 'undefined' && n instanceof Node) return _pGet.call(n);
          return n.parentElement && !(safeTagLower(n) === 'form' && 'form' in n.parentElement) ? n.parentElement : null;
        };
        const safeSlot = (n) => {
          if (!n) return null;
          if (_sGet && typeof Element !== 'undefined' && n instanceof Element) return _sGet.call(n);
          if (_tsGet && typeof Text !== 'undefined' && n instanceof Text) return _tsGet.call(n);
          return n.assignedSlot && !(safeTagLower(n) === 'form' && 'form' in n.assignedSlot) ? n.assignedSlot : null;
        };
        const safeRoot = (n) => {
          if (!n) return null;
          if (_rootFn && typeof Node !== 'undefined' && n instanceof Node) return _rootFn.call(n);
          return typeof n.getRootNode === 'function' ? n.getRootNode() : null;
        };
        const safeMatches = (n, sel) => {
          if (!n) return false;
          if (_matchFn && typeof Element !== 'undefined' && n instanceof Element) return _matchFn.call(n, sel);
          return typeof n.matches === 'function' ? n.matches(sel) : false;
        };
        const safeClosest = (n, sel) => {
          if (!n) return null;
          if (_closeFn && typeof Element !== 'undefined' && n instanceof Element) return _closeFn.call(n, sel);
          return typeof n.closest === 'function' ? n.closest(sel) : null;
        };
        const safeCheckVis = (n) => {
          if (!n) return false;
          if (_visFn && typeof Element !== 'undefined' && n instanceof Element) {
            return _visFn.call(n, { checkVisibilityCSS: true, checkOpacity: true });
          }
          return typeof n.checkVisibility === 'function'
            ? n.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            : true;
        };
        const safeGetAttr = (n, k) => {
          if (!n) return null;
          if (_attrFn && typeof Element !== 'undefined' && n instanceof Element) return _attrFn.call(n, k);
          return typeof n.getAttribute === 'function' ? n.getAttribute(k) : null;
        };
        const safeSetAttr = (n, k, v) => {
          if (!n) return;
          if (_setAttrFn && typeof Element !== 'undefined' && n instanceof Element) _setAttrFn.call(n, k, v);
          else if (typeof n.setAttribute === 'function') n.setAttribute(k, v);
        };
        const isElementFlatVisible = (elNode) => {
          if (!elNode) return false;
          const vFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
          const pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
          const sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
          const rFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
          const okVis =
            vFn && typeof Element !== 'undefined' && elNode instanceof Element
              ? vFn.call(elNode, { checkVisibilityCSS: true, checkOpacity: true })
              : typeof elNode.checkVisibility === 'function'
                ? elNode.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
                : true;
          if (!okVis) return false;
          const seen = new Set();
          let cur = elNode;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) {
              return false;
            }
            const sl =
              sGet && typeof Element !== 'undefined' && cur instanceof Element
                ? sGet.call(cur)
                : cur.assignedSlot && !(String(cur.tagName || '').toLowerCase() === 'form' && 'form' in cur.assignedSlot)
                  ? cur.assignedSlot
                  : null;
            if (sl) {
              cur = sl;
              continue;
            }
            const rn =
              rFn && typeof Node !== 'undefined' && cur instanceof Node
                ? rFn.call(cur)
                : typeof cur.getRootNode === 'function'
                  ? cur.getRootNode()
                  : null;
            const par =
              pGet && typeof Node !== 'undefined' && cur instanceof Node
                ? pGet.call(cur)
                : cur.parentElement && !(String(cur.tagName || '').toLowerCase() === 'form' && 'form' in cur.parentElement)
                  ? cur.parentElement
                  : null;
            cur = par || (rn && rn.host ? rn.host : null);
          }
          return true;
        };
        const SNAP_NESTED_EDITOR_OR_HIDDEN_SEL =
          '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
        const isNestedInsideEditorOrHidden = (elNode) => {
          const seen = new Set();
          const startRn = safeRoot(elNode);
          let cur = safeSlot(elNode) || safeParent(elNode) || (startRn && startRn.host ? startRn.host : null);
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (
              safeIsCE(cur) ||
              safeMatches(cur, SNAP_NESTED_EDITOR_OR_HIDDEN_SEL) ||
              safeClosest(cur, SNAP_NESTED_EDITOR_OR_HIDDEN_SEL)
            ) {
              return true;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };

        const candidates = collectDeep(document, SELECTORS);
        const elements = [];
        let idx = 0;

        for (const node of candidates) {
          if (idx >= limit) break;
          if (safeClosest(node, '[data-chrome-live-hud]') || isNestedInsideEditorOrHidden(node)) continue;
          if (!isElementFlatVisible(node)) continue;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;

          const tagLower = safeTagLower(node);
          let linkedInput = null;
          if (tagLower === 'label') {
            linkedInput = node.querySelector('input[type="radio"], input[type="checkbox"]');
            if (linkedInput) {
              const inpRect = linkedInput.getBoundingClientRect();
              if (isElementFlatVisible(linkedInput) && inpRect.width >= 4 && inpRect.height >= 4) continue;
            }
          }

          safeSetAttr(node, 'data-clive-idx', String(idx));
          const inputType = tagLower === 'input' ? String(node.type || 'text').toLowerCase() : '';
          const autoAttr = String(safeGetAttr(node, 'autocomplete') || '').toLowerCase();
          const roleAttr = String(safeGetAttr(node, 'role') || '').trim().toLowerCase();
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
            safeIsCE(node) ||
            /^(?:textbox|searchbox|combobox|spinbutton)$/.test(roleAttr);
          // Never expose user-entered password/OTP/input values or nested editor draft text as element labels
          const SNAP_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const SNAP_ANCESTOR_SKIP_SEL =
            '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isSnapSkipped = (n, stopRoot) => {
            const seen = new Set();
            let cur = n instanceof Element ? n : safeSlot(n) || safeParent(n);
            let passedStop = false;
            while (cur && !seen.has(cur)) {
              seen.add(cur);
              if (!passedStop && (safeIsCE(cur) || safeMatches(cur, SNAP_SKIP_SEL) || safeClosest(cur, SNAP_SKIP_SEL))) {
                return true;
              }
              if (safeIsCE(cur) || safeMatches(cur, SNAP_ANCESTOR_SKIP_SEL) || safeClosest(cur, SNAP_ANCESTOR_SKIP_SEL)) {
                return true;
              }
              if (!safeCheckVis(cur)) return true;
              const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
              const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
              if (
                cs.display === 'none' ||
                cs.visibility === 'hidden' ||
                cs.visibility === 'collapse' ||
                cs.opacity === '0' ||
                (tSec && tSec !== 'none')
              ) {
                return true;
              }
              const sl = safeSlot(cur);
              if (sl) {
                cur = sl;
                continue;
              }
              if (cur === stopRoot) {
                passedStop = true;
              }
              const rn = safeRoot(cur);
              cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
            }
            return false;
          };
          const extractCleanText = (rootNode) => {
            if (!rootNode) return '';
            const outParts = [];
            const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(rootNode, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = tw.nextNode())) {
              const _tnSl = safeSlot(tn); const _tnPar = safeParent(tn); if (!_tnSl && _tnPar && (typeof getOpenShadow === 'function' ? getOpenShadow(_tnPar) : Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(_tnPar))) continue; const startEl = _tnSl || _tnPar;
              if (startEl && !isSnapSkipped(startEl, rootNode)) {
                outParts.push(tn.nodeValue || '');
              }
            }
            return outParts.join(' ');
          };
          const rawLabel =
            safeGetAttr(node, 'aria-label') ||
            safeGetAttr(node, 'placeholder') ||
            (isUserValueField || isSensitiveField ? '' : extractCleanText(node)) ||
            (isButtonInput ? node.value : '') ||
            safeGetAttr(node, 'title') ||
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
          const testId = safeGetAttr(node, 'data-testid');
          const nodeIdStr = safeId(node);
          if (isControl && testId && /^[\w.:-]{1,64}$/.test(testId)) {
            stableSelector = `[data-testid="${testId}"]`;
          } else if (
            isControl &&
            nodeIdStr &&
            /^[a-zA-Z][\w-]{1,48}$/.test(nodeIdStr) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(nodeIdStr) &&
            !/\d{4,}/.test(nodeIdStr)
          ) {
            stableSelector = `#${nodeIdStr}`;
          } else if (isControl) {
            const nameAttr = safeGetAttr(node, 'name');
            if (nameAttr && /^[\w.:-]{1,48}$/.test(nameAttr)) {
              stableSelector = `${tagLower}[name="${nameAttr}"]`;
            }
          }

          const isDisabled =
            Boolean(node.disabled) ||
            Boolean(linkedInput?.disabled) ||
            safeGetAttr(node, 'aria-disabled') === 'true';
          let checkedState;
          const ariaChecked = safeGetAttr(node, 'aria-checked');
          if (ariaChecked === 'true' || ariaChecked === 'false') {
            checkedState = ariaChecked === 'true';
          } else if (
            (tagLower === 'input' && /^(?:checkbox|radio)$/i.test(safeGetAttr(node, 'type') || '')) ||
            linkedInput
          ) {
            checkedState = Boolean((linkedInput || node).checked);
          } else if (safeGetAttr(node, 'aria-pressed') === 'true') {
            checkedState = true;
          }
          const isSelected = safeGetAttr(node, 'aria-selected') === 'true' || Boolean(node.selected);
          const ariaExpanded = safeGetAttr(node, 'aria-expanded');
          const expandedState =
            ariaExpanded === 'true' || ariaExpanded === 'false' ? ariaExpanded === 'true' : undefined;

          const entryObj = {
            index: idx,
            tag: tagLower,
            type: safeGetAttr(node, 'type') || (linkedInput ? safeGetAttr(linkedInput, 'type') : undefined) || undefined,
            role: roleAttr || undefined,
            label: label || `(${tagLower})`,
            href: tagLower === 'a' ? node.href : undefined,
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
          if (safeClosest(aNode, '[data-chrome-live-hud]') || isNestedInsideEditorOrHidden(aNode)) continue;
          if (!isElementFlatVisible(aNode)) continue;
          const aRect = aNode.getBoundingClientRect();
          if (aRect.width < 4 || aRect.height < 4) continue;
          const ALERT_SKIP_SEL =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const ALERT_ANCESTOR_SKIP_SEL =
            '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const isAlertSkipped = (n, stopRoot) => {
            const seen = new Set();
            let cur = n instanceof Element ? n : safeSlot(n) || safeParent(n);
            let passedStop = false;
            while (cur && !seen.has(cur)) {
              seen.add(cur);
              if (!passedStop && (safeIsCE(cur) || safeMatches(cur, ALERT_SKIP_SEL) || safeClosest(cur, ALERT_SKIP_SEL))) {
                return true;
              }
              if (safeIsCE(cur) || safeMatches(cur, ALERT_ANCESTOR_SKIP_SEL) || safeClosest(cur, ALERT_ANCESTOR_SKIP_SEL)) {
                return true;
              }
              if (!safeCheckVis(cur)) return true;
              const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
              const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
              if (
                cs.display === 'none' ||
                cs.visibility === 'hidden' ||
                cs.visibility === 'collapse' ||
                cs.opacity === '0' ||
                (tSec && tSec !== 'none')
              ) {
                return true;
              }
              const sl = safeSlot(cur);
              if (sl) {
                cur = sl;
                continue;
              }
              if (cur === stopRoot) {
                passedStop = true;
              }
              const rn = safeRoot(cur);
              cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
            }
            return false;
          };
          const cleanAlertParts = [];
          const aWalker = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(aNode, NodeFilter.SHOW_TEXT);
          let aTn;
          while ((aTn = aWalker.nextNode())) {
            const _aSl = safeSlot(aTn); const _aPar = safeParent(aTn); if (!_aSl && _aPar && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(_aPar)) continue; const ap = _aSl || _aPar;
            if (ap && !isAlertSkipped(ap, aNode)) {
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
          const seen = new Set();
          let cur = n instanceof Element ? n : safeSlot(n) || safeParent(n);
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (safeIsCE(cur) || safeMatches(cur, SKIP_CLOSEST) || safeClosest(cur, SKIP_CLOSEST)) return true;
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };
        const visCache = new WeakMap();
        const isSingleElemVisible = (el) => {
          if (visCache.has(el)) return visCache.get(el);
          const cs = window.getComputedStyle(el);
          const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || '').toLowerCase();
          let v = (!tSec || tSec === 'none') && cs.opacity !== '0' && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
          if (v) {
            v = safeCheckVis(el);
          }
          visCache.set(el, v);
          return v;
        };
        const isFlatVisible = (startEl) => {
          const seen = new Set();
          let cur = startEl;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (!isSingleElemVisible(cur)) return false;
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return true;
        };
        let excerpt = '';
        if (mainRoot) {
          const parts = [];
          let accLen = 0;
          const walker = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(mainRoot, NodeFilter.SHOW_TEXT);
          let tNode;
          while ((tNode = walker.nextNode())) {
            const p = safeParent(tNode); const _tSl = safeSlot(tNode); if (!_tSl && p && Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(p)) continue;
            const startEl = _tSl || p;
            if (!startEl) continue;
            if ((p && SKIP_TAGS.has(safeTagLower(p).toUpperCase())) || isInsideSkipped(startEl) || !isFlatVisible(startEl)) {
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
    if (typeof target !== 'number' && typeof target !== 'string') {
      throw new Error('[GUARDRAIL] click target must be an element index (number) or selector/label (string)');
    }
    if (typeof target === 'string') {
      assertSafeModelSelector(target);
    }
    entry.activity = tr().clicking(typeof target === 'number' ? `[${target}]` : String(target).slice(0, 24));
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (tgt) => {
        function getOpenShadow(n) {
          if (!n) return null;
          try {
            if (typeof Element !== 'undefined') {
              const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
              if (sr) return sr;
            }
          } catch {}
          return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
        }

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
            if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
            const sr = getOpenShadow(h);
            if (sr) {
              const hit = queryDeep(sr, sel, depth + 1);
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
            if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
            const sr = getOpenShadow(h);
            if (sr) collectDeep(sr, sel, depth + 1, acc);
          }
          return acc;
        }

        const CLICK_SKIP_SEL =
          'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
        const CLICK_ANCESTOR_SKIP_SEL =
          '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
        const isClickSkipped = (n, stopRoot) => {
          const pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
          const sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
          const tsGet = typeof Text !== 'undefined' ? Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get : null;
          const ceGet =
            typeof HTMLElement !== 'undefined'
              ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get
              : null;
          const rFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
          const mFn = typeof Element !== 'undefined' ? Element.prototype.matches : null;
          const cFn = typeof Element !== 'undefined' ? Element.prototype.closest : null;
          const vFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
          const getPar = (x) =>
            !x
              ? null
              : pGet && typeof Node !== 'undefined' && x instanceof Node
                ? pGet.call(x)
                : x.parentElement && !(String(x.tagName || '').toLowerCase() === 'form' && 'form' in x.parentElement)
                  ? x.parentElement
                  : null;
          const getSl = (x) =>
            !x
              ? null
              : sGet && typeof Element !== 'undefined' && x instanceof Element
                ? sGet.call(x)
                : tsGet && typeof Text !== 'undefined' && x instanceof Text
                  ? tsGet.call(x)
                  : x.assignedSlot && !(String(x.tagName || '').toLowerCase() === 'form' && 'form' in x.assignedSlot)
                    ? x.assignedSlot
                    : null;
          const getRt = (x) =>
            !x
              ? null
              : rFn && typeof Node !== 'undefined' && x instanceof Node
                ? rFn.call(x)
                : typeof x.getRootNode === 'function'
                  ? x.getRootNode()
                  : null;
          const matchSel = (x, sel) =>
            !x
              ? false
              : mFn && typeof Element !== 'undefined' && x instanceof Element
                ? mFn.call(x, sel)
                : typeof x.matches === 'function'
                  ? x.matches(sel)
                  : false;
          const closeSel = (x, sel) =>
            !x
              ? null
              : cFn && typeof Element !== 'undefined' && x instanceof Element
                ? cFn.call(x, sel)
                : typeof x.closest === 'function'
                  ? x.closest(sel)
                  : null;
          const isCE = (x) =>
            !x
              ? false
              : ceGet && typeof HTMLElement !== 'undefined' && x instanceof HTMLElement
                ? Boolean(ceGet.call(x))
                : x.isContentEditable === true;
          const chkVis = (x) =>
            !x
              ? false
              : vFn && typeof Element !== 'undefined' && x instanceof Element
                ? vFn.call(x, { checkVisibilityCSS: true, checkOpacity: true })
                : typeof x.checkVisibility === 'function'
                  ? x.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
                  : true;
          const seen = new Set();
          let cur = n instanceof Element ? n : getSl(n) || getPar(n);
          let passedStop = false;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (!passedStop && (isCE(cur) || matchSel(cur, CLICK_SKIP_SEL) || closeSel(cur, CLICK_SKIP_SEL))) {
              return true;
            }
            if (isCE(cur) || matchSel(cur, CLICK_ANCESTOR_SKIP_SEL) || closeSel(cur, CLICK_ANCESTOR_SKIP_SEL)) {
              return true;
            }
            if (!chkVis(cur)) return true;
            const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
            const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
            if (
              cs.display === 'none' ||
              cs.visibility === 'hidden' ||
              cs.visibility === 'collapse' ||
              cs.opacity === '0' ||
              (tSec && tSec !== 'none')
            ) {
              return true;
            }
            const sl = getSl(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            if (cur === stopRoot) {
              passedStop = true;
            }
            const rn = getRt(cur);
            cur = getPar(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };

        function extractCleanContainerText(rootNode) {
          if (!rootNode) return '';
          const pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
          const tsGet = typeof Text !== 'undefined' ? Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get : null;
          const outParts = [];
          const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(rootNode, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = tw.nextNode())) {
            const sl =
              tsGet && typeof Text !== 'undefined' && tn instanceof Text ? tsGet.call(tn) : tn.assignedSlot || null;
            const par =
              pGet && typeof Node !== 'undefined' && tn instanceof Node ? pGet.call(tn) : tn.parentElement || null;
            if (!sl && par && (typeof getOpenShadow === 'function' ? getOpenShadow(par) : null)) continue;
            const p = sl || par;
            if (p && !isClickSkipped(p, rootNode)) {
              outParts.push(tn.nodeValue || '');
            }
          }
          return outParts.join(' ');
        }

        const _pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
        const _sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
        const _tagGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get : null;
        const _idGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'id')?.get : null;
        const _ceGet =
          typeof HTMLElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get
            : null;
        const _rootFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
        const _matchFn = typeof Element !== 'undefined' ? Element.prototype.matches : null;
        const _closeFn = typeof Element !== 'undefined' ? Element.prototype.closest : null;
        const _visFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
        const _attrFn = typeof Element !== 'undefined' ? Element.prototype.getAttribute : null;

        const safeTagLower = (n) => {
          if (!n) return '';
          const raw =
            _tagGet && typeof Element !== 'undefined' && n instanceof Element
              ? _tagGet.call(n)
              : typeof n.tagName === 'string'
                ? n.tagName
                : '';
          return String(raw).toLowerCase();
        };
        const safeId = (n) => {
          if (!n) return '';
          if (_idGet && typeof Element !== 'undefined' && n instanceof Element) return String(_idGet.call(n) || '');
          return typeof n.id === 'string' ? n.id : '';
        };
        const safeIsCE = (n) => {
          if (!n) return false;
          if (_ceGet && typeof HTMLElement !== 'undefined' && n instanceof HTMLElement) return Boolean(_ceGet.call(n));
          return n.isContentEditable === true;
        };
        const safeParent = (n) => {
          if (!n) return null;
          if (_pGet && typeof Node !== 'undefined' && n instanceof Node) return _pGet.call(n);
          return n.parentElement && !(safeTagLower(n) === 'form' && 'form' in n.parentElement) ? n.parentElement : null;
        };
        const safeSlot = (n) => {
          if (!n) return null;
          if (_sGet && typeof Element !== 'undefined' && n instanceof Element) return _sGet.call(n);
          return n.assignedSlot && !(safeTagLower(n) === 'form' && 'form' in n.assignedSlot) ? n.assignedSlot : null;
        };
        const safeRoot = (n) => {
          if (!n) return null;
          if (_rootFn && typeof Node !== 'undefined' && n instanceof Node) return _rootFn.call(n);
          return typeof n.getRootNode === 'function' ? n.getRootNode() : null;
        };
        const safeMatches = (n, sel) => {
          if (!n) return false;
          if (_matchFn && typeof Element !== 'undefined' && n instanceof Element) return _matchFn.call(n, sel);
          return typeof n.matches === 'function' ? n.matches(sel) : false;
        };
        const safeClosest = (n, sel) => {
          if (!n) return null;
          if (_closeFn && typeof Element !== 'undefined' && n instanceof Element) return _closeFn.call(n, sel);
          return typeof n.closest === 'function' ? n.closest(sel) : null;
        };
        const safeGetAttr = (n, k) => {
          if (!n) return null;
          if (_attrFn && typeof Element !== 'undefined' && n instanceof Element) return _attrFn.call(n, k);
          return typeof n.getAttribute === 'function' ? n.getAttribute(k) : null;
        };
        const isElementFlatVisible = (elNode) => {
          if (!elNode) return false;
          const okVis =
            _visFn && typeof Element !== 'undefined' && elNode instanceof Element
              ? _visFn.call(elNode, { checkVisibilityCSS: true, checkOpacity: true })
              : typeof elNode.checkVisibility === 'function'
                ? elNode.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
                : true;
          if (!okVis) return false;
          const seen = new Set();
          let cur = elNode;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (safeMatches(cur, '[hidden], [aria-hidden="true"]')) return false;
            const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) {
              return false;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return true;
        };
        const isNestedInsideEditor = (elNode) => {
          const EDITOR_ANC_SEL =
            '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror';
          const seen = new Set();
          const startRn = safeRoot(elNode);
          let cur = safeSlot(elNode) || safeParent(elNode) || (startRn && startRn.host ? startRn.host : null);
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (safeIsCE(cur) || safeMatches(cur, EDITOR_ANC_SEL) || safeClosest(cur, EDITOR_ANC_SEL)) return true;
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };

        function isInteractableElement(cand) {
          if (!cand || !(cand instanceof Element)) return false;
          const tg = safeTagLower(cand);
          if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
            return false;
          }
          if (tg === 'input' && String(cand.type || '').toLowerCase() === 'hidden') return false;
          if (safeClosest(cand, '[data-chrome-live-hud]')) return false;
          if (!isElementFlatVisible(cand)) return false;
          const rc = cand.getBoundingClientRect();
          return rc.width >= 2 && rc.height >= 2;
        }

        let el = null;
        if (typeof tgt === 'number') {
          const hit = queryDeep(document, `[data-clive-idx="${tgt}"]`);
          if (isInteractableElement(hit)) el = hit;
        } else if (typeof tgt === 'string') {
          const raw = tgt.trim();
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
              if (safeClosest(item, '[data-chrome-live-hud]') || isNestedInsideEditor(item)) continue;
              if (!isElementFlatVisible(item)) continue;
              const rc = item.getBoundingClientRect();
              if (rc.width < 4 || rc.height < 4) continue;
              const iTag = safeTagLower(item);
              const iRole = String(safeGetAttr(item, 'role') || '').trim().toLowerCase();
              const iBtn = iTag === 'input' && /^(?:button|submit|reset)$/i.test(String(item.type || ''));
              const iUserVal =
                (iTag === 'input' && !iBtn) ||
                iTag === 'textarea' ||
                iTag === 'select' ||
                safeIsCE(item) ||
                /^(?:textbox|searchbox|combobox|spinbutton)$/.test(iRole);
              const txt = (
                (iUserVal ? '' : extractCleanContainerText(item)) ||
                (iBtn ? item.value : '') ||
                safeGetAttr(item, 'aria-label') ||
                safeGetAttr(item, 'title') ||
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
        const elTagLower = safeTagLower(el);
        const elInputType = elTagLower === 'input' ? String(el.type || 'text').toLowerCase() : '';
        const elAutoAttr = String(safeGetAttr(el, 'autocomplete') || '').toLowerCase();
        const elRoleAttr = String(safeGetAttr(el, 'role') || '').trim().toLowerCase();
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
          safeIsCE(el) ||
          /^(?:textbox|searchbox|combobox|spinbutton)$/.test(elRoleAttr);
        const extractSafeNodeText = (rootNode) => extractCleanContainerText(rootNode);
        const elSafeId = safeId(el);
        // Never leak user-entered password/OTP/input values or nested drafts in disabled errors or click receipts
        const safeElemLabel = (maxLen) =>
          (
            safeGetAttr(el, 'aria-label') ||
            safeGetAttr(el, 'placeholder') ||
            (elIsUserValueField || elIsSensitive ? '' : extractSafeNodeText(el)) ||
            (elIsButtonInput ? el.value : '') ||
            safeGetAttr(el, 'title') ||
            (elIsSensitive ? '(password)' : '') ||
            safeGetAttr(el, 'name') ||
            elSafeId ||
            elTagLower
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLen);

        if (el.disabled || safeGetAttr(el, 'aria-disabled') === 'true') {
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
          const tag = safeTagLower(node);
          const tid = safeGetAttr(node, 'data-testid');
          if (tid && /^[\w.:-]{1,64}$/.test(tid)) return `[data-testid="${tid}"]`;
          const nid = safeId(node);
          if (
            nid &&
            /^[a-zA-Z][\w-]{1,48}$/.test(nid) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(nid) &&
            !/\d{4,}/.test(nid)
          ) {
            return `#${nid}`;
          }
          const nm = safeGetAttr(node, 'name');
          if (nm && /^[\w.:-]{1,48}$/.test(nm)) return `${tag}[name="${nm}"]`;
          const aria = (safeGetAttr(node, 'aria-label') || '').trim();
          if (aria && aria.length <= 40 && !/["\\\r\n\f]|\/\*|\*\//.test(aria)) return `${tag}[aria-label="${aria}"]`;
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
            tag: elTagLower,
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
          tag: elTagLower,
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
    if (typeof target !== 'number' && typeof target !== 'string') {
      throw new Error('[GUARDRAIL] type target must be an element index (number) or selector/label (string)');
    }
    if (typeof text !== 'string') {
      throw new Error('type text must be a string');
    }
    if (typeof target === 'string') {
      assertSafeModelSelector(target);
    }
    entry.activity = tr().typing;
    await syncHud(entry.tabId, { visible: true, mode: 'working', activity: entry.activity });
    await verifyEntryStillControllable(entry);

    const execRes = await chrome.scripting.executeScript({ target: { tabId: entry.tabId  }, injectImmediately: true,
      func: async (tgt, val, shouldSubmit) => {
        function getOpenShadow(n) {
          if (!n) return null;
          try {
            if (typeof Element !== 'undefined') {
              const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
              if (sr) return sr;
            }
          } catch {}
          return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
        }

        function queryDeep(root, sel, depth = 0) {
          if (!root || depth > 6) return null;
          try {
            const direct = root.querySelector(sel);
            if (direct) return direct;
          } catch {
            return null;
          }
          for (const h of root.querySelectorAll('*')) {
            if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
            const sr = getOpenShadow(h);
            if (sr) {
              const hit = queryDeep(sr, sel, depth + 1);
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
            if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
            const sr = getOpenShadow(h);
            if (sr) collectDeep(sr, sel, depth + 1, acc);
          }
          return acc;
        }

        const _pGet = typeof Node !== 'undefined' ? Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get : null;
        const _sGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get : null;
        const _tsGet = typeof Text !== 'undefined' ? Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get : null;
        const _tagGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get : null;
        const _idGet = typeof Element !== 'undefined' ? Object.getOwnPropertyDescriptor(Element.prototype, 'id')?.get : null;
        const _ceGet =
          typeof HTMLElement !== 'undefined'
            ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get
            : null;
        const _rootFn = typeof Node !== 'undefined' ? Node.prototype.getRootNode : null;
        const _matchFn = typeof Element !== 'undefined' ? Element.prototype.matches : null;
        const _closeFn = typeof Element !== 'undefined' ? Element.prototype.closest : null;
        const _visFn = typeof Element !== 'undefined' ? Element.prototype.checkVisibility : null;
        const _attrFn = typeof Element !== 'undefined' ? Element.prototype.getAttribute : null;

        const safeTagLower = (n) => {
          if (!n) return '';
          const raw =
            _tagGet && typeof Element !== 'undefined' && n instanceof Element
              ? _tagGet.call(n)
              : typeof n.tagName === 'string'
                ? n.tagName
                : '';
          return String(raw).toLowerCase();
        };
        const safeId = (n) => {
          if (!n) return '';
          if (_idGet && typeof Element !== 'undefined' && n instanceof Element) return String(_idGet.call(n) || '');
          return typeof n.id === 'string' ? n.id : '';
        };
        const safeIsCE = (n) => {
          if (!n) return false;
          if (_ceGet && typeof HTMLElement !== 'undefined' && n instanceof HTMLElement) return Boolean(_ceGet.call(n));
          return n.isContentEditable === true;
        };
        const safeParent = (n) => {
          if (!n) return null;
          if (_pGet && typeof Node !== 'undefined' && n instanceof Node) return _pGet.call(n);
          return n.parentElement && !(safeTagLower(n) === 'form' && 'form' in n.parentElement) ? n.parentElement : null;
        };
        const safeSlot = (n) => {
          if (!n) return null;
          if (_sGet && typeof Element !== 'undefined' && n instanceof Element) return _sGet.call(n);
          if (_tsGet && typeof Text !== 'undefined' && n instanceof Text) return _tsGet.call(n);
          return n.assignedSlot && !(safeTagLower(n) === 'form' && 'form' in n.assignedSlot) ? n.assignedSlot : null;
        };
        const safeRoot = (n) => {
          if (!n) return null;
          if (_rootFn && typeof Node !== 'undefined' && n instanceof Node) return _rootFn.call(n);
          return typeof n.getRootNode === 'function' ? n.getRootNode() : null;
        };
        const safeMatches = (n, sel) => {
          if (!n) return false;
          if (_matchFn && typeof Element !== 'undefined' && n instanceof Element) return _matchFn.call(n, sel);
          return typeof n.matches === 'function' ? n.matches(sel) : false;
        };
        const safeClosest = (n, sel) => {
          if (!n) return null;
          if (_closeFn && typeof Element !== 'undefined' && n instanceof Element) return _closeFn.call(n, sel);
          return typeof n.closest === 'function' ? n.closest(sel) : null;
        };
        const safeCheckVis = (n) => {
          if (!n) return false;
          if (_visFn && typeof Element !== 'undefined' && n instanceof Element) {
            return _visFn.call(n, { checkVisibilityCSS: true, checkOpacity: true });
          }
          return typeof n.checkVisibility === 'function'
            ? n.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            : true;
        };
        const safeGetAttr = (n, k) => {
          if (!n) return null;
          if (_attrFn && typeof Element !== 'undefined' && n instanceof Element) return _attrFn.call(n, k);
          return typeof n.getAttribute === 'function' ? n.getAttribute(k) : null;
        };
        const isElementFlatVisible = (elNode) => {
          if (!elNode || !safeCheckVis(elNode)) return false;
          const seen = new Set();
          let cur = elNode;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (safeMatches(cur, '[hidden], [aria-hidden="true"]')) return false;
            const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) {
              return false;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return true;
        };
        const TYPE_NESTED_EDITOR_OR_HIDDEN_SEL =
          '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], [data-chrome-live-hud]';
        const isNestedInsideEditorOrHidden = (elNode) => {
          const seen = new Set();
          const startRn = safeRoot(elNode);
          let cur = safeSlot(elNode) || safeParent(elNode) || (startRn && startRn.host ? startRn.host : null);
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (
              safeIsCE(cur) ||
              safeMatches(cur, TYPE_NESTED_EDITOR_OR_HIDDEN_SEL) ||
              safeClosest(cur, TYPE_NESTED_EDITOR_OR_HIDDEN_SEL)
            ) {
              return true;
            }
            const sl = safeSlot(cur);
            if (sl) {
              cur = sl;
              continue;
            }
            const rn = safeRoot(cur);
            cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
          }
          return false;
        };

        function isValidTypeTarget(cand) {
          if (!cand || !(cand instanceof Element)) return false;
          const tg = safeTagLower(cand);
          if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
            return false;
          }
          if (tg === 'input' && String(cand.type || '').toLowerCase() === 'hidden') return false;
          if (safeClosest(cand, '[data-chrome-live-hud]')) return false;
          if (!isElementFlatVisible(cand)) return false;
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
            const readCleanLabel = (lbl) => {
              if (!lbl) return '';
              if (typeof NodeFilter === 'undefined') return '';
              const skipSel =
                'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
              const ancestorSkipSel =
                '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
              const parts = [];
              const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(lbl, NodeFilter.SHOW_TEXT);
              let tn;
              while ((tn = tw.nextNode())) {
                const _lSl = safeSlot(tn); const _lPar = safeParent(tn); if (!_lSl && _lPar && (typeof getOpenShadow === 'function' ? getOpenShadow(_lPar) : Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(_lPar))) continue; let cur = _lSl || _lPar;
                let blocked = false;
                let passedRoot = false;
                const seen = new Set();
                while (cur && !seen.has(cur)) {
                  seen.add(cur);
                  if (!passedRoot && (safeIsCE(cur) || safeMatches(cur, skipSel) || safeClosest(cur, skipSel))) {
                    blocked = true;
                    break;
                  }
                  if (safeIsCE(cur) || safeMatches(cur, ancestorSkipSel) || safeClosest(cur, ancestorSkipSel)) {
                    blocked = true;
                    break;
                  }
                  if (!safeCheckVis(cur)) {
                    blocked = true;
                    break;
                  }
                  const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
                  const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
                  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || (tSec && tSec !== 'none')) {
                    blocked = true;
                    break;
                  }
                  const sl = safeSlot(cur);
                  if (sl) {
                    cur = sl;
                    continue;
                  }
                  if (cur === lbl) {
                    passedRoot = true;
                  }
                  const rn = safeRoot(cur);
                  cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
                }
                if (blocked) continue;
                if (tn.nodeValue) parts.push(tn.nodeValue);
              }
              return parts.join(' ');
            };
            let partialMatch = null;
            for (const cand of inputs) {
              if (!isValidTypeTarget(cand) || isNestedInsideEditorOrHidden(cand)) continue;
              const rect = cand.getBoundingClientRect();
              if (rect.width < 4 || rect.height < 4) continue;
              const labelText = readCleanLabel(cand.labels?.[0]);
              const haystacks = [
                safeGetAttr(cand, 'placeholder'),
                safeGetAttr(cand, 'aria-label'),
                safeGetAttr(cand, 'name'),
                safeId(cand),
                safeGetAttr(cand, 'title'),
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
          !safeIsCE(el)
        ) {
          const openSr = getOpenShadow(el);
          const inner =
            (openSr &&
              openSr.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"])')) ||
            el.querySelector?.('input, textarea, [contenteditable]:not([contenteditable="false"])');
          if (inner && isValidTypeTarget(inner)) el = inner;
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
        if (safeIsCE(el)) {
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
          if (el.form && typeof HTMLFormElement !== 'undefined' && el.form instanceof HTMLFormElement) {
            if (typeof HTMLFormElement.prototype.requestSubmit === 'function') {
              HTMLFormElement.prototype.requestSubmit.call(el.form);
            } else {
              HTMLFormElement.prototype.submit.call(el.form);
            }
          }
        }
        function deriveInputSelector(node) {
          const tag = safeTagLower(node);
          const tid = safeGetAttr(node, 'data-testid');
          if (tid && /^[\w.:-]{1,64}$/.test(tid)) return `[data-testid="${tid}"]`;
          const nid = safeId(node);
          if (
            nid &&
            /^[a-zA-Z][\w-]{1,48}$/.test(nid) &&
            !/^(?:ember\d+|rc-|radix-|headlessui-|mui-|el-id-)/i.test(nid) &&
            !/\d{4,}/.test(nid)
          ) {
            return `#${nid}`;
          }
          const nm = safeGetAttr(node, 'name');
          if (nm && /^[\w.:-]{1,48}$/.test(nm)) return `${tag}[name="${nm}"]`;
          if (String(safeGetAttr(node, 'type') || '').toLowerCase() === 'search') {
            return `${tag}[type="search"]`;
          }
          // Only use static UI placeholders (avoid rotating e-commerce promo hotwords like "丹东大草莓")
          const ph = (safeGetAttr(node, 'placeholder') || '').trim();
          if (
            ph &&
            ph.length <= 24 &&
            !/["\\\r\n\f]|\/\*|\*\//.test(ph) &&
            /(?:搜索|查找|输入|标题|内容|关键词|search|find|filter|enter|type|query|email|url)/i.test(ph)
          ) {
            return `${tag}[placeholder="${ph}"]`;
          }
          const aria = (safeGetAttr(node, 'aria-label') || '').trim();
          if (aria && aria.length <= 40 && !/["\\\r\n\f]|\/\*|\*\//.test(aria)) return `${tag}[aria-label="${aria}"]`;
          return '';
        }

        const elSafeId = safeId(el);
        const elSafeName = safeGetAttr(el, 'name') || '';
        const tInputType = String(safeGetAttr(el, 'type') || el.type || '').toLowerCase();
        const tAutoAttr = String(safeGetAttr(el, 'autocomplete') || '').toLowerCase();
        const tMeta = `${elSafeId} ${elSafeName} ${safeGetAttr(el, 'placeholder') || ''} ${safeGetAttr(el, 'aria-label') || ''}`;
        const isSensitiveTypeTarget =
          tInputType === 'password' ||
          /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(tAutoAttr) ||
          /(?:password|passwd|passcode|pwd|one-time|otp|2fa|totp|cvv|cvc|secret|pin|token|sms|verify|captcha|密码|口令|验证码|动态码|安全码|密钥|支付)/i.test(tMeta);
        const learnedSelector = isSensitiveTypeTarget ? '' : deriveInputSelector(el);
        const idAndCls = `${elSafeId} ${elSafeName} ${safeGetAttr(el, 'class') || ''}`;
        const isSearchField =
          /(?:search|query|^s$|^q$|^kw$)/i.test(elSafeName) ||
          /search/i.test(idAndCls) ||
          tInputType === 'search';
        const extractSafeLabelNode = (lblNode) => {
          if (!lblNode) return '';
          const skipSel =
            'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const ancestorSkipSel =
            '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
          const parts = [];
          const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(lblNode, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = tw.nextNode())) {
            const _lSl = safeSlot(tn); const _lPar = safeParent(tn); if (!_lSl && _lPar && (typeof getOpenShadow === 'function' ? getOpenShadow(_lPar) : Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(_lPar))) continue; let cur = _lSl || _lPar;
            let blocked = false;
            let passedRoot = false;
            const seen = new Set();
            while (cur && !seen.has(cur)) {
              seen.add(cur);
              if (!passedRoot && (safeIsCE(cur) || safeMatches(cur, skipSel) || safeClosest(cur, skipSel))) {
                blocked = true;
                break;
              }
              if (safeIsCE(cur) || safeMatches(cur, ancestorSkipSel) || safeClosest(cur, ancestorSkipSel)) {
                blocked = true;
                break;
              }
              if (!safeCheckVis(cur)) {
                blocked = true;
                break;
              }
              const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
              const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || (tSec && tSec !== 'none')) {
                blocked = true;
                break;
              }
              const sl = safeSlot(cur);
              if (sl) {
                cur = sl;
                continue;
              }
              if (cur === lblNode) {
                passedRoot = true;
              }
              const rn = safeRoot(cur);
              cur = safeParent(cur) || (rn && rn.host ? rn.host : null);
            }
            if (!blocked) {
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
                safeGetAttr(el, 'aria-label') ||
                extractSafeLabelNode(el.labels?.[0]) ||
                elSafeName ||
                elSafeId ||
                safeGetAttr(el, 'placeholder') ||
                '输入框'
              )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 32);
        const cmHost = safeClosest(el, '.CodeMirror');
        let cmTargetToken = '';
        if (cmHost) {
          cmTargetToken = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          Element.prototype.setAttribute.call(cmHost, 'data-clive-cm-target', cmTargetToken);
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
    if (
      params.target !== undefined &&
      params.target !== null &&
      typeof params.target !== 'number' &&
      typeof params.target !== 'string'
    ) {
      throw new Error('[GUARDRAIL] upload target must be a number or string');
    }
    if (typeof params.target === 'string') {
      assertSafeModelSelector(params.target);
    }
    const EXT_SENSITIVE_BASE_RX =
      /^(?:(?!.*\.pub$)id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-].+)|authorized_keys|known_hosts|auth\.token|site-playbooks\.json|daemon\.pid|spawn\.(?:lock|cooldown)|\.local-runtime\.json|agent_vault\.enc|accessTokens\.json|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|credentials(?:\.json)?|application_default_credentials\.json|Local\s+State|Cookies(?:-journal)?|cookies\.sqlite|key[34]\.db|cert9\.db|logins\.json|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore|gpg|age)|.*\.tfstate(?:\.backup)?)$/i;
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
    if (typeof isolatedContextId !== 'number') {
      throw new Error('Failed to create isolated execution world for file upload');
    }

    const locateExpr = `((tgt, fileExts) => {
      function getOpenShadow(n) {
        if (!n) return null;
        try {
          if (typeof Element !== 'undefined') {
            const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
            if (sr) return sr;
          }
        } catch {}
        return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
      }

      function queryDeep(root, sel, depth = 0) {
        if (!root || depth > 6) return null;
        try {
          const hit = root.querySelector(sel);
          if (hit) return hit;
        } catch {
          return null;
        }
        for (const h of root.querySelectorAll('*')) {
          if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
          const sr = getOpenShadow(h);
          if (sr) {
            const sub = queryDeep(sr, sel, depth + 1);
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
          if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
          const sr = getOpenShadow(h);
          if (sr) collectDeep(sr, sel, depth + 1, acc);
        }
        return acc;
      }

      const _pGet = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get;
      const _sGet = Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get;
      const _tsGet = Object.getOwnPropertyDescriptor(Text.prototype, 'assignedSlot')?.get;
      const _tagGet = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
      const _ceGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable')?.get;
      const _rootFn = Node.prototype.getRootNode;
      const _matchFn = Element.prototype.matches;
      const _closeFn = Element.prototype.closest;
      const _visFn = Element.prototype.checkVisibility;
      const _attrFn = Element.prototype.getAttribute;
      const uParent = (x) => (x && _pGet && x instanceof Node ? _pGet.call(x) : null);
      const uSlot = (x) =>
        !x
          ? null
          : _sGet && x instanceof Element
            ? _sGet.call(x)
            : _tsGet && x instanceof Text
              ? _tsGet.call(x)
              : null;
      const uRoot = (x) => (x && _rootFn && x instanceof Node ? _rootFn.call(x) : null);
      const uTag = (x) => (x && _tagGet && x instanceof Element ? String(_tagGet.call(x) || '').toUpperCase() : '');
      const uIsCE = (x) => Boolean(x && _ceGet && x instanceof HTMLElement && _ceGet.call(x));
      const uAttr = (x, k) => (x && _attrFn && x instanceof Element ? _attrFn.call(x, k) : null);

      function findRelatedFileInput(node) {
        if (!node) return null;
        if (uTag(node) === 'INPUT' && String(node.type).toLowerCase() === 'file') return node;
        if (uTag(node) === 'LABEL' && node.htmlFor) {
          const byFor = queryDeep(document, '#' + CSS.escape(node.htmlFor));
          if (byFor && uTag(byFor) === 'INPUT' && String(byFor.type).toLowerCase() === 'file') return byFor;
        }
        const openSr = getOpenShadow(node);
        const inner =
          (openSr && openSr.querySelector('input[type="file"]:not(:disabled)')) ||
          (node.querySelector && node.querySelector('input[type="file"]:not(:disabled)'));
        if (inner) return inner;
        let cur = uParent(node);
        for (let i = 0; i < 3 && cur; i++) {
          const near = cur.querySelector && cur.querySelector('input[type="file"]:not(:disabled)');
          if (near) return near;
          cur = uParent(cur);
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
          const readSafeClickableText = (node) => {
            if (!node) return '';
            if (typeof NodeFilter === 'undefined') return '';
            const skipSel =
              'textarea, select, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
            const ancestorSkipSel =
              '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], .CodeMirror, .cm-editor, .monaco-editor, .ace_editor, .ql-editor, .ProseMirror, [hidden], [aria-hidden="true"], style, script, noscript, template, [data-chrome-live-hud]';
            const out = [];
            const tw = (typeof Document !== 'undefined' && document instanceof Document ? Document.prototype.createTreeWalker.bind(document) : document.createTreeWalker)(node, NodeFilter.SHOW_TEXT);
            let tn;
            while ((tn = tw.nextNode())) {
              const _uSl = uSlot(tn); const _uPar = uParent(tn); if (!_uSl && _uPar && getOpenShadow(_uPar)) continue; let cur = _uSl || _uPar;
              let blocked = false;
              let passedRoot = false;
              const seen = new Set();
              while (cur && !seen.has(cur)) {
                seen.add(cur);
                if (
                  !passedRoot &&
                  (uIsCE(cur) ||
                    (_matchFn && cur instanceof Element && _matchFn.call(cur, skipSel)) ||
                    (_closeFn && cur instanceof Element && _closeFn.call(cur, skipSel)))
                ) {
                  blocked = true;
                  break;
                }
                if (
                  uIsCE(cur) ||
                  (_matchFn && cur instanceof Element && _matchFn.call(cur, ancestorSkipSel)) ||
                  (_closeFn && cur instanceof Element && _closeFn.call(cur, ancestorSkipSel))
                ) {
                  blocked = true;
                  break;
                }
                if (typeof _visFn === 'function' && cur instanceof Element && !_visFn.call(cur, { checkVisibilityCSS: true, checkOpacity: true })) {
                  blocked = true;
                  break;
                }
                const cs = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
                const tSec = String(cs.webkitTextSecurity || cs.getPropertyValue?.('-webkit-text-security') || '').toLowerCase();
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || (tSec && tSec !== 'none')) {
                  blocked = true;
                  break;
                }
                const sl = uSlot(cur);
                if (sl) {
                  cur = sl;
                  continue;
                }
                if (cur === node) {
                  passedRoot = true;
                }
                const rn = uRoot(cur);
                cur = uParent(cur) || (rn && rn.host ? rn.host : null);
              }
              if (blocked) continue;
              if (tn.nodeValue) out.push(tn.nodeValue);
            }
            return out.join(' ');
          };
          const clickables = collectDeep(document, 'label, button, a, [role="button"]');
          for (const item of clickables) {
            const txt = (readSafeClickableText(item) || uAttr(item, 'aria-label') || uAttr(item, 'title') || '')
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
            const _pGet = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get;
            const pOf = (x) => (x && _pGet && x instanceof Node ? _pGet.call(x) : null);
            const inp = this;
            let anchor = inp;
            let rect = anchor.getBoundingClientRect();
            while (anchor && (rect.width < 4 || rect.height < 4) && pOf(anchor)) {
              anchor = pOf(anchor);
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
    if (typeof params.url !== 'string' || !params.url.trim()) {
      throw new Error('[GUARDRAIL] URL parameter must be a non-empty string');
    }
    const url = params.url.trim();
    const safety = checkTabUrlAllowed(url);
    if (!safety.allowed) throw new Error(`[GUARDRAIL] ${safety.reason}`);
    await verifyEntryStillControllable(entry);
    // Pre-stop any active screencast BEFORE navigating so transitional frames on pages embedding protected frames are never streamed
    await stopCdpForTab(entry.tabId, entry);
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

  if (method === 'wait') {
    if (params.selector !== undefined && params.selector !== null && typeof params.selector !== 'string') {
      throw new Error('[GUARDRAIL] wait selector must be a string');
    }
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
            function getOpenShadow(n) {
              if (!n) return null;
              try {
                if (typeof Element !== 'undefined') {
                  const sr = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get?.call(n);
                  if (sr) return sr;
                }
              } catch {}
              return n.shadowRoot && typeof n.shadowRoot.querySelectorAll === 'function' ? n.shadowRoot : null;
            }
            function queryDeep(root, s, depth = 0) {
              if (!root || depth > 6) return null;
              try {
                const hit = root.querySelector(s);
                if (hit) return hit;
              } catch {
                return null;
              }
              for (const h of root.querySelectorAll('*')) {
                if (h instanceof Element && Element.prototype.hasAttribute.call(h, 'data-chrome-live-hud')) continue;
                const sr = getOpenShadow(h);
                if (sr) {
                  const sub = queryDeep(sr, s, depth + 1);
                  if (sub) return sub;
                }
              }
              return null;
            }
            const found = queryDeep(document, sel);
            if (!found || !(found instanceof Element)) return false;
            const _pGet = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get;
            const _sGet = Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get;
            const _tagGet = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')?.get;
            const _rootFn = Node.prototype.getRootNode;
            const _matchFn = Element.prototype.matches;
            const _visFn = Element.prototype.checkVisibility;
            const tg = String((_tagGet && _tagGet.call(found)) || '').toLowerCase();
            if (tg === 'meta' || tg === 'script' || tg === 'style' || tg === 'link' || tg === 'template' || tg === 'head') {
              return false;
            }
            if (tg === 'input' && String(found.type || '').toLowerCase() === 'hidden') return false;
            if (typeof _visFn === 'function' && !_visFn.call(found, { checkVisibilityCSS: true, checkOpacity: true })) {
              return false;
            }
            const seen = new Set();
            let cur = found;
            while (cur && !seen.has(cur)) {
              seen.add(cur);
              if (_matchFn && cur instanceof Element && _matchFn.call(cur, '[hidden], [aria-hidden="true"], [data-chrome-live-hud]')) {
                return false;
              }
              const st = (cur.ownerDocument?.defaultView || window).getComputedStyle(cur);
              if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || st.opacity === '0') {
                return false;
              }
              const sl = _sGet && cur instanceof Element ? _sGet.call(cur) : null;
              if (sl) {
                cur = sl;
                continue;
              }
              const rn = _rootFn && cur instanceof Node ? _rootFn.call(cur) : null;
              cur = (_pGet && cur instanceof Node ? _pGet.call(cur) : null) || (rn && rn.host ? rn.host : null);
            }
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
    if (entry.paused || entry.detached || !checkTabUrlAllowed(entry.url || '').allowed) {
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

chrome.debugger.onDetach.addListener(async (source, reason) => {
  await ensureSwInitialized();
  const tabId = source?.tabId;
  if (tabId && managedTabs.has(tabId)) {
    const entry = managedTabs.get(tabId);
    entry.attachedCdp = false;
    entry.screencastActive = false;
    if (reason === 'canceled_by_user') {
      await detachManagedTab(tabId, 'Canceled by user in Chrome banner').catch(() => {});
    }
  }
});

async function handleWebNavGuardrail(details) {
  if (!details || typeof details.tabId !== 'number') return;
  // Synchronous pre-await kill switch for already-loaded managedTabs so concurrent `Page.screencastFrame` drops at 0us!
  if (
    managedTabs.has(details.tabId) &&
    details.url &&
    details.url !== 'about:blank' &&
    !(details.frameId !== 0 && isPassiveTelemetrySubframeUrl(details.url))
  ) {
    const syncCheck = checkTabUrlAllowed(details.url);
    if (!syncCheck.allowed) {
      const curEntry = managedTabs.get(details.tabId);
      if (curEntry) {
        curEntry.detached = true;
        curEntry.paused = true;
      }
    }
  }
  await ensureSwInitialized();
  if (!managedTabs.has(details.tabId)) return;
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

if (chrome.webNavigation?.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(handleWebNavGuardrail);
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
  // Synchronous pre-await kill switch on URL / pendingUrl changes before async storage await
  if (managedTabs.has(tabId)) {
    const candidateSyncUrl = changeInfo.url || tab?.pendingUrl || tab?.url || '';
    if (candidateSyncUrl && !checkTabUrlAllowed(candidateSyncUrl).allowed) {
      const syncEntry = managedTabs.get(tabId);
      if (syncEntry) {
        syncEntry.detached = true;
        syncEntry.paused = true;
      }
    }
  }
  await ensureSwInitialized();
  // Always notify the open side panel when an active tab navigates from chrome://newtab/ to a web URL
  if (tab?.active && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) {
    chrome.runtime.sendMessage({ type: 'sw:state_updated' }).catch(() => {});
  }
  if (!managedTabs.has(tabId)) return;
  const entry = managedTabs.get(tabId);
  if (changeInfo.url || tab?.pendingUrl || changeInfo.status === 'complete') {
    entry.title = tab.title || entry.title;
    entry.url = tab.url || entry.url;
    const safety = checkTabUrlAllowed(entry.url);
    const pendSafety = tab?.pendingUrl ? checkTabUrlAllowed(tab.pendingUrl) : { allowed: true, reason: '' };
    if (!safety.allowed || !pendSafety.allowed) {
      const tripReason = !safety.allowed ? safety.reason : pendSafety.reason;
      const tripUrl = !safety.allowed ? entry.url : tab.pendingUrl;
      await detachManagedTab(tabId, tripReason, true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'guardrail_trip',
            tabId,
            url: redactAuditUrl(tripUrl || ''),
            reason: tripReason
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
  if (!/^https?:\/\//i.test(restoreUrl)) return false;
  const safety = checkTabUrlAllowed(restoreUrl);
  if (!safety.allowed) return false;

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
  if (targetWindowId === null) return false;

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
  if (!created || typeof created.id !== 'number') return false;

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
    replacedTabId: typeof closedEntry.tabId === 'number' ? closedEntry.tabId : null,
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
  if (!updatedTab || !managedTabs.has(created.id)) return true;

  const postSafety = checkTabUrlAllowed(updatedTab.url || '');
  if (!postSafety.allowed) {
    await detachManagedTab(created.id, postSafety.reason, true);
    return true;
  }
  const postFrameSafety = await inspectEmbeddedFramesSafety(created.id);
  if (!postFrameSafety.allowed) {
    await detachManagedTab(created.id, postFrameSafety.reason, true);
    return true;
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
  return true;
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureSwInitialized();
  if (managedTabs.has(tabId)) {
    const entry = managedTabs.get(tabId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const shouldAutoMergeRelay =
      typeof entry.relayPopoutWinId === 'number' &&
      (removeInfo?.isWindowClosing || removeInfo?.windowId === entry.relayPopoutWinId);
    managedTabs.delete(tabId);
    if (shouldAutoMergeRelay) {
      const merged = await autoMergeClosedRelayTab(entry).catch(() => false);
      if (merged) return;
    }
    rememberDetachedTab(tabId, 'Tab closed', false);
    await syncLiveTabGroups();
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
  await ensureSwInitialized();
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
  await ensureSwInitialized();
  if (info.menuItemId === 'chrome-live-toggle-share' && tab) {
    await shareTab(tab, true);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureSwInitialized();
  if (alarm.name === KEEPALIVE_ALARM) {
    connectWebSocket();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ensureSwInitialized();
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
          await persistSessionState();
        } else if (msg.event === 'resume') {
          if (entry.relayPopoutWinId) {
            await mergeRelayTabBack(entry, { resumedByUserInBrowser: true });
          } else {
            entry.paused = false;
            entry.uiMode = 'working';
            entry.activity = currentLang === 'zh' ? '已恢复锁定操控' : 'Resumed automation';
            await syncLiveTabGroups();
            notifyPanelAndDaemon();
            await persistSessionState();
          }
        }
      } else if (typeof senderTabId === 'number' && msg.event === 'release') {
        await chrome.tabs.ungroup(senderTabId).catch(() => {});
        await syncLiveTabGroups();
        await persistSessionState();
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
        wsConnected: Boolean(ws && ws.readyState === WebSocket.OPEN && wsAuthed),
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
        await pollHudUserEvents(entry.tabId, entry);
        if (!managedTabs.has(msg.tabId)) {
          sendResponse({ ok: true });
          return;
        }
        if (entry.paused && entry.relayPopoutWinId) {
          await mergeRelayTabBack(entry, { resumedByUserInBrowser: true });
          await persistSessionState();
          sendResponse({ ok: true });
          return;
        }
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
        await persistSessionState();
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
      for (const [tid, ent] of Array.from(managedTabs.entries())) {
        const liveTab = await chrome.tabs.get(tid).catch(() => null);
        const liveUrl = liveTab?.pendingUrl || liveTab?.url || ent.url || '';
        const topCheck = checkTabUrlAllowed(liveUrl);
        if (!topCheck.allowed) {
          await detachManagedTab(tid, topCheck.reason || 'Custom blocked domain', true);
          continue;
        }
        if (liveTab && !liveTab.discarded) {
          const subCheck = await inspectEmbeddedFramesSafety(tid);
          if (!subCheck.allowed) {
            await detachManagedTab(tid, subCheck.reason || 'Embedded custom blocked frame', true);
          }
        }
      }
      notifyPanelAndDaemon();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown panel message' });
  })();
  return true;
});

swInitPromise = loadBootstrapAndStorage().then(async () => {
  await reconcileHudAfterStartup();
  await syncLiveTabGroups();
  notifyPanelAndDaemon();
  connectWebSocket();
});
