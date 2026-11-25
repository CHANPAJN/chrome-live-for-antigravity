import crypto from 'node:crypto';
import { timingSafeEqualToken } from './token-store.mjs';

export const AUTH_MAX_SKEW_MS = 30000;
const MAX_NONCE_CACHE = 2048;

export function sha256Hex(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function computeChallengeHmac(token, role, clientNonce, serverNonce) {
  return crypto
    .createHmac('sha256', String(token || ''))
    .update(`chrome-live:${role}:${clientNonce}:${serverNonce}`, 'utf8')
    .digest('hex');
}

export function computeHttpRequestHmac(token, method, pathWithQuery, ts, nonce, bodyBuf = null) {
  const bodyHash = sha256Hex(bodyBuf || Buffer.alloc(0));
  const canonical = `chrome-live:http-req:v1:${String(method || 'GET').toUpperCase()}:${pathWithQuery}:${ts}:${nonce}:${bodyHash}`;
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function computeHttpResponseHmac(token, statusCode, ts, nonce) {
  const canonical = `chrome-live:http-res:v1:${Number(statusCode) || 0}:${ts}:${nonce}`;
  return crypto.createHmac('sha256', String(token || '')).update(canonical, 'utf8').digest('hex');
}

export function buildSignedHttpHeaders(token, method, pathWithQuery, bodyBuf = null) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = computeHttpRequestHmac(token, method, pathWithQuery, ts, nonce, bodyBuf);
  return {
    ts,
    nonce,
    headers: {
      'X-Chrome-Live-Ts': ts,
      'X-Chrome-Live-Nonce': nonce,
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

export function createReplayProtectedVerifier(authToken) {
  const seenNonces = new Map(); // nonce -> expiresAt

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

  function precheckHeaders(req) {
    // Reject any legacy plaintext token header immediately BEFORE reading request body
    if (req.headers['x-chrome-live-token'] || req.headers.authorization) {
      return { ok: false, reason: 'Plaintext token headers are rejected; use HMAC request signature' };
    }
    const tsRaw = String(req.headers['x-chrome-live-ts'] || '').trim();
    const nonce = String(req.headers['x-chrome-live-nonce'] || '').trim();
    const sig = String(req.headers['x-chrome-live-sig'] || '').trim();
    if (
      !tsRaw ||
      !nonce ||
      !sig ||
      nonce.length < 16 ||
      nonce.length > 128 ||
      !/^[0-9a-f]{64}$/i.test(sig)
    ) {
      return { ok: false, reason: 'Missing or malformed HMAC authentication headers' };
    }
    const tsNum = Number(tsRaw);
    const now = Date.now();
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > AUTH_MAX_SKEW_MS) {
      return { ok: false, reason: 'HMAC timestamp expired or out of skew window' };
    }
    prune(now);
    if (seenNonces.has(nonce)) {
      return { ok: false, reason: 'Replayed HMAC request nonce rejected' };
    }
    return { ok: true, ts: tsRaw, nonce, sig, now };
  }

  function verifyBody(req, pathWithQuery, bodyBuf = null, prechecked = null) {
    const headerCheck = prechecked || precheckHeaders(req);
    if (!headerCheck.ok) return headerCheck;
    const { ts, nonce, sig } = headerCheck;
    const now = Date.now();
    prune(now);
    if (seenNonces.has(nonce)) {
      return { ok: false, reason: 'Replayed HMAC request nonce rejected' };
    }
    const expected = computeHttpRequestHmac(authToken, req.method || 'GET', pathWithQuery, ts, nonce, bodyBuf);
    if (!timingSafeEqualToken(sig, expected)) {
      return { ok: false, reason: 'Invalid HMAC signature' };
    }
    // Record nonce ONLY after cryptographic HMAC verification succeeds (prevents unauthenticated cache eviction)
    seenNonces.set(nonce, now + AUTH_MAX_SKEW_MS + 5000);
    return { ok: true, ts, nonce };
  }

  const verifyFn = (req, pathWithQuery, bodyBuf = null) => verifyBody(req, pathWithQuery, bodyBuf, null);
  verifyFn.precheckHeaders = precheckHeaders;
  verifyFn.verifyBody = verifyBody;
  return verifyFn;
}
