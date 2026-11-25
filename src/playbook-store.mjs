import fs from 'node:fs';
import path from 'node:path';
import { evaluateUrlSafety } from './guardrails.mjs';
import { getStateDir } from './token-store.mjs';

const MAX_SITES = 120;
const MAX_ROUTES_PER_SITE = 18;
const MAX_TIPS_PER_SITE = 12;
const MAX_SELECTORS_PER_SITE = 12;

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
  /^token$/i,
  /^access_token$/i,
  /^id_token$/i,
  /^refresh_token$/i,
  /^auth/i,
  /^code$/i,
  /^state$/i,
  /^sig$/i,
  /^signature$/i,
  /^key$/i,
  /^api_key$/i,
  /^secret$/i,
  /^password$/i,
  /^session/i
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

export function getPlaybookFilePath() {
  return path.join(getStateDir(), 'site-playbooks.json');
}

function defaultStore() {
  // Strictly opt-in by default (`enabled: false`) for privacy & audit transparency
  return {
    version: 1,
    enabled: false,
    updatedAt: 0,
    sites: {}
  };
}

function loadStore() {
  const filePath = getPlaybookFilePath();
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
      memoryCache = {
        version: 1,
        enabled: Boolean(parsed.enabled),
        updatedAt: Number(parsed.updatedAt) || 0,
        sites: parsed.sites && typeof parsed.sites === 'object' ? parsed.sites : {}
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

function persistStore(store) {
  const dir = getStateDir();
  const filePath = getPlaybookFilePath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function sanitizeRouteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const safety = evaluateUrlSafety(rawUrl);
  if (!safety.allowed) return null;

  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  u.username = '';
  u.password = '';
  if (u.hash && (u.hash.length > 64 || /(?:token|code|auth|session|utm_)=/i.test(u.hash))) {
    u.hash = '';
  }

  for (const key of Array.from(u.searchParams.keys())) {
    if (STRIP_QUERY_PATTERNS.some((rx) => rx.test(key))) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

function shouldAutoLearnUrl(cleanUrl) {
  try {
    const u = new URL(cleanUrl);
    const host = u.hostname.toLowerCase();
    if (SKIP_AUTO_HOSTS.has(host)) return false;
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
  if (!store.sites[domain]) {
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
      routes: {},
      selectors: {},
      tips: [],
      updatedAt: Date.now()
    };
  }
  return store.sites[domain];
}

export function getPlaybookSummary() {
  const store = loadStore();
  const domains = Object.keys(store.sites);
  return {
    enabled: store.enabled,
    siteCount: domains.length,
    domains,
    updatedAt: store.updatedAt
  };
}

export function setPlaybookEnabled(enabled) {
  const store = loadStore();
  store.enabled = Boolean(enabled);
  persistStore(store);
  return getPlaybookSummary();
}

export function lookupDomainPlaybook(urlOrDomain) {
  const store = loadStore();
  if (!store.enabled) return null;
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) return null;

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

export function learnFromPageVisit({ url, title, elements = [] } = {}) {
  const store = loadStore();
  if (!store.enabled) return false;

  const cleanUrl = sanitizeRouteUrl(url);
  if (!cleanUrl || !shouldAutoLearnUrl(cleanUrl)) return false;

  const domain = normalizeDomain(cleanUrl);
  if (!domain) return false;

  const cleanTitle = String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  if (!cleanTitle) return false;

  const bucket = ensureSiteBucket(store, domain);
  let changed = false;

  const routeKeys = Object.keys(bucket.routes);
  if (bucket.routes[cleanTitle] !== cleanUrl) {
    if (routeKeys.length >= MAX_ROUTES_PER_SITE && !(cleanTitle in bucket.routes)) {
      delete bucket.routes[routeKeys[0]];
    }
    bucket.routes[cleanTitle] = cleanUrl;
    changed = true;
  }

  // Persist stable ID/name selectors if provided by snapshot
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (el && el.stableSelector && el.label && Object.keys(bucket.selectors).length < MAX_SELECTORS_PER_SITE) {
        const key = String(el.label).slice(0, 40);
        if (bucket.selectors[key] !== el.stableSelector) {
          bucket.selectors[key] = el.stableSelector;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    bucket.updatedAt = Date.now();
    persistStore(store);
  }
  return changed;
}

export function learnInteractionSelector({ url, label, selector } = {}) {
  const store = loadStore();
  if (!store.enabled) return false;
  if (!url || !label || !selector) return false;
  if (!evaluateUrlSafety(url).allowed) return false;

  const domain = normalizeDomain(url);
  if (!domain || SKIP_AUTO_HOSTS.has(domain)) return false;

  const cleanKey = String(label).replace(/\s+/g, ' ').trim().slice(0, 42);
  const cleanCss = String(selector).trim().slice(0, 140);
  if (!cleanKey || !cleanCss) return false;

  const bucket = ensureSiteBucket(store, domain);
  if (bucket.selectors[cleanKey] === cleanCss) return false;

  const keys = Object.keys(bucket.selectors);
  if (keys.length >= MAX_SELECTORS_PER_SITE && !(cleanKey in bucket.selectors)) {
    delete bucket.selectors[keys[0]];
  }
  bucket.selectors[cleanKey] = cleanCss;
  bucket.updatedAt = Date.now();
  persistStore(store);
  return true;
}

export function saveManualPlaybook({ domain: rawDomain, route, tip, tipIndex, selector } = {}) {
  const store = loadStore();
  if (!store.enabled) {
    throw new Error('Site Playbooks are disabled; enable them before saving entries');
  }
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new Error('Invalid domain for playbook entry');
  }
  const safety = evaluateUrlSafety(`https://${domain}/`);
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
    const cleanUrl = sanitizeRouteUrl(candidateUrl);
    if (!cleanUrl) throw new Error('Route URL is invalid or blocked by guardrails');
    const name = String(route.name).trim().slice(0, 64);
    if (route.oldName && route.oldName !== name && route.oldName in bucket.routes) {
      delete bucket.routes[route.oldName];
    }
    const keys = Object.keys(bucket.routes);
    if (keys.length >= MAX_ROUTES_PER_SITE && !(name in bucket.routes)) {
      delete bucket.routes[keys[0]];
    }
    bucket.routes[name] = cleanUrl;
  }

  if (selector && typeof selector === 'object' && selector.name && selector.css) {
    const name = String(selector.name).trim().slice(0, 48);
    const css = String(selector.css).trim().slice(0, 140);
    if (selector.oldName && selector.oldName !== name && selector.oldName in bucket.selectors) {
      delete bucket.selectors[selector.oldName];
    }
    const keys = Object.keys(bucket.selectors);
    if (keys.length >= MAX_SELECTORS_PER_SITE && !(name in bucket.selectors)) {
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
  persistStore(store);
  return {
    enabled: store.enabled,
    domain,
    entry: bucket
  };
}

export function deletePlaybookItem({ domain: rawDomain, kind, key, index } = {}) {
  const store = loadStore();
  const domain = normalizeDomain(rawDomain);
  if (!domain || !store.sites[domain]) {
    return getPlaybookSummary();
  }
  const bucket = store.sites[domain];
  if (kind === 'route' && typeof key === 'string') {
    delete bucket.routes[key];
  } else if (kind === 'selector' && typeof key === 'string') {
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
  persistStore(store);
  return {
    ...getPlaybookSummary(),
    domain,
    entry: store.sites[domain] || null
  };
}

export function listPlaybooks(rawDomain = '') {
  const store = loadStore();
  if (rawDomain) {
    const d = normalizeDomain(rawDomain);
    return {
      enabled: store.enabled,
      domain: d,
      entry: store.sites[d] || null
    };
  }
  return {
    enabled: store.enabled,
    sites: store.sites
  };
}

export function clearPlaybooks(rawDomain = '') {
  const store = loadStore();
  if (rawDomain) {
    const d = normalizeDomain(rawDomain);
    delete store.sites[d];
  } else {
    store.sites = {};
  }
  persistStore(store);
  return getPlaybookSummary();
}
