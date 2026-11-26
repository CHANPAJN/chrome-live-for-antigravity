import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { evaluateUploadFileSafety, evaluateUrlSafety, redactUrlForAudit, redactUrlsInText } from './guardrails.mjs';
import {
  computeChallengeHmac,
  computeHttpResponseHmac,
  createReplayProtectedVerifier,
  sha256Hex,
  verifySignedHttpResponse,
  buildSignedHttpHeaders
} from './hmac-auth.mjs';
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
  ensureSecureDirSync,
  getStateDir,
  tightenFileAclSync,
  timingSafeEqualToken
} from './token-store.mjs';
import { upgradeHttpToWebSocket } from './ws-codec.mjs';

const MAX_AUDIT_ENTRIES = 80;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 25000;
const __daemonFilename = fileURLToPath(import.meta.url);
const REPO_ROOT_DIR = path.resolve(path.dirname(__daemonFilename), '..');

export { computeChallengeHmac };

function consumeAndShredLocalRuntimeBootstrap(targetFile) {
  const runtimeFile = targetFile || path.join(REPO_ROOT_DIR, 'extension', '.local-runtime.json');
  try {
    if (fs.existsSync(runtimeFile)) {
      const st = fs.statSync(runtimeFile);
      if (st.isFile() && st.size > 0) {
        fs.writeFileSync(runtimeFile, Buffer.alloc(st.size, 0));
      }
      fs.unlinkSync(runtimeFile);
    }
  } catch {}
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

function parseValidExtensionOrigin(originHeader) {
  if (!originHeader) return null;
  const trimmed = String(originHeader).trim();
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

const URL_FIELD_KEYS = new Set(['url', 'pageUrl', 'finalUrl', 'href', 'targetUrl', 'frameUrl']);
const URL_ARRAY_KEYS = new Set(['urls', 'images']);
const TEXT_URL_SCRUB_KEYS = new Set([
  'error',
  'excerpt',
  'text',
  'summary',
  'title',
  'label',
  'clicked',
  'learnedLabel'
]);

const BINARY_PAYLOAD_KEYS = new Set(['data', 'base64', 'frameDataUrl']);

function redactPayloadUrls(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return node;
  if (Array.isArray(node)) {
    return node.map((item) => (typeof item === 'string' ? redactUrlsInText(item) : redactPayloadUrls(item, depth + 1)));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (BINARY_PAYLOAD_KEYS.has(k)) {
      out[k] = v;
    } else if (URL_FIELD_KEYS.has(k) && typeof v === 'string') {
      out[k] = redactUrlForAudit(v);
    } else if (URL_ARRAY_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v.map((u) => (typeof u === 'string' ? redactUrlForAudit(u) : u));
    } else if (k === 'routes' && v && typeof v === 'object' && !Array.isArray(v)) {
      const cleanRoutes = {};
      for (const [rk, rv] of Object.entries(v)) {
        const cleanKey = redactUrlsInText(String(rk));
        cleanRoutes[cleanKey] = typeof rv === 'string' ? redactUrlForAudit(rv) : rv;
      }
      out[k] = cleanRoutes;
    } else if (typeof v === 'string') {
      out[k] = redactUrlsInText(v);
    } else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
      out[k] = redactPayloadUrls(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readRawBody(req) {
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
      resolve(total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseJsonBuffer(rawBuf) {
  if (!rawBuf || rawBuf.length === 0) return {};
  try {
    return JSON.parse(rawBuf.toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err.message}`);
  }
}

export function createDaemonServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const resolveInstanceStateDir = () =>
    options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const resolveBootstrapPath = () =>
    options.runtimeBootstrapPath
      ? path.resolve(String(options.runtimeBootstrapPath))
      : options.stateDir
        ? path.join(path.resolve(String(options.stateDir)), '.local-runtime.json')
        : path.join(REPO_ROOT_DIR, 'extension', '.local-runtime.json');
  const resolveAuthToken = () =>
    typeof options.token === 'function'
      ? String(options.token() || '').trim()
      : options.token
        ? String(options.token)
        : ensureAuthToken();

  // Sweep any orphan `.upload-snapshots` left behind by an abruptly terminated prior daemon process
  try {
    const staleSnapRoot = path.join(resolveInstanceStateDir(), '.upload-snapshots');
    if (fs.existsSync(staleSnapRoot)) {
      fs.rmSync(staleSnapRoot, { recursive: true, force: true });
    }
  } catch {}

  let extensionPeer = null;
  let activeExtensionOrigin = null;
  let lastKnownTokenDigest = sha256Hex(resolveAuthToken());
  const liveViewPeers = new Set();
  const unauthedWsPeers = new Set();
  const upgradeSockets = new Set();
  const pendingRpc = new Map();
  const auditLog = [];

  function resolveAllowedExtensionOrigin(originHeader) {
    const parsedOrigin = parseValidExtensionOrigin(originHeader);
    if (!parsedOrigin || !activeExtensionOrigin) return null;
    if (parsedOrigin !== activeExtensionOrigin) return null;
    return String(originHeader).trim();
  }

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

  function resetExtensionSessionState() {
    activeExtensionOrigin = null;
    state.extensionConnected = false;
    state.activeTabId = null;
    state.tabs = [];
    state.latestFrame = null;
    state.framesByTab.clear();
    auditLog.length = 0;
    state.updatedAt = Date.now();
  }

  function evictStaleTokenPeers() {
    const currentDigest = sha256Hex(resolveAuthToken());
    if (currentDigest !== lastKnownTokenDigest) {
      lastKnownTokenDigest = currentDigest;
      resetExtensionSessionState();
    }
    if (extensionPeer && !extensionPeer.closed && extensionPeer._tokenDigest !== currentDigest) {
      resetExtensionSessionState();
      extensionPeer.close(4001, 'Auth token rotated');
    }
    for (const peer of Array.from(liveViewPeers)) {
      if (!peer.closed && peer._tokenDigest !== currentDigest) {
        liveViewPeers.delete(peer);
        peer.close(4001, 'Auth token rotated');
      }
    }
  }

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
    if (!Array.isArray(liveTabs)) return;
    const unpausedLiveIds = new Set(
      liveTabs
        .filter((t) => t && typeof t.tabId === 'number' && !t.paused)
        .map((t) => t.tabId)
    );
    for (const cachedId of Array.from(state.framesByTab.keys())) {
      if (!unpausedLiveIds.has(cachedId)) {
        state.framesByTab.delete(cachedId);
      }
    }
    if (
      state.latestFrame &&
      typeof state.latestFrame.tabId === 'number' &&
      !unpausedLiveIds.has(state.latestFrame.tabId)
    ) {
      const remaining = Array.from(state.framesByTab.values());
      state.latestFrame = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  function recordAudit(action, detail = {}, status = 'ok') {
    const safeDetail =
      detail && typeof detail === 'object'
        ? redactPayloadUrls(detail)
        : typeof detail === 'string'
          ? redactUrlsInText(detail)
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
    const frameTimestampsByTab = {};
    for (const [tid, frm] of state.framesByTab.entries()) {
      if (frm && typeof frm.capturedAt === 'number') {
        frameTimestampsByTab[tid] = frm.capturedAt;
      }
    }
    return {
      ok: true,
      daemonPid: process.pid,
      port: server.address()?.port ?? requestedPort,
      extensionConnected: state.extensionConnected && Boolean(extensionPeer && !extensionPeer.closed),
      extensionVersion: state.extensionVersion,
      connectedAt: state.connectedAt,
      updatedAt: state.updatedAt,
      activeTabId: state.activeTabId,
      tabs: Array.isArray(state.tabs)
        ? state.tabs.map((t) =>
            t && typeof t === 'object'
              ? {
                  ...t,
                  ...(typeof t.url === 'string' ? { url: redactUrlForAudit(t.url) } : {}),
                  ...(typeof t.title === 'string' ? { title: redactUrlsInText(t.title) } : {})
                }
              : t
          )
        : [],
      hasFrame: Boolean(state.latestFrame),
      cachedFrameTabIds: Array.from(state.framesByTab.keys()),
      frameTimestampsByTab,
      latestFrameMeta: state.latestFrame
        ? {
            tabId: state.latestFrame.tabId,
            title: redactUrlsInText(String(state.latestFrame.title || '')),
            url: redactUrlForAudit(state.latestFrame.url),
            activity: state.latestFrame.activity,
            capturedAt: state.latestFrame.capturedAt
          }
        : null,
      playbook: getPlaybookSummary(resolveInstanceStateDir()),
      recentAudit: auditLog.slice(0, 20)
    };
  }

  const LIVE_PEER_SOFT_BACKPRESSURE = 2 * 1024 * 1024;
  const LIVE_PEER_HARD_BACKPRESSURE = 8 * 1024 * 1024;

  function broadcastToLivePeers(payload) {
    if (liveViewPeers.size === 0) return;
    const text = JSON.stringify(payload);
    for (const peer of Array.from(liveViewPeers)) {
      if (peer.closed) {
        liveViewPeers.delete(peer);
        continue;
      }
      const queued = peer.socket?.writableLength ?? 0;
      if (queued > LIVE_PEER_HARD_BACKPRESSURE) {
        liveViewPeers.delete(peer);
        peer.close(1008, 'Live stream consumer backpressure exceeded');
        continue;
      }
      if (queued > LIVE_PEER_SOFT_BACKPRESSURE && payload && payload.type === 'frame') {
        // Drop intermediate video frame for slow viewer rather than growing heap unboundedly
        continue;
      }
      peer.sendText(text);
    }
  }

  const verifyHttpHmac = createReplayProtectedVerifier(resolveAuthToken);

  function attachServerProofHeader(req, statusCode, headers) {
    if (req._hmacAuth?.ts && req._hmacAuth?.nonce) {
      headers['X-Chrome-Live-Server-Sig'] = computeHttpResponseHmac(
        resolveAuthToken(),
        statusCode,
        req._hmacAuth.ts,
        req._hmacAuth.nonce
      );
    }
  }

  function sendJson(req, res, statusCode, bodyObj) {
    const extOrigin = resolveAllowedExtensionOrigin(req.headers.origin);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff'
    };
    if (extOrigin) {
      headers['Access-Control-Allow-Origin'] = extOrigin;
      headers['Access-Control-Expose-Headers'] = 'X-Chrome-Live-Server-Sig';
      headers['Vary'] = 'Origin';
    }
    attachServerProofHeader(req, statusCode, headers);
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

  const MAX_FILES_PER_REQUEST = 16;
  const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024 * 1024;

  function prepareUploadParams(stepParams, cleanupDirs = [], budget = { count: 0, bytes: 0 }) {
    const rawList = Array.isArray(stepParams.files)
      ? stepParams.files
      : typeof stepParams.file === 'string' && stepParams.file.trim()
        ? [stepParams.file]
        : [];
    if (rawList.length === 0) {
      throw new Error('upload requires at least one local file path');
    }
    if (budget.count + rawList.length > MAX_FILES_PER_REQUEST) {
      throw new Error(`Upload exceeds maximum ${MAX_FILES_PER_REQUEST} files per request`);
    }

    const snapshotsRoot = ensureSecureDirSync(path.join(resolveInstanceStateDir(), '.upload-snapshots'));
    const batchSnapDir = ensureSecureDirSync(path.join(snapshotsRoot, crypto.randomUUID()));
    cleanupDirs.push(batchSnapDir);

    const resolvedFiles = [];
    let totalBytes = 0;
    const filePayloads = [];
    const openFlags = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

    for (let idx = 0; idx < rawList.length; idx++) {
      const item = rawList[idx];
      const check = evaluateUploadFileSafety(String(item || ''), { stateDir: resolveInstanceStateDir() });
      if (!check.allowed) {
        recordAudit('upload', { file: String(item || ''), code: check.code }, 'blocked');
        throw new Error(`[GUARDRAIL:${check.code}] ${check.reason}`);
      }
      let fd;
      try {
        fd = fs.openSync(check.resolvedPath, openFlags);
      } catch {
        throw new Error(`Local file does not exist or symlink was rejected: ${check.resolvedPath}`);
      }
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
          throw new Error(`Upload path is not a regular file: ${check.resolvedPath}`);
        }
        // Secondary post-open canonical & symlink verification (covers Windows where O_NOFOLLOW is 0)
        const lstatAfterOpen = fs.lstatSync(check.resolvedPath);
        if (lstatAfterOpen.isSymbolicLink()) {
          throw new Error('[GUARDRAIL:SYMLINK_BLOCKED] Uploading symbolic links is blocked by local guardrails');
        }
        const realAfterOpen = (fs.realpathSync.native || fs.realpathSync)(check.resolvedPath);
        if (
          (process.platform === 'win32'
            ? realAfterOpen.toLowerCase() !== check.resolvedPath.toLowerCase()
            : realAfterOpen !== check.resolvedPath)
        ) {
          throw new Error('[GUARDRAIL:SYMLINK_BLOCKED] Upload path canonical target changed during open');
        }
        if (typeof st.nlink === 'number' && st.nlink > 1) {
          recordAudit('upload', { file: String(item || ''), code: 'HARDLINK_BLOCKED' }, 'blocked');
          throw new Error('[GUARDRAIL:HARDLINK_BLOCKED] Uploading hard-linked files (nlink > 1) is blocked by local guardrails');
        }
        if (st.size > MAX_UPLOAD_SNAPSHOT_BYTES || budget.bytes + st.size > MAX_UPLOAD_SNAPSHOT_BYTES) {
          throw new Error(`Upload total size exceeds ${MAX_UPLOAD_SNAPSHOT_BYTES} byte limit`);
        }
        budget.count += 1;
        budget.bytes += st.size;

        // Freeze an immutable private copy directly from the verified fd so subsequent symlink swaps
        // (e.g. during multi-step batch waits before Chrome calls DOM.setFileInputFiles) cannot cause TOCTOU escape!
        const itemSlotDir = ensureSecureDirSync(path.join(batchSnapDir, String(idx)));
        const safeBaseName = path.basename(check.resolvedPath).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'upload.bin';
        const privateCopyPath = path.join(itemSlotDir, safeBaseName);
        const buf = st.size > 0 ? Buffer.allocUnsafe(st.size) : Buffer.alloc(0);
        let offset = 0;
        while (offset < st.size) {
          const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
          if (n <= 0) break;
          offset += n;
        }
        const exactBuf = offset === buf.length ? buf : buf.subarray(0, offset);
        fs.writeFileSync(privateCopyPath, exactBuf, { mode: 0o600 });
        tightenFileAclSync(privateCopyPath);

        resolvedFiles.push(privateCopyPath);
        totalBytes += exactBuf.length;
        if (exactBuf.length > 0 && totalBytes <= 3 * 1024 * 1024) {
          filePayloads.push({
            name: safeBaseName,
            mimeType: guessMimeType(check.resolvedPath),
            base64: exactBuf.toString('base64')
          });
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    stepParams.files = resolvedFiles;
    // Attach lightweight paste/drop fallback payload when total size <= 3MB (for rich-text editors without <input type="file">)
    if (totalBytes > 0 && totalBytes <= 3 * 1024 * 1024 && filePayloads.length === resolvedFiles.length) {
      stepParams.pasteFallback = filePayloads;
    }
  }

  function dispatchExtensionRpc(method, params = {}, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      evictStaleTokenPeers();
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

      const uploadCleanupDirs = [];
      const uploadBudget = { count: 0, bytes: 0 };
      const purgeUploadSnapshots = () => {
        for (const d of uploadCleanupDirs) {
          try {
            fs.rmSync(d, { recursive: true, force: true });
          } catch {}
        }
        uploadCleanupDirs.length = 0;
      };

      try {
        if (method === 'upload') {
          prepareUploadParams(params, uploadCleanupDirs, uploadBudget);
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
          const ALLOWED_BATCH_STEP_ACTIONS = new Set([
            'open',
            'navigate',
            'type',
            'click',
            'upload',
            'scroll',
            'wait',
            'snapshot',
            'screenshot',
            'done'
          ]);
          for (const step of params.steps) {
            if (!step || typeof step !== 'object') continue;
            const stepAction = String(step.action || step.method || step.cmd || '').trim();
            if (!ALLOWED_BATCH_STEP_ACTIONS.has(stepAction)) {
              purgeUploadSnapshots();
              reject(
                new Error(
                  `[GUARDRAIL:FORBIDDEN_BATCH_ACTION] Action "${stepAction}" is not permitted inside batch pipelines`
                )
              );
              return;
            }
            if (typeof step.url === 'string') {
              const safety = evaluateUrlSafety(step.url, state.customBlockedDomains);
              if (!safety.allowed) {
                purgeUploadSnapshots();
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
                  purgeUploadSnapshots();
                  recordAudit('batch', { url: urlStr, code: safety.code }, 'blocked');
                  reject(new Error(`[GUARDRAIL:${safety.code}] ${safety.reason}`));
                  return;
                }
              }
            }
            if (stepAction === 'upload') {
              prepareUploadParams(step, uploadCleanupDirs, uploadBudget);
            }
          }
        }
      } catch (prepErr) {
        purgeUploadSnapshots();
        reject(prepErr);
        return;
      }

      const id = crypto.randomUUID();
      const wrapResolve = (val) => {
        purgeUploadSnapshots();
        resolve(val);
      };
      const wrapReject = (err) => {
        purgeUploadSnapshots();
        reject(err);
      };
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        wrapReject(new Error(`Extension RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRpc.set(id, { resolve: wrapResolve, reject: wrapReject, timer, method });
      const sent = extensionPeer.sendJson({
        type: 'rpc_request',
        id,
        method,
        params
      });
      if (!sent) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        wrapReject(new Error('Failed to write RPC frame to Chrome extension WebSocket'));
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

    // Block arbitrary web page requests (including cross-site and same-site cross-port `http://127.0.0.1:<other>` probes)
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    const hasValidExtOrigin = Boolean(parseValidExtensionOrigin(req.headers.origin));
    if (
      (req.headers.origin && !hasValidExtOrigin) ||
      ((secFetchSite === 'cross-site' || secFetchSite === 'same-site') && !hasValidExtOrigin)
    ) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff'
      });
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
        'Access-Control-Allow-Headers': 'Content-Type, X-Chrome-Live-Ts, X-Chrome-Live-Nonce, X-Chrome-Live-Hdr-Sig, X-Chrome-Live-Sig',
        'Access-Control-Expose-Headers': 'X-Chrome-Live-Server-Sig',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    const pathname = parsedUrl.pathname;

    // Unauthenticated minimal liveness ping (reveals zero sensitive state, blocks cross-site no-cors probing via CORP)
    if (req.method === 'GET' && pathname === '/api/ping') {
      const pingPayload = Buffer.from(JSON.stringify({ ok: true, service: 'chrome-live-for-antigravity' }), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(pingPayload.length)
      });
      res.end(pingPayload);
      return;
    }

    evictStaleTokenPeers();

    if (parsedUrl.searchParams.has('token')) {
      sendJson(req, res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Query-string token authentication is prohibited'
      });
      req.destroy();
      return;
    }

    const pathWithQuery = `${pathname}${parsedUrl.search}`;
    // Cryptographically verify header HMAC BEFORE buffering a single byte of POST body (blocks unauthenticated 12MBxN memory DoS)
    const prechecked = verifyHttpHmac.precheckHeaders(req, pathWithQuery);
    if (!prechecked.ok) {
      sendJson(req, res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
        message: prechecked.reason
      });
      res.once('finish', () => {
        try {
          req.destroy();
        } catch {}
      });
      return;
    }

    let rawBody = Buffer.alloc(0);
    try {
      if (req.method === 'POST') {
        rawBody = await readRawBody(req);
      }
    } catch (readErr) {
      sendJson(req, res, 400, { ok: false, error: readErr.message });
      return;
    }

    const authCheck = verifyHttpHmac.verifyBody(req, pathWithQuery, rawBody, prechecked);
    if (!authCheck.ok) {
      sendJson(req, res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
        message: authCheck.reason
      });
      return;
    }
    const verifiedHttpExtOrigin = parseValidExtensionOrigin(req.headers.origin);
    if (verifiedHttpExtOrigin) {
      activeExtensionOrigin = verifiedHttpExtOrigin;
    }
    req._hmacAuth = authCheck;

    try {
      if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/state')) {
        const snap = buildPublicSnapshot();
        if (parsedUrl.searchParams.get('includeFrame') === '1') {
          const targetFrame = resolveFrame(parsedUrl.searchParams.get('tabId'));
          if (targetFrame?.buffer) {
            snap.frameDataUrl = `data:${targetFrame.mimeType || 'image/jpeg'};base64,${targetFrame.buffer.toString('base64')}`;
            snap.frameTabId = targetFrame.tabId ?? null;
            snap.frameCapturedAt = targetFrame.capturedAt ?? 0;
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
        sendJson(req, res, 200, { ok: true, ...listPlaybooks(domain, resolveInstanceStateDir()) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/playbook') {
        const body = parseJsonBuffer(rawBody);
        const action = String(body.action || '').trim();
        const instanceDir = resolveInstanceStateDir();
        if (action === 'set_enabled') {
          const summary = setPlaybookEnabled(Boolean(body.enabled), instanceDir);
          recordAudit('playbook_toggle', { enabled: summary.enabled });
          sendJson(req, res, 200, { ok: true, ...summary });
          return;
        }
        if (action === 'save') {
          const saved = saveManualPlaybook({
            ...body,
            customBlockedDomains: state.customBlockedDomains,
            stateDir: instanceDir
          });
          recordAudit('playbook_save', { domain: saved.domain });
          sendJson(req, res, 200, { ok: true, ...saved });
          return;
        }
        if (action === 'delete_item') {
          const updated = deletePlaybookItem({ ...body, stateDir: instanceDir });
          recordAudit('playbook_delete_item', { domain: body.domain || '', kind: body.kind || '' });
          sendJson(req, res, 200, { ok: true, ...updated });
          return;
        }
        if (action === 'clear') {
          const summary = clearPlaybooks(body.domain || '', instanceDir);
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
          const noContentHeaders = {
            'Cache-Control': 'no-store',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff'
          };
          attachServerProofHeader(req, 204, noContentHeaders);
          res.writeHead(204, noContentHeaders);
          res.end();
          return;
        }
        const headers = {
          'Content-Type': targetFrame.mimeType || 'image/jpeg',
          'Content-Length': String(targetFrame.buffer.length),
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff'
        };
        if (typeof targetFrame.tabId === 'number') {
          headers['X-Chrome-Live-Tab-Id'] = String(targetFrame.tabId);
        }
        attachServerProofHeader(req, 200, headers);
        res.writeHead(200, headers);
        res.end(targetFrame.buffer);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/command') {
        const body = parseJsonBuffer(rawBody);
        const method = String(body.method || body.cmd || '').trim();
        const params = body.params && typeof body.params === 'object' ? body.params : {};
        const defaultTimeoutMs = method === 'batch' || method === 'extract' ? 90000 : 28000;
        const timeoutMs =
          Number(body.timeoutMs) > 0 ? Math.min(120000, Math.max(1000, Number(body.timeoutMs))) : defaultTimeoutMs;

        if (!method) {
          sendJson(req, res, 400, { ok: false, error: 'Missing command method' });
          return;
        }

        const instanceDir = resolveInstanceStateDir();
        const result = await dispatchExtensionRpc(method, params, timeoutMs);
        if (result && typeof result === 'object') {
          if (result.learnedSelector && result.pageUrl) {
            learnInteractionSelector({
              url: result.pageUrl,
              label: result.learnedLabel,
              selector: result.learnedSelector,
              customBlockedDomains: state.customBlockedDomains,
              stateDir: instanceDir
            });
          }
          if (method === 'batch' && Array.isArray(result.stepResults)) {
            for (const stepItem of result.stepResults) {
              const r = stepItem?.result;
              if (r && r.learnedSelector && r.pageUrl) {
                learnInteractionSelector({
                  url: r.pageUrl,
                  label: r.learnedLabel,
                  selector: r.learnedSelector,
                  customBlockedDomains: state.customBlockedDomains,
                  stateDir: instanceDir
                });
              }
            }
          }
          const snapTarget = method === 'batch' && result.finalSnapshot ? result.finalSnapshot : result;
          if (snapTarget && typeof snapTarget.url === 'string') {
            learnFromPageVisit({
              url: snapTarget.url,
              title: snapTarget.title,
              elements: snapTarget.elements,
              customBlockedDomains: state.customBlockedDomains,
              stateDir: instanceDir
            });
            const pb = lookupDomainPlaybook(snapTarget.url, state.customBlockedDomains, instanceDir);
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
        sendJson(req, res, 200, { ok: true, result: redactPayloadUrls(result) });
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
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      sendJson(req, res, 500, {
        ok: false,
        error: redactUrlsInText(rawErrMsg)
      });
    }
  });

  server.headersTimeout = 8000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;

  server.on('upgrade', (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.on('close', () => upgradeSockets.delete(socket));
    const boundPort = server.address()?.port ?? requestedPort;
    if (!isAllowedHostHeader(req.headers.host, boundPort)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const wsSecFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    const wsHasExtOrigin = Boolean(parseValidExtensionOrigin(req.headers.origin));
    if (
      (req.headers.origin && !wsHasExtOrigin) ||
      ((wsSecFetchSite === 'cross-site' || wsSecFetchSite === 'same-site') && !wsHasExtOrigin)
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    if (
      parsedUrl.searchParams.has('token') ||
      req.headers['x-chrome-live-token'] ||
      req.headers.authorization
    ) {
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

    if (unauthedWsPeers.size >= 24) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Cap pre-authentication WS payload at 4KB and <=16 fragments; expand only after mutual HMAC handshake succeeds
    const peer = upgradeHttpToWebSocket(req, socket, head, {
      requireMask: true,
      maxPayloadBytes: 4096,
      maxFragments: 16
    });
    if (!peer) return;
    unauthedWsPeers.add(peer);
    peer.on('close', () => unauthedWsPeers.delete(peer));
    peer.on('error', () => {});

    const attachAuthenticatedPeer = (authPayload = null, verifiedToken = '') => {
      unauthedWsPeers.delete(peer);
      peer._tokenDigest = sha256Hex(verifiedToken);
      peer.maxPayloadBytes = 16 * 1024 * 1024;
      peer.maxFragments = 512;
      if (pathname === '/ws/extension') {
        const verifiedOrigin = parseValidExtensionOrigin(req.headers.origin);
        if (verifiedOrigin) {
          activeExtensionOrigin = verifiedOrigin;
        }
        // Extension has persisted the pairing token into chrome.storage.local; shred any leftover bootstrap file
        consumeAndShredLocalRuntimeBootstrap(resolveBootstrapPath());
        if (extensionPeer && !extensionPeer.closed) {
          // Close code 4009 instructs the older browser profile not to auto-reconnect in a loop
          extensionPeer.close(4009, 'Replaced by another browser profile');
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
            resetExtensionSessionState();
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
          url: redactUrlForAudit(state.latestFrame.url),
          activity: state.latestFrame.activity,
          capturedAt: state.latestFrame.capturedAt
        });
      }
      peer.on('close', () => {
        liveViewPeers.delete(peer);
      });
    };

    let authenticated = false;
    let pendingChallenge = null; // { clientNonce, serverNonce }
    let authTimer = setTimeout(() => {
      if (!authenticated && !peer.closed) {
        peer.close(4001, 'Authentication timeout');
      }
    }, 3000);
    authTimer.unref();
    peer.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
    });

    peer.on('message', (rawText) => {
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch {
        if (!authenticated) peer.close(4001, 'Invalid auth payload');
        return;
      }
      if (!authenticated) {
        const curToken = resolveAuthToken();
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
          const serverProof = computeChallengeHmac(curToken, 'server', clientNonce, serverNonce);
          peer.sendJson({ type: 'auth_challenge', serverNonce, serverProof });
          return;
        }
        if (msg && msg.type === 'auth_response' && pendingChallenge) {
          const clientProof = typeof msg.clientProof === 'string' ? msg.clientProof.trim() : '';
          const expectedClientProof = computeChallengeHmac(
            curToken,
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
          attachAuthenticatedPeer(msg, curToken);
          return;
        }
        if (authTimer) clearTimeout(authTimer);
        peer.close(4001, 'Unauthorized');
        return;
      }
      if (peer._tokenDigest !== sha256Hex(resolveAuthToken())) {
        evictStaleTokenPeers();
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
      // Strict active-tab allowlist: drop any frame missing a valid integer tabId or belonging to a paused/released tab
      if (typeof msg.tabId !== 'number' || !Number.isInteger(msg.tabId)) {
        return;
      }
      const matchingTab = Array.isArray(state.tabs) ? state.tabs.find((t) => t && t.tabId === msg.tabId) : null;
      if (!matchingTab || matchingTab.paused) {
        return;
      }
      const mimeType = msg.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const buffer = Buffer.from(msg.data, 'base64');
      const cleanFrameUrl = redactUrlForAudit(String(msg.url || ''));
      const cleanFrameTitle = redactUrlsInText(String(msg.title || ''));
      const frame = {
        tabId: msg.tabId ?? null,
        mimeType,
        buffer,
        title: cleanFrameTitle,
        url: cleanFrameUrl,
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
        url: cleanFrameUrl,
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

  // Promptly evict stale WebSocket sessions within ~1s whenever auth.token rotates on disk
  const tokenWatchTimer = setInterval(() => {
    evictStaleTokenPeers();
  }, 1000);
  tokenWatchTimer.unref();

  const heartbeatTimer = setInterval(() => {
    evictStaleTokenPeers();
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
    clearInterval(tokenWatchTimer);
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
    get authToken() {
      return resolveAuthToken();
    },
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
      ensureSecureDirSync(getStateDir());
      fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
      tightenFileAclSync(pidFile);
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
        const tok = ensureAuthToken();
        const { ts, nonce, headers } = buildSignedHttpHeaders(tok, 'GET', '/api/health');
        const probe = http.request(
          { host: DEFAULT_HOST, port: DEFAULT_PORT, path: '/api/health', method: 'GET', headers, timeout: 1500 },
          (res) => {
            res.resume();
            if (verifySignedHttpResponse(tok, res.statusCode || 500, res.headers, ts, nonce)) {
              process.stdout.write(`[chrome-live] Verified daemon already active on port ${DEFAULT_PORT}.\n`);
              process.exit(0);
            } else {
              process.stderr.write(
                `[chrome-live] Port ${DEFAULT_PORT} is occupied by an unverified local process! Refusing to treat as active.\n`
              );
              process.exit(1);
            }
          }
        );
        probe.on('timeout', () => {
          probe.destroy();
          process.stderr.write(`[chrome-live] Port ${DEFAULT_PORT} is in use and unresponsive.\n`);
          process.exit(1);
        });
        probe.on('error', (probeErr) => {
          process.stderr.write(`[chrome-live] Port ${DEFAULT_PORT} conflict: ${probeErr.message}\n`);
          process.exit(1);
        });
        probe.end();
        return;
      }
      process.stderr.write(`[chrome-live] Failed to start daemon: ${err.message}\n`);
      process.exit(1);
    });
}
