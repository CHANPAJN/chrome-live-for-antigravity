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

const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata',
  'instance-data',
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.packet.net',
  'metadata.tencentyun.com'
]);

const DNS_REBIND_METADATA_RX =
  /(?:^|[.-])(?:169[.-]254(?:[.-]\d{1,3}){2}|100[.-]100[.-]100[.-]200)(?:$|\.)/i;

function isBlockedIpv4Octets(a, b, c, d) {
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return false;
  }
  // 0.0.0.0/8 ("this network" / all-interfaces wildcard)
  if (a === 0) return true;
  // 169.254.0.0/16 Link-Local & AWS/GCP/Azure/Oracle/ECS cloud metadata services
  if (a === 169 && b === 254) return true;
  // 100.100.100.200 Alibaba/Tencent cloud instance metadata service (preserves normal Tailscale 100.64.0.0/10 hosts)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  return false;
}

export function isBlockedCloudMetadataOrZeroHost(rawHostname) {
  let host = String(rawHostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return false;

  // Re-normalize trailing-dot numeric/hex/octal IPv4 forms (`http://2852039166./` or `http://0xa9fea9fe./`) via WHATWG URL parser
  if (!host.startsWith('[') && !host.includes(':')) {
    try {
      const reparsed = new URL(`http://${host}/`).hostname.toLowerCase().replace(/\.+$/, '');
      if (reparsed) host = reparsed;
    } catch {}
  }

  if (
    BLOCKED_METADATA_HOSTNAMES.has(host) ||
    host.endsWith('.metadata.google.internal') ||
    host.endsWith('.metadata.azure.internal') ||
    DNS_REBIND_METADATA_RX.test(host)
  ) {
    return true;
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    return isBlockedIpv4Octets(
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4])
    );
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).split('%')[0].split('%25')[0].toLowerCase();
    // Unspecified IPv6 `::`
    if (/^[0:]+$/.test(v6) && v6.includes(':')) return true;
    // IPv6 Link-Local `fe80::/10`
    if (/^fe[89ab][0-9a-f]:/i.test(v6)) return true;
    // AWS / cloud IPv6 IMDS `fd00:ec2::254`
    if (/^fd00:0*ec2:(?:0*:)*0*254$/i.test(v6)) return true;

    // Dotted-quad suffix on IPv6 (`[::ffff:169.254.169.254]`, `[64:ff9b::169.254.169.254]`)
    const v4Suffix = v6.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4Suffix) {
      if (
        isBlockedIpv4Octets(
          Number(v4Suffix[1]),
          Number(v4Suffix[2]),
          Number(v4Suffix[3]),
          Number(v4Suffix[4])
        )
      ) {
        return true;
      }
    }

    // Hex-encoded embedded IPv4 in IPv4-mapped (`::ffff:a9fe:a9fe`), IPv4-compatible (`::a9fe:a9fe`), NAT64 (`64:ff9b::a9fe:a9fe`), or 6to4 (`2002:a9fe:a9fe:...`)
    const checkHexPair = (hiHex, loHex) => {
      const hi = Number.parseInt(hiHex, 16);
      const lo = Number.parseInt(loHex, 16);
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return false;
      return isBlockedIpv4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
    };
    const m6to4 = v6.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i);
    if (m6to4 && checkHexPair(m6to4[1], m6to4[2])) return true;

    const mTailHex = v6.match(
      /^(?:(?::|[0:]+:(?:ffff:)?)|64:ff9b:(?:0*:)*)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
    );
    if (mTailHex && checkHexPair(mTailHex[1], mTailHex[2])) return true;
  }

  return false;
}

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
  'bankcomm.com'
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
    if (eqIdx === -1) {
      if (isHighEntropyPathToken(pieces[i], { splitMatrix: false })) {
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
    if (AUDIT_SENSITIVE_PARAM_RX.test(decMk)) {
      pieces[i] = `${mk}=REDACTED`;
      changed = true;
    } else {
      const nestedMv = scrubNestedParamValue(mv, 0);
      if (nestedMv.changed) {
        pieces[i] = `${mk}=${nestedMv.value}`;
        changed = true;
      }
    }
  }
  pieces[0] = head;
  return changed ? pieces.join(';') : seg;
}

function scrubNestedParamValue(rawV, depth = 0) {
  if (!rawV || depth > 4) return { value: rawV, changed: false };
  if (isHighEntropyPathToken(rawV, { splitMatrix: false })) {
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
  if (isHighEntropyPathToken(decV, { splitMatrix: false })) {
    return { value: 'REDACTED', changed: true };
  }
  if (/^https?:\/\//i.test(decV.trim())) {
    const redUrl = redactUrlForAudit(decV.trim(), depth + 1);
    if (redUrl !== decV.trim()) {
      return { value: reencodeLayers(redUrl), changed: true };
    }
  } else if (/https?:\/\//i.test(decV)) {
    const redTxt = redactUrlsInText(decV);
    if (redTxt !== decV) {
      return { value: reencodeLayers(redTxt), changed: true };
    }
  } else if (decV.includes('=') || decV.includes('&') || decV.includes('#')) {
    const subScrub = scrubQueryStringTokens(`?${decV}`, depth + 1);
    if (subScrub.changed) {
      const inner = subScrub.text.slice(1);
      return { value: reencodeLayers(inner), changed: true };
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
    if ((rawV === '' || /^=+$/.test(rawV)) && isHighEntropyPathToken(rawK, { splitMatrix: false })) {
      tokens[i] = 'REDACTED';
      changed = true;
      continue;
    }
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
  // Strip leading hashbang `!` AFTER percent-decoding so `#%21checkout` -> `/checkout` cannot bypass!
  const normalizedSlashes = decodedPath.replace(/\\/g, '/').replace(/^[/]*!+/, '/');
  const rawPieces = [];
  const stack = [];
  for (const rawPiece of normalizedSlashes.split('/')) {
    const cleanPiece = rawPiece.split(';')[0];
    if (!cleanPiece || cleanPiece === '.') continue;
    if (cleanPiece === '..') {
      rawPieces.push('..');
      stack.pop();
      continue;
    }
    const strippedPiece = cleanPiece.replace(/\.+$/, '');
    if (!strippedPiece) continue;
    rawPieces.push(strippedPiece);
    stack.push(strippedPiece);
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
      const scrubbedSearch = scrubQueryStringTokens(parsed.search, depth);
      if (scrubbedSearch.changed) {
        parsed.search = scrubbedSearch.text;
        mutated = true;
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
        (isHighEntropyPathToken(hashNoPad, { splitMatrix: false }) ||
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

      cleanedHash = cleanedHash.replace(/([#?&])([^=&#]+)=([^&#]*)/g, (full, sep, rawKey) => {
        let decKey = rawKey;
        if (rawKey.includes('%')) {
          try {
            decKey = decodeURIComponent(rawKey);
          } catch {}
        }
        return AUDIT_SENSITIVE_PARAM_RX.test(rawKey) || AUDIT_SENSITIVE_PARAM_RX.test(decKey)
          ? `${sep}${rawKey}=REDACTED`
          : full;
      });
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

function splitBalancedUrlSuffix(rawMatch) {
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

export function redactUrlsInText(rawText) {
  if (typeof rawText !== 'string' || !/https?:\/\//i.test(rawText)) return rawText;
  return rawText.replace(/https?:\/\/[^\s"'<>`\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/gi, (match) => {
    const { coreUrl, suffix } = splitBalancedUrlSuffix(match);
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

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (isBlockedCloudMetadataOrZeroHost(parsed.hostname)) {
    return {
      allowed: false,
      code: 'CLOUD_METADATA_BLOCKED',
      reason: `Host "${host}" is blocked by cloud metadata / unspecified-address SSRF guardrail`
    };
  }
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
  let hashMatchedCheckout = false;
  if (parsed.hash && parsed.hash.length > 1) {
    const subChunks = parsed.hash.slice(1).split('#');
    for (const chunk of subChunks) {
      const cleanChunk = chunk.replace(/^!+/, '');
      if (!cleanChunk) continue;
      const canonChunk = canonicalizePathForGuardrail(cleanChunk, true);
      if (!canonChunk.ok) {
        return { allowed: false, code: 'MALFORMED_URL', reason: 'Malformed percent-encoding in URL fragment' };
      }
      if (
        (canonChunk.rawPath && CHECKOUT_SEGMENT_RX.test(canonChunk.rawPath)) ||
        (canonChunk.path && CHECKOUT_SEGMENT_RX.test(canonChunk.path))
      ) {
        hashMatchedCheckout = true;
      }
    }
  }

  // Inspect BOTH uncollapsed and dot-collapsed routes so `/checkout/..;x=1`, `/cashier%2f..`, `#%21checkout`, and `#?step=1#/%63heckout` cannot bypass!
  if (
    CHECKOUT_SEGMENT_RX.test(canonPath.rawPath) ||
    CHECKOUT_SEGMENT_RX.test(canonPath.path) ||
    hashMatchedCheckout
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

const nativeRealpathSync = fs.realpathSync.native || fs.realpathSync;

function resolveCanonicalPath(targetPath) {
  try {
    return nativeRealpathSync(targetPath);
  } catch {
    // If file does not exist yet or symlink is dangling, still canonicalize its parent directory
    try {
      const parentReal = nativeRealpathSync(path.dirname(targetPath));
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

function parseAllowedUploadDirEntries(explicitDirs, stateDirOverride = '') {
  let rawList;
  if (Array.isArray(explicitDirs)) {
    rawList = explicitDirs;
  } else if (typeof process.env.CHROME_LIVE_UPLOAD_DIR === 'string' && process.env.CHROME_LIVE_UPLOAD_DIR.trim()) {
    rawList = process.env.CHROME_LIVE_UPLOAD_DIR.split(path.delimiter);
  } else {
    rawList = [];
  }
  const entries = [];
  for (const raw of rawList) {
    const trimmed = expandLeadingTilde(String(raw || ''));
    if (!trimmed || /^[;:\s]+$/.test(trimmed)) continue;
    const abs = path.resolve(trimmed);
    entries.push({ rawDir: abs, canonDir: resolveCanonicalPath(abs) });
  }
  // Strict Fail-Closed: if explicitDirs or CHROME_LIVE_UPLOAD_DIR resolves to zero valid directories
  // (e.g. ";" or empty array), always fall back to the isolated default staging directory.
  if (entries.length === 0) {
    const defaultDir = path.resolve(getDefaultUploadStagingDir(stateDirOverride));
    try {
      fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    } catch {}
    entries.push({ rawDir: defaultDir, canonDir: resolveCanonicalPath(defaultDir) });
  }
  return entries;
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
  const allowedEntries = parseAllowedUploadDirEntries(options.allowedDirs, effectiveStateDir);
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

  const matchedEntry = allowedEntries.find((e) => isPathInsideDir(realPath, e.canonDir));
  if (!matchedEntry) {
    return {
      allowed: false,
      code: 'UPLOAD_DIR_RESTRICTED',
      reason: `Upload path must reside inside the staging directory (${getDefaultUploadStagingDir()}) or CHROME_LIVE_UPLOAD_DIR`
    };
  }

  // Reject symbolic links and Windows directory junctions anywhere along the upload path (even when pointing inside the same allowed directory!)
  let relSub = '';
  if (isPathInsideDir(resolvedPath, matchedEntry.rawDir)) {
    relSub = path.relative(matchedEntry.rawDir, resolvedPath);
  } else if (isPathInsideDir(resolvedPath, matchedEntry.canonDir)) {
    relSub = path.relative(matchedEntry.canonDir, resolvedPath);
  } else {
    return {
      allowed: false,
      code: 'SYMLINK_BLOCKED',
      reason: 'Uploading symbolic links or junctions is blocked by local guardrails'
    };
  }

  const nativeRealpath = fs.realpathSync.native || fs.realpathSync;
  const subSegments = relSub.split(path.sep).filter(Boolean);
  let walkCur = matchedEntry.canonDir;
  for (const seg of subSegments) {
    walkCur = path.join(walkCur, seg);
    let segStat = null;
    try {
      segStat = fs.lstatSync(walkCur);
    } catch {
      // Non-existent final target is caught by fs.openSync in daemon prepareUploadParams
      break;
    }
    if (segStat.isSymbolicLink()) {
      return {
        allowed: false,
        code: 'SYMLINK_BLOCKED',
        reason: 'Uploading symbolic links is blocked by local guardrails'
      };
    }
    try {
      const segReal = nativeRealpath(walkCur);
      const sameTarget =
        process.platform === 'win32'
          ? segReal.toLowerCase() === walkCur.toLowerCase()
          : segReal === walkCur;
      if (!sameTarget) {
        return {
          allowed: false,
          code: 'SYMLINK_BLOCKED',
          reason: 'Uploading symbolic links or junctions is blocked by local guardrails'
        };
      }
    } catch {
      return {
        allowed: false,
        code: 'SYMLINK_BLOCKED',
        reason: 'Uploading broken symbolic links is blocked by local guardrails'
      };
    }
  }

  const verifiedNonSymlinkPath = path.join(matchedEntry.canonDir, relSub);

  // Block multi-hardlink files (e.g. `mklink /H` or `fs.linkSync` pointing an innocent staging filename at a secret file)
  try {
    const st = fs.lstatSync(verifiedNonSymlinkPath);
    if (st.isSymbolicLink()) {
      return {
        allowed: false,
        code: 'SYMLINK_BLOCKED',
        reason: 'Uploading symbolic links is blocked by local guardrails'
      };
    }
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

  return { allowed: true, code: 'OK', reason: '', resolvedPath: verifiedNonSymlinkPath };
}

export const SAFE_ATTR_SELECTOR_ALLOWLIST_RX =
  /^(?:id|class|name|type|role|placeholder|aria-(?:label|expanded|selected|checked|controls|current|disabled)|title|for|disabled|checked|selected|readonly|required|multiple|contenteditable|tabindex|data-(?:testid|test|cy|qa|clive-idx|index|id|action|role|tab|state)|target|alt)$/i;

export const SAFE_FUNCTIONAL_PSEUDO_RX =
  /^(?:nth-child|nth-last-child|nth-of-type|nth-last-of-type|not|is|where)$/i;

export function assertSafeAutomationSelector(rawSelector) {
  if (typeof rawSelector !== 'string') {
    throw new Error('[GUARDRAIL] CSS selector must be a string');
  }
  const s = rawSelector.trim();
  if (!s) return;
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
