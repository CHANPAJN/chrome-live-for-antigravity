#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandLeadingTilde, getDefaultUploadStagingDir, isNetworkUncPath } from '../src/guardrails.mjs';
import { buildSignedHttpHeaders, verifySignedHttpResponse } from '../src/hmac-auth.mjs';
import { startMcpStdioServer } from '../src/mcp-server.mjs';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureAuthToken,
  ensureSecureDirSync,
  getStateDir,
  getTokenFilePath,
  tightenFileAclSync
} from '../src/token-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_ENTRY = path.join(REPO_ROOT, 'src', 'daemon.mjs');
const SPAWN_LOCK_FILE = path.join(getStateDir(), 'spawn.cooldown');
const SPAWN_COOLDOWN_MS = 15000;

function requestDaemon(method, routePath, bodyObj = null, timeoutMs = 30000) {
  const token = ensureAuthToken();
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const { ts, nonce, headers } = buildSignedHttpHeaders(token, method, routePath, payload);
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(payload.length);
    }

    const req = http.request(
      {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        path: routePath,
        method,
        timeout: timeoutMs,
        headers
      },
      (res) => {
        const statusCode = res.statusCode || 500;
        if (!verifySignedHttpResponse(token, statusCode, res.headers, ts, nonce)) {
          res.destroy();
          req.destroy();
          reject(
            new Error(
              `Unverified local service on ${DEFAULT_HOST}:${DEFAULT_PORT} (missing or invalid daemon HMAC signature)`
            )
          );
          return;
        }
        const MAX_RES_BYTES = 16 * 1024 * 1024;
        const chunks = [];
        let receivedBytes = 0;
        let aborted = false;
        res.on('data', (c) => {
          receivedBytes += c.length;
          if (receivedBytes > MAX_RES_BYTES) {
            aborted = true;
            res.destroy();
            req.destroy();
            reject(new Error(`Daemon response exceeded 16MB safety cap (${routePath})`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          const rawBuf = Buffer.concat(chunks);
          const ct = res.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try {
              const parsed = JSON.parse(rawBuf.toString('utf8'));
              if (statusCode >= 400 || parsed.ok === false) {
                reject(new Error(parsed.error || parsed.message || `HTTP ${statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (e) {
              reject(new Error(`Malformed JSON from daemon: ${e.message}`));
            }
          } else {
            resolve({ statusCode, buffer: rawBuf, contentType: ct });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Daemon request timed out (${routePath})`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureDaemonRunning(forceSpawn = false) {
  try {
    return await requestDaemon('GET', '/api/health', null, 1200);
  } catch (probeErr) {
    if (probeErr instanceof Error && probeErr.message.includes('Unverified local service')) {
      throw probeErr;
    }
    // Daemon is offline; check cooldown before spawning a background process.
  }

  ensureSecureDirSync(getStateDir());
  if (!forceSpawn) {
    try {
      const st = fs.statSync(SPAWN_LOCK_FILE);
      if (Date.now() - st.mtimeMs < SPAWN_COOLDOWN_MS) {
        // Wait briefly in case another CLI invocation just spawned it.
        await new Promise((r) => setTimeout(r, 450));
        return await requestDaemon('GET', '/api/health', null, 2000);
      }
    } catch {}
  }

  fs.writeFileSync(SPAWN_LOCK_FILE, `${Date.now()}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenFileAclSync(SPAWN_LOCK_FILE);
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 180));
    try {
      return await requestDaemon('GET', '/api/health', null, 1000);
    } catch {}
  }
  throw new Error(`Daemon did not become reachable on ${DEFAULT_HOST}:${DEFAULT_PORT}`);
}

async function restartDaemonCleanly(alwaysStart = false) {
  let wasRunning = false;
  try {
    await requestDaemon('GET', '/api/health', null, 900);
    wasRunning = true;
  } catch {}

  if (wasRunning) {
    await requestDaemon('POST', '/api/shutdown', {}, 2000).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        await requestDaemon('GET', '/api/health', null, 500);
      } catch {
        break;
      }
    }
  }

  if (wasRunning || alwaysStart) {
    return await ensureDaemonRunning(true);
  }
  return null;
}

async function callDaemonWithAutoStart(method, routePath, bodyObj = null, timeoutMs = 30000) {
  await ensureDaemonRunning();
  return await requestDaemon(method, routePath, bodyObj, timeoutMs);
}

const BOOLEAN_CLI_FLAGS = new Set([
  'compact',
  'submit',
  'fg',
  'bg',
  'json',
  'all',
  'no-focus',
  'with-plugin',
  'help',
  'h'
]);

const KNOWN_VALUE_CLI_FLAGS = new Set([
  'tab',
  'out',
  'label',
  'max',
  'target',
  'selector',
  'scroll',
  'route',
  'tip',
  'domain',
  'port',
  'timeout'
]);

function parseFlags(args, cmd = '') {
  const positional = [];
  const flags = {};
  let passthrough = false;
  for (let i = 0; i < args.length; i++) {
    const cur = String(args[i] ?? '');
    if (passthrough) {
      positional.push(cur);
      continue;
    }
    if (cur === '--') {
      passthrough = true;
      continue;
    }
    if (cur.startsWith('--') && cur.length > 2) {
      const body = cur.slice(2);
      const eqIdx = body.indexOf('=');
      const key = eqIdx === -1 ? body : body.slice(0, eqIdx);
      // Allow typing flag-like strings (`chrome-live type 0 "--silent-debugger-extension-api"`) without requiring `--`
      if (
        cmd === 'type' &&
        positional.length === 1 &&
        !BOOLEAN_CLI_FLAGS.has(key) &&
        !KNOWN_VALUE_CLI_FLAGS.has(key)
      ) {
        positional.push(cur);
        continue;
      }
      if (eqIdx !== -1) {
        const rawVal = body.slice(eqIdx + 1);
        flags[key] = BOOLEAN_CLI_FLAGS.has(key) ? rawVal !== 'false' && rawVal !== '0' : rawVal;
        continue;
      }
      if (BOOLEAN_CLI_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      const nextStr = next === undefined ? '' : String(next);
      const nextKey = nextStr.startsWith('--') ? nextStr.slice(2).split('=')[0] : '';
      if (
        next === undefined ||
        (nextStr.startsWith('--') && (BOOLEAN_CLI_FLAGS.has(nextKey) || KNOWN_VALUE_CLI_FLAGS.has(nextKey)))
      ) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(cur);
    }
  }
  return { positional, flags };
}

function writeExtensionLocalRuntimeConfig(token) {
  ensureSecureDirSync(getDefaultUploadStagingDir());
  const runtimeFile = path.join(REPO_ROOT, 'extension', '.local-runtime.json');
  const data = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token
  };
  // Pre-create empty file and tighten Windows ACL BEFORE writing plaintext pairing secret
  if (!fs.existsSync(runtimeFile)) {
    fs.writeFileSync(runtimeFile, '', { encoding: 'utf8', mode: 0o600 });
  }
  tightenFileAclSync(runtimeFile);
  fs.writeFileSync(runtimeFile, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return runtimeFile;
}

function copyDirectoryRecursive(srcDir, destDir, replacements = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcFull = path.join(srcDir, entry.name);
    const destFull = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcFull, destFull, replacements);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.json', '.mjs', '.js', '.html', '.svg'].includes(ext)) {
        let content = fs.readFileSync(srcFull, 'utf8');
        for (const [placeholder, rawVal] of Object.entries(replacements)) {
          let safeVal = String(rawVal);
          if (ext === '.json') {
            safeVal = JSON.stringify(safeVal).slice(1, -1);
          } else if (ext === '.mjs' || ext === '.js') {
            safeVal = JSON.stringify(safeVal.replace(/\\/g, '/')).slice(1, -1).replace(/'/g, "\\'");
          }
          content = content.split(placeholder).join(safeVal);
        }
        fs.writeFileSync(destFull, content, 'utf8');
      } else {
        fs.copyFileSync(srcFull, destFull);
      }
    }
  }
}

function formatPlaybookBanner(pb) {
  if (!pb || typeof pb !== 'object') return '';
  const lines = [`[Site Playbook: ${pb.domain}]`];
  const routes = Object.entries(pb.routes || {});
  if (routes.length > 0) {
    for (const [name, url] of routes.slice(0, 8)) {
      lines.push(`  Route: ${name} -> ${url}`);
    }
  }
  const selectors = Object.entries(pb.selectors || {});
  if (selectors.length > 0) {
    lines.push(
      `  Selectors: ${selectors
        .slice(0, 6)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ')}`
    );
  }
  if (Array.isArray(pb.tips) && pb.tips.length > 0) {
    for (const tip of pb.tips.slice(0, 5)) {
      lines.push(`  Tip: ${tip}`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

function formatSnapshotElementLine(el) {
  const badges = [];
  if (el.role) badges.push(`role=${el.role}`);
  if (el.disabled) badges.push('DISABLED');
  if (el.checked !== undefined) badges.push(`checked=${el.checked}`);
  if (el.selected) badges.push('selected');
  if (el.expanded !== undefined) badges.push(`expanded=${el.expanded}`);
  const badgeStr = badges.length > 0 ? ` {${badges.join(' ')}}` : '';
  return `[${el.index}] <${el.tag}> ${el.label}${badgeStr}${el.href ? ` -> ${el.href}` : ''}`;
}

function formatAlertsBlock(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return '';
  return `Alerts:\n${alerts.map((a) => `  ! ${a}`).join('\n')}\n\n`;
}

function printHelp() {
  const help = `
chrome-live-for-antigravity — Zero-dependency Chrome MV3 bridge, CLI & MCP server

Usage:
  chrome-live setup                      Generate local pairing token & extension bootstrap config
  chrome-live start                      Start the local background bridge daemon
  chrome-live reload                     Hot-reload the unpacked Chrome extension in background
  chrome-live install [--with-plugin]    Opt-in install of Antigravity plugin (Skill + Live Sidecar)
  chrome-live health                     Check daemon & Chrome extension status
  chrome-live tabs                       List shared & controlled browser tabs
  chrome-live open <url> [--label "..."] Open URL in background Chrome tab group
  chrome-live snapshot [--tab <id>]      Capture indexed interactive DOM elements & states
  chrome-live click <index|selector|text> Click element by index, CSS selector, or label
  chrome-live type <index|selector|placeholder> "<text>" [--submit]
  chrome-live upload [target] <file1> [file2...] Upload local file(s) via CDP into file input or editor
  chrome-live relay [popout|merge] [--tab <id>]  Pop tab into human relay window or merge back to AI
  chrome-live scroll [down|up|top|bottom] [pixels]
  chrome-live navigate <url> [--tab <id>]
  chrome-live wait [ms] [--selector "css"]
  chrome-live batch '<json_steps_array>' [--tab <id>]
  chrome-live playbook <on|off|list|save|tip|clear> [domain]
  chrome-live extract <url1> [url2...] [--scroll 1]
  chrome-live screenshot [--out <file>]  Save latest live preview frame to disk
  chrome-live release [--tab <id>|--all] Detach control from a tab (or all) without closing it
  chrome-live done ["summary"]           Finish task, detach debugger & clean up worker tabs
  chrome-live stop                       Gracefully stop the background daemon
  chrome-live mcp                        Run standard stdio MCP server
`.trim();
  process.stdout.write(`${help}\n`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const cmd = rawArgs[0] || 'help';
  const { positional, flags } = parseFlags(rawArgs.slice(1), cmd);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'mcp') {
    startMcpStdioServer({ callDaemon: callDaemonWithAutoStart });
    return;
  }

  if (cmd === 'setup' || cmd === 'install') {
    const token = ensureAuthToken();
    const runtimePath = writeExtensionLocalRuntimeConfig(token);
    process.stdout.write(`[OK] Local auth token ready at: ${getTokenFilePath()}\n`);
    process.stdout.write(`[OK] Unpacked extension bootstrap written to: ${runtimePath}\n`);
    process.stdout.write(
      `[Next] Open chrome://extensions (or edge://extensions) -> Enable Developer Mode -> Load unpacked -> ${path.join(REPO_ROOT, 'extension')}\n`
    );

    if (cmd === 'install' && flags['with-plugin']) {
      const templateDir = path.join(REPO_ROOT, 'plugin-template');
      const targetPluginDir = path.join(
        os.homedir(),
        '.gemini',
        'config',
        'plugins',
        'chrome-live-for-antigravity'
      );
      const cliSlashPath = path.join(REPO_ROOT, 'bin', 'chrome-live.mjs').replace(/\\/g, '/');
      const daemonSlashPath = path.join(REPO_ROOT, 'src', 'daemon.mjs').replace(/\\/g, '/');
      copyDirectoryRecursive(templateDir, targetPluginDir, {
        '__CHROME_LIVE_CLI_PATH__': cliSlashPath,
        '__CHROME_LIVE_DAEMON_PATH__': daemonSlashPath,
        '__CHROME_LIVE_PORT__': String(DEFAULT_PORT)
      });
      process.stdout.write(`[OK] Antigravity plugin installed to: ${targetPluginDir}\n`);
    } else if (cmd === 'install') {
      process.stdout.write(
        `[Info] Global ~/.gemini/config was NOT modified (opt-in by default). Pass --with-plugin to install the Antigravity Skill & Live Sidecar.\n`
      );
    }
    // If a local daemon is already running, restart it cleanly (bypassing 15s spawn cooldown) so updated code & bundle hash take effect immediately
    try {
      const restarted = await restartDaemonCleanly(false);
      if (restarted) {
        process.stdout.write(`[OK] Restarted local daemon; connected Chrome extension will hot-reload automatically.\n`);
      }
    } catch {}
    return;
  }

  if (cmd === 'reload' || cmd === 'restart') {
    const snap = await restartDaemonCleanly(true);
    let extConnected = Boolean(snap?.extensionConnected);
    if (!extConnected) {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const h = await requestDaemon('GET', '/api/health', null, 1000);
          if (h?.extensionConnected) {
            extConnected = true;
            break;
          }
        } catch {}
      }
    }
    if (extConnected) {
      try {
        const res = await requestDaemon('POST', '/api/command', {
          method: 'reload_extension',
          params: {}
        });
        process.stdout.write(`${JSON.stringify({ daemonRestarted: true, ...res.result }, null, 2)}\n`);
        return;
      } catch {}
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, daemonRestarted: true, extensionConnected: extConnected }, null, 2)}\n`
    );
    return;
  }

  if (cmd === 'start') {
    const snap = await ensureDaemonRunning();
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    return;
  }

  if (cmd === 'stop') {
    try {
      const res = await requestDaemon('POST', '/api/shutdown', {}, 2500);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || /ECONNREFUSED|socket hang up/i.test(msg)) {
        process.stdout.write(`{"ok":true,"alreadyStopped":true}\n`);
      } else {
        throw new Error(`Failed to stop running daemon on ${DEFAULT_HOST}:${DEFAULT_PORT}: ${msg}`);
      }
    }
    return;
  }

  if (cmd === 'health' || cmd === 'status') {
    const snap = await callDaemonWithAutoStart('GET', '/api/health');
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    return;
  }

  if (cmd === 'tabs') {
    const snap = await callDaemonWithAutoStart('GET', '/api/health');
    process.stdout.write(`${JSON.stringify(snap.tabs || [], null, 2)}\n`);
    return;
  }

  if (cmd === 'playbook') {
    const sub = positional[0] || 'status';
    const domain = positional[1] || '';
    if (sub === 'on' || sub === 'enable' || sub === 'off' || sub === 'disable') {
      const enabled = sub === 'on' || sub === 'enable';
      const res = await callDaemonWithAutoStart('POST', '/api/playbook', {
        action: 'set_enabled',
        enabled
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    if (sub === 'status' || sub === 'list') {
      const q = domain ? `?domain=${encodeURIComponent(domain)}` : '';
      const res = await callDaemonWithAutoStart('GET', `/api/playbook${q}`);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    if (sub === 'clear') {
      const res = await callDaemonWithAutoStart('POST', '/api/playbook', {
        action: 'clear',
        domain
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    if (sub === 'tip') {
      const tipText = positional[2];
      if (!domain || !tipText) {
        throw new Error('Usage: chrome-live playbook tip <domain> "<widget workaround note>"');
      }
      const res = await callDaemonWithAutoStart('POST', '/api/playbook', {
        action: 'save',
        domain,
        tip: tipText
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    if (sub === 'save') {
      if (!domain) {
        throw new Error(
          'Usage: chrome-live playbook save <domain> [--route "Title=https://..."] [--selector "name=css"] [--tip "..."]'
        );
      }
      let route;
      if (typeof flags.route === 'string' && flags.route.includes('=')) {
        const eq = flags.route.indexOf('=');
        route = { name: flags.route.slice(0, eq).trim(), url: flags.route.slice(eq + 1).trim() };
      }
      let selector;
      if (typeof flags.selector === 'string' && flags.selector.includes('=')) {
        const eq = flags.selector.indexOf('=');
        selector = { name: flags.selector.slice(0, eq).trim(), css: flags.selector.slice(eq + 1).trim() };
      }
      const tip = typeof flags.tip === 'string' ? flags.tip : undefined;
      const res = await callDaemonWithAutoStart('POST', '/api/playbook', {
        action: 'save',
        domain,
        route,
        selector,
        tip
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    throw new Error(`Unknown playbook subcommand "${sub}". Expected: on|off|list|save|tip|clear`);
  }

  let tabId = undefined;
  if (flags.tab !== undefined) {
    const rawTabFlag = String(flags.tab).trim();
    const parsedTab = /^\d+$/.test(rawTabFlag) ? Number.parseInt(rawTabFlag, 10) : Number.NaN;
    if (!Number.isSafeInteger(parsedTab) || parsedTab <= 0) {
      throw new Error(`Invalid --tab value "${flags.tab}"; expected a positive integer tabId`);
    }
    tabId = parsedTab;
  }

  if (cmd === 'open') {
    const url = positional[0];
    if (!url) throw new Error('Usage: chrome-live open <url> [--label "..."]');
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'open',
      params: {
        url,
        label: typeof flags.label === 'string' ? flags.label : '',
        background: flags.fg ? false : true
      }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'snapshot') {
    const maxItems = flags.max ? Number.parseInt(String(flags.max), 10) : 90;
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'snapshot',
      params: { tabId, maxItems }
    });
    const r = res.result || {};
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    } else {
      const banner = formatPlaybookBanner(r.playbook);
      const alertBlock = formatAlertsBlock(r.alerts);
      process.stdout.write(`${banner}Title: ${r.title || ''}\nURL: ${r.url || ''}\nTabId: ${r.tabId ?? ''}\n\n${alertBlock}`);
      if (Array.isArray(r.elements)) {
        for (const el of r.elements) {
          process.stdout.write(`${formatSnapshotElementLine(el)}\n`);
        }
      }
      if (r.excerpt) {
        process.stdout.write(`\n--- Page Excerpt ---\n${r.excerpt}\n`);
      }
    }
    return;
  }

  if (cmd === 'click') {
    const rawTarget = positional[0];
    if (rawTarget === undefined) throw new Error('Usage: chrome-live click <index|text> [--tab <id>]');
    const target = /^\d+$/.test(rawTarget) ? Number.parseInt(rawTarget, 10) : rawTarget;
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'click',
      params: { target, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'type') {
    const rawTarget = positional[0];
    const text = positional[1];
    if (rawTarget === undefined || text === undefined) {
      throw new Error('Usage: chrome-live type <index> "<text>" [--submit] [--tab <id>]');
    }
    const target = /^\d+$/.test(rawTarget) ? Number.parseInt(rawTarget, 10) : rawTarget;
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'type',
      params: { target, text, submit: Boolean(flags.submit), tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'upload') {
    if (positional.length === 0) {
      throw new Error('Usage: chrome-live upload [index|selector] <file1> [file2...] [--tab <id>]');
    }
    let target =
      typeof flags.target === 'string'
        ? /^\d+$/.test(flags.target.trim())
          ? Number.parseInt(flags.target.trim(), 10)
          : flags.target
        : 'auto';
    let fileArgs = positional;

    if (flags.target === undefined && positional.length >= 2) {
      let firstIsFile = false;
      if (!isNetworkUncPath(positional[0])) {
        const expandedFirst = expandLeadingTilde(positional[0]);
        if (!isNetworkUncPath(expandedFirst)) {
          const firstAsPath = path.resolve(expandedFirst);
          if (!isNetworkUncPath(firstAsPath)) {
            try {
              firstIsFile = fs.existsSync(firstAsPath) && fs.statSync(firstAsPath).isFile();
            } catch {}
          }
        }
      }
      if (!firstIsFile) {
        target = /^\d+$/.test(positional[0]) ? Number.parseInt(positional[0], 10) : positional[0];
        fileArgs = positional.slice(1);
      }
    }

    const expandedFiles = fileArgs.map((f) => expandLeadingTilde(String(f || '')));
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'upload',
      params: { target, files: expandedFiles, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'relay') {
    const mode = String(positional[0] || 'popout').toLowerCase();
    const method = mode === 'merge' || mode === 'back' ? 'relay_merge' : 'relay_popout';
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method,
      params: { tabId, focus: flags['no-focus'] ? false : true }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'scroll') {
    const direction = positional[0] || 'down';
    const amount = positional[1] ? Number.parseInt(positional[1], 10) : 600;
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'scroll',
      params: { direction, amount, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'navigate') {
    const url = positional[0];
    if (!url) throw new Error('Usage: chrome-live navigate <url> [--tab <id>]');
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'navigate',
      params: { url, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'wait') {
    const ms = positional[0] ? Number.parseInt(positional[0], 10) : 500;
    const selector = typeof flags.selector === 'string' ? flags.selector : undefined;
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'wait',
      params: { ms, selector, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'batch') {
    let rawJson = positional[0];
    if (!rawJson || rawJson === '-') {
      rawJson = fs.readFileSync(0, 'utf8').trim();
    } else if (rawJson.startsWith('@')) {
      rawJson = fs.readFileSync(path.resolve(rawJson.slice(1)), 'utf8').trim();
    }
    if (!rawJson) {
      throw new Error(
        'Usage: chrome-live batch \'[{"action":"type","target":"#q","text":"hello"},{"action":"wait","ms":600},{"action":"snapshot"}]\' (or pass "-" to read JSON from stdin)'
      );
    }
    let steps;
    try {
      steps = JSON.parse(rawJson);
    } catch (e) {
      throw new Error(`Invalid JSON steps array for batch: ${e.message}`);
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('batch steps must be a non-empty JSON array');
    }
    const res = await callDaemonWithAutoStart(
      'POST',
      '/api/command',
      {
        method: 'batch',
        params: { tabId, steps },
        timeoutMs: 55000
      },
      60000
    );
    const out = res.result || {};
    if (flags.compact && out.finalSnapshot) {
      const snap = out.finalSnapshot;
      const banner = formatPlaybookBanner(snap.playbook || out.playbook);
      const alertBlock = formatAlertsBlock(snap.alerts);
      process.stdout.write(
        `${banner}Completed ${out.completedSteps}/${out.totalSteps} steps (TabId: ${out.tabId})\nTitle: ${snap.title || ''}\nURL: ${snap.url || ''}\n\n${alertBlock}`
      );
      for (const el of snap.elements || []) {
        process.stdout.write(`${formatSnapshotElementLine(el)}\n`);
      }
      if (snap.excerpt) {
        process.stdout.write(`\n--- Page Excerpt ---\n${snap.excerpt}\n`);
      }
    } else {
      const stripLargeBlobs = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(stripLargeBlobs);
        const copy = {};
        for (const [k, v] of Object.entries(node)) {
          if ((k === 'dataBase64' || k === 'base64') && typeof v === 'string' && v.length > 256) {
            copy[k] = `[omitted ${v.length} base64 chars]`;
          } else {
            copy[k] = stripLargeBlobs(v);
          }
        }
        return copy;
      };
      process.stdout.write(`${JSON.stringify(stripLargeBlobs(out), null, 2)}\n`);
    }
    return;
  }

  if (cmd === 'extract') {
    if (positional.length === 0) throw new Error('Usage: chrome-live extract <url1> [url2...] [--scroll 1]');
    const scrollSteps = flags.scroll !== undefined ? Number.parseInt(String(flags.scroll), 10) : 1;
    const res = await callDaemonWithAutoStart(
      'POST',
      '/api/command',
      {
        method: 'extract',
        params: { urls: positional, scrollSteps },
        timeoutMs: 50000
      },
      55000
    );
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'screenshot') {
    const snap = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'screenshot',
      params: { tabId }
    });
    const b64 = snap.result?.data;
    if (!b64) throw new Error('No screenshot data returned');
    const outPath =
      typeof flags.out === 'string'
        ? path.resolve(flags.out)
        : path.join(ensureSecureDirSync(path.join(getStateDir(), 'screenshots')), `chrome-live-${Date.now()}.jpg`);
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'), { mode: 0o600 });
    tightenFileAclSync(outPath);
    process.stdout.write(`${JSON.stringify({ ok: true, file: outPath, tabId: snap.result?.tabId })}\n`);
    return;
  }

  if (cmd === 'release') {
    const releaseAll = Boolean(flags.all) || positional[0] === 'all';
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'release_tab',
      params: releaseAll ? { all: true } : { tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  if (cmd === 'done') {
    const summary = positional[0] || 'Task finished';
    const res = await callDaemonWithAutoStart('POST', '/api/command', {
      method: 'done',
      params: { summary, tabId }
    });
    process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run "chrome-live --help" for usage.`);
}

main().catch((err) => {
  process.stderr.write(`[chrome-live error] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
