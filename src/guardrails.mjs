import fs from 'node:fs';
import path from 'node:path';

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

const AUDIT_SENSITIVE_PARAM_RX =
  /^(?:token|access_token|id_token|refresh_token|auth.*|code|state|sig|signature|key|api_key|secret|password|session.*)$/i;

export function redactUrlForAudit(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl.trim());
    if (!parsed.search) return parsed.toString();
    let mutated = false;
    for (const [k] of parsed.searchParams.entries()) {
      if (AUDIT_SENSITIVE_PARAM_RX.test(k)) {
        parsed.searchParams.set(k, 'REDACTED');
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
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
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.chrome-live-antigravity)(?:\/|$)/i;
const SENSITIVE_FILE_NAME_RX =
  /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|auth\.token|\.local-runtime\.json|agent_vault\.enc|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|Cookies(?:-journal)?|Login Data(?:\s+For\s+Account)?|Web Data|.*\.(?:pem|key|p12|pfx|kdbx|ovpn|jks|keystore))$/i;

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
  const rel = path.relative(dirPath, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function parseAllowedUploadDirs(explicitDirs) {
  const rawList = Array.isArray(explicitDirs)
    ? explicitDirs
    : typeof process.env.CHROME_LIVE_UPLOAD_DIR === 'string' && process.env.CHROME_LIVE_UPLOAD_DIR.trim()
      ? process.env.CHROME_LIVE_UPLOAD_DIR.split(path.delimiter)
      : [];
  const dirs = [];
  for (const raw of rawList) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    const abs = path.resolve(trimmed);
    dirs.push(resolveCanonicalPath(abs));
  }
  return dirs;
}

export function evaluateUploadFileSafety(rawFilePath, options = {}) {
  if (!rawFilePath || typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    return { allowed: false, code: 'INVALID_FILE', reason: 'Empty file path' };
  }
  const resolvedPath = path.resolve(rawFilePath.trim());
  const realPath = resolveCanonicalPath(resolvedPath);
  const candidates = realPath === resolvedPath ? [resolvedPath] : [resolvedPath, realPath];

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/');
    const baseName = path.basename(candidate);
    if (SENSITIVE_FILE_DIR_RX.test(normalized) || SENSITIVE_FILE_NAME_RX.test(baseName)) {
      return {
        allowed: false,
        code: 'SENSITIVE_FILE',
        reason: `Uploading sensitive credential or key file "${baseName}" is blocked by local guardrails`
      };
    }
  }

  const allowedDirs = parseAllowedUploadDirs(options.allowedDirs);
  if (allowedDirs.length > 0) {
    const insideAllowed = allowedDirs.some(
      (dir) => isPathInsideDir(realPath, dir) && isPathInsideDir(resolvedPath, dir)
    );
    if (!insideAllowed) {
      return {
        allowed: false,
        code: 'UPLOAD_DIR_RESTRICTED',
        reason: `Upload path is outside allowed CHROME_LIVE_UPLOAD_DIR boundary`
      };
    }
  }

  return { allowed: true, code: 'OK', reason: '', resolvedPath: realPath };
}
