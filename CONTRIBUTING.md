# Contributing to VPNtoProxy

English and Vietnamese contributions are welcome. Open an issue describing a bug or proposed change, including the OS, application version and engine mode. Never include private keys, passwords or complete peer configuration files.

## Development

Use Node.js 24 and npm. Install the frontend with `npm --prefix frontend ci`, then run `npm test` and `npm run build`. `npm start` runs the built interface and backend on loopback. `npm run dev` is the frontend-only preview. The Electron shell uses `desktop/main.cjs` and an isolated preload bridge.

## Pull requests

- Explain the behavior change and relevant verification.
- Keep English and Vietnamese catalogs and READMEs aligned.
- Add network integration tests for routing, authentication and lifecycle changes. Tests must use loopback fixtures and must not depend on a public proxy.
- Preserve the default block policy and outbound isolation. Never introduce an implicit direct fallback.
- Keep secrets out of metadata, logs, screenshots, fixtures and release artifacts.
- Test an actual sing-box build before claiming new VPN compatibility; config-generation tests alone are insufficient.

Use the [MIT license](LICENSE) for contributions to this project. Keep third-party attribution intact.
