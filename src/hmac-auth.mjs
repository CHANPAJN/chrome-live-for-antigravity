import crypto from 'node:crypto';
import { timingSafeEqualToken } from './token-store.mjs';

export const AUTH_MAX_SKEW_MS = 30000;
const MAX_NONCE_CACHE = 16384;
const MAX_DECLARED_POST_BYTES = 12 * 1024 * 1024;

export function sha256Hex(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function computeChallengeHmac(token, role, clientNonce, serverNonce) {
  const canonical = JSON.stringify([
    'chrome-live:ws-auth:v2',
    String(role || ''),
    String(clientNonce || ''),
    String(serverNonce || '')
  ]);
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function computeHttpHeaderHmac(token, method, pathWithQuery, ts, nonce, contentLength = 0) {
  const canonical = JSON.stringify([
    'chrome-live:http-hdr:v2',
    String(method || 'GET').toUpperCase(),
    String(pathWithQuery || '/'),
    String(ts || ''),
    String(nonce || ''),
    Number(contentLength) || 0
  ]);
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function computeHttpRequestHmac(token, method, pathWithQuery, ts, nonce, bodyBuf = null) {
  const bodyHash = sha256Hex(bodyBuf || Buffer.alloc(0));
  const canonical = JSON.stringify([
    'chrome-live:http-req:v2',
    String(method || 'GET').toUpperCase(),
    String(pathWithQuery || '/'),
    String(ts || ''),
    String(nonce || ''),
    bodyHash
  ]);
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function computeHttpResponseHmac(token, statusCode, ts, nonce) {
  const canonical = JSON.stringify([
    'chrome-live:http-res:v2',
    Number(statusCode) || 0,
    String(ts || ''),
    String(nonce || '')
  ]);
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function buildSignedHttpHeaders(token, method, pathWithQuery, bodyBuf = null) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const byteLen = bodyBuf ? Buffer.byteLength(bodyBuf) : 0;
  const hdrSig = computeHttpHeaderHmac(token, method, pathWithQuery, ts, nonce, byteLen);
  const sig = computeHttpRequestHmac(token, method, pathWithQuery, ts, nonce, bodyBuf);
  return {
    ts,
    nonce,
    headers: {
      'X-Chrome-Live-Ts': ts,
      'X-Chrome-Live-Nonce': nonce,
      'X-Chrome-Live-Hdr-Sig': hdrSig,
      'X-Chrome-Live-Sig': sig
    }
  };
}

export function verifySignedHttpResponse(token, statusCode, resHeaders, sentTs, sentNonce) {
  const serverSig = String(resHeaders?.['x-chrome-live-server-sig'] || '');
  if (!serverSig) return false;
  const expected = computeHttpResponseHmac(token, statusCode, sentTs, sentNonce);
  return timingSafeEqualToken(serverSig, expected);
}

export function createReplayProtectedVerifier(tokenOrProvider) {
  const seenNonces = new Map(); // nonce -> expiresAt
  const resolveToken = () =>
    typeof tokenOrProvider === 'function' ? String(tokenOrProvider() || '') : String(tokenOrProvider || '');

  function prune(now) {
    if (seenNonces.size === 0) return;
    for (const [k, exp] of seenNonces.entries()) {
      if (exp <= now) seenNonces.delete(k);
    }
    while (seenNonces.size > MAX_NONCE_CACHE) {
      const oldest = seenNonces.keys().next().value;
      if (oldest === undefined) break;
      seenNonces.delete(oldest);
    }
  }

  function precheckHeaders(req, pathWithQuery) {
    // Reject any legacy plaintext token header immediately BEFORE reading request body
    if (req.headers['x-chrome-live-token'] || req.headers.authorization) {
      return { ok: false, reason: 'Plaintext token headers are rejected; use HMAC request signature' };
    }
    const tsRaw = String(req.headers['x-chrome-live-ts'] || '').trim();
    const nonce = String(req.headers['x-chrome-live-nonce'] || '').trim();
    const hdrSig = String(req.headers['x-chrome-live-hdr-sig'] || '').trim();
    const sig = String(req.headers['x-chrome-live-sig'] || '').trim();
    if (
      !/^\d{13}$/.test(tsRaw) ||
      !/^[0-9a-f]{32,64}$/i.test(nonce) ||
      !/^[0-9a-f]{64}$/i.test(hdrSig) ||
      !/^[0-9a-f]{64}$/i.test(sig)
    ) {
      return { ok: false, reason: 'Missing or malformed HMAC authentication headers' };
    }
    const tsNum = Number(tsRaw);
    const now = Date.now();
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > AUTH_MAX_SKEW_MS) {
      return { ok: false, reason: 'HMAC timestamp expired or out of skew window' };
    }

    let declaredLength = 0;
    const methodUpper = String(req.method || 'GET').toUpperCase();
    if (methodUpper === 'POST' || methodUpper === 'PUT' || methodUpper === 'PATCH') {
      if (req.headers['transfer-encoding']) {
        return { ok: false, reason: 'Chunked transfer-encoding is rejected; specify explicit Content-Length' };
      }
      const clRaw = String(req.headers['content-length'] ?? '').trim();
      if (!/^\d+$/.test(clRaw)) {
        return { ok: false, reason: 'Missing or invalid Content-Length header on POST request' };
      }
      declaredLength = Number(clRaw);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_DECLARED_POST_BYTES) {
        return { ok: false, reason: 'Declared Content-Length exceeds maximum payload limit' };
      }
    }

    prune(now);
    if (seenNonces.has(nonce)) {
      return { ok: false, reason: 'Replayed HMAC request nonce rejected' };
    }

    // Cryptographically verify header HMAC BEFORE reading a single byte of POST body
    const activeSecret = resolveToken();
    if (!activeSecret) {
      return { ok: false, reason: 'Daemon authentication token is not configured' };
    }
    const expectedHdrSig = computeHttpHeaderHmac(
      activeSecret,
      methodUpper,
      pathWithQuery,
      tsRaw,
      nonce,
      declaredLength
    );
    if (!timingSafeEqualToken(hdrSig, expectedHdrSig)) {
      return { ok: false, reason: 'Invalid HMAC header signature' };
    }

    return { ok: true, ts: tsRaw, nonce, sig, now, declaredLength, tokenUsed: activeSecret };
  }

  const verifyFn = function verifyRequest(req, pathWithQuery, bodyBuf = null, prechecked = null) {
    const headerCheck = prechecked || precheckHeaders(req, pathWithQuery);
    if (!headerCheck.ok) return headerCheck;

    const { ts, nonce, sig, now, declaredLength, tokenUsed } = headerCheck;
    const actualLen = bodyBuf ? bodyBuf.length : 0;
    if (actualLen !== declaredLength) {
      return { ok: false, reason: 'Request body byte length did not match signed Content-Length' };
    }
    if (seenNonces.has(nonce)) {
      return { ok: false, reason: 'Replayed HMAC request nonce rejected' };
    }

    const currentToken = resolveToken();
    if (!currentToken || !timingSafeEqualToken(currentToken, tokenUsed)) {
      return { ok: false, reason: 'Authentication token rotated during request' };
    }
    const expected = computeHttpRequestHmac(currentToken, req.method || 'GET', pathWithQuery, ts, nonce, bodyBuf);
    if (!timingSafeEqualToken(sig, expected)) {
      return { ok: false, reason: 'Invalid HMAC request body signature' };
    }

    seenNonces.set(nonce, now + AUTH_MAX_SKEW_MS * 2);
    return { ok: true, ts, nonce };
  };

  verifyFn.precheckHeaders = precheckHeaders;
  verifyFn.verifyBody = verifyFn;
  return verifyFn;
}
