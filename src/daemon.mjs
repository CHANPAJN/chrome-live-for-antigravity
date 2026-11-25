import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { evaluateUploadFileSafety, evaluateUrlSafety, redactUrlForAudit } from './guardrails.mjs';
import {
  clearPlaybooks,
  deletePlaybookItem,
  getPlaybookSummary,
  learnFromPageVisit,
  learnInteractionSelector,
  listPlaybooks,
  lookupDomainPlaybook,
  saveManualPlaybook,
  setPlaybookEnabled
} from './playbook-store.mjs';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureAuthToken,
  getStateDir,
  timingSafeEqualToken
} from './token-store.mjs';
import { upgradeHttpToWebSocket } from './ws-codec.mjs';

const MAX_AUDIT_ENTRIES = 80;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 25000;

export function computeChallengeHmac(token, role, clientNonce, serverNonce) {
  return crypto
    .createHmac('sha256', String(token || ''))
    .update(`chrome-live:${role}:${clientNonce}:${serverNonce}`, 'utf8')
    .digest('hex');
}

function isAllowedHostHeader(hostHeader, boundPort) {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  const normalized = hostHeader.trim().toLowerCase();
  return (
    normalized === `127.0.0.1:${boundPort}` ||
    normalized === `localhost:${boundPort}` ||
    normalized === '127.0.0.1' ||
    normalized === 'localhost'
  );
}

function resolveAllowedExtensionOrigin(originHeader) {
  if (!originHeader) return null;
  const trimmed = String(originHeader).trim();
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request payload exceeds maximum size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

export function createDaemonServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const authToken = options.token || ensureAuthToken();

  let extensionPeer = null;
  const liveViewPeers = new Set();
  const upgradeSockets = new Set();
  const pendingRpc = new Map();
  const auditLog = [];

  const MAX_TAB_FRAMES = 6;

  const state = {
    extensionConnected: false,
    extensionVersion: '',
    connectedAt: 0,
    updatedAt: Date.now(),
    activeTabId: null,
    tabs: [],
    customBlockedDomains: [],
    latestFrame: null, // { tabId, mimeType, buffer, title, url, activity, capturedAt }
    framesByTab: new Map() // tabId -> frame
  };

  function resolveFrame(tabIdParam) {
    if (tabIdParam !== null && tabIdParam !== undefined && tabIdParam !== '') {
      const tid = Number.parseInt(String(tabIdParam), 10);
      if (Number.isInteger(tid)) {
        return state.framesByTab.get(tid) || null;
      }
    }
    return state.latestFrame;
  }

  function storeTabFrame(frame) {
    state.latestFrame = frame;
    if (typeof frame.tabId === 'number' && Number.isInteger(frame.tabId)) {
      state.framesByTab.delete(frame.tabId);
      state.framesByTab.set(frame.tabId, frame);
      while (state.framesByTab.size > MAX_TAB_FRAMES) {
        const oldestKey = state.framesByTab.keys().next().value;
        state.framesByTab.delete(oldestKey);
      }
    }
  }

  function pruneClosedTabFrames(liveTabs) {
    if (!Array.isArray(liveTabs) || state.framesByTab.size === 0) return;
    const liveIds = new Set(
      liveTabs
        .map((t) => (t && typeof t.tabId === 'number' ? t.tabId : null))
        .filter((id) => id !== null)
    );
    for (const cachedId of Array.from(state.framesByTab.keys())) {
      if (!liveIds.has(cachedId)) {
        state.framesByTab.delete(cachedId);
      }
    }
    if (state.latestFrame && typeof state.latestFrame.tabId === 'number' && !liveIds.has(state.latestFrame.tabId)) {
      const remaining = Array.from(state.framesByTab.values());
      state.latestFrame = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  function recordAudit(action, detail = {}, status = 'ok') {
    const safeDetail =
      detail && typeof detail === 'object'
        ? {
            ...detail,
            ...(typeof detail.url === 'string' ? { url: redactUrlForAudit(detail.url) } : {})
          }
        : detail;
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      action,
      status,
      detail: safeDetail
    };
    auditLog.unshift(entry);
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
      auditLog.length = MAX_AUDIT_ENTRIES;
    }
    broadcastToLivePeers({
      type: 'audit',
      entry
    });
    return entry;
  }

  function buildPublicSnapshot() {
    return {
      ok: true,
      daemonPid: process.pid,
      port: server.address()?.port ?? requestedPort,
      extensionConnected: state.extensionConnected && Boolean(extensionPeer && !extensionPeer.closed),
      extensionVersion: state.extensionVersion,
      connectedAt: state.connectedAt,
      updatedAt: state.updatedAt,
      activeTabId: state.activeTabId,
      tabs: state.tabs,
      hasFrame: Boolean(state.latestFrame),
      latestFrameMeta: state.latestFrame
        ? {
            tabId: state.latestFrame.tabId,
            title: state.latestFrame.title,
            url: state.latestFrame.url,
            activity: state.latestFrame.activity,
            capturedAt: state.latestFrame.capturedAt
          }
        : null,
      playbook: getPlaybookSummary(),
      recentAudit: auditLog.slice(0, 20)
    };
  }

  function broadcastToLivePeers(payload) {
    if (liveViewPeers.size === 0) return;
    const text = JSON.stringify(payload);
    for (const peer of liveViewPeers) {
      if (peer.closed) {
        liveViewPeers.delete(peer);
      } else {
        peer.sendText(text);
      }
    }
  }

  function extractHeaderToken(req) {
    return String(
      req.headers['x-chrome-live-token'] ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '') ||
        ''
    );
  }

  function checkAuthorized(req) {
    return timingSafeEqualToken(extractHeaderToken(req), authToken);
  }

  function sendJson(req, res, statusCode, bodyObj) {
    const extOrigin = resolveAllowedExtensionOrigin(req.headers.origin);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    };
    if (extOrigin) {
      headers['Access-Control-Allow-Origin'] = extOrigin;
      headers['Vary'] = 'Origin';
    }
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    headers['Content-Length'] = String(payload.length);
    res.writeHead(statusCode, headers);
    res.end(payload);
  }

  function guessMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
      '.mp4': 'video/mp4'
    };
    return map[ext] || 'application/octet-stream';
  }

  function prepareUploadParams(stepParams) {
    const rawList = Array.isArray(stepParams.files)
      ? stepParams.files
      : typeof stepParams.file === 'string' && stepParams.file.trim()
        ? [stepParams.file]
        : [];
    if (rawList.length === 0) {
      throw new Error('upload requires at least one local file path');
    }

    const resolvedFiles = [];
    let totalBytes = 0;
    const statsList = [];

    for (const item of rawList) {
      const check = evaluateUploadFileSafety(String(item || ''));
      if (!check.allowed) {
        recordAudit('upload', { file: String(item || ''), code: check.code }, 'blocked');
        throw new Error(`[GUARDRAIL:${check.code}] ${check.reason}`);
      }
      let st;
      try {
        st = fs.statSync(check.resolvedPath);
      } catch {
        throw new Error(`Local file does not exist: ${check.resolvedPath}`);
      }
      if (!st.isFile()) {
        throw new Error(`Upload path is not a regular file: ${check.resolvedPath}`);
      }
      resolvedFiles.push(check.resolvedPath);
      totalBytes += st.size;
      statsList.push({ path: check.resolvedPath, size: st.size });
    }

    stepParams.files = resolvedFiles;
    // Attach lightweight paste/drop fallback payload when total size <= 3MB (for rich-text editors without <input type="file">)
    if (totalBytes > 0 && totalBytes <= 3 * 1024 * 1024) {
      stepParams.pasteFallback = statsList.map((f) => ({
        name: path.basename(f.path),
        mimeType: guessMimeType(f.path),
        base64: fs.readFileSync(f.path).toString('base64')
      }));
    }
  }

  function dispatchExtensionRpc(method, params = {}, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      if (!extensionPeer || extensionPeer.closed) {
        reject(
          new Error(
            'Chrome extension is not connected. Load the unpacked "extension/" directory in chrome://extensions and verify the pairing token.'
          )
        );
        return;
      }

      if (params && typeof params.url === 'string') {
        const safety = evaluateUrlSafety(params.url, state.customBlockedDomains);
        if (!safety.allowed) {
          recordAudit(method, { url: params.url, code: safety.code }, 'blocked');
          reject(new Error(`[GUARDRAIL:${safety.code}] ${safety.reason}`));
          return;
        }
      }

      try {
        if (method === 'upload') {
          prepareUploadParams(params);
        } else if (method === 'extract' && Array.isArray(params.urls)) {
          for (const rawUrl of params.urls) {
            const urlStr = String(rawUrl || '');
            const safety = evaluateUrlSafety(urlStr, state.customBlockedDomains);
            if (!safety.allowed) {
              recordAudit('extract', { url: urlStr, code: safety.code }, 'blocked');
              reject(new Error(`[GUARDRAIL:${safety.code}] ${safety.reason}`));
              return;
            }
          }
        } else if (method === 'batch' && Array.isArray(params.steps)) {
          for (const step of params.steps) {
            if (!step || typeof step !== 'object') continue;
            const stepAction = String(step.action || step.method || step.cmd || '').trim();
            if (typeof step.url === 'string') {
              const safety = evaluateUrlSafety(step.url, state.customBlockedDomains);
              if (!safety.allowed) {
                recordAudit('batch', { url: step.url, code: safety.code }, 'blocked');
                reject(new Error(`[GUARDRAIL:${safety.code}] ${safety.reason}`));
                return;
              }
            }
            if (stepAction === 'extract' && Array.isArray(step.urls)) {
              for (const rawUrl of step.urls) {
                const urlStr = String(rawUrl || '');
                const safety = evaluateUrlSafety(urlStr, state.customBlockedDomains);
                if (!safety.allowed) {
                  recordAudit('batch', { url: urlStr, code: safety.code }, 'blocked');
                  reject(new Error(`[GUARDRAIL:${safety.code}] ${safety.reason}`));
                  return;
                }
              }
            }
            if (stepAction === 'upload') {
              prepareUploadParams(step);
            }
          }
        }
      } catch (prepErr) {
        reject(prepErr);
        return;
      }

      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`Extension RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRpc.set(id, { resolve, reject, timer, method });
      const sent = extensionPeer.sendJson({
        type: 'rpc_request',
        id,
        method,
        params
      });
      if (!sent) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        reject(new Error('Failed to write RPC frame to Chrome extension WebSocket'));
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const boundPort = server.address()?.port ?? requestedPort;
    if (!isAllowedHostHeader(req.headers.host, boundPort)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden Host header');
      return;
    }

    // Block arbitrary web page cross-origin requests; only allow non-browser local clients or chrome-extension://
    if (req.headers.origin && !resolveAllowedExtensionOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Cross-origin web access is prohibited');
      return;
    }

    if (req.method === 'OPTIONS') {
      const extOrigin = resolveAllowedExtensionOrigin(req.headers.origin);
      if (!extOrigin) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': extOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Chrome-Live-Token, Authorization',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    const pathname = parsedUrl.pathname;

    // Unauthenticated minimal liveness ping (reveals zero sensitive state or tab titles)
    if (req.method === 'GET' && pathname === '/api/ping') {
      sendJson(req, res, 200, {
        ok: true,
        service: 'chrome-live-for-antigravity',
        extensionConnected: state.extensionConnected && Boolean(extensionPeer && !extensionPeer.closed)
      });
      return;
    }

    if (!checkAuthorized(req, parsedUrl)) {
      sendJson(req, res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Missing or invalid X-Chrome-Live-Token'
      });
      return;
    }

    try {
      if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/state')) {
        const snap = buildPublicSnapshot();
        snap.cachedFrameTabIds = Array.from(state.framesByTab.keys());
        if (parsedUrl.searchParams.get('includeFrame') === '1') {
          const targetFrame = resolveFrame(parsedUrl.searchParams.get('tabId'));
          if (targetFrame?.buffer) {
            snap.frameDataUrl = `data:${targetFrame.mimeType || 'image/jpeg'};base64,${targetFrame.buffer.toString('base64')}`;
            snap.frameTabId = targetFrame.tabId ?? null;
          }
        }
        sendJson(req, res, 200, snap);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        sendJson(req, res, 200, { ok: true, entries: auditLog });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/playbook') {
        const domain = parsedUrl.searchParams.get('domain') || '';
        sendJson(req, res, 200, { ok: true, ...listPlaybooks(domain) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/playbook') {
        const body = await readJsonBody(req);
        const action = String(body.action || '').trim();
        if (action === 'set_enabled') {
          const summary = setPlaybookEnabled(Boolean(body.enabled));
          recordAudit('playbook_toggle', { enabled: summary.enabled });
          sendJson(req, res, 200, { ok: true, ...summary });
          return;
        }
        if (action === 'save') {
          const saved = saveManualPlaybook(body);
          recordAudit('playbook_save', { domain: saved.domain });
          sendJson(req, res, 200, { ok: true, ...saved });
          return;
        }
        if (action === 'delete_item') {
          const updated = deletePlaybookItem(body);
          recordAudit('playbook_delete_item', { domain: body.domain || '', kind: body.kind || '' });
          sendJson(req, res, 200, { ok: true, ...updated });
          return;
        }
        if (action === 'clear') {
          const summary = clearPlaybooks(body.domain || '');
          recordAudit('playbook_clear', { domain: body.domain || '*' });
          sendJson(req, res, 200, { ok: true, ...summary });
          return;
        }
        sendJson(req, res, 400, { ok: false, error: `Unknown playbook action: ${action}` });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/frame') {
        const targetFrame = resolveFrame(parsedUrl.searchParams.get('tabId'));
        if (!targetFrame || !targetFrame.buffer) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const headers = {
          'Content-Type': targetFrame.mimeType || 'image/jpeg',
          'Content-Length': String(targetFrame.buffer.length),
          'Cache-Control': 'no-store'
        };
        if (typeof targetFrame.tabId === 'number') {
          headers['X-Chrome-Live-Tab-Id'] = String(targetFrame.tabId);
        }
        res.writeHead(200, headers);
        res.end(targetFrame.buffer);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/command') {
        const body = await readJsonBody(req);
        const method = String(body.method || body.cmd || '').trim();
        const params = body.params && typeof body.params === 'object' ? body.params : {};
        const defaultTimeoutMs = method === 'batch' || method === 'extract' ? 90000 : 28000;
        const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : defaultTimeoutMs;

        if (!method) {
          sendJson(req, res, 400, { ok: false, error: 'Missing command method' });
          return;
        }

        const result = await dispatchExtensionRpc(method, params, timeoutMs);
        if (result && typeof result === 'object') {
          if (result.learnedSelector && result.pageUrl) {
            learnInteractionSelector({
              url: result.pageUrl,
              label: result.learnedLabel,
              selector: result.learnedSelector
            });
          }
          if (method === 'batch' && Array.isArray(result.stepResults)) {
            for (const stepItem of result.stepResults) {
              const r = stepItem?.result;
              if (r && r.learnedSelector && r.pageUrl) {
                learnInteractionSelector({
                  url: r.pageUrl,
                  label: r.learnedLabel,
                  selector: r.learnedSelector
                });
              }
            }
          }
          const snapTarget = method === 'batch' && result.finalSnapshot ? result.finalSnapshot : result;
          if (snapTarget && typeof snapTarget.url === 'string') {
            learnFromPageVisit({
              url: snapTarget.url,
              title: snapTarget.title,
              elements: snapTarget.elements
            });
            const pb = lookupDomainPlaybook(snapTarget.url);
            if (pb) {
              result.playbook = pb;
              if (method === 'batch' && result.finalSnapshot) {
                result.finalSnapshot.playbook = pb;
              }
            }
          }
        }
        recordAudit(method, {
          tabId: params.tabId ?? result?.tabId ?? null,
          url: params.url ?? undefined,
          label: params.label ?? params.summary ?? undefined
        });
        sendJson(req, res, 200, { ok: true, result });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/shutdown') {
        recordAudit('daemon_shutdown', { by: 'local_api' });
        sendJson(req, res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => {
          closeDaemonGracefully();
        }, 60);
        return;
      }

      sendJson(req, res, 404, { ok: false, error: `Route not found: ${pathname}` });
    } catch (err) {
      sendJson(req, res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.on('close', () => upgradeSockets.delete(socket));
    const boundPort = server.address()?.port ?? requestedPort;
    if (!isAllowedHostHeader(req.headers.host, boundPort)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.headers.origin && !resolveAllowedExtensionOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    if (parsedUrl.searchParams.has('token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const pathname = parsedUrl.pathname;
    if (pathname !== '/ws/extension' && pathname !== '/ws/live') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headerToken = extractHeaderToken(req);
    let preAuthed = false;
    if (headerToken) {
      if (!timingSafeEqualToken(headerToken, authToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      preAuthed = true;
    }

    const peer = upgradeHttpToWebSocket(req, socket, head, { requireMask: true });
    if (!peer) return;
    peer.on('error', () => {});

    const attachAuthenticatedPeer = (authPayload = null) => {
      if (pathname === '/ws/extension') {
        if (extensionPeer && !extensionPeer.closed) {
          extensionPeer.close(1000, 'Replaced by newer extension connection');
        }
        extensionPeer = peer;
        state.extensionConnected = true;
        state.connectedAt = Date.now();
        state.updatedAt = Date.now();
        recordAudit('extension_connected', {});
        if (authPayload) {
          handleExtensionMessage({ ...authPayload, type: 'hello' });
        } else {
          broadcastToLivePeers({ type: 'state', snapshot: buildPublicSnapshot() });
        }

        peer.on('close', () => {
          if (extensionPeer === peer) {
            extensionPeer = null;
            state.extensionConnected = false;
            state.updatedAt = Date.now();
            for (const [id, entry] of pendingRpc.entries()) {
              clearTimeout(entry.timer);
              entry.reject(new Error('Extension WebSocket disconnected during RPC'));
              pendingRpc.delete(id);
            }
            broadcastToLivePeers({ type: 'state', snapshot: buildPublicSnapshot() });
          }
        });
        return;
      }

      liveViewPeers.add(peer);
      peer.sendJson({ type: 'state', snapshot: buildPublicSnapshot() });
      if (state.latestFrame && state.latestFrame.buffer) {
        peer.sendJson({
          type: 'frame',
          tabId: state.latestFrame.tabId,
          mimeType: state.latestFrame.mimeType,
          data: state.latestFrame.buffer.toString('base64'),
          title: state.latestFrame.title,
          url: state.latestFrame.url,
          activity: state.latestFrame.activity,
          capturedAt: state.latestFrame.capturedAt
        });
      }
      peer.on('close', () => {
        liveViewPeers.delete(peer);
      });
    };

    let authenticated = preAuthed;
    let pendingChallenge = null; // { clientNonce, serverNonce }
    let authTimer = null;
    if (authenticated) {
      attachAuthenticatedPeer(null);
    } else {
      authTimer = setTimeout(() => {
        if (!authenticated && !peer.closed) {
          peer.close(4001, 'Authentication timeout');
        }
      }, 3000);
      authTimer.unref();
      peer.on('close', () => {
        if (authTimer) clearTimeout(authTimer);
      });
    }

    peer.on('message', (rawText) => {
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch {
        if (!authenticated) peer.close(4001, 'Invalid auth payload');
        return;
      }
      if (!authenticated) {
        // Mutual HMAC-SHA256 challenge-response (zero plaintext token over WebSocket)
        if (msg && msg.type === 'auth_init' && !pendingChallenge) {
          const clientNonce = typeof msg.clientNonce === 'string' ? msg.clientNonce.trim() : '';
          if (clientNonce.length < 16 || clientNonce.length > 128) {
            if (authTimer) clearTimeout(authTimer);
            peer.close(4001, 'Invalid client nonce');
            return;
          }
          const serverNonce = crypto.randomBytes(32).toString('hex');
          pendingChallenge = { clientNonce, serverNonce };
          const serverProof = computeChallengeHmac(authToken, 'server', clientNonce, serverNonce);
          peer.sendJson({ type: 'auth_challenge', serverNonce, serverProof });
          return;
        }
        if (msg && msg.type === 'auth_response' && pendingChallenge) {
          const clientProof = typeof msg.clientProof === 'string' ? msg.clientProof.trim() : '';
          const expectedClientProof = computeChallengeHmac(
            authToken,
            'client',
            pendingChallenge.clientNonce,
            pendingChallenge.serverNonce
          );
          if (!timingSafeEqualToken(clientProof, expectedClientProof)) {
            if (authTimer) clearTimeout(authTimer);
            peer.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;
          pendingChallenge = null;
          if (authTimer) {
            clearTimeout(authTimer);
            authTimer = null;
          }
          attachAuthenticatedPeer(msg);
          return;
        }
        if (authTimer) clearTimeout(authTimer);
        peer.close(4001, 'Unauthorized');
        return;
      }
      if (pathname === '/ws/extension') {
        handleExtensionMessage(msg);
      }
    });
  });

  function handleExtensionMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'rpc_response' && msg.id) {
      const pending = pendingRpc.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRpc.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || `Extension command "${pending.method}" failed`));
      }
      return;
    }

    if (msg.type === 'hello' || msg.type === 'status_sync') {
      if (typeof msg.version === 'string') state.extensionVersion = msg.version;
      if (Array.isArray(msg.tabs)) {
        state.tabs = msg.tabs;
        pruneClosedTabFrames(state.tabs);
      }
      if (msg.activeTabId !== undefined) state.activeTabId = msg.activeTabId;
      if (Array.isArray(msg.customBlockedDomains)) {
        state.customBlockedDomains = msg.customBlockedDomains.slice(0, 200);
      }
      state.updatedAt = Date.now();
      broadcastToLivePeers({ type: 'state', snapshot: buildPublicSnapshot() });
      return;
    }

    if (msg.type === 'screencast_frame' && typeof msg.data === 'string' && msg.data.length > 0) {
      const mimeType = msg.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const buffer = Buffer.from(msg.data, 'base64');
      const frame = {
        tabId: msg.tabId ?? null,
        mimeType,
        buffer,
        title: String(msg.title || ''),
        url: String(msg.url || ''),
        activity: String(msg.activity || ''),
        capturedAt: Date.now()
      };
      storeTabFrame(frame);
      state.updatedAt = Date.now();
      broadcastToLivePeers({
        type: 'frame',
        tabId: frame.tabId,
        mimeType,
        data: msg.data,
        title: frame.title,
        url: frame.url,
        activity: frame.activity,
        capturedAt: frame.capturedAt
      });
      return;
    }

    if (msg.type === 'guardrail_trip') {
      recordAudit('guardrail_trip', {
        tabId: msg.tabId ?? null,
        url: msg.url ?? '',
        reason: msg.reason ?? ''
      }, 'blocked');
    }
  }

  const heartbeatTimer = setInterval(() => {
    if (extensionPeer && !extensionPeer.closed) {
      extensionPeer.ping();
    }
    for (const peer of liveViewPeers) {
      if (!peer.closed) peer.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  let closed = false;
  function closeDaemonGracefully() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(heartbeatTimer);
    if (extensionPeer && !extensionPeer.closed) {
      extensionPeer.close(1001, 'Daemon shutting down');
    }
    for (const peer of liveViewPeers) {
      peer.close(1001, 'Daemon shutting down');
    }
    liveViewPeers.clear();
    for (const sock of upgradeSockets) {
      try {
        sock.destroy();
      } catch {}
    }
    upgradeSockets.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    authToken,
    getSnapshot: buildPublicSnapshot,
    dispatchExtensionRpc,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : requestedPort);
        });
      });
    },
    close: closeDaemonGracefully
  };
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const pidFile = path.join(getStateDir(), 'daemon.pid');
  const instance = createDaemonServer();
  instance
    .listen()
    .then((boundPort) => {
      fs.mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
      process.stdout.write(
        `[chrome-live] Listening on http://${DEFAULT_HOST}:${boundPort} (PID ${process.pid})\n`
      );
      const cleanExit = () => {
        try {
          if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch {}
        instance.close().finally(() => process.exit(0));
      };
      process.on('SIGINT', cleanExit);
      process.on('SIGTERM', cleanExit);
    })
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') {
        process.stdout.write(`[chrome-live] Port ${DEFAULT_PORT} is already active.\n`);
        process.exit(0);
      }
      process.stderr.write(`[chrome-live] Failed to start daemon: ${err.message}\n`);
      process.exit(1);
    });
}
