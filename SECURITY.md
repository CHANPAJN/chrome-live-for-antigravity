# Security Policy

## Scope & Architecture

`chrome-live-for-antigravity` is a 100% local, zero-dependency bridge connecting Google Antigravity to your signed-in Chromium browser over `127.0.0.1` loopback:

- **Loopback & Origin Isolation**: Binds strictly to `127.0.0.1` (default port `28196`), verifies `Host` headers, rejects browser `Origin` headers with `403`, and enforces RFC 6455 client WebSocket frame masking.
- **Zero-Plaintext Mutual HMAC Authentication**: Authenticates all local HTTP and WebSocket traffic using collision-free JSON-tuple `HMAC-SHA256` signatures (`X-Chrome-Live-Hdr-Sig` verified prior to body buffering) with timestamp skew bounds and replay-prevention nonces.
- **Dual-Layer Financial & Credential Guardrails**: Both the local Node.js daemon and the MV3 extension block payment gateways, online banking portals, `chrome://` / `edge://` pages, and checkout routes, while redacting password fields, masked text, and editor drafts on read.
- **Staged File Upload Confinement**: Native CDP uploads are restricted to `~/.chrome-live-antigravity/uploads` (or an explicit `CHROME_LIVE_UPLOAD_DIR` allowlist) with symlink/hardlink rejection and file-descriptor snapshotting against TOCTOU swaps.

## Supported Versions

| Version | Supported |
| :--- | :---: |
| `1.0.x` (`main`) | Yes |

## Reporting a Vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/CHANPAJN/chrome-live-for-antigravity/security/advisories/new) rather than opening a public issue with exploit details. Include:

1. Affected component (`src/daemon.mjs`, `src/guardrails.mjs`, `extension/`, etc.) and OS / Chrome version;
2. Minimal local reproduction steps;
3. Expected vs. observed behavior.
