import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = Number.parseInt(process.env.CHROME_LIVE_PORT || '__CHROME_LIVE_PORT__', 10) || 28196;
const DAEMON_SCRIPT = '__CHROME_LIVE_DAEMON_PATH__';

let lastSpawnAt = 0;
const SPAWN_COOLDOWN_MS = 15000;

function readLocalToken() {
  if (process.env.CHROME_LIVE_TOKEN) return process.env.CHROME_LIVE_TOKEN.trim();
  const homeDir = process.env.CHROME_LIVE_HOME || path.join(os.homedir(), '.chrome-live-antigravity');
  const tokenPath = path.join(homeDir, 'auth.token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function signDaemonHttp(token, method, routePath, payload) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const methodUpper = String(method || 'GET').toUpperCase();
  const byteLen = payload ? payload.length : 0;
  const bodyHash = crypto
    .createHash('sha256')
    .update(payload || Buffer.alloc(0))
    .digest('hex');
  const hdrCanonical = JSON.stringify([
    'chrome-live:http-hdr:v2',
    methodUpper,
    routePath,
    ts,
    nonce,
    byteLen
  ]);
  const reqCanonical = JSON.stringify([
    'chrome-live:http-req:v2',
    methodUpper,
    routePath,
    ts,
    nonce,
    bodyHash
  ]);
  const hdrSig = crypto.createHmac('sha256', token).update(hdrCanonical, 'utf8').digest('hex');
  const sig = crypto.createHmac('sha256', token).update(reqCanonical, 'utf8').digest('hex');
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

function verifyDaemonHttp(token, statusCode, resHeaders, ts, nonce) {
  const serverSig = String(resHeaders?.['x-chrome-live-server-sig'] || '');
  if (!serverSig || !token) return false;
  const canonical = JSON.stringify(['chrome-live:http-res:v2', Number(statusCode) || 0, String(ts), String(nonce)]);
  const expected = crypto.createHmac('sha256', token).update(canonical, 'utf8').digest('hex');
  const a = Buffer.from(serverSig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function maybeBootstrapDaemon() {
  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_COOLDOWN_MS) return;
  lastSpawnAt = now;
  if (!DAEMON_SCRIPT || DAEMON_SCRIPT.includes('__CHROME_LIVE') || !fs.existsSync(DAEMON_SCRIPT)) {
    return;
  }

  const spawnDaemon = () => {
    try {
      const child = spawn(process.execPath, [DAEMON_SCRIPT], {
        cwd: path.dirname(DAEMON_SCRIPT),
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch {}
  };

  const token = readLocalToken();
  if (!token) {
    spawnDaemon();
    return;
  }
  const { ts, nonce, headers } = signDaemonHttp(token, 'GET', '/api/health', null);
  const probe = http.request(
    { host: DAEMON_HOST, port: DAEMON_PORT, path: '/api/health', method: 'GET', headers, timeout: 800 },
    (res) => {
      res.resume();
      if (!verifyDaemonHttp(token, res.statusCode || 500, res.headers, ts, nonce)) {
        // Port is occupied by an unverified process; do not treat as a healthy daemon
        return;
      }
    }
  );
  probe.on('timeout', () => probe.destroy());
  probe.on('error', () => spawnDaemon());
  probe.end();
}

function callDaemon(method, routePath, bodyObj = null, timeoutMs = 6000) {
  const token = readLocalToken();
  if (!token) {
    return Promise.reject(new Error('Local pairing token not found; run chrome-live setup'));
  }
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const { ts, nonce, headers: baseHeaders } = signDaemonHttp(token, method, routePath, payload);
    const req = http.request(
      {
        host: DAEMON_HOST,
        port: DAEMON_PORT,
        path: routePath,
        method,
        timeout: timeoutMs,
        headers: payload
          ? {
              ...baseHeaders,
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': String(payload.length)
            }
          : baseHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode || 500;
          if (!verifyDaemonHttp(token, status, res.headers, ts, nonce)) {
            reject(new Error('Unverified local service on daemon port'));
            return;
          }
          resolve({
            status,
            contentType: res.headers['content-type'] || 'application/octet-stream',
            buffer: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Daemon request timed out')));
    req.on('error', (err) => {
      maybeBootstrapDaemon();
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

maybeBootstrapDaemon();

const app = new SidecarApp();

app.page('/', () => fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));

app.api(
  '/api/live_state',
  async (data) => {
    maybeBootstrapDaemon();
    try {
      const includeFrame = data && data.includeFrame === '1' ? '1' : '0';
      const tabParam =
        data && data.tabId !== undefined && data.tabId !== ''
          ? `&tabId=${encodeURIComponent(String(data.tabId))}`
          : '';
      const r = await callDaemon('GET', `/api/state?includeFrame=${includeFrame}${tabParam}`, null, 3000);
      return JSON.parse(r.buffer.toString('utf8'));
    } catch (err) {
      return {
        ok: false,
        daemonOffline: true,
        extensionConnected: false,
        error: err instanceof Error ? err.message : 'daemon offline'
      };
    }
  },
  'GET'
);

app.api(
  '/api/live_frame',
  async (data) => {
    try {
      const tabQuery =
        data && data.tabId !== undefined && data.tabId !== ''
          ? `?tabId=${encodeURIComponent(String(data.tabId))}`
          : '';
      const r = await callDaemon('GET', `/api/frame${tabQuery}`, null, 3500);
      if (r.status !== 200 || !r.buffer.length) {
        return new Response('no frame', { status: 404 });
      }
      return new Response(r.buffer, {
        contentType: r.contentType || 'image/jpeg',
        headers: { 'Cache-Control': 'no-store, max-age=0' }
      });
    } catch {
      return new Response('offline', { status: 503 });
    }
  },
  'GET'
);

async function handleAction(data = {}) {
  const cmd = String(data.cmd || '').trim();
  const allowed = new Set(['screenshot', 'focus_tab', 'release_tab', 'done']);
  if (!allowed.has(cmd)) {
    return { ok: false, error: `Unsupported action: ${cmd}` };
  }
  const params = {};
  if (data.tabId !== undefined && data.tabId !== '') params.tabId = Number(data.tabId);
  if (data.all !== undefined) params.all = Boolean(data.all);
  if (data.summary) params.summary = String(data.summary);

  try {
    const r = await callDaemon('POST', '/api/command', { method: cmd, params }, 10000);
    return JSON.parse(r.buffer.toString('utf8'));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'action failed' };
  }
}

app.api('/api/action', handleAction, 'GET');
app.api('/api/action', handleAction, 'POST');

app.run();
