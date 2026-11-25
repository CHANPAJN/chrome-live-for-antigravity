import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStateDir } from './token-store.mjs';

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
  'checkout.stripe.com',
  'billing.stripe.com',
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

const CHECKOUT_PATH_PATTERNS = [
  /\/checkout(?:\/|\?|$|#)/i,
  /\/pay(?:ment(?:s)?)?(?:\/|\?|$|#)/i,
  /\/cashier(?:\/|\?|$|#)/i,
  /\/billing(?:\/|\?|$|#)/i,
  /\/wallet\/transfer(?:\/|\?|$|#)/i
];

export const AUDIT_SENSITIVE_PARAM_RX =
  /(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential)/i;

const HASH_SENSITIVE_PAIR_RX =
  /([#?&])([^=&#]*(?:token|secret|passw|pwd|apikey|api[-_]?key|access[-_]?key|private[-_]?key|auth|code|state|sig|jwt|bearer|ticket|session|sid|csrf|xsrf|otp|credential)[^=&#]*)=([^&#]*)/gi;

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
      if (cleanedHash === parsed.hash && /^#(?:eyJ[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{32,})$/.test(parsed.hash)) {
        cleanedHash = '#REDACTED';
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
  if (typeof rawText !== 'string' || !rawText.includes('http')) return rawText;
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

  if (parsed.port && BLOCKED_PORTS.has(parsed.port)) {
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

  // Also inspect SPA hash routes (e.g. https://shop.example.com/#/checkout/pay)
  const fullRoute = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  for (const rx of CHECKOUT_PATH_PATTERNS) {
    if (rx.test(fullRoute)) {
      return {
        allowed: false,
        code: 'PAYMENT_PATH',
        reason: `URL route "${parsed.pathname}${parsed.hash}" matches protected payment/checkout guardrail`
      };
    }
  }

  return { allowed: true, code: 'OK', reason: '' };
}

const SENSITIVE_FILE_DIR_RX =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.azure|\.gcloud|\.docker|\.chrome-live-antigravity|gcloud)(?:\/|$)/i;
const SENSITIVE_FILE_NAME_RX =
  /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|auth\.token|\.local-runtime\.json|agent_vault\.enc|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?|application_default_credentials\.json|Cookies(?:-journal)?|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore))$/i;

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
