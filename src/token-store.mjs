import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = Number.parseInt(process.env.CHROME_LIVE_PORT || '28196', 10) || 28196;

const hardenedDirs = new Set();

const SAFE_CHILD_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEM32',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'NODE_EXTRA_CA_CERTS',
  'CHROME_LIVE_HOME',
  'CHROME_LIVE_PORT',
  'CHROME_LIVE_UPLOAD_DIR'
]);

const SENSITIVE_ENV_NAME_RX =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|AUTH|SESSION|COOKIE|^AWS_|^GH_|^GITHUB_|^OPENAI_|^GEMINI_|^ANTHROPIC_|^GOOGLE_API|^AZURE_|^CLOUDFLARE_|^STRIPE_|^NPM_TOKEN|^NODE_OPTIONS$|^LD_PRELOAD$|^DYLD_INSERT_LIBRARIES$)/i;

export function buildSanitizedChildEnv(extraEnv = {}, sourceEnv = process.env) {
  const clean = Object.create(null);
  if (sourceEnv && typeof sourceEnv === 'object') {
    for (const [k, v] of Object.entries(sourceEnv)) {
      if (typeof v !== 'string') continue;
      const upper = k.toUpperCase();
      if (SENSITIVE_ENV_NAME_RX.test(upper) && upper !== 'CHROME_LIVE_TOKEN') {
        continue;
      }
      if (SAFE_CHILD_ENV_KEYS.has(upper)) {
        clean[k] = v;
      }
    }
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v !== undefined && v !== null) clean[k] = String(v);
    }
  }
  return clean;
}

export function assertSafeRegularFileForWriteSync(filePath) {
  const resolved = path.resolve(filePath);
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') return resolved;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing to write non-regular or symlinked state file: ${path.basename(resolved)}`);
  }
  if (typeof st.nlink === 'number' && st.nlink > 1) {
    throw new Error(`Refusing to write hard-linked state file: ${path.basename(resolved)}`);
  }
  return resolved;
}

export function readPrivateRegularFileSync(filePath, maxBytes = 1048576) {
  const resolved = path.resolve(filePath);
  const st = fs.lstatSync(resolved);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing to read non-regular or symlinked state file: ${path.basename(resolved)}`);
  }
  if (typeof st.nlink === 'number' && st.nlink > 1) {
    throw new Error(`Refusing to read hard-linked state file: ${path.basename(resolved)}`);
  }
  if (st.size > maxBytes) {
    throw new Error(`State file exceeds ${maxBytes}-byte safety ceiling: ${path.basename(resolved)}`);
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`State file owner mismatch for ${path.basename(resolved)}`);
    }
    if ((st.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(resolved, 0o600);
      } catch {
        throw new Error(`Insecure permissions on private state file: ${path.basename(resolved)}`);
      }
    }
  }
  return fs.readFileSync(resolved, 'utf8');
}

export function copySecretToClipboardConcealedSync(secretText) {
  if (typeof secretText !== 'string' || !secretText) return false;
  const cleanEnv = buildSanitizedChildEnv();
  try {
    if (process.platform === 'win32') {
      // Mark clipboard data with ExcludeClipboardContentFromMonitorProcessing & CanIncludeInClipboardHistory=0 (Windows Win+V / Cloud Clipboard exclusion)
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$text = [Console]::In.ReadToEnd();',
        '$do = New-Object System.Windows.Forms.DataObject;',
        '$do.SetText($text);',
        '$zero = [BitConverter]::GetBytes([UInt32]0);',
        '$msHist = New-Object System.IO.MemoryStream(,$zero);',
        '$msCloud = New-Object System.IO.MemoryStream(,$zero);',
        '$msExcl = New-Object System.IO.MemoryStream(,$zero);',
        '$do.SetData("CanIncludeInClipboardHistory", $false, $msHist);',
        '$do.SetData("CanUploadToCloudClipboard", $false, $msCloud);',
        '$do.SetData("ExcludeClipboardContentFromMonitorProcessing", $false, $msExcl);',
        '[System.Windows.Forms.Clipboard]::SetDataObject($do, $true)'
      ].join(' ');
      const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript],
        { input: secretText, encoding: 'utf8', windowsHide: true, timeout: 4000, env: cleanEnv }
      );
      return res.status === 0;
    }
    if (process.platform === 'darwin') {
      // NSPasteboard ConcealedType + TransientType (standard macOS password-manager exclusion)
      const jxa = [
        'ObjC.import("AppKit"); ObjC.import("Foundation");',
        'const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;',
        'const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);',
        'const pb = $.NSPasteboard.generalPasteboard;',
        'pb.clearContents;',
        'pb.setStringForType(str, $.NSPasteboardTypeString);',
        'pb.setDataForType($.NSData.data, $("org.nspasteboard.ConcealedType"));',
        'pb.setDataForType($.NSData.data, $("org.nspasteboard.TransientType"));'
      ].join(' ');
      const res = spawnSync('osascript', ['-l', 'JavaScript', '-e', jxa], {
        input: secretText,
        encoding: 'utf8',
        timeout: 4000,
        env: cleanEnv
      });
      return res.status === 0;
    }
    // Linux X11/Wayland: x-kde-passwordManagerHint=secret where supported, fallback to xclip
    const wl = spawnSync('wl-copy', ['--sensitive'], {
      input: secretText,
      encoding: 'utf8',
      timeout: 3000,
      env: cleanEnv
    });
    if (wl.status === 0) return true;
  } catch {}
  return false;
}

export function getStateDir() {
  if (process.env.CHROME_LIVE_HOME) {
    return path.resolve(process.env.CHROME_LIVE_HOME);
  }
  return path.join(os.homedir(), '.chrome-live-antigravity');
}

export function ensureSecureDirSync(dirPath) {
  const resolved = path.resolve(dirPath);
  const existedBefore = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(resolved, 0o700);
    } else if (!existedBefore || !hardenedDirs.has(resolved)) {
      hardenedDirs.add(resolved);
      const username = os.userInfo().username;
      if (username && !/["\r\n]/.test(username)) {
        spawnSync(
          'icacls',
          [resolved, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`],
          { windowsHide: true, stdio: 'ignore', timeout: 3000, env: buildSanitizedChildEnv() }
        );
      }
    }
  } catch {
    // Best-effort ACL tightening in restricted sandboxes
  }
  return resolved;
}

export function tightenFileAclSync(filePath) {
  const resolved = path.resolve(filePath);
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(resolved, 0o600);
    } else {
      const username = os.userInfo().username;
      if (username && !/["\r\n]/.test(username)) {
        spawnSync('icacls', [resolved, '/inheritance:r', '/grant:r', `${username}:F`], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 3000,
          env: buildSanitizedChildEnv()
        });
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
  let existingSymlinkOrTampered = false;
  try {
    // Read via strict lstat regular-file & ownership verifier (blocks symlink/hardlink read confusion)
    const raw = readPrivateRegularFileSync(tokenFile, 512).trim();
    if (raw.length >= 32) {
      return raw;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      existingSymlinkOrTampered = true;
      throw err;
    }
  }

  if (existingSymlinkOrTampered) {
    throw new Error('Refusing to overwrite tampered auth.token file');
  }
  const dir = ensureSecureDirSync(getStateDir());
  const fresh = crypto.randomBytes(32).toString('hex');
  const outPath = assertSafeRegularFileForWriteSync(path.join(dir, 'auth.token'));
  fs.writeFileSync(outPath, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  tightenFileAclSync(outPath);
  return fresh;
}

export function timingSafeEqualToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
