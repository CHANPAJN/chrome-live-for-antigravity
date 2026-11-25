import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = Number.parseInt(process.env.CHROME_LIVE_PORT || '28196', 10) || 28196;

let cachedToken = '';
let cachedTokenMtimeMs = 0;

export function getStateDir() {
  if (process.env.CHROME_LIVE_HOME) {
    return path.resolve(process.env.CHROME_LIVE_HOME);
  }
  return path.join(os.homedir(), '.chrome-live-antigravity');
}

export function getTokenFilePath() {
  return path.join(getStateDir(), 'auth.token');
}

export function ensureAuthToken() {
  if (process.env.CHROME_LIVE_TOKEN && process.env.CHROME_LIVE_TOKEN.trim().length >= 16) {
    return process.env.CHROME_LIVE_TOKEN.trim();
  }

  const tokenFile = getTokenFilePath();
  try {
    const st = fs.statSync(tokenFile);
    if (cachedToken && st.mtimeMs === cachedTokenMtimeMs) {
      return cachedToken;
    }
    const raw = fs.readFileSync(tokenFile, 'utf8').trim();
    if (raw.length >= 32) {
      cachedToken = raw;
      cachedTokenMtimeMs = st.mtimeMs;
      return cachedToken;
    }
  } catch {
    // Token file does not exist yet; generate a fresh 256-bit random secret below.
  }

  const dir = getStateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const st = fs.statSync(tokenFile);
    cachedTokenMtimeMs = st.mtimeMs;
  } catch {
    cachedTokenMtimeMs = Date.now();
  }
  cachedToken = fresh;
  return fresh;
}

export function timingSafeEqualToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
