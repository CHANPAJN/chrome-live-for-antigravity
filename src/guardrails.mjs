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
  /\/checkout(?:\/|$)/i,
  /\/payment(?:s)?(?:\/|$)/i,
  /\/cashier(?:\/|$)/i,
  /\/billing\/pay(?:\/|$)/i,
  /\/wallet\/transfer(?:\/|$)/i
];

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
  /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|auth\.token|agent_vault\.enc|\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|Cookies|Login Data|Web Data)$/i;

export function evaluateUploadFileSafety(rawFilePath) {
  if (!rawFilePath || typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    return { allowed: false, code: 'INVALID_FILE', reason: 'Empty file path' };
  }
  const resolvedPath = path.resolve(rawFilePath.trim());
  const normalized = resolvedPath.replace(/\\/g, '/');
  const baseName = path.basename(resolvedPath);

  if (SENSITIVE_FILE_DIR_RX.test(normalized) || SENSITIVE_FILE_NAME_RX.test(baseName)) {
    return {
      allowed: false,
      code: 'SENSITIVE_FILE',
      reason: `Uploading sensitive credential or key file "${baseName}" is blocked by local guardrails`
    };
  }

  return { allowed: true, code: 'OK', reason: '', resolvedPath };
}
