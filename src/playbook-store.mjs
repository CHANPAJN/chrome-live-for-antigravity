import fs from 'node:fs';
import path from 'node:path';
import {
  AUDIT_SENSITIVE_PARAM_RX,
  evaluateUrlSafety,
  isHighEntropyPathToken,
  redactUrlForAudit,
  redactUrlsInText
} from './guardrails.mjs';
import { ensureSecureDirSync, getStateDir } from './token-store.mjs';

const MAX_SITES = 120;
const MAX_ROUTES_PER_SITE = 18;
const MAX_TIPS_PER_SITE = 12;
const MAX_SELECTORS_PER_SITE = 12;
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);
const SENSITIVE_SELECTOR_RX =
  /(?:password|passwd|passcode|pwd|one-time|otp|2fa|totp|cvv|cvc|secret|pin|token|sms|verify|captcha|code|auth|密码|口令|验证码|动态码|安全码|密钥|支付)/i;

function isSafeDictKey(k) {
  return typeof k === 'string' && k.length > 0 && !FORBIDDEN_PROTO_KEYS.has(k);
}

function toNullProtoDict(src) {
  const out = Object.create(null);
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      if (isSafeDictKey(k)) out[k] = v;
    }
  }
  return out;
}

// Strip tracking noise AND sensitive auth/session query parameters before persisting locally
const STRIP_QUERY_PATTERNS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^spm$/i,
  /^from$/i,
  /^ref$/i,
  /^_t$/i,
  /^t$/i,
  /^ts$/i,
  /^timestamp$/i,
  /^nonce$/i,
  AUDIT_SENSITIVE_PARAM_RX
];

// Skip ephemeral feed items, search query result pages, and one-off post URLs during auto-learn
const SKIP_AUTO_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  '::1',
  'www.google.com',
  'google.com',
  'www.bing.com',
  'bing.com',
  'www.baidu.com',
  'baidu.com',
  'duckduckgo.com'
]);

const SKIP_AUTO_PATH_PATTERNS = [
  /^\/$/i,
  /^\/(?:zh(?:-cn|-tw|-hk)?|en(?:-us|-gb)?|ja|ko|de|fr|es)(?:\/index\.html?)?\/?$/i,
  /^\/raw\//i,
  /^\/search(?:\/|$)/i,
  /^\/s(?:\/|$)/i,
  /\/status\/\d+/i,
  /\/t\/[^/]+\/\d+/i,
  /\/video\/[a-z0-9]+/i,
  /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i
];

let memoryCache = null;
let memoryMtimeMs = -1;
let memoryFilePath = '';

export function getPlaybookFilePath(stateDirOverride = '') {
  const baseDir = stateDirOverride ? path.resolve(stateDirOverride) : getStateDir();
  return path.join(baseDir, 'site-playbooks.json');
}

function defaultStore() {
  // Strictly opt-in by default (`enabled: false`) for privacy & audit transparency
  return {
    version: 1,
    enabled: false,
    updatedAt: 0,
    sites: Object.create(null)
  };
}

function loadStore(stateDirOverride = '') {
  const filePath = getPlaybookFilePath(stateDirOverride);
  if (memoryFilePath !== filePath) {
    memoryCache = null;
    memoryMtimeMs = -1;
    memoryFilePath = filePath;
  }
  try {
    const st = fs.statSync(filePath);
    if (memoryCache && st.mtimeMs === memoryMtimeMs) {
      return memoryCache;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const cleanSites = Object.create(null);
      if (parsed.sites && typeof parsed.sites === 'object' && !Array.isArray(parsed.sites)) {
        for (const [dom, entry] of Object.entries(parsed.sites)) {
          if (!isSafeDictKey(dom) || !entry || typeof entry !== 'object') continue;
          cleanSites[dom] = {
            routes: toNullProtoDict(entry.routes),
            selectors: toNullProtoDict(entry.selectors),
            tips: Array.isArray(entry.tips) ? entry.tips.filter((t) => typeof t === 'string') : [],
            updatedAt: Number(entry.updatedAt) || 0
          };
        }
      }
      memoryCache = {
        version: 1,
        enabled: Boolean(parsed.enabled),
        updatedAt: Number(parsed.updatedAt) || 0,
        sites: cleanSites
      };
      memoryMtimeMs = st.mtimeMs;
      return memoryCache;
    }
  } catch {
    // File does not exist on disk: reset to clean default store
    memoryCache = defaultStore();
    memoryMtimeMs = 0;
    return memoryCache;
  }

  if (!memoryCache) {
    memoryCache = defaultStore();
    memoryMtimeMs = 0;
  }
  return memoryCache;
}

function persistStore(store, stateDirOverride = '') {
  const dir = ensureSecureDirSync(stateDirOverride ? path.resolve(stateDirOverride) : getStateDir());
  const filePath = getPlaybookFilePath(stateDirOverride);
  store.updatedAt = Date.now();
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    memoryMtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    memoryMtimeMs = Date.now();
  }
  memoryCache = store;
}

export function normalizeDomain(urlOrDomain) {
  if (!urlOrDomain || typeof urlOrDomain !== 'string') return '';
  const raw = urlOrDomain.trim();
  if (!raw) return '';
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return isSafeDictKey(host) ? host : '';
  } catch {
    return '';
  }
}

export function sanitizeRouteUrl(rawUrl, customBlockedDomains = []) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const safety = evaluateUrlSafety(rawUrl, customBlockedDomains);
  if (!safety.allowed) return null;

  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  u.username = '';
  u.password = '';
  if (u.hash) {
    // Only retain pure SPA route paths like #/orders/list; strip all opaque anchors/tokens/params (e.g. #9f8e7d...)
    const pureSpaRoute =
      /^#\/[A-Za-z0-9/_-]{1,64}$/.test(u.hash) &&
      !/^#\/?(?:eyJ|[0-9a-f]{24,})/i.test(u.hash) &&
      !AUDIT_SENSITIVE_PARAM_RX.test(u.hash);
    if (!pureSpaRoute) {
      u.hash = '';
    }
  }

  for (const key of Array.from(u.searchParams.keys())) {
    if (STRIP_QUERY_PATTERNS.some((rx) => rx.test(key)) || AUDIT_SENSITIVE_PARAM_RX.test(key)) {
      u.searchParams.delete(key);
    }
  }
  if (u.pathname && u.pathname.length >= 32) {
    const parts = u.pathname.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (isHighEntropyPathToken(parts[i])) {
        parts[i] = 'REDACTED';
      }
    }
    u.pathname = parts.join('/');
  }
  return u.toString();
}

function shouldAutoLearnUrl(cleanUrl) {
  try {
    const u = new URL(cleanUrl);
    const host = u.hostname.toLowerCase();
    if (SKIP_AUTO_HOSTS.has(host)) return false;
    // Never auto-learn one-time auth/magic-link paths containing redacted path tokens or oversized draft queries
    if (u.pathname.includes('/REDACTED') || u.search.length > 120) return false;
    for (const seg of u.pathname.split('/')) {
      if (isHighEntropyPathToken(seg)) return false;
    }
    for (const rx of SKIP_AUTO_PATH_PATTERNS) {
      if (rx.test(u.pathname)) return false;
    }
    // Skip paths containing long numeric IDs (likely individual order/article detail pages)
    if (/\/\d{6,}(?:\/|$)/.test(u.pathname)) return false;
    return u.pathname.length > 1;
  } catch {
    return false;
  }
}

function ensureSiteBucket(store, domain) {
  if (!Object.hasOwn(store.sites, domain)) {
    const keys = Object.keys(store.sites);
    if (keys.length >= MAX_SITES) {
      // Evict oldest site entry
      let oldestKey = keys[0];
      let oldestTs = Infinity;
      for (const k of keys) {
        const ts = store.sites[k]?.updatedAt || 0;
        if (ts < oldestTs) {
          oldestTs = ts;
          oldestKey = k;
        }
      }
      if (oldestKey) delete store.sites[oldestKey];
    }
    store.sites[domain] = {
      routes: Object.create(null),
      selectors: Object.create(null),
      tips: [],
      updatedAt: Date.now()
    };
  }
  return store.sites[domain];
}

export function getPlaybookSummary(stateDirOverride = '') {
  const store = loadStore(stateDirOverride);
  const domains = Object.keys(store.sites);
  return {
    enabled: store.enabled,
    siteCount: domains.length,
    domains,
    updatedAt: store.updatedAt
  };
}

export function setPlaybookEnabled(enabled, stateDirOverride = '') {
  const store = loadStore(stateDirOverride);
  store.enabled = Boolean(enabled);
  persistStore(store, stateDirOverride);
  return getPlaybookSummary(stateDirOverride);
}

export function lookupDomainPlaybook(urlOrDomain, customBlockedDomains = [], stateDirOverride = '') {
  const store = loadStore(stateDirOverride);
  if (!store.enabled) return null;
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) return null;
  if (!evaluateUrlSafety(`https://${domain}/`, customBlockedDomains).allowed) return null;
  if (!Object.hasOwn(store.sites, domain)) return null;

  const entry = store.sites[domain];
  if (!entry) return null;
  const routeCount = Object.keys(entry.routes || {}).length;
  const selCount = Object.keys(entry.selectors || {}).length;
  const tipCount = Array.isArray(entry.tips) ? entry.tips.length : 0;
  if (routeCount === 0 && selCount === 0 && tipCount === 0) return null;

  return {
    domain,
    routes: entry.routes || {},
    selectors: entry.selectors || {},
    tips: entry.tips || []
  };
}

export function learnFromPageVisit({ url, title, elements = [], customBlockedDomains = [], stateDir = '' } = {}) {
  const store = loadStore(stateDir);
  if (!store.enabled) return false;

  const cleanUrl = sanitizeRouteUrl(url, customBlockedDomains);
  if (!cleanUrl || !shouldAutoLearnUrl(cleanUrl, url)) return false;

  const domain = normalizeDomain(cleanUrl);
  if (!domain) return false;

  const rawTitle = String(title || '').replace(/\s+/g, ' ').trim();
  // Skip bare URL fallback titles (e.g. untitled OAuth callbacks where document.title === location.href)
  if (/^https?:\/\//i.test(rawTitle)) return false;
  const cleanTitle = redactUrlsInText(rawTitle).slice(0, 64);
  if (!isSafeDictKey(cleanTitle) || cleanTitle.includes('REDACTED')) return false;

  const bucket = ensureSiteBucket(store, domain);
  let changed = false;

  const routeKeys = Object.keys(bucket.routes);
  if (bucket.routes[cleanTitle] !== cleanUrl) {
    if (routeKeys.length >= MAX_ROUTES_PER_SITE && !Object.hasOwn(bucket.routes, cleanTitle)) {
      delete bucket.routes[routeKeys[0]];
    }
    bucket.routes[cleanTitle] = cleanUrl;
    changed = true;
  }

  // Persist stable ID/name selectors if provided by snapshot (skip sensitive credential fields)
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (el && el.stableSelector && el.label && Object.keys(bucket.selectors).length < MAX_SELECTORS_PER_SITE) {
        const key = String(el.label).slice(0, 40);
        if (!isSafeDictKey(key) || SENSITIVE_SELECTOR_RX.test(key) || SENSITIVE_SELECTOR_RX.test(String(el.stableSelector))) {
          continue;
        }
        if (bucket.selectors[key] !== el.stableSelector) {
          bucket.selectors[key] = el.stableSelector;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    bucket.updatedAt = Date.now();
    persistStore(store, stateDir);
  }
  return changed;
}

export function learnInteractionSelector({ url, label, selector, customBlockedDomains = [], stateDir = '' } = {}) {
  const store = loadStore(stateDir);
  if (!store.enabled) return false;
  if (!url || !label || !selector) return false;
  if (!evaluateUrlSafety(url, customBlockedDomains).allowed) return false;

  const domain = normalizeDomain(url);
  if (!domain || SKIP_AUTO_HOSTS.has(domain)) return false;

  const cleanKey = redactUrlsInText(String(label)).replace(/\s+/g, ' ').trim().slice(0, 42);
  const cleanCss = String(selector).trim().slice(0, 140);
  if (!isSafeDictKey(cleanKey) || !cleanCss || cleanKey.includes('REDACTED')) return false;
  if (SENSITIVE_SELECTOR_RX.test(`${cleanKey} ${cleanCss}`)) {
    return false;
  }

  const bucket = ensureSiteBucket(store, domain);
  if (bucket.selectors[cleanKey] === cleanCss) return false;

  const keys = Object.keys(bucket.selectors);
  if (keys.length >= MAX_SELECTORS_PER_SITE && !Object.hasOwn(bucket.selectors, cleanKey)) {
    delete bucket.selectors[keys[0]];
  }
  bucket.selectors[cleanKey] = cleanCss;
  bucket.updatedAt = Date.now();
  persistStore(store, stateDir);
  return true;
}

export function saveManualPlaybook({ domain: rawDomain, route, tip, tipIndex, selector, customBlockedDomains = [], stateDir = '' } = {}) {
  const store = loadStore(stateDir);
  if (!store.enabled) {
    throw new Error('Site Playbooks are disabled; enable them before saving entries');
  }
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new Error('Invalid domain for playbook entry');
  }
  const safety = evaluateUrlSafety(`https://${domain}/`, customBlockedDomains);
  if (!safety.allowed) {
    throw new Error(`Cannot store playbook for protected domain: ${domain}`);
  }

  const bucket = ensureSiteBucket(store, domain);

  if (route && typeof route === 'object' && route.name && route.url) {
    let candidateUrl = String(route.url).trim();
    if (candidateUrl.startsWith('/')) {
      candidateUrl = `https://${domain}${candidateUrl}`;
    } else if (!/^https?:\/\//i.test(candidateUrl)) {
      candidateUrl = `https://${candidateUrl}`;
    }
    const cleanUrl = sanitizeRouteUrl(candidateUrl, customBlockedDomains);
    if (!cleanUrl) throw new Error('Route URL is invalid or blocked by guardrails');
    const routeHost = normalizeDomain(cleanUrl);
    if (!routeHost || (routeHost !== domain && !routeHost.endsWith(`.${domain}`))) {
      throw new Error(`Route URL host "${routeHost}" does not match playbook domain "${domain}"`);
    }
    const name = String(route.name).trim().slice(0, 64);
    if (!isSafeDictKey(name)) throw new Error('Invalid route shortcut name');
    if (route.oldName && route.oldName !== name && Object.hasOwn(bucket.routes, route.oldName)) {
      delete bucket.routes[route.oldName];
    }
    const keys = Object.keys(bucket.routes);
    if (keys.length >= MAX_ROUTES_PER_SITE && !Object.hasOwn(bucket.routes, name)) {
      delete bucket.routes[keys[0]];
    }
    bucket.routes[name] = cleanUrl;
  }

  if (selector && typeof selector === 'object' && selector.name && selector.css) {
    const name = String(selector.name).trim().slice(0, 48);
    const css = String(selector.css).trim().slice(0, 140);
    if (!isSafeDictKey(name)) throw new Error('Invalid selector alias');
    if (SENSITIVE_SELECTOR_RX.test(name) || SENSITIVE_SELECTOR_RX.test(css)) {
      throw new Error('Refusing to store sensitive password/OTP/token selector in playbook');
    }
    if (selector.oldName && selector.oldName !== name && Object.hasOwn(bucket.selectors, selector.oldName)) {
      delete bucket.selectors[selector.oldName];
    }
    const keys = Object.keys(bucket.selectors);
    if (keys.length >= MAX_SELECTORS_PER_SITE && !Object.hasOwn(bucket.selectors, name)) {
      delete bucket.selectors[keys[0]];
    }
    bucket.selectors[name] = css;
  }

  if (typeof tip === 'string' && tip.trim()) {
    const cleanTip = tip.trim().slice(0, 200);
    if (typeof tipIndex === 'number' && tipIndex >= 0 && tipIndex < bucket.tips.length) {
      bucket.tips[tipIndex] = cleanTip;
    } else if (!bucket.tips.includes(cleanTip)) {
      if (bucket.tips.length >= MAX_TIPS_PER_SITE) bucket.tips.shift();
      bucket.tips.push(cleanTip);
    }
  }

  bucket.updatedAt = Date.now();
  persistStore(store, stateDir);
  return {
    enabled: store.enabled,
    domain,
    entry: bucket
  };
}

export function deletePlaybookItem({ domain: rawDomain, kind, key, index, stateDir = '' } = {}) {
  const store = loadStore(stateDir);
  const domain = normalizeDomain(rawDomain);
  if (!domain || !Object.hasOwn(store.sites, domain)) {
    return getPlaybookSummary(stateDir);
  }
  const bucket = store.sites[domain];
  if (kind === 'route' && typeof key === 'string' && Object.hasOwn(bucket.routes, key)) {
    delete bucket.routes[key];
  } else if (kind === 'selector' && typeof key === 'string' && Object.hasOwn(bucket.selectors, key)) {
    delete bucket.selectors[key];
  } else if (kind === 'tip') {
    if (typeof index === 'number' && index >= 0 && index < bucket.tips.length) {
      bucket.tips.splice(index, 1);
    } else if (typeof key === 'string') {
      bucket.tips = bucket.tips.filter((t) => t !== key);
    }
  }

  const remaining =
    Object.keys(bucket.routes || {}).length +
    Object.keys(bucket.selectors || {}).length +
    (bucket.tips?.length || 0);
  if (remaining === 0) {
    delete store.sites[domain];
  } else {
    bucket.updatedAt = Date.now();
  }
  persistStore(store, stateDir);
  return {
    ...getPlaybookSummary(stateDir),
    domain,
    entry: Object.hasOwn(store.sites, domain) ? store.sites[domain] : null
  };
}

export function listPlaybooks(rawDomain = '', stateDir = '') {
  const store = loadStore(stateDir);
  if (rawDomain) {
    const d = normalizeDomain(rawDomain);
    return {
      enabled: store.enabled,
      domain: d,
      entry: d && Object.hasOwn(store.sites, d) ? store.sites[d] : null
    };
  }
  return {
    enabled: store.enabled,
    sites: store.sites
  };
}

export function clearPlaybooks(rawDomain = '', stateDir = '') {
  const store = loadStore(stateDir);
  if (rawDomain) {
    const d = normalizeDomain(rawDomain);
    if (d && Object.hasOwn(store.sites, d)) delete store.sites[d];
  } else {
    store.sites = Object.create(null);
  }
  persistStore(store, stateDir);
  return getPlaybookSummary(stateDir);
}
