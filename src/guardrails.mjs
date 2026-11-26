import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT, getStateDir } from './token-store.mjs';

export function expandLeadingTilde(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

const BLOCKED_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'edge:',
  'brave:',
  'vivaldi:',
  'view-source:',
  'file:',
  'javascript:',
  'data:'
]);

const BLOCKED_PORTS = new Set(['9222', '9229', '28196']);

export const DEFAULT_BLOCKED_DOMAINS = Object.freeze([
  // Global payment & checkout gateways
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
  // Regional payment & clearing networks
  'alipay.com',
  'pay.weixin.qq.com',
  'tenpay.com',
  '95516.com',
  // Retail & commercial banking portals
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
  // Cloud billing & root credential consoles
  'console.aws.amazon.com',
  'console.cloud.google.com',
  'portal.azure.com',
  'dash.cloudflare.com'
]);

const CHECKOUT_SEGMENT_RX =
  /(?:^|\/)(?:checkout|pay|payment|payments|cashier|billing|wallet\/transfer)(?:\/|\?|$|#|;|\.[a-z0-9]{1,8}(?:\/|\?|$|#|;))/i;

const CHECKOUT_SUBDOMAIN_RX = /(?:^|\.)(?:checkout|pay|payment|payments|cashier|billing)\./i;

export const AUDIT_SENSITIVE_PARAM_RX =
  /(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))/i;

const HASH_SENSITIVE_PAIR_RX =
  /([#?&])([^=&#]*(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential|hmac|(?:^|[-_.])(?:key|pass|pin|hash)(?:$|[-_.]))[^=&#]*)=([^&#]*)/gi;

export function isHighEntropyPathToken(rawSegment, options = {}) {
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

function redactMatrixParamsInSegment(seg) {
  if (!seg || !seg.includes(';')) return seg;
  const pieces = seg.split(';');
  const head = isHighEntropyPathToken(pieces[0], { splitMatrix: true }) ? 'REDACTED' : pieces[0];
  let changed = head !== pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    const eqIdx = pieces[i].indexOf('=');
    if (eqIdx === -1) continue;
    const mk = pieces[i].slice(0, eqIdx);
    const mv = pieces[i].slice(eqIdx + 1);
    if (AUDIT_SENSITIVE_PARAM_RX.test(mk) || isHighEntropyPathToken(mv, { splitMatrix: false })) {
      pieces[i] = `${mk}=REDACTED`;
      changed = true;
    }
  }
  pieces[0] = head;
  return changed ? pieces.join(';') : seg;
}

function scrubNestedParamValue(rawV, depth = 0) {
  if (!rawV || depth > 3) return { value: rawV, changed: false };
  if (isHighEntropyPathToken(rawV, { splitMatrix: false })) {
    return { value: 'REDACTED', changed: true };
  }
  let decV = rawV;
  let wasEncoded = false;
  if (rawV.includes('%')) {
    try {
      decV = decodeURIComponent(rawV);
      wasEncoded = decV !== rawV;
    } catch {
      return { value: rawV, changed: false };
    }
  }
  if (/^https?:\/\//i.test(decV.trim())) {
    const redUrl = redactUrlForAudit(decV.trim(), depth + 1);
    if (redUrl !== decV.trim()) {
      return { value: wasEncoded ? encodeURIComponent(redUrl) : redUrl, changed: true };
    }
  } else if (/https?:\/\//i.test(decV)) {
    const redTxt = redactUrlsInText(decV);
    if (redTxt !== decV) {
      return { value: wasEncoded ? encodeURIComponent(redTxt) : redTxt, changed: true };
    }
  } else if (decV.includes('=') || decV.includes('&') || decV.includes('#')) {
    const subScrub = scrubQueryStringTokens(`?${decV}`, depth + 1);
    if (subScrub.changed) {
      const inner = subScrub.text.slice(1);
      return { value: wasEncoded ? encodeURIComponent(inner) : inner, changed: true };
    }
  }
  return { value: rawV, changed: false };
}

function scrubQueryStringTokens(rawQueryWithQuestionMark, depth = 0) {
  if (!rawQueryWithQuestionMark || !rawQueryWithQuestionMark.startsWith('?') || depth > 3) {
    return { text: rawQueryWithQuestionMark || '', changed: false };
  }
  const rawBody = rawQueryWithQuestionMark.slice(1);
  if (!rawBody) return { text: rawQueryWithQuestionMark, changed: false };
  let changed = false;
  // Split by `&`, `#`, or `?` while preserving original delimiters (handles `#tab=1#%74oken=sec` and `#tab=1#r=eyJ...`)
  const tokens = rawBody.split(/([&#?])/);
  for (let i = 0; i < tokens.length; i += 2) {
    const pair = tokens[i];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      if (isHighEntropyPathToken(pair, { splitMatrix: false })) {
        tokens[i] = 'REDACTED';
        changed = true;
      }
      continue;
    }
    const rawK = pair.slice(0, eq);
    const rawV = pair.slice(eq + 1);
    let decK = rawK;
    try {
      decK = decodeURIComponent(rawK.replace(/\+/g, ' '));
    } catch {}
    if (AUDIT_SENSITIVE_PARAM_RX.test(decK)) {
      tokens[i] = `${rawK}=REDACTED`;
      changed = true;
      continue;
    }
    const nested = scrubNestedParamValue(rawV, depth);
    if (nested.changed) {
      tokens[i] = `${rawK}=${nested.value}`;
      changed = true;
    }
  }
  return { text: changed ? `?${tokens.join('')}` : rawQueryWithQuestionMark, changed };
}

function decodeNestedPercentOnce(str) {
  let changed = false;
  const out = str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      const dec = decodeURIComponent(seq);
      if (dec !== seq) changed = true;
      return dec;
    } catch {
      // Literal `%25` followed by orphan high-bit hex (e.g. `100%25accurate` -> `%ac`, or mixed `%25ac%2563heckout` -> `%ac%63`):
      // preserve invalid multi-byte sequences as literal `%XX` while still decoding valid single-byte ASCII `%00..%7F`!
      const partial = seq.replace(/%[0-7][0-9A-Fa-f]/g, (asciiHex) => decodeURIComponent(asciiHex));
      if (partial !== seq) changed = true;
      return partial;
    }
  });
  return { out, changed };
}

function canonicalizePathForGuardrail(rawSegment, splitRawQuery = false) {
  if (!rawSegment) return { ok: true, rawPath: '/', path: '/' };
  const inputStr = String(rawSegment);
  // Split unencoded `?` BEFORE percent-decoding so `%3f` inside a path (`/#/a%3f/../wallet/transfer` or `/v1%3f/wallet;x=1/transfer`)
  // can never truncate matrix-parameter stripping or dot-segment collapsing!
  const rawQIdx = splitRawQuery ? inputStr.indexOf('?') : -1;
  let decodedPath = rawQIdx === -1 ? inputStr : inputStr.slice(0, rawQIdx);
  const queryPart = rawQIdx === -1 ? '' : inputStr.slice(rawQIdx);

  if (decodedPath.includes('%')) {
    if (/%(?![0-9A-Fa-f]{2})/.test(decodedPath)) {
      return { ok: false, rawPath: '', path: '' };
    }
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      return { ok: false, rawPath: '', path: '' };
    }
    for (let round = 1; round < 6; round++) {
      if (!/%[0-9A-Fa-f]{2}/.test(decodedPath)) break;
      const step = decodeNestedPercentOnce(decodedPath);
      if (!step.changed) break;
      decodedPath = step.out;
    }
    // Fail-closed if 7+ layers of nested percent-encoding still decode further
    if (/%[0-9A-Fa-f]{2}/.test(decodedPath) && decodeNestedPercentOnce(decodedPath).changed) {
      return { ok: false, rawPath: '', path: '' };
    }
  }
  const normalizedSlashes = decodedPath.replace(/\\/g, '/');
  const rawPieces = [];
  const stack = [];
  for (const rawPiece of normalizedSlashes.split('/')) {
    const cleanPiece = rawPiece.split(';')[0];
    if (!cleanPiece || cleanPiece === '.') continue;
    rawPieces.push(cleanPiece);
    if (cleanPiece === '..') {
      stack.pop();
      continue;
    }
    stack.push(cleanPiece);
  }
  return {
    ok: true,
    rawPath: `/${rawPieces.join('/')}${queryPart}`,
    path: `/${stack.join('/')}${queryPart}`
  };
}

export function redactUrlForAudit(rawUrl, depth = 0) {
  if (!rawUrl || typeof rawUrl !== 'string' || depth > 3) return rawUrl;
  try {
    const parsed = new URL(rawUrl.trim());
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      mutated = true;
    }
    if (parsed.pathname) {
      const parts = parsed.pathname.split('/');
      let pathChanged = false;
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        if (parts[i].includes(';')) {
          const scrubbedSeg = redactMatrixParamsInSegment(parts[i]);
          if (scrubbedSeg !== parts[i]) {
            parts[i] = scrubbedSeg;
            pathChanged = true;
          }
        } else if (isHighEntropyPathToken(parts[i], { splitMatrix: true })) {
          parts[i] = 'REDACTED';
          pathChanged = true;
        }
      }
      if (pathChanged) {
        parsed.pathname = parts.join('/');
        mutated = true;
      }
    }
    if (parsed.search) {
      for (const [k, v] of Array.from(parsed.searchParams.entries())) {
        if (AUDIT_SENSITIVE_PARAM_RX.test(k) || isHighEntropyPathToken(v, { splitMatrix: false })) {
          parsed.searchParams.set(k, 'REDACTED');
          mutated = true;
        } else if (/^https?:\/\//i.test(v.trim())) {
          const redNested = redactUrlForAudit(v.trim(), depth + 1);
          if (redNested !== v.trim()) {
            parsed.searchParams.set(k, redNested);
            mutated = true;
          }
        } else if (/https?:\/\//i.test(v)) {
          const redTxt = redactUrlsInText(v);
          if (redTxt !== v) {
            parsed.searchParams.set(k, redTxt);
            mutated = true;
          }
        } else if (v.includes('=') || v.includes('&') || v.includes('#')) {
          const subScrub = scrubQueryStringTokens(`?${v}`, depth + 1);
          if (subScrub.changed) {
            parsed.searchParams.set(k, subScrub.text.slice(1));
            mutated = true;
          }
        }
      }
    }
    if (parsed.hash) {
      const prefixMatch = parsed.hash.match(/^(#!?)/);
      const hashPrefix = prefixMatch ? prefixMatch[1] : '#';
      const rawHashBody = parsed.hash.slice(hashPrefix.length);
      let cleanedHash = parsed.hash;

      if (
        rawHashBody &&
        !rawHashBody.includes('/') &&
        !rawHashBody.includes('?') &&
        !rawHashBody.includes('&') &&
        !rawHashBody.includes('=') &&
        !rawHashBody.includes('#') &&
        (isHighEntropyPathToken(rawHashBody, { splitMatrix: false }) ||
          /^(?:eyJ[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{32,})$/.test(rawHashBody))
      ) {
        cleanedHash = `${hashPrefix}REDACTED`;
      } else if (
        !rawHashBody.startsWith('/') &&
        !rawHashBody.includes('?') &&
        (rawHashBody.includes('=') || rawHashBody.includes('&') || rawHashBody.includes('#'))
      ) {
        // OAuth2 / OIDC implicit fragment `#r=eyJ...&lang=zh`, `#tab=1#%74oken=secret`, or `#tab=1#r=eyJ...`
        const scrubbedFragPairs = scrubQueryStringTokens(`?${rawHashBody}`, depth);
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
            const scrubbedSegPairs = scrubQueryStringTokens(`?${seg}`, depth);
            if (scrubbedSegPairs.changed) {
              hParts[i] = scrubbedSegPairs.text.slice(1);
              hChanged = true;
              continue;
            }
          }
          if (seg.includes(';')) {
            const nextSeg = redactMatrixParamsInSegment(seg);
            if (nextSeg !== seg) {
              hParts[i] = nextSeg;
              hChanged = true;
            }
          } else if (isHighEntropyPathToken(seg, { splitMatrix: true })) {
            hParts[i] = 'REDACTED';
            hChanged = true;
          }
        }
        const scrubbedHQuery = scrubQueryStringTokens(hQuery, depth);
        if (hChanged || scrubbedHQuery.changed) {
          cleanedHash = `${hashPrefix}${hParts.join('/')}${scrubbedHQuery.text}`;
        }
      }

      cleanedHash = cleanedHash.replace(HASH_SENSITIVE_PAIR_RX, '$1$2=REDACTED');
      if (cleanedHash !== parsed.hash) {
        parsed.hash = cleanedHash;
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

export function redactUrlsInText(rawText) {
  if (typeof rawText !== 'string' || !/https?:\/\//i.test(rawText)) return rawText;
  return rawText.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (match) => {
    const punctMatch = match.match(/([.,;:!?]+)$/);
    const coreUrl = punctMatch ? match.slice(0, -punctMatch[1].length) : match;
    const suffix = punctMatch ? punctMatch[1] : '';
    return redactUrlForAudit(coreUrl) + suffix;
  });
}

export function evaluateUrlSafety(rawUrl, customBlockedDomains = []) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { allowed: false, code: 'INVALID_URL', reason: 'Empty or non-string URL' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed === 'about:blank') {
    return { allowed: true, code: 'OK', reason: '' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, code: 'MALFORMED_URL', reason: `Malformed URL: ${trimmed.slice(0, 80)}` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(protocol)) {
    return {
      allowed: false,
      code: 'BLOCKED_PROTOCOL',
      reason: `Protocol ${protocol} is restricted for local browser safety`
    };
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      allowed: false,
      code: 'UNSUPPORTED_PROTOCOL',
      reason: `Only http: and https: pages can be automated (got ${protocol})`
    };
  }

  const activePortStr = String(process.env.CHROME_LIVE_PORT || DEFAULT_PORT || 28196).trim();
  if (parsed.port && (BLOCKED_PORTS.has(parsed.port) || parsed.port === activePortStr)) {
    return {
      allowed: false,
      code: 'BLOCKED_PORT',
      reason: `Port ${parsed.port} is reserved for debugger or bridge endpoints`
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const mergedList = [...DEFAULT_BLOCKED_DOMAINS, ...customBlockedDomains];
  for (const rawRule of mergedList) {
    const rule = String(rawRule || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!rule) continue;
    if (host === rule || host.endsWith(`.${rule}`)) {
      return {
        allowed: false,
        code: 'SENSITIVE_DOMAIN',
        reason: `Domain "${host}" matches protected financial/security guardrail "${rule}"`
      };
    }
  }
  if (CHECKOUT_SUBDOMAIN_RX.test(host)) {
    return {
      allowed: false,
      code: 'SENSITIVE_DOMAIN',
      reason: `Subdomain "${host}" matches protected payment/cashier subdomain guardrail`
    };
  }

  const canonPath = canonicalizePathForGuardrail(parsed.pathname, false);
  if (!canonPath.ok) {
    return { allowed: false, code: 'MALFORMED_URL', reason: 'Malformed percent-encoding in URL pathname' };
  }
  const rawHashBody = parsed.hash ? parsed.hash.replace(/^#+!?/, '') : '';
  const canonHash = rawHashBody ? canonicalizePathForGuardrail(rawHashBody, true) : { ok: true, rawPath: '', path: '' };
  if (!canonHash.ok) {
    return { allowed: false, code: 'MALFORMED_URL', reason: 'Malformed percent-encoding in URL fragment' };
  }

  // Inspect BOTH uncollapsed and dot-collapsed routes so `/checkout/..;x=1`, `/cashier%2f..`, and `#!checkout` cannot bypass!
  if (
    CHECKOUT_SEGMENT_RX.test(canonPath.rawPath) ||
    CHECKOUT_SEGMENT_RX.test(canonPath.path) ||
    (canonHash.rawPath && CHECKOUT_SEGMENT_RX.test(canonHash.rawPath)) ||
    (canonHash.path && CHECKOUT_SEGMENT_RX.test(canonHash.path))
  ) {
    // Never echo raw parsed.hash into error messages to avoid leaking #access_token=... fragments
    return {
      allowed: false,
      code: 'PAYMENT_PATH',
      reason: 'URL route matches protected payment/checkout guardrail'
    };
  }

  return { allowed: true, code: 'OK', reason: '' };
}

const SENSITIVE_FILE_DIR_RX =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.azure|\.gcloud|\.docker|gcloud)(?:\/|$)/i;
const SENSITIVE_FILE_NAME_RX =
  /^(?:(?!.*\.pub$)id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-].+)|authorized_keys|known_hosts|auth\.token|site-playbooks\.json|daemon\.pid|spawn\.(?:lock|cooldown)|\.local-runtime\.json|agent_vault\.enc|accessTokens\.json|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|credentials(?:\.json)?|application_default_credentials\.json|Local\s+State|Cookies(?:-journal)?|cookies\.sqlite|key[34]\.db|cert9\.db|logins\.json|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore|gpg|age)|.*\.tfstate(?:\.backup)?)$/i;

function resolveCanonicalPath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    // If file does not exist yet or symlink is dangling, still canonicalize its parent directory
    try {
      const parentReal = fs.realpathSync(path.dirname(targetPath));
      return path.join(parentReal, path.basename(targetPath));
    } catch {
      return targetPath;
    }
  }
}

function isPathInsideDir(candidatePath, dirPath) {
  const normCandidate = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
  const normDir = process.platform === 'win32' ? dirPath.toLowerCase() : dirPath;
  const rel = path.relative(normDir, normCandidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function getDefaultUploadStagingDir(stateDirOverride = '') {
  const base = stateDirOverride ? path.resolve(String(stateDirOverride)) : getStateDir();
  return path.join(base, 'uploads');
}

function parseAllowedUploadDirs(explicitDirs, stateDirOverride = '') {
  let rawList;
  if (Array.isArray(explicitDirs)) {
    rawList = explicitDirs;
  } else if (typeof process.env.CHROME_LIVE_UPLOAD_DIR === 'string' && process.env.CHROME_LIVE_UPLOAD_DIR.trim()) {
    rawList = process.env.CHROME_LIVE_UPLOAD_DIR.split(path.delimiter);
  } else {
    rawList = [];
  }
  const dirs = [];
  for (const raw of rawList) {
    const trimmed = expandLeadingTilde(String(raw || ''));
    if (!trimmed) continue;
    const abs = path.resolve(trimmed);
    dirs.push(resolveCanonicalPath(abs));
  }
  // Strict Fail-Closed: if explicitDirs or CHROME_LIVE_UPLOAD_DIR resolves to zero valid directories
  // (e.g. ";" or empty array), always fall back to the isolated default staging directory.
  if (dirs.length === 0) {
    const defaultDir = getDefaultUploadStagingDir(stateDirOverride);
    try {
      fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    } catch {}
    dirs.push(resolveCanonicalPath(path.resolve(defaultDir)));
  }
  return dirs;
}

export function isNetworkUncPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const s = rawPath.trim();
  return /^\\\\|^\/\//.test(s);
}

export function evaluateUploadFileSafety(rawFilePath, options = {}) {
  if (!rawFilePath || typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    return { allowed: false, code: 'INVALID_FILE', reason: 'Empty file path' };
  }
  const rawTrimmed = rawFilePath.trim();
  // Block Windows UNC / WebDAV network paths (`\\server\share` or `//server/share`) BEFORE any `fs.*` syscall
  // to prevent NTLMv2 credential hash egress and synchronous SMB timeout DoS!
  if (isNetworkUncPath(rawTrimmed)) {
    return {
      allowed: false,
      code: 'UNC_PATH_BLOCKED',
      reason: 'Network UNC paths are blocked by local guardrails'
    };
  }
  // Reject NTFS Alternate Data Streams (`file.env::$DATA`), control chars, or trailing dots/spaces used to evade basename regexes
  const withoutDrive = rawTrimmed.replace(/^[A-Za-z]:/, '');
  if (withoutDrive.includes(':') || /[\x00-\x1f]/.test(rawTrimmed) || /[.\s]$/.test(rawTrimmed)) {
    return {
      allowed: false,
      code: 'INVALID_FILE',
      reason: 'File path contains restricted stream syntax, control characters, or trailing dots/spaces'
    };
  }

  const expandedPath = expandLeadingTilde(rawTrimmed);
  if (isNetworkUncPath(expandedPath)) {
    return {
      allowed: false,
      code: 'UNC_PATH_BLOCKED',
      reason: 'Network UNC paths are blocked by local guardrails'
    };
  }
  const resolvedPath = path.resolve(expandedPath);
  if (isNetworkUncPath(resolvedPath) || (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(resolvedPath))) {
    return {
      allowed: false,
      code: 'UNC_PATH_BLOCKED',
      reason: 'Upload path must reside on a local drive volume'
    };
  }
  const realPath = resolveCanonicalPath(resolvedPath);

  const effectiveStateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const allowedDirs = parseAllowedUploadDirs(options.allowedDirs, effectiveStateDir);
  // Check sensitive filename/directory patterns UNCONDITIONALLY (including `.aws/config`, `.ssh/config`, `.docker/config.json` inside `uploads/`!),
  // while blocking files inside `effectiveStateDir` outside its `uploads/` subdirectory.
  const defaultUploadsDir = resolveCanonicalPath(path.resolve(getDefaultUploadStagingDir(effectiveStateDir)));
  const activeStateDir = resolveCanonicalPath(effectiveStateDir);
  for (const candidate of realPath === resolvedPath ? [resolvedPath] : [resolvedPath, realPath]) {
    const normalized = candidate.replace(/\\/g, '/');
    const baseName = path.basename(candidate).replace(/[.\s]+$/, '');
    if (SENSITIVE_FILE_NAME_RX.test(baseName)) {
      return {
        allowed: false,
        code: 'SENSITIVE_FILE',
        reason: `Uploading sensitive credential or key file "${baseName}" is blocked by local guardrails`
      };
    }
    if (SENSITIVE_FILE_DIR_RX.test(normalized)) {
      return {
        allowed: false,
        code: 'SENSITIVE_FILE',
        reason: `Uploading files from protected credential directory is blocked by local guardrails`
      };
    }
    const inDefaultStaging = isPathInsideDir(candidate, defaultUploadsDir);
    const inActiveStateDir =
      isPathInsideDir(candidate, activeStateDir) || path.resolve(candidate) === path.resolve(activeStateDir);
    if (!inDefaultStaging && inActiveStateDir) {
      return {
        allowed: false,
        code: 'SENSITIVE_FILE',
        reason: `Uploading internal bridge state files is blocked by local guardrails`
      };
    }
  }

  const insideAllowed = allowedDirs.some((dir) => isPathInsideDir(realPath, dir));
  if (!insideAllowed) {
    return {
      allowed: false,
      code: 'UPLOAD_DIR_RESTRICTED',
      reason: `Upload path must reside inside the staging directory (${getDefaultUploadStagingDir()}) or CHROME_LIVE_UPLOAD_DIR`
    };
  }

  // Block multi-hardlink files (e.g. `mklink /H` or `fs.linkSync` pointing an innocent staging filename at a secret file)
  try {
    const st = fs.statSync(realPath);
    if (st.isFile() && typeof st.nlink === 'number' && st.nlink > 1) {
      return {
        allowed: false,
        code: 'HARDLINK_BLOCKED',
        reason: 'Uploading hard-linked files (nlink > 1) is blocked by local guardrails'
      };
    }
  } catch {
    // Non-existent file paths are caught by stat/open in daemon prepareUploadParams
  }

  return { allowed: true, code: 'OK', reason: '', resolvedPath: realPath };
}
