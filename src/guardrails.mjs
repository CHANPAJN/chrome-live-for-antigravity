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

export function isHighEntropyPathToken(rawSegment) {
  if (!rawSegment || rawSegment.length < 32) return false;
  let segment = String(rawSegment);
  if (segment.includes('%')) {
    try {
      segment = decodeURIComponent(segment);
    } catch {}
  }
  if (segment.length < 32) return false;
  if (/^eyJ[A-Za-z0-9._~+/=-]{10,}$/.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (segment.length >= 36 && /^[A-Za-z0-9._~+/=-]+$/.test(segment)) {
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

function canonicalizePathForGuardrail(rawSegment) {
  if (!rawSegment) return { ok: true, rawPath: '/', path: '/' };
  let decoded = String(rawSegment);
  for (let i = 0; i < 3; i++) {
    if (!decoded.includes('%')) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return { ok: false, rawPath: '', path: '' };
    }
  }
  const normalizedSlashes = decoded.replace(/\\/g, '/');
  const qIdx = normalizedSlashes.indexOf('?');
  const pathPart = qIdx === -1 ? normalizedSlashes : normalizedSlashes.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : normalizedSlashes.slice(qIdx);

  const rawPieces = [];
  const stack = [];
  for (const rawPiece of pathPart.split('/')) {
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

export function redactUrlForAudit(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl.trim());
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      mutated = true;
    }
    if (parsed.pathname && parsed.pathname.length >= 32) {
      const parts = parsed.pathname.split('/');
      let pathChanged = false;
      for (let i = 0; i < parts.length; i++) {
        if (isHighEntropyPathToken(parts[i])) {
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
      for (const [k] of parsed.searchParams.entries()) {
        if (AUDIT_SENSITIVE_PARAM_RX.test(k)) {
          parsed.searchParams.set(k, 'REDACTED');
          mutated = true;
        }
      }
    }
    if (parsed.hash) {
      let cleanedHash = parsed.hash.replace(HASH_SENSITIVE_PAIR_RX, '$1$2=REDACTED');
      if (cleanedHash === parsed.hash && /^#!?(:?eyJ[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{32,})$/.test(parsed.hash)) {
        cleanedHash = '#REDACTED';
      } else {
        // Also scrub high-entropy token segments inside SPA hash paths (e.g. #/invite/9f8e7d... or #/verify/eyJ...?foo=1)
        const prefixMatch = cleanedHash.match(/^(#!?)/);
        const hashPrefix = prefixMatch ? prefixMatch[1] : '#';
        const body = cleanedHash.slice(hashPrefix.length);
        const qPos = body.indexOf('?');
        const hPath = qPos === -1 ? body : body.slice(0, qPos);
        const hQuery = qPos === -1 ? '' : body.slice(qPos);
        if (hPath.length >= 32) {
          const hParts = hPath.split('/');
          let hChanged = false;
          for (let i = 0; i < hParts.length; i++) {
            if (isHighEntropyPathToken(hParts[i])) {
              hParts[i] = 'REDACTED';
              hChanged = true;
            }
          }
          if (hChanged) {
            cleanedHash = `${hashPrefix}${hParts.join('/')}${hQuery}`;
          }
        }
      }
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
  return rawText.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (m) => redactUrlForAudit(m));
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

  const canonPath = canonicalizePathForGuardrail(parsed.pathname);
  if (!canonPath.ok) {
    return { allowed: false, code: 'MALFORMED_URL', reason: 'Malformed percent-encoding in URL pathname' };
  }
  const rawHashBody = parsed.hash ? parsed.hash.replace(/^#+!?/, '') : '';
  const canonHash = rawHashBody ? canonicalizePathForGuardrail(rawHashBody) : { ok: true, rawPath: '', path: '' };
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
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.azure|\.gcloud|\.docker|\.chrome-live-antigravity|gcloud)(?:\/|$)/i;
const SENSITIVE_FILE_NAME_RX =
  /^(?:(?!.*\.pub$)id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-].+)|authorized_keys|known_hosts|auth\.token|\.local-runtime\.json|agent_vault\.enc|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|credentials(?:\.json)?|application_default_credentials\.json|Local\s+State|Cookies(?:-journal)?|cookies\.sqlite|key[34]\.db|cert9\.db|logins\.json|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore)|.*\.tfstate(?:\.backup)?)$/i;

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

export function getDefaultUploadStagingDir() {
  return path.join(getStateDir(), 'uploads');
}

function parseAllowedUploadDirs(explicitDirs) {
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
    const defaultDir = getDefaultUploadStagingDir();
    try {
      fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    } catch {}
    dirs.push(resolveCanonicalPath(path.resolve(defaultDir)));
  }
  return dirs;
}

export function evaluateUploadFileSafety(rawFilePath, options = {}) {
  if (!rawFilePath || typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    return { allowed: false, code: 'INVALID_FILE', reason: 'Empty file path' };
  }
  const rawTrimmed = rawFilePath.trim();
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
  const resolvedPath = path.resolve(expandedPath);
  const realPath = resolveCanonicalPath(resolvedPath);

  const allowedDirs = parseAllowedUploadDirs(options.allowedDirs);
  // Check sensitive filename/directory patterns BEFORE and AFTER canonicalization,
  // while exempting the dedicated uploads staging subdir inside ~/.chrome-live-antigravity/uploads
  const defaultUploadsDir = resolveCanonicalPath(path.resolve(getDefaultUploadStagingDir()));
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
    const inDefaultStaging = isPathInsideDir(candidate, defaultUploadsDir);
    if (!inDefaultStaging && SENSITIVE_FILE_DIR_RX.test(normalized)) {
      return {
        allowed: false,
        code: 'SENSITIVE_FILE',
        reason: `Uploading files from protected directory is blocked by local guardrails`
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
