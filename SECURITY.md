# Security Policy

## Scope & Architecture

`chrome-live-for-antigravity` is a 100% local, zero-dependency bridge connecting Google Antigravity to your signed-in Chromium browser over `127.0.0.1` loopback:

- **Loopback & Origin Isolation**: Binds strictly to `127.0.0.1` (default port `28196`), verifies `Host` headers, rejects browser `Origin` headers with `403`, and enforces RFC 6455 client WebSocket frame masking.
- **Zero-Plaintext Mutual HMAC & Epoch Isolation**: Authenticates all local HTTP and WebSocket traffic using collision-free JSON-tuple `HMAC-SHA256` signatures (`X-Chrome-Live-Hdr-Sig` verified prior to body buffering) with timestamp skew bounds, replay-prevention nonces, persistent 128-bit `profileInstanceId` binding, monotonic `connectionEpoch`, and per-tab `grantSeq` lease invalidation.
- **Dual-Layer Financial, Derived-Popup & DOM Guardrails**: Both the local Node.js daemon and the MV3 extension block payment gateways, online banking portals, cloud metadata IPs, `chrome://` / `edge://` pages, checkout routes, and child popups spawned from controlled tabs (`tabs.onCreated` / `onCreatedNavigationTarget` / `tabs.onReplaced`). Snapshot indexing enforces per-pass `data-clive-snap` element fingerprints, `elementFromPoint` click-occlusion checks, out-of-viewport `LIVE` / `HOLD` native toolbar badges, and `OffscreenCanvas` credential-box masking.
- **Read/Write State Verification, Sanitized Subprocess Env & Staged Upload Confinement**: Local token and playbook reads/writes enforce `lstat` symlink/hardlink rejection and strict byte caps; background daemon spawning strips inherited API keys/tokens and `NODE_OPTIONS` from `process.env`; native CDP uploads are confined to `~/.chrome-live-antigravity/uploads` with FD snapshotting against TOCTOU swaps.

## Supported Versions

| Version | Supported |
| :--- | :---: |
| `1.0.x` (`main`) | Yes |

## Reporting a Vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/CHANPAJN/chrome-live-for-antigravity/security/advisories/new) rather than opening a public issue with exploit details. Include:

1. Affected component (`src/daemon.mjs`, `src/guardrails.mjs`, `extension/`, etc.) and OS / Chrome version;
2. Minimal local reproduction steps;
3. Expected vs. observed behavior.
