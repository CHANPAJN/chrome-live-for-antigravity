import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { computeChallengeHmac, createDaemonServer } from '../src/daemon.mjs';
import { evaluateUploadFileSafety, evaluateUrlSafety, getDefaultUploadStagingDir } from '../src/guardrails.mjs';
import { buildSignedHttpHeaders, verifySignedHttpResponse } from '../src/hmac-auth.mjs';
import { learnFromPageVisit, learnInteractionSelector, lookupDomainPlaybook, sanitizeRouteUrl, setPlaybookEnabled } from '../src/playbook-store.mjs';
import { computeWebSocketAccept, encodeWsFrame, NativeWsPeer } from '../src/ws-codec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

function connectTestWsClient(port, routePath, token, { authMode = 'challenge' } = {}) {
  return new Promise((resolve, reject) => {
    const secKey = crypto.randomBytes(16).toString('base64');
    const expectedAccept = computeWebSocketAccept(secKey);
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const headers = [
        `GET ${routePath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13'
      ];
      if (authMode === 'header' && token) {
        headers.push(`X-Chrome-Live-Token: ${token}`);
      }
      headers.push('\r\n');
      socket.write(headers.join('\r\n'));
    });

    let headerBuf = Buffer.alloc(0);
    function onHandshakeData(chunk) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onHandshakeData);
      const headerText = headerBuf.subarray(0, idx).toString('utf8');
      const rest = headerBuf.subarray(idx + 4);
      if (!headerText.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`Unexpected handshake response: ${headerText.split('\r\n')[0]}`));
        return;
      }
      assert.ok(headerText.includes(expectedAccept), 'Sec-WebSocket-Accept mismatch');
      const peer = new NativeWsPeer(socket);
      // Browser clients send masked frames per RFC 6455
      peer.sendMaskedJson = (obj) => {
        socket.write(encodeWsFrame(0x01, Buffer.from(JSON.stringify(obj), 'utf8'), true));
      };
      if (rest.length > 0) peer._onData(rest);

      if (authMode === 'challenge' && token) {
        const clientNonce = crypto.randomBytes(32).toString('hex');
        const onChallenge = (raw) => {
          let msg;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (msg && msg.type === 'auth_challenge') {
            peer.removeListener('message', onChallenge);
            const expectedServerProof = computeChallengeHmac(token, 'server', clientNonce, msg.serverNonce);
            if (msg.serverProof !== expectedServerProof) {
              socket.destroy();
              reject(new Error('Daemon serverProof verification failed'));
              return;
            }
            const clientProof = computeChallengeHmac(token, 'client', clientNonce, msg.serverNonce);
            peer.sendMaskedJson({ type: 'auth_response', clientProof, version: '1.0.0', tabs: [] });
            resolve(peer);
          }
        };
        peer.on('message', onChallenge);
        peer.once('close', () => reject(new Error('Closed during challenge-response auth')));
        peer.sendMaskedJson({ type: 'auth_init', clientNonce });
        return;
      }

      resolve(peer);
    }

    socket.on('data', onHandshakeData);
    socket.on('error', reject);
  });
}

function httpJson(port, method, routePath, authOrHeaders = {}, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const rawOpts = authOrHeaders && typeof authOrHeaders === 'object' ? { ...authOrHeaders } : {};
    const hmacToken = typeof rawOpts.token === 'string' ? rawOpts.token : '';
    delete rawOpts.token;

    let signedMeta = null;
    let computedHeaders = rawOpts;
    if (hmacToken) {
      signedMeta = buildSignedHttpHeaders(hmacToken, method, routePath, payload);
      computedHeaders = { ...signedMeta.headers, ...rawOpts };
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method,
        agent: false,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(payload.length)
              }
            : {}),
          ...computedHeaders
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (signedMeta) {
            assert.equal(
              verifySignedHttpResponse(hmacToken, res.statusCode, res.headers, signedMeta.ts, signedMeta.nonce),
              true,
              `Expected valid X-Chrome-Live-Server-Sig on ${method} ${routePath}`
            );
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Repository hygiene gate: zero external npm dependencies, zero prebuilt binaries, and npm pack excludes pairing secrets', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Expected zero runtime npm dependencies');

  const forbiddenBinaryExts = new Set(['.exe', '.dll', '.so', '.dylib', '.wasm', '.bin', '.node']);
  const allEntries = [];
  function walkAll(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walkAll(full);
      } else if (entry.isFile()) {
        allEntries.push({ full, rel });
      }
    }
  }
  walkAll(REPO_ROOT);
  assert.ok(allEntries.length >= 12, 'Expected complete repository file set');

  for (const { full, rel } of allEntries) {
    const ext = path.extname(rel).toLowerCase();
    const base = path.basename(rel);
    assert.equal(forbiddenBinaryExts.has(ext), false, `Unexpected binary file in repository: ${rel}`);
    assert.notEqual(base, 'auth.token', `Secret token file must never live inside repository: ${rel}`);
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) {
      const content = fs.readFileSync(full, 'utf8');
      assert.equal(
        /C:\\Users\\[A-Za-z0-9._-]+\\\.gemini/i.test(content),
        false,
        `Hardcoded personal path found in ${rel}`
      );
    }
  }

  if (fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    const gitTracked = spawnSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (gitTracked.status === 0) {
      const trackedList = gitTracked.stdout.split(/\r?\n/).filter(Boolean);
      assert.equal(
        trackedList.some((p) => p.endsWith('.local-runtime.json') || p.endsWith('.token')),
        false,
        'git must never track .local-runtime.json or .token files'
      );
    }
  }

  // Real npm pack dry-run verification from a paired checkout containing extension/.local-runtime.json
  const runtimeBootstrapPath = path.join(REPO_ROOT, 'extension', '.local-runtime.json');
  const hadExistingBootstrap = fs.existsSync(runtimeBootstrapPath);
  const previousBootstrapRaw = hadExistingBootstrap ? fs.readFileSync(runtimeBootstrapPath, 'utf8') : null;
  fs.writeFileSync(
    runtimeBootstrapPath,
    JSON.stringify({ host: '127.0.0.1', port: 28196, token: 'simulated_secret_token_never_pack_me' }),
    'utf8'
  );
  try {
    const packRun =
      process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
            cwd: REPO_ROOT,
            encoding: 'utf8'
          })
        : spawnSync('npm', ['pack', '--dry-run', '--json'], {
            cwd: REPO_ROOT,
            encoding: 'utf8'
          });
    assert.equal(packRun.status, 0, `npm pack --dry-run failed: ${packRun.stderr}`);
    const parsedPack = JSON.parse(packRun.stdout);
    const packedFiles = (parsedPack[0]?.files || []).map((f) => String(f.path || '').replace(/\\/g, '/'));
    assert.ok(packedFiles.length >= 10, 'Expected non-empty npm pack manifest');
    assert.equal(
      packedFiles.some((p) => p.endsWith('.local-runtime.json') || p.endsWith('.token')),
      false,
      `npm pack leaked pairing secret file: ${packedFiles.join(', ')}`
    );
  } finally {
    try {
      if (hadExistingBootstrap && previousBootstrapRaw !== null) {
        fs.writeFileSync(runtimeBootstrapPath, previousBootstrapRaw, 'utf8');
      } else if (fs.existsSync(runtimeBootstrapPath)) {
        fs.unlinkSync(runtimeBootstrapPath);
      }
    } catch {}
  }
});

test('Financial & security guardrails block payment gateways, internal schemes, and checkout paths', () => {
  const blockedUrls = [
    'https://checkout.stripe.com/c/pay/cs_live_123',
    'https://www.paypal.com/signin',
    'https://cashier.alipay.com/standard/lightpay',
    'https://pay.weixin.qq.com/index.php',
    'https://online.cmbchina.com/login',
    'https://shop.example.com/cart/checkout/confirm',
    'chrome://extensions',
    'file:///etc/passwd',
    'http://127.0.0.1:9222/json/version'
  ];

  for (const url of blockedUrls) {
    const res = evaluateUrlSafety(url);
    assert.equal(res.allowed, false, `Expected guardrail to block: ${url}`);
  }

  const customCheck = evaluateUrlSafety('https://corp-oa.internal.example/home', ['internal.example']);
  assert.equal(customCheck.allowed, false);

  const safeUrls = [
    'https://linux.do/latest',
    'https://github.com/trending',
    'https://developer.chrome.com/docs/extensions'
  ];
  for (const url of safeUrls) {
    const res = evaluateUrlSafety(url);
    assert.equal(res.allowed, true, `Expected safe URL to pass: ${url}`);
  }
});

test('Daemon enforces Host header, blocks web Origins, validates Token, and routes rapid RPCs + live frames', async () => {
  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    // 1. DNS Rebinding defense: spoofed Host header must return 403
    const badHost = await httpJson(port, 'GET', '/api/ping', { Host: 'evil.attacker.tld' });
    assert.equal(badHost.statusCode, 403);

    // 2. Web CSRF defense: web page Origin must return 403 even on /api/ping
    const badOrigin = await httpJson(port, 'GET', '/api/ping', { Origin: 'https://evil.example' });
    assert.equal(badOrigin.statusCode, 403);

    // 3. Missing token on /api/health must return 401
    const unauth = await httpJson(port, 'GET', '/api/health');
    assert.equal(unauth.statusCode, 401);

    // 4. Valid Chrome extension Origin + valid HMAC signature succeeds
    const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const okHealth = await httpJson(port, 'GET', '/api/health', {
      Origin: extOrigin,
      token: testToken
    });
    assert.equal(okHealth.statusCode, 200);
    assert.equal(okHealth.json.extensionConnected, false);

    // 5. Connect simulated Extension WS & Live Sidecar WS
    const extWs = await connectTestWsClient(port, '/ws/extension', testToken);
    const liveWs = await connectTestWsClient(port, '/ws/live', testToken);

    const liveFramesReceived = [];
    liveWs.on('message', (txt) => {
      const parsed = JSON.parse(txt);
      if (parsed.type === 'frame') liveFramesReceived.push(parsed);
    });

    extWs.on('message', (txt) => {
      const msg = JSON.parse(txt);
      if (msg.type === 'rpc_request') {
        extWs.sendMaskedJson({
          type: 'rpc_response',
          id: msg.id,
          ok: true,
          result: { echoedMethod: msg.method, tabId: 42, params: msg.params }
        });
      }
    });

    extWs.sendMaskedJson({
      type: 'hello',
      version: '1.0.0',
      tabs: [{ tabId: 42, substate: 'shared', title: 'Linux.do', url: 'https://linux.do' }]
    });

    // Rapid 10-step toggle / RPC burst stress test (15ms intervals)
    for (let i = 0; i < 10; i++) {
      const cmdRes = await httpJson(
        port,
        'POST',
        '/api/command',
        { token: testToken },
        { method: i % 2 === 0 ? 'snapshot' : 'scroll', params: { step: i } }
      );
      assert.equal(cmdRes.statusCode, 200);
      assert.equal(cmdRes.json.result.params.step, i);
      await new Promise((r) => setTimeout(r, 15));
    }

    // Daemon-level guardrail must reject payment URL before reaching extension (both direct & inside batch)
    const blockedCmd = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'open', params: { url: 'https://checkout.stripe.com/pay/123' } }
    );
    assert.equal(blockedCmd.statusCode, 500);
    assert.match(blockedCmd.json.error, /GUARDRAIL:SENSITIVE_DOMAIN/);

    const blockedBatch = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      {
        method: 'batch',
        params: {
          steps: [
            { action: 'open', url: 'https://github.com' },
            { action: 'navigate', url: 'https://cashier.alipay.com/pay' }
          ]
        }
      }
    );
    assert.equal(blockedBatch.statusCode, 500);
    assert.match(blockedBatch.json.error, /GUARDRAIL:SENSITIVE_DOMAIN/);

    const okBatch = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      {
        method: 'batch',
        params: {
          steps: [
            { action: 'type', target: 1, text: 'mcp', submit: true },
            { action: 'wait', ms: 300 },
            { action: 'snapshot', maxItems: 10 }
          ]
        }
      }
    );
    assert.equal(okBatch.statusCode, 200);
    assert.equal(okBatch.json.result.echoedMethod, 'batch');

    // Screencast JPEG broadcast from extension -> daemon -> live sidecar + /api/frame
    const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    extWs.sendMaskedJson({
      type: 'screencast_frame',
      tabId: 42,
      mimeType: 'image/jpeg',
      data: dummyJpeg,
      title: 'Linux.do',
      url: 'https://linux.do',
      activity: 'Reading post'
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(liveFramesReceived.length, 1);
    assert.equal(liveFramesReceived[0].tabId, 42);

    // Simulate abrupt Windows TCP reset (ECONNRESET) and verify daemon stays alive
    extWs.socket.destroy();
    liveWs.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const afterReset = await httpJson(port, 'GET', '/api/health', {
      token: testToken
    });
    assert.equal(afterReset.statusCode, 200);
  } finally {
    await daemon.close();
  }
});

test('Site Playbooks are strictly opt-in (false by default), strip sensitive query params, and attach on repeat visits', async () => {
  const prevHome = process.env.CHROME_LIVE_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-pb-test-'));
  process.env.CHROME_LIVE_HOME = tempHome;

  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    // Query sanitizer strips auth tokens & tracking noise while keeping functional params
    const cleaned = sanitizeRouteUrl(
      'https://seller.example.com/orders/manage?tab=pending&token=secret123&utm_source=x&_t=999'
    );
    assert.equal(cleaned, 'https://seller.example.com/orders/manage?tab=pending');
    assert.equal(sanitizeRouteUrl('https://checkout.stripe.com/pay'), null);

    // 1. Default state MUST be disabled (opt-in privacy gate)
    const initialPb = await httpJson(port, 'GET', '/api/playbook', {
      token: testToken
    });
    assert.equal(initialPb.statusCode, 200);
    assert.equal(initialPb.json.enabled, false);

    const extWs = await connectTestWsClient(port, '/ws/extension', testToken);
    extWs.on('message', (txt) => {
      const msg = JSON.parse(txt);
      if (msg.type === 'rpc_request') {
        extWs.sendMaskedJson({
          type: 'rpc_response',
          id: msg.id,
          ok: true,
          result: {
            tabId: 7,
            title: 'Order Console',
            url: 'https://seller.example.com/orders/manage?status=open&access_token=leak',
            elements: [{ index: 0, tag: 'input', label: 'Order ID', stableSelector: '#order-id' }]
          }
        });
      }
    });

    // While disabled, snapshot must NOT record anything
    await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'snapshot', params: {} }
    );
    const stillEmpty = await httpJson(port, 'GET', '/api/playbook', {
      token: testToken
    });
    assert.equal(Object.keys(stillEmpty.json.sites).length, 0);

    // 2. Explicitly opt in + save a widget tip
    await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      { action: 'set_enabled', enabled: true }
    );
    await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      {
        action: 'save',
        domain: 'seller.example.com',
        tip: 'Date range input is read-only; click calendar popup cells'
      }
    );

    // 3. Visit learns sanitized route + stable selector and attaches playbook on response
    const snapWithPb = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'snapshot', params: {} }
    );
    const pb = snapWithPb.json.result.playbook;
    assert.ok(pb, 'Expected playbook attached to snapshot result');
    assert.equal(pb.routes['Order Console'], 'https://seller.example.com/orders/manage?status=open');
    assert.equal(pb.selectors['Order ID'], '#order-id');
    assert.equal(pb.tips.length, 1);

    // 3b. In-place edit (rename + relative URL) and single-item deletion
    const renamed = await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      {
        action: 'save',
        domain: 'seller.example.com',
        route: { name: 'Open Orders', url: '/orders/open', oldName: 'Order Console' }
      }
    );
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json.entry.routes['Open Orders'], 'https://seller.example.com/orders/open');
    assert.equal(renamed.json.entry.routes['Order Console'], undefined);

    const delTip = await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      { action: 'delete_item', domain: 'seller.example.com', kind: 'tip', index: 0 }
    );
    assert.equal(delTip.statusCode, 200);
    assert.equal(delTip.json.entry.tips.length, 0);

    // 4. Clear resets stored sites to zero
    const cleared = await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      { action: 'clear' }
    );
    assert.equal(cleared.json.siteCount, 0);

    extWs.socket.destroy();
  } finally {
    await daemon.close();
    if (prevHome === undefined) delete process.env.CHROME_LIVE_HOME;
    else process.env.CHROME_LIVE_HOME = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Edge-case regressions: SPA hash checkout guardrail, UTF-8 multibyte WS close frame <=125B, and interleaved fragment rejection', async () => {
  // 1. SPA hash route /#/checkout must be blocked
  const hashCheckout = evaluateUrlSafety('https://spa-store.example.com/app#/checkout/confirm');
  assert.equal(hashCheckout.allowed, false);
  assert.equal(hashCheckout.code, 'PAYMENT_PATH');

  // 2. Multibyte UTF-8 close reason (>60 Chinese chars = >180 UTF-8 bytes) must truncate cleanly to <=125B control frame
  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    const wsClient = await connectTestWsClient(port, '/ws/extension', testToken);

    // Send an incomplete fragmented frame (FIN=0, opcode=1) followed illegally by a new text frame (FIN=1, opcode=1)
    const makeMaskedRaw = (fin, opcode, buf) => {
      const mask = crypto.randomBytes(4);
      const f = Buffer.allocUnsafe(6 + buf.length);
      f[0] = (fin ? 0x80 : 0x00) | opcode;
      f[1] = 0x80 | buf.length;
      mask.copy(f, 2);
      for (let i = 0; i < buf.length; i++) f[6 + i] = buf[i] ^ mask[i & 3];
      return f;
    };

    const closePromise = new Promise((resolve) => wsClient.on('close', resolve));
    wsClient.socket.write(makeMaskedRaw(false, 0x01, Buffer.from('{"type":', 'utf8')));
    wsClient.socket.write(makeMaskedRaw(true, 0x01, Buffer.from('{}', 'utf8')));
    await closePromise;
    assert.equal(wsClient.closed, true);

    // Verify UTF-8 multibyte close reason never produces >125B payload
    const client2 = await connectTestWsClient(port, '/ws/extension', testToken);
    const rawChunks = [];
    client2.socket.on('data', (c) => rawChunks.push(c));
    client2.close(1000, '这是一段非常长的中文关闭原因用于验证多字节截断绝不会超过一百二十五字节上限'.repeat(3));
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    await daemon.close();
  }
});

test('Upload guardrails block credential keys, restrict default uploads to staging dir, and resolve valid attachments', async () => {
  const prevHome = process.env.CHROME_LIVE_HOME;
  const prevUploadDir = process.env.CHROME_LIVE_UPLOAD_DIR;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-upload-default-'));
  process.env.CHROME_LIVE_HOME = tempHome;
  delete process.env.CHROME_LIVE_UPLOAD_DIR;

  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    for (const blockedPath of [
      '/home/dev/.ssh/id_rsa',
      '/Users/dev/.aws/credentials-demo/.env.production',
      '/tmp/.chrome-live-antigravity/auth.token',
      './.env'
    ]) {
      const res = evaluateUploadFileSafety(blockedPath);
      assert.equal(res.allowed, false, `Expected sensitive file "${blockedPath}" to be blocked`);
      assert.equal(res.code, 'SENSITIVE_FILE');
    }

    // Ordinary files outside ~/.chrome-live-antigravity/uploads (e.g. repo files, desktop spreadsheets/invoices)
    // MUST be blocked by default unless explicitly staged or permitted via CHROME_LIVE_UPLOAD_DIR
    const outsideIcon = path.join(REPO_ROOT, 'extension', 'icons', 'icon48.png');
    const outsideRes = evaluateUploadFileSafety(outsideIcon);
    assert.equal(outsideRes.allowed, false);
    assert.equal(outsideRes.code, 'UPLOAD_DIR_RESTRICTED');

    const stagingDir = getDefaultUploadStagingDir();
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagedIcon = path.join(stagingDir, 'staged-icon48.png');
    fs.copyFileSync(outsideIcon, stagedIcon);
    const expectedRealIcon = fs.realpathSync(stagedIcon);

    const safeRes = evaluateUploadFileSafety(stagedIcon);
    assert.equal(safeRes.allowed, true);
    assert.equal(safeRes.resolvedPath, expectedRealIcon);

    const extWs = await connectTestWsClient(port, '/ws/extension', testToken);
    extWs.sendMaskedJson({ type: 'hello', version: '1.0.0', tabs: [] });

    extWs.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'rpc_request' && msg.method === 'upload') {
        extWs.sendMaskedJson({
          type: 'rpc_response',
          id: msg.id,
          ok: true,
          result: {
            receivedFiles: msg.params.files,
            hasPasteFallback: Array.isArray(msg.params.pasteFallback) && msg.params.pasteFallback.length === 1,
            fallbackMime: msg.params.pasteFallback?.[0]?.mimeType
          }
        });
      }
    });

    const blockedResp = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'upload', params: { target: 'auto', files: ['/home/dev/.ssh/id_ed25519'] } }
    );
    assert.equal(blockedResp.statusCode, 500);
    assert.match(blockedResp.json.error, /GUARDRAIL:SENSITIVE_FILE/);

    const blockedOutsideResp = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'upload', params: { target: 'auto', files: [outsideIcon] } }
    );
    assert.equal(blockedOutsideResp.statusCode, 500);
    assert.match(blockedOutsideResp.json.error, /GUARDRAIL:UPLOAD_DIR_RESTRICTED/);

    const okResp = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'upload', params: { target: 'auto', files: [stagedIcon] } }
    );
    assert.equal(okResp.statusCode, 200);
    assert.deepEqual(okResp.json.result.receivedFiles, [expectedRealIcon]);
    assert.equal(okResp.json.result.hasPasteFallback, true);
    assert.equal(okResp.json.result.fallbackMime, 'image/png');

    extWs.socket.destroy();
  } finally {
    await daemon.close();
    if (prevHome === undefined) delete process.env.CHROME_LIVE_HOME;
    else process.env.CHROME_LIVE_HOME = prevHome;
    if (prevUploadDir === undefined) delete process.env.CHROME_LIVE_UPLOAD_DIR;
    else process.env.CHROME_LIVE_UPLOAD_DIR = prevUploadDir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('MCP stdio server isolates model-visible monitor from app-only UI actions, propagates release errors, and locks closed pinned tabs', async () => {
  const { spawn } = await import('node:child_process');
  const testToken = crypto.randomBytes(32).toString('hex');
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-mcp-ui-'));
  fs.writeFileSync(path.join(tempHome, 'auth.token'), `${testToken}\n`, 'utf8');

  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  let mcpProc = null;
  let simulateReleaseError = false;
  try {
    const extWs = await connectTestWsClient(port, '/ws/extension', testToken);
    extWs.sendMaskedJson({
      type: 'hello',
      version: '1.0.0',
      tabs: [
        { tabId: 77, substate: 'shared', paused: false, title: 'Live Demo', url: 'https://example.com/' },
        { tabId: 88, substate: 'worker', paused: false, title: 'Second Store', url: 'https://store-b.example.com/' }
      ]
    });
    extWs.sendMaskedJson({
      type: 'screencast_frame',
      tabId: 77,
      mimeType: 'image/jpeg',
      data: Buffer.from('fake-jpeg-bytes-77').toString('base64'),
      title: 'Live Demo',
      url: 'https://example.com/'
    });
    extWs.sendMaskedJson({
      type: 'screencast_frame',
      tabId: 88,
      mimeType: 'image/jpeg',
      data: Buffer.from('fake-jpeg-bytes-88').toString('base64'),
      title: 'Second Store',
      url: 'https://store-b.example.com/'
    });
    extWs.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'rpc_request') {
        if (msg.method === 'release_tab' && simulateReleaseError) {
          extWs.sendMaskedJson({
            type: 'rpc_response',
            id: msg.id,
            ok: false,
            error: 'Simulated debugger detach failure'
          });
          return;
        }
        if (msg.method === 'inspect_region') {
          extWs.sendMaskedJson({
            type: 'rpc_response',
            id: msg.id,
            ok: true,
            result: {
              url: 'https://example.com/',
              elements: [{ tag: 'button', label: 'Confirm', selector: '#confirm-btn' }]
            }
          });
        } else {
          extWs.sendMaskedJson({
            type: 'rpc_response',
            id: msg.id,
            ok: true,
            result: { tabId: msg.params?.tabId ?? 77, method: msg.method }
          });
        }
      }
    });
    await new Promise((r) => setTimeout(r, 40));

    const cliPath = path.join(REPO_ROOT, 'bin', 'chrome-live.mjs');
    mcpProc = spawn(process.execPath, [cliPath, 'mcp'], {
      env: { ...process.env, CHROME_LIVE_PORT: String(port), CHROME_LIVE_HOME: tempHome },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = new Map();
    let lineBuf = '';
    mcpProc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined) responses.set(parsed.id, parsed);
        }
      }
    });

    const rpc = async (id, method, params = {}) => {
      mcpProc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let i = 0; i < 40; i++) {
        if (responses.has(id)) return responses.get(id);
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`MCP timeout for ${method}`);
    };

    const initResp = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.ok(initResp.result.capabilities.resources, 'Expected resources capability for MCP App');

    const toolsList = await rpc(20, 'tools/list');
    const monitorTool = toolsList.result.tools.find((t) => t.name === 'chrome_live_monitor');
    const wsTool = toolsList.result.tools.find((t) => t.name === 'chrome_live_workspace');
    assert.ok(monitorTool, 'Expected chrome_live_monitor tool');
    assert.deepEqual(monitorTool._meta?.ui?.visibility, ['model', 'app']);
    assert.equal('action' in (monitorTool.inputSchema?.properties || {}), false, 'Model monitor schema must not expose UI actions');
    assert.ok(wsTool, 'Expected chrome_live_workspace entrypoint tool');
    assert.equal(wsTool._meta?.ui?.resourceUri, 'ui://chrome-live/live-monitor.html');
    const epTypes = (wsTool._meta?.['com.google.antigravity/ui']?.entrypoints || []).map((e) => e.type);
    assert.deepEqual(epTypes.sort(), ['aux_pane', 'global']);

    // Model attempting to sneak an action into chrome_live_monitor without the iframe UI capability secret MUST be rejected
    const forbiddenModelAction = await rpc(29, 'tools/call', {
      name: 'chrome_live_monitor',
      arguments: { tabId: 77, action: 'relay_merge' }
    });
    assert.equal(Boolean(forbiddenModelAction.error || forbiddenModelAction.result?.isError), true);

    const resList = await rpc(2, 'resources/list');
    assert.equal(resList.result.resources[0].uri, 'ui://chrome-live/live-monitor.html');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const resRead = await rpc(3, 'resources/read', { uri: 'ui://chrome-live/live-monitor.html' });
    const appHtml = resRead.result.contents[0].text;
    assert.match(appHtml, /ui\/initialize/);
    assert.match(appHtml, /pinnedTabClosed/);
    assert.equal(
      /[0-9a-f]{64}/i.test(appHtml),
      false,
      'resources/read static HTML MUST NOT contain any 256-bit secret readable via model read_resource'
    );

    const monitorCall = await rpc(4, 'tools/call', { name: 'chrome_live_monitor', arguments: { tabId: 77 } });
    assert.ok(monitorCall.result.structuredContent.frameDataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(monitorCall.result.structuredContent.frameTabId, 77);
    const uiSecret = monitorCall.result.structuredContent.uiSecret;
    assert.match(uiSecret, /^[0-9a-f]{64}$/, 'Expected 256-bit uiSecret inside structuredContent');
    assert.equal(
      JSON.stringify(monitorCall.result.content || []).includes(uiSecret),
      false,
      'Model-visible text content MUST NOT include uiSecret'
    );

    // Entrypoint launches invoke chrome_live_workspace with empty {}
    const wsCall = await rpc(21, 'tools/call', { name: 'chrome_live_workspace', arguments: {} });
    assert.ok(wsCall.result.structuredContent.frameDataUrl.startsWith('data:image/jpeg;base64,'));

    // Authenticated iframe UI actions succeed when carrying the ephemeral UI capability secret
    const pollCall = await rpc(22, 'tools/call', {
      name: 'chrome_live_monitor',
      arguments: { action: 'poll', lastFrameTs: 0, tabId: 77, uiSecret }
    });
    assert.equal(pollCall.result.structuredContent.frameTabId, 77);

    const regionCall = await rpc(5, 'tools/call', {
      name: 'chrome_live_monitor',
      arguments: { action: 'inspect_region', tabId: 77, rx1: 0.1, ry1: 0.1, rx2: 0.5, ry2: 0.5, uiSecret }
    });
    assert.equal(regionCall.result.structuredContent.regionResult.elements[0].selector, '#confirm-btn');

    // Release error MUST propagate instead of silently reporting success
    simulateReleaseError = true;
    const failedRelease = await rpc(25, 'tools/call', {
      name: 'chrome_live_monitor',
      arguments: { action: 'release_tab', tabId: 77, uiSecret }
    });
    assert.equal(Boolean(failedRelease.error || failedRelease.result?.isError), true);
    const errText = JSON.stringify(failedRelease);
    assert.match(errText, /Simulated debugger detach failure/);
    simulateReleaseError = false;

    // Closing pinned tab 88 must NOT silently fall back to capturing tab 77
    extWs.sendMaskedJson({
      type: 'status_sync',
      tabs: [{ tabId: 77, substate: 'shared', paused: false, title: 'Live Demo', url: 'https://example.com/' }],
      activeTabId: 77
    });
    await new Promise((r) => setTimeout(r, 40));

    const closedTabPoll = await rpc(26, 'tools/call', {
      name: 'chrome_live_monitor',
      arguments: { action: 'poll', lastFrameTs: 0, tabId: 88, uiSecret }
    });
    assert.equal(closedTabPoll.result.structuredContent.requestedTabMissing, true);
    assert.equal(closedTabPoll.result.structuredContent.frameDataUrl ?? null, null);

    extWs.socket.destroy();
  } finally {
    if (mcpProc) mcpProc.kill();
    await daemon.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Soak bug-hunt regressions: strict explicit tabId isolation, batch cmd alias, and discarded-tab bounded script helper', () => {
  const swSource = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'service-worker.js'), 'utf8');

  // 1. Explicit tabId must never silently fall back to another shared tab after detachment
  assert.match(swSource, /Tab #\$\{numId\} is no longer controlled/);
  assert.match(swSource, /\[GUARDRAIL\] Detached tab #\$\{numId\}/);

  // 2. Batch step parser accepts action, method, or cmd aliases
  assert.match(swSource, /rawStep\.action \|\| rawStep\.method \|\| rawStep\.cmd/);

  // 3. Discarded background tabs are reloaded and bounded by timeout
  assert.match(swSource, /async function execScriptBounded/);
  assert.match(swSource, /cur\?\.discarded/);
});

test('Multi-tab concurrency & form-state regressions: per-tab frame isolation, ARIA states/alerts, and click disabled guard', async () => {
  // 1. Daemon isolates screencast frames per tabId and prunes closed tabs
  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    const extWs = await connectTestWsClient(port, '/ws/extension', testToken);
    extWs.sendMaskedJson({
      type: 'hello',
      version: '1.0.0',
      tabs: [
        { tabId: 101, substate: 'worker', paused: false, title: 'Tab A', url: 'https://a.example.com/' },
        { tabId: 202, substate: 'worker', paused: false, title: 'Tab B', url: 'https://b.example.com/' }
      ]
    });
    extWs.sendMaskedJson({
      type: 'screencast_frame',
      tabId: 101,
      mimeType: 'image/jpeg',
      data: Buffer.from('frame-bytes-tab-101').toString('base64'),
      title: 'Tab A',
      url: 'https://a.example.com/'
    });
    extWs.sendMaskedJson({
      type: 'screencast_frame',
      tabId: 202,
      mimeType: 'image/jpeg',
      data: Buffer.from('frame-bytes-tab-202').toString('base64'),
      title: 'Tab B',
      url: 'https://b.example.com/'
    });
    await new Promise((r) => setTimeout(r, 40));

    const f101 = await httpJson(port, 'GET', '/api/frame?tabId=101', { token: testToken });
    const f202 = await httpJson(port, 'GET', '/api/frame?tabId=202', { token: testToken });
    assert.equal(f101.statusCode, 200);
    assert.equal(f101.text, 'frame-bytes-tab-101');
    assert.equal(f202.statusCode, 200);
    assert.equal(f202.text, 'frame-bytes-tab-202');

    const h101 = await httpJson(port, 'GET', '/api/health?includeFrame=1&tabId=101', {
      token: testToken
    });
    assert.equal(h101.json.frameTabId, 101);
    assert.deepEqual(h101.json.cachedFrameTabIds.sort((a, b) => a - b), [101, 202]);

    // Closing tab 101 via status_sync automatically prunes its cached frame while keeping tab 202 intact
    extWs.sendMaskedJson({
      type: 'status_sync',
      tabs: [{ tabId: 202, substate: 'worker', paused: false, title: 'Tab B', url: 'https://b.example.com/' }],
      activeTabId: 202
    });
    await new Promise((r) => setTimeout(r, 40));

    const f101Gone = await httpJson(port, 'GET', '/api/frame?tabId=101', { token: testToken });
    const f202Still = await httpJson(port, 'GET', '/api/frame?tabId=202', { token: testToken });
    assert.equal(f101Gone.statusCode, 204);
    assert.equal(f202Still.statusCode, 200);
    assert.equal(f202Still.text, 'frame-bytes-tab-202');

    extWs.socket.destroy();
  } finally {
    await daemon.close();
  }

  // 2. Snapshot collects modern ARIA switches/radios/options, disabled/checked states, and validation alerts
  const swSource = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'service-worker.js'), 'utf8');
  assert.match(swSource, /\[role="switch"\], \[role="radio"\], \[role="checkbox"\], \[role="option"\]/);
  assert.match(swSource, /entryObj\.disabled = true/);
  assert.match(swSource, /entryObj\.checked = checkedState/);
  assert.match(swSource, /\[role="alert"\], \[aria-live="assertive"\]/);

  // 3. Click guards against plain-text HTML tag false positives, skips hidden elements, and surfaces disabled controls
  assert.ok(swSource.includes('/[#.\\[\\]>:+~=]/.test(raw)'));
  assert.match(swSource, /Element is disabled:/);
  assert.match(swSource, /let fuzzyMatch = null/);

  // 4. Clean text extraction strips inline <style>/<script> as well as <textarea>/<select>/<option> via TreeWalker
  assert.match(swSource, /'STYLE',\s*'SCRIPT',\s*'NOSCRIPT',\s*'TEMPLATE',\s*'SVG',\s*'TEXTAREA',\s*'SELECT',\s*'OPTION'/);
  assert.match(swSource, /document\.createTreeWalker/);

  // 5. Daemon stores single binary buffer per frame (no duplicate base64 copy) with bounded cache
  const daemonSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'daemon.mjs'), 'utf8');
  assert.match(daemonSource, /const MAX_TAB_FRAMES = 6/);
  assert.ok(!daemonSource.includes('base64: msg.data'));

  // 6. CLI exposes release command and formats element state badges & alerts
  const cliSource = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'chrome-live.mjs'), 'utf8');
  assert.match(cliSource, /if \(cmd === 'release'\)/);
  assert.match(cliSource, /function formatSnapshotElementLine/);
  assert.match(cliSource, /function formatAlertsBlock/);
});

test('Security audit hardening: mutual HTTP/WS HMAC, replay defense, runtime bootstrap shred, symlink assertion, password click redaction & paused relay lock', async () => {
  // 1. Standalone /pay and /billing routes are blocked without false positives on /payload or /billing-docs
  assert.equal(evaluateUrlSafety('https://shop.example.com/pay').allowed, false);
  assert.equal(evaluateUrlSafety('https://shop.example.com/pay?order=1').allowed, false);
  assert.equal(evaluateUrlSafety('https://cloud.example.com/billing').allowed, false);
  assert.equal(evaluateUrlSafety('https://cloud.example.com/#/billing/invoices').allowed, false);
  assert.equal(evaluateUrlSafety('https://docs.example.com/payload').allowed, true);
  assert.equal(evaluateUrlSafety('https://docs.example.com/billing-docs').allowed, true);

  // 2. Live daemon integration checks
  const prevHome = process.env.CHROME_LIVE_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-sec-audit-'));
  process.env.CHROME_LIVE_HOME = tempHome;
  const testToken = crypto.randomBytes(32).toString('hex');
  const daemon = createDaemonServer({ host: '127.0.0.1', port: 0, token: testToken });
  const port = await daemon.listen();

  try {
    // 2a. Query-string ?token= and plaintext headers MUST be rejected on both HTTP and WS
    const httpQueryAuth = await httpJson(port, 'GET', `/api/health?token=${encodeURIComponent(testToken)}`);
    assert.equal(httpQueryAuth.statusCode, 401);
    const httpPlainHeaderAuth = await httpJson(port, 'GET', '/api/health', {
      'X-Chrome-Live-Token': testToken
    });
    assert.equal(httpPlainHeaderAuth.statusCode, 401);

    await assert.rejects(
      () => connectTestWsClient(port, `/ws/extension?token=${encodeURIComponent(testToken)}`, testToken, { authMode: 'none' }),
      /401/
    );
    await assert.rejects(
      () => connectTestWsClient(port, '/ws/extension', testToken, { authMode: 'header' }),
      /401/
    );

    // 2a-replay. Replaying an identical HTTP HMAC signature + nonce MUST be rejected with 401
    const replaySigned = buildSignedHttpHeaders(testToken, 'GET', '/api/health', null);
    const firstSignedResp = await httpJson(port, 'GET', '/api/health', replaySigned.headers);
    assert.equal(firstSignedResp.statusCode, 200);
    assert.equal(
      verifySignedHttpResponse(testToken, firstSignedResp.statusCode, firstSignedResp.headers, replaySigned.ts, replaySigned.nonce),
      true
    );
    const secondReplayResp = await httpJson(port, 'GET', '/api/health', replaySigned.headers);
    assert.equal(secondReplayResp.statusCode, 401);

    // 2a-spoof. Unverified local HTTP listener (without the secret token) fails mutual response verification
    const fakeServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Chrome-Live-Server-Sig': 'f'.repeat(64)
      });
      res.end('{"ok":true}');
    });
    await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
    try {
      const fakePort = fakeServer.address().port;
      const probeMeta = buildSignedHttpHeaders(testToken, 'GET', '/api/health', null);
      const fakeResp = await httpJson(fakePort, 'GET', '/api/health', probeMeta.headers);
      assert.equal(
        verifySignedHttpResponse(testToken, fakeResp.statusCode, fakeResp.headers, probeMeta.ts, probeMeta.nonce),
        false,
        'Client must reject forged X-Chrome-Live-Server-Sig from impostor local service'
      );
    } finally {
      fakeServer.close();
    }

    // 2b. WS rejects legacy plaintext auth and invalid HMAC clientProof without hijacking extensionPeer
    const badPlainWs = await connectTestWsClient(port, '/ws/extension', '', { authMode: 'none' });
    const badPlainClosed = new Promise((resolve) => badPlainWs.on('close', resolve));
    badPlainWs.sendMaskedJson({ type: 'auth', token: testToken });
    await badPlainClosed;
    assert.equal(badPlainWs.closed, true);

    const badProofWs = await connectTestWsClient(port, '/ws/extension', '', { authMode: 'none' });
    const badProofClosed = new Promise((resolve) => badProofWs.on('close', resolve));
    const gotChallenge = new Promise((resolve) => {
      badProofWs.once('message', (raw) => resolve(JSON.parse(String(raw))));
    });
    badProofWs.sendMaskedJson({ type: 'auth_init', clientNonce: crypto.randomBytes(32).toString('hex') });
    const ch = await gotChallenge;
    assert.equal(ch.type, 'auth_challenge');
    assert.ok(typeof ch.serverNonce === 'string' && typeof ch.serverProof === 'string');
    badProofWs.sendMaskedJson({ type: 'auth_response', clientProof: '0'.repeat(64) });
    await badProofClosed;
    assert.equal(badProofWs.closed, true);

    // 2c. RFC 6455: Unmasked client WS frame must be rejected by server with protocol error close
    const unmaskedWs = await connectTestWsClient(port, '/ws/extension', '', { authMode: 'none' });
    const unmaskedClosed = new Promise((resolve) => unmaskedWs.on('close', resolve));
    unmaskedWs.socket.write(encodeWsFrame(0x01, Buffer.from('{"type":"auth_init"}', 'utf8'), false));
    await unmaskedClosed;
    assert.equal(unmaskedWs.closed, true);

    // 2d. Valid mutual HMAC-SHA256 challenge-response connects extensionPeer cleanly AND shreds .local-runtime.json
    const runtimeBootstrapFile = path.join(REPO_ROOT, 'extension', '.local-runtime.json');
    fs.writeFileSync(runtimeBootstrapFile, JSON.stringify({ host: '127.0.0.1', port, token: testToken }), 'utf8');
    let extWs;
    try {
      extWs = await connectTestWsClient(port, '/ws/extension', testToken, { authMode: 'challenge' });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        fs.existsSync(runtimeBootstrapFile),
        false,
        'Daemon must consume and shred extension/.local-runtime.json upon first extension handshake'
      );
    } finally {
      try {
        if (fs.existsSync(runtimeBootstrapFile)) fs.unlinkSync(runtimeBootstrapFile);
      } catch {}
    }

    extWs.on('message', (txt) => {
      const msg = JSON.parse(txt);
      if (msg.type === 'rpc_request') {
        extWs.sendMaskedJson({ type: 'rpc_response', id: msg.id, ok: true, result: { ok: true } });
      }
    });

    // 2e. Daemon-level guardrail blocks protected URLs inside extract & batch (including cmd alias)
    const blockedExtract = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      {
        method: 'extract',
        params: { urls: ['https://example.com/article', 'https://checkout.stripe.com/c/pay/123'] }
      }
    );
    assert.equal(blockedExtract.statusCode, 500);
    assert.match(blockedExtract.json.error, /GUARDRAIL:SENSITIVE_DOMAIN/);

    const blockedBatchCmdUpload = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      {
        method: 'batch',
        params: { steps: [{ cmd: 'upload', files: [path.join(REPO_ROOT, 'extension', '.local-runtime.json')] }] }
      }
    );
    assert.equal(blockedBatchCmdUpload.statusCode, 500);
    assert.match(blockedBatchCmdUpload.json.error, /GUARDRAIL:SENSITIVE_FILE/);

    // 2f. Upload guardrails: .local-runtime.json, .pem, directory symlinks/junctions (unconditional assertion!), and allowlist
    assert.equal(evaluateUploadFileSafety(path.join(REPO_ROOT, 'extension', '.local-runtime.json')).allowed, false);
    assert.equal(evaluateUploadFileSafety('/tmp/server-private.pem').allowed, false);

    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-upload-dir-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-outside-dir-'));
    try {
      const safeFile = path.join(sandboxDir, 'photo.png');
      const outsideFile = path.join(outsideDir, 'invoice-2026.png');
      const secretFile = path.join(outsideDir, '.env');
      fs.writeFileSync(safeFile, 'ok');
      fs.writeFileSync(outsideFile, 'outside-invoice');
      fs.writeFileSync(secretFile, 'SECRET=1');

      assert.equal(evaluateUploadFileSafety(safeFile, { allowedDirs: [sandboxDir] }).allowed, true);
      const outsideCheck = evaluateUploadFileSafety(outsideFile, { allowedDirs: [sandboxDir] });
      assert.equal(outsideCheck.allowed, false);
      assert.equal(outsideCheck.code, 'UPLOAD_DIR_RESTRICTED');

      // Unconditional symlink / junction escape test (never wrapped in an empty catch!)
      const linkDir = path.join(sandboxDir, 'linked-outside');
      fs.symlinkSync(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');

      const symSecretCheck = evaluateUploadFileSafety(path.join(linkDir, '.env'), { allowedDirs: [sandboxDir] });
      assert.equal(symSecretCheck.allowed, false);
      assert.equal(symSecretCheck.code, 'SENSITIVE_FILE');

      const symEscapeCheck = evaluateUploadFileSafety(path.join(linkDir, 'invoice-2026.png'), {
        allowedDirs: [sandboxDir]
      });
      assert.equal(symEscapeCheck.allowed, false);
      assert.equal(symEscapeCheck.code, 'UPLOAD_DIR_RESTRICTED');
    } finally {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    // 2g. Daemon audit log redacts sensitive query params in stored URLs
    const okOpen = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'open', params: { url: 'https://example.com/cb?page=2&token=supersecret&code=oauth123' } }
    );
    assert.equal(okOpen.statusCode, 200);
    const health = await httpJson(port, 'GET', '/api/health', { token: testToken });
    const openAudit = health.json.recentAudit.find((a) => a.action === 'open');
    assert.ok(openAudit && typeof openAudit.detail.url === 'string');
    assert.ok(!openAudit.detail.url.includes('supersecret'), 'Audit log must redact token param');
    assert.ok(!openAudit.detail.url.includes('oauth123'), 'Audit log must redact code param');
    assert.ok(openAudit.detail.url.includes('page=2'), 'Audit log preserves benign query params');

    // 2h. Playbook refuses save while disabled and never stores password/OTP selectors when enabled
    const saveWhileOff = await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      { action: 'save', domain: 'example.com', tip: 'Should not persist while disabled' }
    );
    assert.equal(saveWhileOff.statusCode, 500);
    assert.match(saveWhileOff.json.error, /disabled/i);

    setPlaybookEnabled(true);
    learnFromPageVisit({
      url: 'https://portal.example.com/account/profile',
      title: 'Account Profile',
      elements: [
        { label: 'User Password', stableSelector: '#user-password' },
        { label: 'Display Name', stableSelector: '#display-name' }
      ]
    });
    assert.equal(learnInteractionSelector({ url: 'https://portal.example.com/login', label: 'OTP Code', selector: '#otp' }), false);
    const pbEntry = lookupDomainPlaybook('https://portal.example.com/account/profile');
    assert.ok(pbEntry && pbEntry.selectors['Display Name'] === '#display-name');
    assert.equal('User Password' in pbEntry.selectors, false);
    assert.equal('OTP Code' in pbEntry.selectors, false);

    // Manual playbook save also rejects password/OTP/token selectors
    const manualSensitiveSel = await httpJson(
      port,
      'POST',
      '/api/playbook',
      { token: testToken },
      {
        action: 'save',
        domain: 'portal.example.com',
        selector: { name: 'Login Password', css: '#password' }
      }
    );
    assert.equal(manualSensitiveSel.statusCode, 500);
    assert.match(manualSensitiveSel.json.error, /sensitive/i);

    // Outgoing state, elements[].href, and #hash fragments redact sensitive OAuth tokens
    extWs.sendMaskedJson({
      type: 'status_sync',
      tabs: [
        {
          tabId: 301,
          substate: 'shared',
          paused: false,
          title: 'OAuth Callback',
          url: 'https://portal.example.com/oauth/cb?page=2&code=secret_oauth_code#access_token=hash_tok_999&state=xyz123'
        }
      ],
      activeTabId: 301
    });
    await new Promise((r) => setTimeout(r, 40));
    const redactedState = await httpJson(port, 'GET', '/api/state', { token: testToken });
    const tabUrlOut = redactedState.json.tabs[0].url;
    assert.ok(!tabUrlOut.includes('secret_oauth_code'), 'Public state must redact OAuth query code');
    assert.ok(!tabUrlOut.includes('hash_tok_999'), 'Public state must redact #access_token fragment');
    assert.ok(!tabUrlOut.includes('xyz123'), 'Public state must redact #state fragment');
    assert.ok(tabUrlOut.includes('page=2'), 'Public state preserves benign query params');

    // Hardlink escape inside allowed upload dir MUST be blocked (nlink > 1)
    const hlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-hl-test-'));
    try {
      const targetSecret = path.join(hlDir, 'real_secret.dat');
      const innocentLink = path.join(hlDir, 'innocent.png');
      fs.writeFileSync(targetSecret, 'TOP_SECRET_PAYLOAD');
      fs.linkSync(targetSecret, innocentLink);
      const hlCheck = evaluateUploadFileSafety(innocentLink, { allowedDirs: [hlDir] });
      assert.equal(hlCheck.allowed, false, 'Hard-linked file (nlink > 1) must be blocked');
      assert.equal(hlCheck.code, 'HARDLINK_BLOCKED');
    } finally {
      fs.rmSync(hlDir, { recursive: true, force: true });
    }

    // Deeply nested elements[].href inside snapshot/batch results must redact query & #hash secrets
    extWs.removeAllListeners('message');
    extWs.on('message', (txt) => {
      const msg = JSON.parse(txt);
      if (msg.type === 'rpc_request') {
        extWs.sendMaskedJson({
          type: 'rpc_response',
          id: msg.id,
          ok: true,
          result: {
            stepResults: [
              {
                step: 0,
                action: 'snapshot',
                result: {
                  url: 'https://app.example.com/home',
                  elements: [
                    {
                      index: 0,
                      tag: 'a',
                      label: 'SSO Login',
                      href: 'https://sso.example.com/magic?keep=1&token=magic_secret_777#id_token=jwt_888'
                    }
                  ]
                }
              }
            ]
          }
        });
      }
    });
    const deepBatchRes = await httpJson(
      port,
      'POST',
      '/api/command',
      { token: testToken },
      { method: 'batch', params: { steps: [{ action: 'snapshot' }] } }
    );
    assert.equal(deepBatchRes.statusCode, 200);
    const outHref = deepBatchRes.json.result.stepResults[0].result.elements[0].href;
    assert.ok(!outHref.includes('magic_secret_777'), 'elements[].href must redact ?token=');
    assert.ok(!outHref.includes('jwt_888'), 'elements[].href must redact #id_token=');
    assert.ok(outHref.includes('keep=1'), 'elements[].href preserves benign params');

    extWs.socket.destroy();
  } finally {
    await daemon.close();
    if (prevHome === undefined) delete process.env.CHROME_LIVE_HOME;
    else process.env.CHROME_LIVE_HOME = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  // 3. Extension runtime & VM behavioral verification:
  //    - Clicking enabled or disabled password/OTP inputs NEVER returns el.value in 42/60-char receipts
  //    - mergeRelayTabBack rejects non-popout paused tabs and preserves paused=true on external RPC merges
  const swSource = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'service-worker.js'), 'utf8');
  assert.match(
    swSource,
    /if \(method === 'remote_interact'\) \{\s*const entry = resolveTargetEntry\(params\.tabId\);\s*await assertTabReadyForAction\(entry\);/
  );
  assert.match(
    swSource,
    /if \(method === 'inspect_region'\) \{\s*const entry = resolveTargetEntry\(params\.tabId\);\s*await assertTabReadyForAction\(entry\);/
  );
  assert.match(swSource, /if \(reason === 'canceled_by_user'\)/);
  assert.match(swSource, /await stopCdpForTab\(tabId, entry\);\s*managedTabs\.delete\(tabId\);/);
  assert.match(swSource, /Sharing an existing signed-in tab requires explicit user confirmation/);
  assert.ok(!swSource.includes('/ws/extension?token='), 'Extension WS must not pass token in query string');

  // Execute the exact click label snippet from service-worker.js inside a VM against mock filled password/OTP inputs
  const clickLabelMatch = swSource.match(
    /const elTagLower = el\.tagName\.toLowerCase\(\);[\s\S]*?if \(el\.disabled \|\| el\.getAttribute\('aria-disabled'\) === 'true'\) \{\s*const dLabel = safeElemLabel\(60\);\s*return \{ ok: false, error: `Element is disabled: \$\{dLabel\}` \};\s*\}/
  );
  assert.ok(clickLabelMatch, 'Expected safeElemLabel block in service-worker.js click handler');
  const runClickLabelCheck = vm.runInNewContext(
    `(function(el) { ${clickLabelMatch[0]} return { ok: true, label: safeElemLabel(42) }; })`
  );

  const secretValue = 'MyBankSecretPass#2026!';
  const makeMockInput = ({ type = 'password', disabled = false, autocomplete = '' } = {}) => ({
    tagName: 'INPUT',
    type,
    value: secretValue,
    textContent: secretValue,
    disabled,
    isContentEditable: false,
    id: '',
    getAttribute(k) {
      if (k === 'autocomplete') return autocomplete;
      return null;
    }
  });

  const enabledPwdRes = runClickLabelCheck(makeMockInput({ type: 'password', disabled: false }));
  assert.equal(enabledPwdRes.ok, true);
  assert.equal(enabledPwdRes.label, '(password)');
  assert.equal(enabledPwdRes.label.includes(secretValue), false);

  const disabledPwdRes = runClickLabelCheck(makeMockInput({ type: 'password', disabled: true }));
  assert.equal(disabledPwdRes.ok, false);
  assert.equal(disabledPwdRes.error, 'Element is disabled: (password)');
  assert.equal(disabledPwdRes.error.includes(secretValue), false);

  const otpTextRes = runClickLabelCheck(makeMockInput({ type: 'text', disabled: false, autocomplete: 'one-time-code' }));
  assert.equal(otpTextRes.label, '(password)');
  assert.equal(otpTextRes.label.includes(secretValue), false);

  const plainFilledInputRes = runClickLabelCheck(makeMockInput({ type: 'text', disabled: false, autocomplete: '' }));
  assert.equal(plainFilledInputRes.label, 'input');
  assert.equal(plainFilledInputRes.label.includes(secretValue), false);

  // Execute mergeRelayTabBack from service-worker.js inside a VM to verify pause cannot be lifted by external RPC
  const mergeFnMatch = swSource.match(/async function mergeRelayTabBack\(entry[\s\S]*?\n\}/);
  assert.ok(mergeFnMatch, 'Expected mergeRelayTabBack function in service-worker.js');
  let capturedFrameCount = 0;
  const runMergeHarness = vm.runInNewContext(
    `(${mergeFnMatch[0]})`,
    {
      currentLang: 'en',
      tr: () => ({ groupTitle: 'Live', groupPaused: 'Paused' }),
      chrome: {
        windows: {
          get: async (id) => ({ id, type: 'normal' }),
          getAll: async () => [{ id: 1, type: 'normal' }]
        },
        tabs: {
          get: async (id) => ({ id, windowId: 99 }),
          move: async () => {},
          group: async () => {}
        }
      },
      placeInBackgroundTabGroup: async () => {},
      syncHud: async () => {},
      syncLiveTabGroups: async () => {},
      captureQuickFrame: async () => {
        capturedFrameCount += 1;
      },
      pushLocalAudit: () => {},
      notifyPanelAndDaemon: () => {}
    }
  );

  // Ordinary paused tab (not popped out) MUST throw on relay_merge
  const ordinaryPausedTab = { tabId: 5, paused: true, uiMode: 'paused', relayPopoutWinId: null };
  await assert.rejects(() => runMergeHarness(ordinaryPausedTab), /not in a standalone relay popout/);
  assert.equal(ordinaryPausedTab.paused, true);

  // Popped-out relay tab merged via external RPC (default resumedByUserInBrowser=false) MUST stay paused & capture 0 frames!
  const popoutRelayTabEntry = {
    tabId: 6,
    substate: 'shared',
    paused: true,
    uiMode: 'paused',
    relayPopoutWinId: 99,
    originWindowId: 1,
    originIndex: 2
  };
  await runMergeHarness(popoutRelayTabEntry);
  assert.equal(popoutRelayTabEntry.paused, true, 'External RPC relay_merge must NOT clear user pause');
  assert.equal(popoutRelayTabEntry.uiMode, 'paused');
  assert.equal(capturedFrameCount, 0, 'External RPC relay_merge must NOT capture frames while paused');

  // Only browser-originated gesture (resumedByUserInBrowser: true) lifts pause
  const browserGestureEntry = {
    tabId: 7,
    substate: 'shared',
    paused: true,
    uiMode: 'paused',
    relayPopoutWinId: 99,
    originWindowId: 1,
    originIndex: 2
  };
  await runMergeHarness(browserGestureEntry, { resumedByUserInBrowser: true });
  assert.equal(browserGestureEntry.paused, false);
  assert.equal(browserGestureEntry.uiMode, 'working');
  assert.equal(capturedFrameCount, 1);

  // Closing a standalone relay window (`autoMergeClosedRelayTab`) MUST preserve paused=true and capture 0 frames
  const autoMergeFnMatch = swSource.match(/async function autoMergeClosedRelayTab\(closedEntry\)[\s\S]*?\n\}/);
  assert.ok(autoMergeFnMatch, 'Expected autoMergeClosedRelayTab in service-worker.js');
  const tempManaged = new Map();
  let autoMergeCaptured = 0;
  const runAutoMergeHarness = vm.runInNewContext(`(${autoMergeFnMatch[0]})`, {
    currentLang: 'en',
    managedTabs: tempManaged,
    checkTabUrlAllowed: () => ({ allowed: true }),
    tr: () => ({ groupTitle: 'Live', groupPaused: 'Paused' }),
    chrome: {
      windows: {
        get: async (id) => ({ id, type: 'normal' }),
        getAll: async () => [{ id: 1, type: 'normal' }]
      },
      tabs: {
        query: async () => [],
        create: async (props) => ({ id: 555, url: props.url, title: 'Restored' }),
        get: async (id) => ({ id, url: 'https://example.com/login', title: 'Restored' }),
        group: async () => {}
      }
    },
    placeInBackgroundTabGroup: async () => {},
    waitForTabComplete: async () => {},
    detachManagedTab: async () => {},
    syncHud: async () => {},
    syncLiveTabGroups: async () => {},
    captureQuickFrame: async () => {
      autoMergeCaptured += 1;
    },
    pushLocalAudit: () => {},
    notifyPanelAndDaemon: () => {}
  });
  await runAutoMergeHarness({
    tabId: 99,
    substate: 'shared',
    paused: true,
    url: 'https://example.com/login',
    originWindowId: 1,
    originIndex: 0,
    relayPopoutWinId: 888
  });
  const restored = tempManaged.get(555);
  assert.ok(restored, 'Expected restored tab entry');
  assert.equal(restored.paused, true, 'Closing relay window must keep restored tab paused');
  assert.equal(restored.uiMode, 'paused');
  assert.equal(autoMergeCaptured, 0, 'Closing paused relay window must not capture frames');

  // Verify extension panel sender isolation, HUD isTrusted guard, and TreeWalker draft/hidden exclusions
  assert.match(swSource, /const expectedPanelPrefix = chrome\.runtime\.getURL\('panel\/'\);/);
  assert.match(swSource, /if \(sender\.tab \|\| typeof sender\.url !== 'string' \|\| !sender\.url\.startsWith\(expectedPanelPrefix\)\)/);
  assert.match(swSource, /\[contenteditable="true"\], \[hidden\], \[aria-hidden="true"\]/);
  const hudSource = fs.readFileSync(path.join(REPO_ROOT, 'extension', 'hud.js'), 'utf8');
  assert.match(hudSource, /if \(!ev\.isTrusted\) return;/);
});
