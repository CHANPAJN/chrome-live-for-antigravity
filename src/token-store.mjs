import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = Number.parseInt(process.env.CHROME_LIVE_PORT || '28196', 10) || 28196;

const hardenedDirs = new Set();

export function getStateDir() {
  if (process.env.CHROME_LIVE_HOME) {
    return path.resolve(process.env.CHROME_LIVE_HOME);
  }
  return path.join(os.homedir(), '.chrome-live-antigravity');
}

export function ensureSecureDirSync(dirPath) {
  const resolved = path.resolve(dirPath);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(resolved, 0o700);
    } else if (!hardenedDirs.has(resolved)) {
      hardenedDirs.add(resolved);
      const username = os.userInfo().username;
      if (username && !/["\r\n]/.test(username)) {
        spawnSync(
          'icacls',
          [resolved, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`],
          { windowsHide: true, stdio: 'ignore', timeout: 3000 }
        );
      }
    }
  } catch {
    // Best-effort ACL tightening in restricted sandboxes
  }
  return resolved;
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
    // Always read directly (65-byte file <0.05ms) to avoid same-millisecond mtime cache staleness on Windows NTFS
    const raw = fs.readFileSync(tokenFile, 'utf8').trim();
    if (raw.length >= 32) {
      return raw;
    }
  } catch {
    // Token file does not exist yet; generate a fresh 256-bit random secret below.
  }

  const dir = ensureSecureDirSync(getStateDir());
  const fresh = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'auth.token'), `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

export function timingSafeEqualToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
